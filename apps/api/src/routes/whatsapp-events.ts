import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  botChannels,
  bots,
  gatewayPools,
  whatsappIdentities,
  whatsappLinkTokens,
} from "../db/schema/index.js";
import {
  findUserPrimaryBot,
  getOfficialWhatsAppAccountId,
  getOfficialWhatsAppPhoneNumber,
  getOfficialWhatsAppPhoneNumberId,
} from "../lib/whatsapp-linking.js";
import type { AppBindings } from "../types.js";

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: {
          phone_number_id?: string;
        };
        messages?: Array<{
          from?: string;
          type?: string;
          text?: {
            body?: string;
          };
        }>;
      };
    }>;
  }>;
}

const execFileAsync = promisify(execFile);

function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  signatureHeader: string,
): boolean {
  if (!signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function extractInbound(payload: WhatsAppWebhookPayload): {
  phoneNumberId: string | null;
  waId: string | null;
  messageText: string | null;
} {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      const firstMessage = change.value?.messages?.[0];
      const waId = firstMessage?.from ?? null;
      const messageText = firstMessage?.text?.body?.trim() ?? null;
      return { phoneNumberId: phoneNumberId ?? null, waId, messageText };
    }
  }

  return { phoneNumberId: null, waId: null, messageText: null };
}

async function runOpenClawAgent(params: {
  podIp: string;
  gatewayToken: string;
  agentId: string;
  sessionKey: string;
  message: string;
}): Promise<string> {
  const openclawBin = process.env.OPENCLAW_BIN ?? "openclaw";
  const configuredTimeout = Number.parseInt(
    process.env.OPENCLAW_AGENT_TIMEOUT_MS ?? "45000",
    10,
  );
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? configuredTimeout
    : 45000;

  const paramsJson = JSON.stringify({
    message: params.message,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    deliver: false,
    idempotencyKey: createId(),
  });

  const { stdout } = await execFileAsync(
    openclawBin,
    [
      "gateway",
      "call",
      "agent",
      "--url",
      `ws://${params.podIp}:18789`,
      "--token",
      params.gatewayToken,
      "--expect-final",
      "--json",
      "--params",
      paramsJson,
    ],
    { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
  );

  const response = JSON.parse(stdout) as {
    status?: string;
    result?: {
      payloads?: Array<{ text?: string | null }>;
    };
  };

  if (response.status !== "ok") {
    throw new Error("OpenClaw agent call failed");
  }

  const textParts = (response.result?.payloads ?? [])
    .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
    .filter((text) => text.length > 0);

  return textParts.join("\n\n");
}

async function sendWhatsAppText(to: string, body: string): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = getOfficialWhatsAppPhoneNumberId();

  if (!accessToken || !phoneNumberId) {
    console.warn(
      "[whatsapp-events] cannot send reply: missing token or phone id",
    );
    return;
  }

  const response = await fetch(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    console.error("[whatsapp-events] failed to send message", {
      status: response.status,
      response: text.slice(0, 180),
    });
  }
}

async function createLinkToken(waId: string): Promise<string> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const token = createId();

  await db.insert(whatsappLinkTokens).values({
    id: createId(),
    token,
    waId,
    expiresAt,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });

  return token;
}

