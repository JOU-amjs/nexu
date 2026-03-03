import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db } from "../db/index.js";
import {
  botChannels,
  gatewayPools,
  sessions,
  webhookRoutes,
} from "../db/schema/index.js";
import { BaseError } from "../lib/error.js";
import { logger } from "../lib/logger.js";
import type { AppBindings } from "../types.js";
import { isUserLinked } from "./link-routes.js";

// ── Feishu event payload types ───────────────────────────────────────────

interface FeishuChallenge {
  challenge: string;
  token: string;
  type: "url_verification";
}

interface FeishuEventV2 {
  schema: "2.0";
  header: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event: {
    sender?: {
      sender_id?: { open_id?: string; user_id?: string; union_id?: string };
      sender_type?: string;
      tenant_key?: string;
    };
    message?: {
      message_id: string;
      chat_id: string;
      chat_type: "p2p" | "group";
      message_type: string;
      content: string;
    };
  };
}

// ── Gateway forwarding ───────────────────────────────────────────────────

async function forwardToGateway(
  route: typeof webhookRoutes.$inferSelect,
  rawBody: string,
): Promise<Response> {
  const [pool] = await db
    .select({ podIp: gatewayPools.podIp })
    .from(gatewayPools)
    .where(eq(gatewayPools.id, route.poolId));

  if (!pool?.podIp) {
    logger.warn({
      message: "feishu_events_gateway_pod_missing",
      pool_id: route.poolId,
    });
    return Response.json({ ok: true }, { status: 200 });
  }

  // Feishu extension listens on a separate webhook port (default 3100)
  const gatewayUrl = `http://${pool.podIp}:3100/feishu/events`;
  logger.info({
    message: "feishu_events_forwarding",
    gateway_url: gatewayUrl,
  });

  try {
    const gatewayResp = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    });

    const respBody = await gatewayResp.text();
    logger.info({
      message: "feishu_events_gateway_response",
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
      message: "feishu_events_gateway_forward_failed",
      scope: "feishu_events_gateway_forward",
      pool_id: route.poolId,
      ...unknownError.toJSON(),
    });
    return Response.json({ ok: true }, { status: 200 });
  }
}

// ── Session upsert (fire-and-forget) ─────────────────────────────────────

function upsertSession(
  route: typeof webhookRoutes.$inferSelect,
  payload: FeishuEventV2,
): void {
  const msg = payload.event?.message;
  if (!msg?.chat_id) return;

  const tenantKey = payload.header.tenant_key;
  const sessionKey = `feishu_${tenantKey}_${msg.chat_id}`;
  const now = new Date().toISOString();
  const title =
    msg.chat_type === "p2p"
      ? `Feishu DM ${msg.chat_id.slice(0, 8)}`
      : `Feishu Group ${msg.chat_id.slice(0, 8)}`;

  void db
    .select({ botId: botChannels.botId })
    .from(botChannels)
    .where(eq(botChannels.id, route.botChannelId))
    .then(async ([ch]) => {
      if (!ch?.botId) return;

      await db
        .insert(sessions)
        .values({
          id: createId(),
          botId: ch.botId,
          sessionKey,
          channelType: "feishu",
          channelId: msg.chat_id,
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
    })
    .catch((err) => {
      const unknownError = BaseError.from(err);
      logger.warn({
        message: "feishu_events_session_upsert_failed",
        scope: "feishu_events_session_upsert",
        session_key: sessionKey,
        ...unknownError.toJSON(),
      });
    });
}

// ── Route registration ────────────────────────────────────────────────────

export function registerFeishuEvents(app: OpenAPIHono<AppBindings>) {
  app.on("POST", "/api/feishu/events", async (c) => {
    try {
      // ── 1. Read body ──────────────────────────────────────────
      let rawBody: string;
      try {
        rawBody = await c.req.text();
      } catch (err) {
        const unknownError = BaseError.from(err);
        logger.warn({
          message: "feishu_events_body_read_failed",
          scope: "feishu_events_body_read",
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

      // ── 3. Verification token (required) ────────────────────
      const expectedToken = process.env.FEISHU_VERIFICATION_TOKEN;
      if (!expectedToken) {
        logger.warn({ message: "feishu_events_no_verification_token_configured" });
        return c.json({ message: "Feishu not configured" }, 500);
      }

      // ── 4. Handle url_verification challenge ──────────────────
      if (payload.type === "url_verification") {
        const challenge = payload as unknown as FeishuChallenge;
        if (challenge.token !== expectedToken) {
          return c.json({ message: "Invalid verification token" }, 401);
        }
        return c.json({ challenge: challenge.challenge });
      }

      // ── 5. Parse v2 event ─────────────────────────────────────
      const event = payload as unknown as FeishuEventV2;
      if (event.schema !== "2.0" || !event.header) {
        return c.json({ message: "Unsupported event format" }, 400);
      }

      // ── 6. Verify event token ─────────────────────────────────
      if (event.header.token !== expectedToken) {
        logger.warn({
          message: "feishu_events_token_mismatch",
          app_id: event.header.app_id,
        });
        return c.json({ message: "Invalid verification token" }, 401);
      }

      const tenantKey = event.header.tenant_key;
      const appId = event.header.app_id;
      if (!tenantKey || !appId) {
        return c.json({ message: "Missing tenant_key or app_id" }, 400);
      }

      // ── 7. Route lookup ───────────────────────────────────────
      const compositeKey = `${tenantKey}:${appId}`;
      const [route] = await db
        .select()
        .from(webhookRoutes)
        .where(
          and(
            eq(webhookRoutes.channelType, "feishu"),
            eq(webhookRoutes.externalId, compositeKey),
          ),
        );

      if (!route) {
        logger.info({
          message: "feishu_events_route_not_found",
          composite_key: compositeKey,
        });
        return c.json({ ok: true });
      }

      // ── 8. User linking check (message events only) ───────────
      const isMessageEvent =
        event.header.event_type === "im.message.receive_v1";
      const openId = event.event?.sender?.sender_id?.open_id;
      const senderType = event.event?.sender?.sender_type;

      if (isMessageEvent && openId && senderType !== "bot") {
        const linked = await isUserLinked("feishu", tenantKey, openId);

        if (!linked) {
          // TODO: Send linking prompt via Feishu API (requires appId + appSecret)
          // For now, log and block the message
          logger.info({
            message: "feishu_events_user_not_linked",
            tenant_key: tenantKey,
            open_id: openId,
          });
          return c.json({ ok: true });
        }
      }

      // ── 9. Session upsert (fire-and-forget) ───────────────────
      upsertSession(route, event);

      // ── 10. Forward to gateway ────────────────────────────────
      return await forwardToGateway(route, rawBody);
    } catch (err) {
      const unknownError = BaseError.from(err);
      logger.warn({
        message: "feishu_events_unhandled_error",
        scope: "feishu_events_handler",
        ...unknownError.toJSON(),
      });
      return c.json({ ok: true });
    }
  });
}
