import type { OpenAPIHono } from "@hono/zod-openapi";
import { logger } from "../lib/logger.js";
import type { AppBindings } from "../types.js";
import {
  createLinkToken,
  createUserLink,
  findLinkedUserAnyTeam,
  isUserLinked,
} from "./link-routes.js";

const ALLOWED_CHANNELS = new Set(["slack", "discord", "feishu"]);

// ── Route registration ─────────────────────────────────────────────────

export function registerAuthCheckRoutes(app: OpenAPIHono<AppBindings>) {
  /**
   * GET /api/v1/auth/check
   *
   * Called by the nexu-auth gateway plugin to verify whether a channel
   * user is linked to a Nexu account.  Supports cross-Guild auto-linking
   * for Discord only (Discord userId is globally unique; Slack/Feishu are not).
   *
   * Authentication: requires GATEWAY_TOKEN in Authorization header.
   *
   * Query params:
   *   channel  – "discord" | "slack" | "feishu"
   *   teamId   – Guild ID / team ID / tenant_key
   *   userId   – Channel-specific user ID
   *
   * Returns:
   *   { linked: true }
   *   { linked: false, linkUrl?: string }
   */
  app.on("GET", "/api/v1/auth/check", async (c) => {
    // Authenticate via gateway token
    const gatewayToken = process.env.GATEWAY_TOKEN;
    if (gatewayToken) {
      const auth = c.req.header("authorization");
      const token = auth?.startsWith("Bearer ")
        ? auth.slice(7)
        : null;
      if (token !== gatewayToken) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    const channel = c.req.query("channel");
    const teamId = c.req.query("teamId") ?? null;
    const userId = c.req.query("userId");

    if (!channel || !userId) {
      return c.json({ error: "Missing channel or userId" }, 400);
    }

    if (!ALLOWED_CHANNELS.has(channel)) {
      return c.json({ error: "Invalid channel type" }, 400);
    }

    // 1. Check if user is linked for this specific team
    const linked = await isUserLinked(channel, teamId, userId);
    if (linked) {
      return c.json({ linked: true });
    }

    // 2. Cross-team auto-linking — Discord only (userId is globally unique)
    //    Slack/Feishu user IDs are workspace-scoped, so cross-team linking
    //    would incorrectly merge different physical users.
    if (channel === "discord" && teamId) {
      const existingNexuUserId = await findLinkedUserAnyTeam(channel, userId);
      if (existingNexuUserId) {
        await createUserLink(channel, teamId, userId, existingNexuUserId);
        logger.info({
          message: "auth_check_cross_guild_auto_linked",
          channel,
          team_id: teamId,
          user_id: userId,
          nexu_user_id: existingNexuUserId,
        });
        return c.json({ linked: true });
      }
    }

    // 3. Not linked — generate a link token so the plugin can send it
    const { url: linkUrl } = await createLinkToken(channel, teamId, userId);

    logger.info({
      message: "auth_check_user_not_linked",
      channel,
      team_id: teamId,
      user_id: userId,
    });

    return c.json({ linked: false, linkUrl });
  });
}