export function registerWhatsAppEvents(app: OpenAPIHono<AppBindings>) {
  app.get("/api/whatsapp/events", async (c) => {
    const mode = c.req.query("hub.mode");
    const verifyToken = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");

    const expectedVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!expectedVerifyToken) {
      return c.text("Webhook verify token is not configured", 500);
    }

    if (
      mode === "subscribe" &&
      verifyToken === expectedVerifyToken &&
      challenge
    ) {
      return c.text(challenge, 200);
    }

    return c.text("Forbidden", 403);
  });

  app.on("POST", "/api/whatsapp/events", async (c) => {
    try {
      const appSecret = process.env.WHATSAPP_APP_SECRET;
      if (!appSecret) {
        console.error("[whatsapp-events] missing WHATSAPP_APP_SECRET");
        return c.json({ error: "Server misconfigured" }, 500);
      }

      const signature = c.req.header("x-hub-signature-256") ?? "";
      if (!signature) {
        return c.json({ error: "Missing signature" }, 401);
      }

      const rawBody = await c.req.text();
      if (!verifyMetaSignature(appSecret, rawBody, signature)) {
        return c.json({ error: "Invalid signature" }, 401);
      }

      let payload: WhatsAppWebhookPayload;
      try {
        payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const { phoneNumberId, waId, messageText } = extractInbound(payload);
      if (!phoneNumberId || !waId) {
        console.log(
          "[whatsapp-events] missing phone_number_id or wa_id in payload",
        );
        return c.json({ accepted: true }, 202);
      }

      if (!messageText) {
        return c.json({ accepted: true }, 202);
      }

      const officialPhoneNumberId = getOfficialWhatsAppPhoneNumberId();
      if (officialPhoneNumberId && phoneNumberId !== officialPhoneNumberId) {
        return c.json({ error: "Unknown phone number" }, 404);
      }

      console.log(
        `[whatsapp-events] phone_number_id=${phoneNumberId} wa_id=${waId}`,
      );

      const [identity] = await db
        .select()
        .from(whatsappIdentities)
        .where(eq(whatsappIdentities.waId, waId));

      if (!identity) {
        const token = await createLinkToken(waId);
        const webUrl = process.env.WEB_URL ?? "http://localhost:5173";
        const linkUrl = `${webUrl}/workspace/channels?wa_link=${encodeURIComponent(token)}`;
        const waLink = getOfficialWhatsAppPhoneNumber();

        await sendWhatsAppText(
          waId,
          `Welcome to Nexu. Your WhatsApp ID is ${waId}. Please register or login, then open ${linkUrl} to link and configure your bot.${waLink ? `\nOfficial number: ${waLink}` : ""}`,
        );
        return c.json({ accepted: true }, 202);
      }

      await db
        .update(whatsappIdentities)
        .set({
          lastSeenAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(whatsappIdentities.id, identity.id));

      const officialAccountId = getOfficialWhatsAppAccountId();

      const [channel] = await db
        .select({
          poolId: bots.poolId,
          botSlug: bots.slug,
        })
        .from(botChannels)
        .innerJoin(bots, eq(botChannels.botId, bots.id))
        .where(
          and(
            eq(bots.userId, identity.userId),
            or(eq(bots.status, "active"), eq(bots.status, "paused")),
            eq(botChannels.channelType, "whatsapp"),
            eq(botChannels.accountId, officialAccountId),
            eq(botChannels.status, "connected"),
            sql`${botChannels.channelConfig}::jsonb ->> 'waId' = ${waId}`,
          ),
        );

      if (!channel) {
        const bot = await findUserPrimaryBot(db, identity.userId);
        if (!bot) {
          await sendWhatsAppText(
            waId,
            "Your WhatsApp is linked, but your bot is not configured yet. Please complete bot setup in Nexu, then send a message again.",
          );
        }
        return c.json({ accepted: true }, 202);
      }

      if (!channel.poolId) {
        return c.json({ accepted: true }, 202);
      }

      const [pool] = await db
        .select({ podIp: gatewayPools.podIp })
        .from(gatewayPools)
        .where(eq(gatewayPools.id, channel.poolId));

      const podIp = pool?.podIp;
      if (!podIp) {
        return c.json({ accepted: true }, 202);
      }

      const gatewayToken = process.env.GATEWAY_TOKEN ?? "";
      if (!channel.botSlug || !gatewayToken) {
        return c.json({ accepted: true }, 202);
      }

      const replyText = await runOpenClawAgent({
        podIp,
        gatewayToken,
        agentId: channel.botSlug,
        sessionKey: `agent:${channel.botSlug}:whatsapp:dm:${waId}`,
        message: messageText,
      });

      if (replyText) {
        await sendWhatsAppText(waId, replyText.slice(0, 4000));
      }

      return c.json({ accepted: true }, 202);
    } catch (error) {
      console.error("[whatsapp-events] unhandled error", {
        error: error instanceof Error ? error.message : "unknown_error",
      });
      return c.json({ accepted: true }, 202);
    }
  });
}
