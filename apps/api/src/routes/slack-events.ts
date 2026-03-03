import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  botChannels,
  channelCredentials,
  gatewayPools,
  sessions,
  slackInstallations,
  webhookRoutes,
} from "../db/schema/index.js";
import { decrypt } from "../lib/crypto.js";
import { BaseError } from "../lib/error.js";
import { logger } from "../lib/logger.js";
import { sendLinkingPrompt } from "../services/onboarding-reply.js";
import { provisionWorkspaceAgent } from "../services/slack-provisioning.js";
import type { AppBindings } from "../types.js";
import { createLinkToken, isUserLinked } from "./link-routes.js";

// ── Read body from Node.js IncomingMessage (bypasses Hono body reading) ──

function readIncomingBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    incoming.on("error", reject);
  });
}

// ── Slack signature verification ──────────────────────────────────────────

function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (Number.parseInt(timestamp, 10) < fiveMinutesAgo) return false;

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(sigBasestring)
    .digest("hex");
  const expected = `v0=${hmac}`;

  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ── Gateway forwarding ───────────────────────────────────────────────────

async function forwardToGateway(
  route: typeof webhookRoutes.$inferSelect,
  rawBody: string,
  timestamp: string,
  signature: string,
): Promise<Response> {
  // Resolve accountId
  const [channel] = await db
    .select({ accountId: botChannels.accountId })
    .from(botChannels)
    .where(eq(botChannels.id, route.botChannelId));

  const accountId = channel?.accountId ?? route.accountId;

  // Resolve gateway pod IP
  const [pool] = await db
    .select({ podIp: gatewayPools.podIp })
    .from(gatewayPools)
    .where(eq(gatewayPools.id, route.poolId));

  if (!pool?.podIp) {
    logger.warn({
      message: "slack_events_gateway_pod_missing",
      pool_id: route.poolId,
    });
    return Response.json({ accepted: true }, { status: 202 });
  }

  const gatewayUrl = `http://${pool.podIp}:18789/slack/events/${accountId}`;
  logger.info({
    message: "slack_events_forwarding",
    gateway_url: gatewayUrl,
    timestamp,
  });

  try {
    const gatewayResp = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    });

    const respBody = await gatewayResp.text();
    logger.info({
      message: "slack_events_gateway_response",
      status: gatewayResp.status,
      body_length: respBody.length,
    });
    return new Response(respBody, {
      status: gatewayResp.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const unknownError = BaseError.from(err);
    logger.warn({
      message: "slack_events_gateway_forward_failed",
      scope: "slack_events_gateway_forward",
      pool_id: route.poolId,
      account_id: accountId,
      ...unknownError.toJSON(),
    });
    return Response.json({ accepted: true }, { status: 202 });
  }
}

// ── Session upsert (fire-and-forget) ─────────────────────────────────────

function upsertSession(
  route: typeof webhookRoutes.$inferSelect,
  payload: Record<string, unknown>,
  teamId: string,
): void {
  const event = payload.event as Record<string, unknown> | undefined;
  const isMessageEvent =
    event?.type === "message" || event?.type === "app_mention";

  if (!isMessageEvent || !event?.channel) return;

  const channelId = event.channel as string;
  const sessionKey = `slack_${teamId}_${channelId}`;
  const now = new Date().toISOString();

  // Resolve bot token for channel name lookup
  const resolveName = async (): Promise<string> => {
    try {
      const [botTokenRow] = await db
        .select({ encryptedValue: channelCredentials.encryptedValue })
        .from(channelCredentials)
        .where(
          and(
            eq(channelCredentials.botChannelId, route.botChannelId),
            eq(channelCredentials.credentialType, "botToken"),
          ),
        );
      if (!botTokenRow) return channelId;

      const botToken = decrypt(botTokenRow.encryptedValue);
      const infoResp = await fetch(
        `https://slack.com/api/conversations.info?channel=${channelId}`,
        { headers: { Authorization: `Bearer ${botToken}` } },
      );
      const infoData = (await infoResp.json()) as {
        ok: boolean;
        channel?: { name?: string; is_im?: boolean; user?: string };
      };
      if (!infoData.ok || !infoData.channel) return channelId;

      if (infoData.channel.is_im) {
        const userId = infoData.channel.user;
        if (!userId) return channelId;
        const userResp = await fetch(
          `https://slack.com/api/users.info?user=${userId}`,
          { headers: { Authorization: `Bearer ${botToken}` } },
        );
        const userData = (await userResp.json()) as {
          ok: boolean;
          user?: {
            real_name?: string;
            profile?: { display_name?: string };
          };
        };
        if (userData.ok && userData.user) {
          return (
            userData.user.profile?.display_name ||
            userData.user.real_name ||
            channelId
          );
        }
      } else {
        return infoData.channel.name ?? channelId;
      }
    } catch {
      // best-effort
    }
    return channelId;
  };

  // Resolve channel → botId
  void db
    .select({ botId: botChannels.botId })
    .from(botChannels)
    .where(eq(botChannels.id, route.botChannelId))
    .then(async ([ch]) => {
      if (!ch?.botId) return;

      const channelName = await resolveName();
      const title =
        channelName === channelId
          ? `Slack #${channelId}`
          : `#${channelName}`;

      await db
        .insert(sessions)
        .values({
          id: createId(),
          botId: ch.botId,
          sessionKey,
          channelType: "slack",
          channelId,
          title,
          status: "active",
          messageCount: 1,
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: sessions.sessionKey,
          set: {
            botId: ch.botId,
            title,
            messageCount: sql`${sessions.messageCount} + 1`,
            lastMessageAt: now,
            updatedAt: now,
          },
        });

      logger.info({
        message: "slack_events_session_upserted",
        session_key: sessionKey,
        title,
      });
    })
    .catch((err) => {
      const unknownError = BaseError.from(err);
      logger.warn({
        message: "slack_events_session_upsert_failed",
        scope: "slack_events_session_upsert",
        session_key: sessionKey,
        ...unknownError.toJSON(),
      });
    });
}

