import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  channelListResponseSchema,
  channelResponseSchema,
  claimWhatsAppLinkSchema,
  connectDiscordSchema,
  connectSlackSchema,
  connectWhatsAppSchema,
  slackOAuthUrlResponseSchema,
  whatsappLinkStatusResponseSchema,
} from "@nexu/shared";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, lt, or } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  botChannels,
  bots,
  channelCredentials,
  oauthStates,
  webhookRoutes,
  whatsappIdentities,
  whatsappLinkTokens,
} from "../db/schema/index.js";
import { findOrCreateDefaultBot } from "../lib/bot-helpers.js";
import { encrypt } from "../lib/crypto.js";
import {
  ensureWhatsAppChannelForBot,
  findUserPrimaryBot,
  getOfficialWhatsAppPhoneNumber,
  getOfficialWhatsAppWaLink,
  hasConfiguredBot,
} from "../lib/whatsapp-linking.js";
import { publishPoolConfigSnapshot } from "../services/runtime/pool-config-service.js";

import type { AppBindings } from "../types.js";

// ---------------------------------------------------------------------------
// Shared helpers & schemas
// ---------------------------------------------------------------------------

const errorResponseSchema = z.object({
  message: z.string(),
});

const channelIdParam = z.object({
  channelId: z.string(),
});

interface SlackOAuthV2Response {
  ok: boolean;
  error?: string;
  access_token: string;
  token_type: "bot";
  scope: string;
  bot_user_id: string;
  app_id: string;
  team: { id: string; name: string };
  enterprise?: { id: string; name: string } | null;
  authed_user: { id: string };
}

interface WhatsAppPhoneNumber {
  id: string;
  display_phone_number?: string;
}

interface WhatsAppPhoneNumbersResponse {
  data?: WhatsAppPhoneNumber[];
}

function normalizePhoneNumber(value: string): string {
  return value.replace(/\D/g, "");
}

async function resolveWhatsAppPhoneNumberIdByNumber(
  phoneNumber: string,
): Promise<{ phoneNumberId: string; displayPhoneNumber?: string }> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

  if (!accessToken) {
    throw new Error("WHATSAPP_ACCESS_TOKEN is not configured on this server");
  }

  if (!businessAccountId) {
    throw new Error(
      "WHATSAPP_BUSINESS_ACCOUNT_ID is required when using phone number",
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/v22.0/${encodeURIComponent(businessAccountId)}/phone_numbers`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to query WhatsApp phone numbers: ${response.status} ${text}`,
    );
  }

  const payload = (await response.json()) as WhatsAppPhoneNumbersResponse;
  const phoneNumbers = Array.isArray(payload.data) ? payload.data : [];
  const target = normalizePhoneNumber(phoneNumber);

  const matched = phoneNumbers.find((item) => {
    const candidate = normalizePhoneNumber(item.display_phone_number ?? "");
    return candidate === target;
  });

  if (!matched) {
    throw new Error(
      `No WhatsApp phone number found for ${phoneNumber} in configured business account`,
    );
  }

  return {
    phoneNumberId: matched.id,
    displayPhoneNumber: matched.display_phone_number,
  };
}

function formatChannel(
  ch: typeof botChannels.$inferSelect,
): z.infer<typeof channelResponseSchema> {
  let config: Record<string, unknown> = {};
  if (ch.channelConfig) {
    try {
      config =
        typeof ch.channelConfig === "string"
          ? JSON.parse(ch.channelConfig)
          : (ch.channelConfig as Record<string, unknown>);
    } catch {
      config = {};
    }
  }
  return {
    id: ch.id,
    botId: ch.botId,
    channelType: ch.channelType as "slack" | "discord" | "whatsapp",
    accountId: ch.accountId,
    status: (ch.status ?? "pending") as
      | "pending"
      | "connected"
      | "disconnected"
      | "error",
    teamName: (config.teamName as string) ?? null,
    appId: (config.appId as string) ?? null,
    createdAt: ch.createdAt,
    updatedAt: ch.updatedAt,
  };
}

