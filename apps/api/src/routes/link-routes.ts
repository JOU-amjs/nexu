import crypto from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { channelUserLinks, linkTokens } from "../db/schema/index.js";
import { logger } from "../lib/logger.js";
import type { AppBindings } from "../types.js";

// ── Token helpers ──────────────────────────────────────────────────────

function generateSecureToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create (or reuse) a one-time link token for a channel user.
 * If an unexpired, unused token already exists for this user, reuse it
 * to avoid flooding the table and spamming the user with duplicate DMs.
 * Returns { url, isNew } — callers can skip sending DM when isNew is false.
 */
export async function createLinkToken(
  channelType: string,
  channelTeamId: string | null,
  channelUserId: string,
): Promise<{ url: string; isNew: boolean }> {
  const webUrl = process.env.WEB_URL ?? "http://localhost:5173";
  const now = new Date().toISOString();

  // Reuse existing unexpired, unused token if available
  const teamCondition =
    channelTeamId != null
      ? eq(linkTokens.channelTeamId, channelTeamId)
      : isNull(linkTokens.channelTeamId);

  const [existing] = await db
    .select({ token: linkTokens.token })
    .from(linkTokens)
    .where(
      and(
        eq(linkTokens.channelType, channelType),
        teamCondition,
        eq(linkTokens.channelUserId, channelUserId),
        isNull(linkTokens.usedAt),
        gt(linkTokens.expiresAt, now),
      ),
    );

  if (existing) {
    return { url: `${webUrl}/link?token=${existing.token}`, isNew: false };
  }

  // Create new token
  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await db.insert(linkTokens).values({
    id: createId(),
    token,
    channelType,
    channelTeamId,
    channelUserId,
    expiresAt,
    createdAt: now,
  });

  return { url: `${webUrl}/link?token=${token}`, isNew: true };
}

/**
 * Check if a channel user is already linked to a Nexu account.
 */
export async function isUserLinked(
  channelType: string,
  channelTeamId: string | null,
  channelUserId: string,
): Promise<boolean> {
  const conditions = [
    eq(channelUserLinks.channelType, channelType),
    eq(channelUserLinks.channelUserId, channelUserId),
    eq(channelUserLinks.status, "active"),
  ];

  if (channelTeamId != null) {
    conditions.push(eq(channelUserLinks.channelTeamId, channelTeamId));
  } else {
    conditions.push(isNull(channelUserLinks.channelTeamId));
  }

  const [link] = await db
    .select({ nexuUserId: channelUserLinks.nexuUserId })
    .from(channelUserLinks)
    .where(and(...conditions));

  return Boolean(link?.nexuUserId);
}

/**
 * Find any existing link for a channel user across all teams.
 * Used for cross-guild auto-linking (Discord).
 */
export async function findLinkedUserAnyTeam(
  channelType: string,
  channelUserId: string,
): Promise<string | null> {
  const [link] = await db
    .select({ nexuUserId: channelUserLinks.nexuUserId })
    .from(channelUserLinks)
    .where(
      and(
        eq(channelUserLinks.channelType, channelType),
        eq(channelUserLinks.channelUserId, channelUserId),
        eq(channelUserLinks.status, "active"),
      ),
    );

  return link?.nexuUserId ?? null;
}

/**
 * Create a channel user link record.
 */
export async function createUserLink(
  channelType: string,
  channelTeamId: string | null,
  channelUserId: string,
  nexuUserId: string,
  displayName?: string,
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .insert(channelUserLinks)
    .values({
      id: createId(),
      channelType,
      channelTeamId,
      channelUserId,
      nexuUserId,
      displayName: displayName ?? null,
      status: "active",
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        channelUserLinks.channelType,
        channelUserLinks.channelTeamId,
        channelUserLinks.channelUserId,
      ],
      set: {
        nexuUserId,
        // Only overwrite displayName if a new value is provided
        ...(displayName != null ? { displayName } : {}),
        status: "active",
        linkedAt: now,
        updatedAt: now,
      },
    });
}

// ── Route registration ─────────────────────────────────────────────────

export function registerLinkRoutes(app: OpenAPIHono<AppBindings>) {
  /**
   * POST /api/v1/link/confirm
   *
   * Confirm a link token and associate the channel user with the
   * currently logged-in Nexu user.
   */
  app.on("POST", "/api/v1/link/confirm", async (c) => {
    // Auth: the user must be logged in (session middleware sets userId)
    const userId = c.get("userId" as never) as string | undefined;
    if (!userId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const body = (await c.req.json()) as { token?: string };
    const tokenValue = body.token?.trim();
    if (!tokenValue) {
      return c.json({ error: "Missing token" }, 400);
    }

    // Atomically claim the token: mark as used only if not yet consumed and not expired.
    // This prevents TOCTOU races where two concurrent requests use the same token.
    const now = new Date().toISOString();
    const [tokenRow] = await db
      .update(linkTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(linkTokens.token, tokenValue),
          isNull(linkTokens.usedAt),
          gt(linkTokens.expiresAt, now),
        ),
      )
      .returning();

    if (!tokenRow) {
      // Token doesn't exist, already used, or expired
      return c.json({ error: "Invalid, expired, or already used token" }, 400);
    }

    // Create the link
    await createUserLink(
      tokenRow.channelType,
      tokenRow.channelTeamId,
      tokenRow.channelUserId,
      userId,
    );

    logger.info({
      message: "user_link_confirmed",
      channel_type: tokenRow.channelType,
      channel_team_id: tokenRow.channelTeamId,
      channel_user_id: tokenRow.channelUserId,
      nexu_user_id: userId,
    });

    return c.json({
      success: true,
      channelType: tokenRow.channelType,
      channelTeamId: tokenRow.channelTeamId,
      channelUserId: tokenRow.channelUserId,
    });
  });
}