// ── Route registration ────────────────────────────────────────────────────

export function registerSlackEvents(app: OpenAPIHono<AppBindings>) {
  app.on("POST", "/api/slack/events", async (c) => {
    try {
      // Skip Slack retries — we already processed the original
      if (c.req.header("x-slack-retry-num")) {
        return c.json({ ok: true });
      }

      // ── 1. Read body ──────────────────────────────────────────
      let rawBody: string;
      try {
        rawBody = await c.req.text();
        if (!rawBody) {
          const incoming = (c.env as { incoming: IncomingMessage }).incoming;
          rawBody = await readIncomingBody(incoming);
        }
      } catch (err) {
        const unknownError = BaseError.from(err);
        logger.warn({
          message: "slack_events_body_read_failed",
          scope: "slack_events_body_read",
          ...unknownError.toJSON(),
        });
        return c.json({ ok: true });
      }

      // ── 2. Parse payload ──────────────────────────────────────
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return c.json({ message: "Invalid JSON" }, 400);
      }

      // Handle url_verification challenge
      if (payload.type === "url_verification") {
        return c.json({ challenge: payload.challenge });
      }

      const teamId = payload.team_id as string | undefined;
      const apiAppId = payload.api_app_id as string | undefined;
      if (!teamId || !apiAppId) {
        return c.json({ message: "Missing team_id or api_app_id" }, 400);
      }

      // ── 3. Signature verification (shared signing secret) ─────
      const signingSecret = process.env.SLACK_SIGNING_SECRET;
      const timestamp = c.req.header("x-slack-request-timestamp") ?? "";
      const signature = c.req.header("x-slack-signature") ?? "";

      if (!signingSecret || !timestamp || !signature) {
        return c.json({ message: "Missing signature" }, 401);
      }

      if (
        !verifySlackSignature(signingSecret, timestamp, rawBody, signature)
      ) {
        logger.warn({ message: "slack_events_signature_mismatch", timestamp });
        return c.json({ message: "Invalid signature" }, 401);
      }

      // ── 4. Route lookup ───────────────────────────────────────
      const compositeKey = `${teamId}:${apiAppId}`;
      let [route] = await db
        .select()
        .from(webhookRoutes)
        .where(
          and(
            eq(webhookRoutes.channelType, "slack"),
            eq(webhookRoutes.externalId, compositeKey),
          ),
        );

      if (!route) {
        // Check if this workspace has an installation → lazy provision
        const [installation] = await db
          .select()
          .from(slackInstallations)
          .where(eq(slackInstallations.teamId, teamId));

        if (!installation || installation.status !== "active") {
          return c.json({ message: "Unknown workspace" }, 404);
        }

        // Installed but no route — provision now
        logger.info({
          message: "slack_events_lazy_provision",
          team_id: teamId,
        });
        try {
          await provisionWorkspaceAgent(db, installation);
          const [newRoute] = await db
            .select()
            .from(webhookRoutes)
            .where(
              and(
                eq(webhookRoutes.channelType, "slack"),
                eq(webhookRoutes.externalId, compositeKey),
              ),
            );
          if (!newRoute) {
            logger.warn({
              message: "slack_events_provision_route_still_missing",
              composite_key: compositeKey,
            });
            return c.json({ ok: true });
          }
          route = newRoute;
        } catch (err) {
          logger.warn({
            message: "slack_events_lazy_provision_failed",
            team_id: teamId,
            error: String(err),
          });
          return c.json({ ok: true });
        }
      }

      // ── 5. User linking check (blocking, message events only) ─
      const event = payload.event as Record<string, unknown> | undefined;
      const isMessageEvent =
        event?.type === "message" || event?.type === "app_mention";
      const slackUserId = event?.user as string | undefined;

      if (isMessageEvent && slackUserId) {
        // Skip bot messages (avoid infinite loop)
        if (event?.bot_id || event?.subtype === "bot_message") {
          // Let bot messages through without link check
        } else {
          const linked = await isUserLinked("slack", teamId, slackUserId);

          if (!linked) {
            // Get bot token to send DM
            const [installation] = await db
              .select({ botToken: slackInstallations.botToken })
              .from(slackInstallations)
              .where(eq(slackInstallations.teamId, teamId));

            if (installation) {
              const botToken = decrypt(installation.botToken);
              const { url: linkUrl, isNew } = await createLinkToken(
                "slack",
                teamId,
                slackUserId,
              );
              // Only send DM for new tokens to avoid spamming on every message
              if (isNew) {
                await sendLinkingPrompt(botToken, slackUserId, linkUrl);
              }
            }

            logger.info({
              message: "slack_events_user_not_linked",
              team_id: teamId,
              slack_user_id: slackUserId,
            });
            return c.json({ ok: true });
          }
        }
      }

      // ── 6. Session upsert (fire-and-forget) ───────────────────
      upsertSession(route, payload, teamId);

      // ── 7. Forward to gateway ─────────────────────────────────
      return await forwardToGateway(route, rawBody, timestamp, signature);
    } catch (err) {
      const unknownError = BaseError.from(err);
      logger.warn({
        message: "slack_events_unhandled_error",
        scope: "slack_events_handler",
        ...unknownError.toJSON(),
      });
      return c.json({ ok: true });
    }
  });
}