async function publishSnapshotSafely(
  poolId: string | null | undefined,
  botId: string,
): Promise<void> {
  if (!poolId) {
    return;
  }

  try {
    await publishPoolConfigSnapshot(db, poolId);
  } catch (error) {
    console.error("[channels] failed to publish pool config snapshot", {
      poolId,
      botId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
  }
}

/** Build the fixed redirect URI used in both the authorize URL and the token exchange. */
function getSlackRedirectUri(): string {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  return `${base}/api/oauth/slack/callback`;
}

/** Scopes required for a messaging bot. */
const SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "users:read",
].join(",");

// ---------------------------------------------------------------------------
// OpenAPI route definitions (user-scoped, no botId param)
// ---------------------------------------------------------------------------

const slackOAuthUrlRoute = createRoute({
  method: "get",
  path: "/v1/channels/slack/oauth-url",
  tags: ["Channels"],
  responses: {
    200: {
      content: {
        "application/json": { schema: slackOAuthUrlResponseSchema },
      },
      description: "Slack OAuth authorization URL",
    },
    500: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Slack OAuth not configured",
    },
  },
});

const connectSlackRoute = createRoute({
  method: "post",
  path: "/v1/channels/slack/connect",
  tags: ["Channels"],
  request: {
    body: { content: { "application/json": { schema: connectSlackSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: channelResponseSchema } },
      description: "Slack channel connected",
    },
    409: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Slack already connected",
    },
  },
});

const listChannelsRoute = createRoute({
  method: "get",
  path: "/v1/channels",
  tags: ["Channels"],
  responses: {
    200: {
      content: { "application/json": { schema: channelListResponseSchema } },
      description: "Channel list",
    },
  },
});

const disconnectChannelRoute = createRoute({
  method: "delete",
  path: "/v1/channels/{channelId}",
  tags: ["Channels"],
  request: {
    params: channelIdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
      description: "Channel disconnected",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Not found",
    },
  },
});

const connectDiscordRoute = createRoute({
  method: "post",
  path: "/v1/channels/discord/connect",
  tags: ["Channels"],
  request: {
    body: {
      content: { "application/json": { schema: connectDiscordSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: channelResponseSchema } },
      description: "Discord channel connected",
    },
    409: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Discord already connected",
    },
  },
});

const connectWhatsAppRoute = createRoute({
  method: "post",
  path: "/v1/channels/whatsapp/connect",
  tags: ["Channels"],
  request: {
    body: {
      content: { "application/json": { schema: connectWhatsAppSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: channelResponseSchema } },
      description: "WhatsApp channel connected",
    },
    400: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Invalid input",
    },
    409: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "WhatsApp already connected",
    },
    500: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Failed to resolve phone number",
    },
  },
});

const whatsappLinkStatusRoute = createRoute({
  method: "get",
  path: "/v1/channels/whatsapp/link-status",
  tags: ["Channels"],
  responses: {
    200: {
      content: {
        "application/json": { schema: whatsappLinkStatusResponseSchema },
      },
      description: "WhatsApp link status",
    },
  },
});

const claimWhatsAppLinkRoute = createRoute({
  method: "post",
  path: "/v1/channels/whatsapp/claim-link",
  tags: ["Channels"],
  request: {
    body: {
      content: { "application/json": { schema: claimWhatsAppLinkSchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: whatsappLinkStatusResponseSchema },
      },
      description: "WhatsApp linked successfully",
    },
    400: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Invalid or expired link token",
    },
    409: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "WhatsApp ID already linked",
    },
  },
});

const unlinkWhatsAppRoute = createRoute({
  method: "post",
  path: "/v1/channels/whatsapp/unlink",
  tags: ["Channels"],
  responses: {
    200: {
      content: {
        "application/json": { schema: whatsappLinkStatusResponseSchema },
      },
      description: "WhatsApp unlinked successfully",
    },
  },
});

const channelStatusRoute = createRoute({
  method: "get",
  path: "/v1/channels/{channelId}/status",
  tags: ["Channels"],
  request: {
    params: channelIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: channelResponseSchema } },
      description: "Channel status",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Authenticated channel routes (under /v1/*)
// ---------------------------------------------------------------------------

export function registerChannelRoutes(app: OpenAPIHono<AppBindings>) {
  // -- Slack OAuth URL generation (authenticated, no botId needed) --
  app.openapi(slackOAuthUrlRoute, async (c) => {
    const userId = c.get("userId");

    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
      return c.json(
        { message: "Slack OAuth is not configured on this server" },
        500,
      );
    }

    // Generate CSRF state token (10 min TTL) — botId is null
    const nonce = createId();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await db.insert(oauthStates).values({
      id: createId(),
      state: nonce,
      userId,
      expiresAt,
    });

    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SLACK_BOT_SCOPES);
    url.searchParams.set("redirect_uri", getSlackRedirectUri());
    url.searchParams.set("state", nonce);

    return c.json({ url: url.toString() }, 200);
  });

  // -- Manual Slack connect (authenticated) --
  app.openapi(connectSlackRoute, async (c) => {
    const userId = c.get("userId");
    const input = c.req.valid("json");

    const bot = await findOrCreateDefaultBot(userId);
    const botId = bot.id;

    const accountId = `slack-${input.teamId}`;

    const [globalExisting] = await db
      .select()
      .from(webhookRoutes)
      .where(
        and(
          eq(webhookRoutes.channelType, "slack"),
          eq(webhookRoutes.externalId, input.teamId),
        ),
      );

    if (globalExisting) {
      return c.json(
        {
          message: "This Slack workspace is already connected to another bot",
        },
        409,
      );
    }

    const [existing] = await db
      .select()
      .from(botChannels)
      .where(
        and(
          eq(botChannels.botId, botId),
          eq(botChannels.channelType, "slack"),
          eq(botChannels.accountId, accountId),
        ),
      );

    if (existing) {
      return c.json({ message: "Slack channel already connected" }, 409);
    }

    const channelId = createId();
    const now = new Date().toISOString();

    await db.insert(botChannels).values({
      id: channelId,
      botId,
      channelType: "slack",
      accountId,
      status: "connected",
      channelConfig: JSON.stringify({
        teamId: input.teamId,
        teamName: input.teamName ?? null,
      }),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(channelCredentials).values({
      id: createId(),
      botChannelId: channelId,
      credentialType: "botToken",
      encryptedValue: encrypt(input.botToken),
      createdAt: now,
    });

    await db.insert(channelCredentials).values({
      id: createId(),
      botChannelId: channelId,
      credentialType: "signingSecret",
      encryptedValue: encrypt(input.signingSecret),
      createdAt: now,
    });

    if (bot.poolId) {
      await db.insert(webhookRoutes).values({
        id: createId(),
        channelType: "slack",
        externalId: input.teamId,
        poolId: bot.poolId,
        botChannelId: channelId,
        botId,
        accountId,
        updatedAt: now,
        createdAt: now,
      });
    }

    await publishSnapshotSafely(bot.poolId, bot.id);

    const [channel] = await db
      .select()
      .from(botChannels)
      .where(eq(botChannels.id, channelId));

    if (!channel) {
      throw new Error("Failed to create channel");
    }

    return c.json(formatChannel(channel), 200);
  });

  // -- Discord connect --
  app.openapi(connectDiscordRoute, async (c) => {
    const userId = c.get("userId");
    const input = c.req.valid("json");

    const bot = await findOrCreateDefaultBot(userId);
    const botId = bot.id;

    const accountId = input.guildId
      ? `discord-${input.guildId}`
      : "discord-default";

    const [existing] = await db
      .select()
      .from(botChannels)
      .where(
        and(
          eq(botChannels.botId, botId),
          eq(botChannels.channelType, "discord"),
          eq(botChannels.accountId, accountId),
        ),
      );

    if (existing) {
      return c.json({ message: "Discord channel already connected" }, 409);
    }

    const channelId = createId();
    const now = new Date().toISOString();

    await db.insert(botChannels).values({
      id: channelId,
      botId,
      channelType: "discord",
      accountId,
      status: "connected",
      channelConfig: JSON.stringify({
        appId: input.appId,
        guildId: input.guildId ?? null,
        guildName: input.guildName ?? null,
      }),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(channelCredentials).values({
      id: createId(),
      botChannelId: channelId,
      credentialType: "botToken",
      encryptedValue: encrypt(input.botToken),
      createdAt: now,
    });

    await publishSnapshotSafely(bot.poolId, bot.id);

    const [channel] = await db
      .select()
      .from(botChannels)
      .where(eq(botChannels.id, channelId));

    if (!channel) {
      throw new Error("Failed to create channel");
    }

    return c.json(formatChannel(channel), 200);
  });

  // -- WhatsApp connect --
  app.openapi(connectWhatsAppRoute, async (c) => {
    const userId = c.get("userId");
    const input = c.req.valid("json");

    const bot = await findOrCreateDefaultBot(userId);
    const botId = bot.id;

    let phoneNumberId = input.phoneNumberId?.trim() ?? "";
    let resolvedDisplayPhoneNumber = input.displayPhoneNumber;

    if (!phoneNumberId && input.phoneNumber) {
      try {
        const resolved = await resolveWhatsAppPhoneNumberIdByNumber(
          input.phoneNumber,
        );
        phoneNumberId = resolved.phoneNumberId;
        resolvedDisplayPhoneNumber =
          resolvedDisplayPhoneNumber ?? resolved.displayPhoneNumber;
      } catch (error) {
        return c.json(
          {
            message:
              error instanceof Error
                ? error.message
                : "Failed to resolve WhatsApp phone number",
          },
          500,
        );
      }
    }

    if (!phoneNumberId) {
      return c.json(
        { message: "phoneNumberId or phoneNumber is required" },
        400,
      );
    }

    const accountId = `whatsapp-${phoneNumberId}`;

    const [existing] = await db
      .select()
      .from(botChannels)
      .where(
        and(
          eq(botChannels.botId, botId),
          eq(botChannels.channelType, "whatsapp"),
          eq(botChannels.accountId, accountId),
        ),
      );

    if (existing) {
      return c.json({ message: "WhatsApp channel already connected" }, 409);
    }

    const [globalExisting] = await db
      .select()
      .from(webhookRoutes)
      .where(
        and(
          eq(webhookRoutes.channelType, "whatsapp"),
          eq(webhookRoutes.externalId, phoneNumberId),
        ),
      );

    if (globalExisting) {
      return c.json(
        { message: "This WhatsApp number is already connected to another bot" },
        409,
      );
    }

    const channelId = createId();
    const now = new Date().toISOString();

    await db.insert(botChannels).values({
      id: channelId,
      botId,
      channelType: "whatsapp",
      accountId,
      status: "connected",
      channelConfig: JSON.stringify({
        teamName:
          resolvedDisplayPhoneNumber ?? input.phoneNumber ?? phoneNumberId,
        phoneNumberId,
        displayPhoneNumber: resolvedDisplayPhoneNumber,
      }),
      createdAt: now,
      updatedAt: now,
    });

    if (bot.poolId) {
      await db.insert(webhookRoutes).values({
        id: createId(),
        channelType: "whatsapp",
        externalId: phoneNumberId,
        poolId: bot.poolId,
        botChannelId: channelId,
        botId,
        accountId,
        updatedAt: now,
        createdAt: now,
      });
    }

    await publishSnapshotSafely(bot.poolId, bot.id);

    const [channel] = await db
      .select()
      .from(botChannels)
      .where(eq(botChannels.id, channelId));

    if (!channel) {
      throw new Error("Failed to create channel");
    }

    return c.json(formatChannel(channel), 200);
  });

  app.openapi(whatsappLinkStatusRoute, async (c) => {
    const userId = c.get("userId");

    const [identity] = await db
      .select({ waId: whatsappIdentities.waId })
      .from(whatsappIdentities)
      .where(eq(whatsappIdentities.userId, userId));

    const hasBot = await hasConfiguredBot(db, userId);

    return c.json(
      {
        linked: Boolean(identity),
        waId: identity?.waId ?? null,
        officialPhoneNumber: getOfficialWhatsAppPhoneNumber(),
        officialWaLink: getOfficialWhatsAppWaLink(),
        hasBotConfigured: hasBot,
      },
      200,
    );
  });

  app.openapi(claimWhatsAppLinkRoute, async (c) => {
    const userId = c.get("userId");
    const input = c.req.valid("json");
    const now = new Date().toISOString();

    const [tokenRow] = await db
      .select()
      .from(whatsappLinkTokens)
      .where(eq(whatsappLinkTokens.token, input.token));

    if (
      !tokenRow ||
      tokenRow.usedAt ||
      new Date(tokenRow.expiresAt) < new Date()
    ) {
      return c.json({ message: "Invalid or expired WhatsApp link token" }, 400);
    }

    const [alreadyLinkedWa] = await db
      .select({ userId: whatsappIdentities.userId })
      .from(whatsappIdentities)
      .where(eq(whatsappIdentities.waId, tokenRow.waId));

    if (alreadyLinkedWa && alreadyLinkedWa.userId !== userId) {
      return c.json(
        { message: "This WhatsApp account is already linked to another user" },
        409,
      );
    }

    const [existingUserLink] = await db
      .select({ waId: whatsappIdentities.waId })
      .from(whatsappIdentities)
      .where(eq(whatsappIdentities.userId, userId));

    if (existingUserLink && existingUserLink.waId !== tokenRow.waId) {
      return c.json(
        { message: "Your account is already linked to another WhatsApp ID" },
        409,
      );
    }

    await db.transaction(async (tx) => {
      if (existingUserLink) {
        await tx
          .update(whatsappIdentities)
          .set({
            waId: tokenRow.waId,
            status: "linked",
            linkedAt: now,
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(whatsappIdentities.userId, userId));
      } else {
        await tx.insert(whatsappIdentities).values({
          id: createId(),
          waId: tokenRow.waId,
          userId,
          status: "linked",
          linkedAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }

      await tx
        .update(whatsappLinkTokens)
        .set({ usedAt: now, updatedAt: now })
        .where(eq(whatsappLinkTokens.id, tokenRow.id));

      const bot = await findUserPrimaryBot(tx, userId);
      if (bot) {
        await ensureWhatsAppChannelForBot(tx, bot.id, tokenRow.waId);
      }
    });

    const bot = await findUserPrimaryBot(db, userId);
    if (bot?.poolId) {
      await publishSnapshotSafely(bot.poolId, bot.id);
    }

    const hasBot = await hasConfiguredBot(db, userId);

    return c.json(
      {
        linked: true,
        waId: tokenRow.waId,
        officialPhoneNumber: getOfficialWhatsAppPhoneNumber(),
        officialWaLink: getOfficialWhatsAppWaLink(),
        hasBotConfigured: hasBot,
      },
      200,
    );
  });

  app.openapi(unlinkWhatsAppRoute, async (c) => {
    const userId = c.get("userId");

    const [identity] = await db
      .select({ id: whatsappIdentities.id, waId: whatsappIdentities.waId })
      .from(whatsappIdentities)
      .where(eq(whatsappIdentities.userId, userId));

    const bot = await findUserPrimaryBot(db, userId);

    if (!identity) {
      const hasBot = await hasConfiguredBot(db, userId);
      return c.json(
        {
          linked: false,
          waId: null,
          officialPhoneNumber: getOfficialWhatsAppPhoneNumber(),
          officialWaLink: getOfficialWhatsAppWaLink(),
          hasBotConfigured: hasBot,
        },
        200,
      );
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(whatsappIdentities)
        .where(eq(whatsappIdentities.id, identity.id));

      if (bot) {
        const whatsappChannels = await tx
          .select({ id: botChannels.id })
          .from(botChannels)
          .where(
            and(
              eq(botChannels.botId, bot.id),
              eq(botChannels.channelType, "whatsapp"),
            ),
          );

        for (const channel of whatsappChannels) {
          await tx
            .delete(webhookRoutes)
            .where(eq(webhookRoutes.botChannelId, channel.id));

          await tx
            .delete(channelCredentials)
            .where(eq(channelCredentials.botChannelId, channel.id));
        }

        await tx
          .delete(botChannels)
          .where(
            and(
              eq(botChannels.botId, bot.id),
              eq(botChannels.channelType, "whatsapp"),
            ),
          );
      }
    });

    if (bot?.poolId) {
      await publishSnapshotSafely(bot.poolId, bot.id);
    }

    const hasBot = await hasConfiguredBot(db, userId);

    return c.json(
      {
        linked: false,
        waId: null,
        officialPhoneNumber: getOfficialWhatsAppPhoneNumber(),
        officialWaLink: getOfficialWhatsAppWaLink(),
        hasBotConfigured: hasBot,
      },
      200,
    );
  });

  // -- List channels --
  app.openapi(listChannelsRoute, async (c) => {
    const userId = c.get("userId");

    // Find user's bot; if none exists, return empty list
    const [bot] = await db
      .select()
      .from(bots)
      .where(
        and(
          eq(bots.userId, userId),
          or(eq(bots.status, "active"), eq(bots.status, "paused")),
        ),
      );

    if (!bot) {
      return c.json({ channels: [] }, 200);
    }

    const channels = await db
      .select()
      .from(botChannels)
      .where(eq(botChannels.botId, bot.id));

    return c.json({ channels: channels.map(formatChannel) }, 200);
  });

  // -- Disconnect channel --
  app.openapi(disconnectChannelRoute, async (c) => {
    const { channelId } = c.req.valid("param");
    const userId = c.get("userId");

    // Find user's bot
    const [bot] = await db
      .select()
      .from(bots)
      .where(
        and(
          eq(bots.userId, userId),
          or(eq(bots.status, "active"), eq(bots.status, "paused")),
        ),
      );

    if (!bot) {
      return c.json({ message: "Channel not found" }, 404);
    }

    const [channel] = await db
      .select()
      .from(botChannels)
      .where(and(eq(botChannels.id, channelId), eq(botChannels.botId, bot.id)));

    if (!channel) {
      return c.json({ message: `Channel ${channelId} not found` }, 404);
    }

    await db
      .delete(webhookRoutes)
      .where(eq(webhookRoutes.botChannelId, channelId));

    await db
      .delete(channelCredentials)
      .where(eq(channelCredentials.botChannelId, channelId));

    await db.delete(botChannels).where(eq(botChannels.id, channelId));

    await publishSnapshotSafely(bot.poolId, bot.id);

    return c.json({ success: true }, 200);
  });

  // -- Channel status --
  app.openapi(channelStatusRoute, async (c) => {
    const { channelId } = c.req.valid("param");
    const userId = c.get("userId");

    // Find user's bot
    const [bot] = await db
      .select()
      .from(bots)
      .where(
        and(
          eq(bots.userId, userId),
          or(eq(bots.status, "active"), eq(bots.status, "paused")),
        ),
      );

    if (!bot) {
      return c.json({ message: "Channel not found" }, 404);
    }

    const [channel] = await db
      .select()
      .from(botChannels)
      .where(and(eq(botChannels.id, channelId), eq(botChannels.botId, bot.id)));

    if (!channel) {
      return c.json({ message: `Channel ${channelId} not found` }, 404);
    }

    return c.json(formatChannel(channel), 200);
  });
}

// ---------------------------------------------------------------------------
// Slack OAuth callback (unauthenticated — called by browser redirect from Slack)
// ---------------------------------------------------------------------------

export function registerSlackOAuthCallback(app: OpenAPIHono<AppBindings>) {
  app.get("/api/oauth/slack/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const slackError = c.req.query("error");
    const webUrl = process.env.WEB_URL ?? "http://localhost:5173";

    const redirectWithError = (msg: string) => {
      const url = new URL("/workspace/channels/slack/callback", webUrl);
      url.searchParams.set("error", msg);
      return c.redirect(url.toString(), 302);
    };

    // --- 1. Handle Slack-side errors (user denied, etc.) ---
    if (slackError) {
      return redirectWithError(
        slackError === "access_denied"
          ? "You cancelled the Slack authorization"
          : `Slack error: ${slackError}`,
      );
    }

    if (!code || !state) {
      return redirectWithError("Missing authorization code or state parameter");
    }

    // --- 2. Validate state token (CSRF protection) ---
    const [stateRow] = await db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.state, state));

    if (!stateRow) {
      return redirectWithError(
        "Invalid or expired authorization. Please try again.",
      );
    }

    if (stateRow.usedAt) {
      return redirectWithError(
        "This authorization link has already been used.",
      );
    }

    if (new Date(stateRow.expiresAt) < new Date()) {
      return redirectWithError("Authorization expired. Please try again.");
    }

    // --- 3. Mark state as used (prevent replay) ---
    await db
      .update(oauthStates)
      .set({ usedAt: new Date().toISOString() })
      .where(eq(oauthStates.id, stateRow.id));

    const { userId } = stateRow;

    // --- 4. Exchange code for token with Slack ---
    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return redirectWithError("Slack OAuth is not configured on this server");
    }

    let tokenResponse: SlackOAuthV2Response;
    try {
      const resp = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          code,
          redirect_uri: getSlackRedirectUri(),
        }),
      });

      tokenResponse = (await resp.json()) as SlackOAuthV2Response;
    } catch {
      return redirectWithError("Failed to communicate with Slack");
    }

    if (!tokenResponse.ok) {
      return redirectWithError(
        `Slack token exchange failed: ${tokenResponse.error ?? "unknown error"}`,
      );
    }

    const teamId = tokenResponse.team.id;
    const teamName = tokenResponse.team.name;
    const botToken = tokenResponse.access_token;

    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      return redirectWithError(
        "SLACK_SIGNING_SECRET is not configured on this server",
      );
    }

    const accountId = `slack-${teamId}`;

    // --- 5. Find or create the user's default bot ---
    const bot = await findOrCreateDefaultBot(userId);
    const botId = bot.id;

    // --- 6. Create or update the channel connection ---
    const [existing] = await db
      .select()
      .from(botChannels)
      .where(
        and(
          eq(botChannels.botId, botId),
          eq(botChannels.channelType, "slack"),
          eq(botChannels.accountId, accountId),
        ),
      );

    const now = new Date().toISOString();
    let channelId: string;

    if (existing) {
      // Reconnect: update existing channel credentials
      channelId = existing.id;

      await db
        .update(botChannels)
        .set({
          status: "connected",
          channelConfig: JSON.stringify({ teamId, teamName }),
          updatedAt: now,
        })
        .where(eq(botChannels.id, channelId));

      // Replace credentials (delete + re-insert)
      await db
        .delete(channelCredentials)
        .where(eq(channelCredentials.botChannelId, channelId));

      await db.insert(channelCredentials).values([
        {
          id: createId(),
          botChannelId: channelId,
          credentialType: "botToken",
          encryptedValue: encrypt(botToken),
          createdAt: now,
        },
        {
          id: createId(),
          botChannelId: channelId,
          credentialType: "signingSecret",
          encryptedValue: encrypt(signingSecret),
          createdAt: now,
        },
      ]);

      if (bot.poolId) {
        await db
          .update(webhookRoutes)
          .set({
            poolId: bot.poolId,
            accountId,
            botId,
            updatedAt: now,
          })
          .where(eq(webhookRoutes.botChannelId, channelId));
      }
    } else {
      // New connection — check global uniqueness first
      const [globalExisting] = await db
        .select()
        .from(webhookRoutes)
        .where(
          and(
            eq(webhookRoutes.channelType, "slack"),
            eq(webhookRoutes.externalId, teamId),
          ),
        );

      if (globalExisting) {
        return redirectWithError(
          "This Slack workspace is already connected to another bot",
        );
      }

      channelId = createId();

      await db.insert(botChannels).values({
        id: channelId,
        botId,
        channelType: "slack",
        accountId,
        status: "connected",
        channelConfig: JSON.stringify({ teamId, teamName }),
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(channelCredentials).values([
        {
          id: createId(),
          botChannelId: channelId,
          credentialType: "botToken",
          encryptedValue: encrypt(botToken),
          createdAt: now,
        },
        {
          id: createId(),
          botChannelId: channelId,
          credentialType: "signingSecret",
          encryptedValue: encrypt(signingSecret),
          createdAt: now,
        },
      ]);

      if (bot.poolId) {
        await db.insert(webhookRoutes).values({
          id: createId(),
          channelType: "slack",
          externalId: teamId,
          poolId: bot.poolId,
          botChannelId: channelId,
          botId,
          accountId,
          updatedAt: now,
          createdAt: now,
        });
      }
    }

    await publishSnapshotSafely(bot.poolId, botId);

    // --- 7. Cleanup expired states (opportunistic) ---
    await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));

    // --- 8. Redirect to frontend success page ---
    const successUrl = new URL("/workspace/channels/slack/callback", webUrl);
    successUrl.searchParams.set("success", "true");
    successUrl.searchParams.set("channelId", channelId);
    successUrl.searchParams.set("teamName", teamName);
    return c.redirect(successUrl.toString(), 302);
  });
}
