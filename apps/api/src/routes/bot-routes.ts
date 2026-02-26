import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  botListResponseSchema,
  botResponseSchema,
  createBotSchema,
  updateBotSchema,
} from "@nexu/shared";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { bots, gatewayAssignments } from "../db/schema/index.js";
import { findDefaultPool } from "../lib/bot-helpers.js";

import type { AppBindings } from "../types.js";

const errorResponseSchema = z.object({
  message: z.string(),
});

const botIdParam = z.object({
  botId: z.string(),
});

const createBotRoute = createRoute({
  method: "post",
  path: "/v1/bots",
  tags: ["Bots"],
  request: {
    body: { content: { "application/json": { schema: createBotSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: botResponseSchema } },
      description: "Bot created",
    },
    409: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Slug already exists",
    },
  },
});

const listBotsRoute = createRoute({
  method: "get",
  path: "/v1/bots",
  tags: ["Bots"],
  responses: {
    200: {
      content: { "application/json": { schema: botListResponseSchema } },
      description: "Bot list",
    },
  },
});

const getBotRoute = createRoute({
  method: "get",
  path: "/v1/bots/{botId}",
  tags: ["Bots"],
  request: {
    params: botIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: botResponseSchema } },
      description: "Bot details",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Bot not found",
    },
  },
});

const updateBotRoute = createRoute({
  method: "patch",
  path: "/v1/bots/{botId}",
  tags: ["Bots"],
  request: {
    params: botIdParam,
    body: { content: { "application/json": { schema: updateBotSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: botResponseSchema } },
      description: "Bot updated",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Bot not found",
    },
  },
});

const deleteBotRoute = createRoute({
  method: "delete",
  path: "/v1/bots/{botId}",
  tags: ["Bots"],
  request: {
    params: botIdParam,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
      description: "Bot deleted",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Bot not found",
    },
  },
});

const pauseBotRoute = createRoute({
  method: "post",
  path: "/v1/bots/{botId}/pause",
  tags: ["Bots"],
  request: {
    params: botIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: botResponseSchema } },
      description: "Bot paused",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Bot not found",
    },
  },
});

const resumeBotRoute = createRoute({
  method: "post",
  path: "/v1/bots/{botId}/resume",
  tags: ["Bots"],
  request: {
    params: botIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: botResponseSchema } },
      description: "Bot resumed",
    },
    404: {
      content: { "application/json": { schema: errorResponseSchema } },
      description: "Bot not found",
    },
  },
});

function formatBot(
  bot: typeof bots.$inferSelect,
): z.infer<typeof botResponseSchema> {
  return {
    id: bot.id,
    name: bot.name,
    slug: bot.slug,
    status: (bot.status ?? "active") as "active" | "paused" | "deleted",
    modelId: bot.modelId ?? "anthropic/claude-sonnet-4-6",
    systemPrompt: bot.systemPrompt,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  };
}

export function registerBotRoutes(app: OpenAPIHono<AppBindings>) {
  app.openapi(createBotRoute, async (c) => {
    const input = c.req.valid("json");
    const userId = c.get("userId");

    const [existingBot] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.userId, userId), eq(bots.slug, input.slug)));

    if (existingBot) {
      return c.json({ message: "Bot slug already exists" }, 409);
    }

    const poolId = await findDefaultPool();
    const botId = createId();
    const now = new Date().toISOString();

    await db.insert(bots).values({
      id: botId,
      userId,
      name: input.name,
      slug: input.slug,
      systemPrompt: input.systemPrompt,
      modelId: input.modelId,
      poolId,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(gatewayAssignments).values({
      id: createId(),
      botId,
      poolId,
      assignedAt: now,
    });

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) {
      throw new Error("Failed to create bot");
    }

    return c.json(formatBot(bot), 200);
  });

  app.openapi(listBotsRoute, async (c) => {
    const userId = c.get("userId");
    const result = await db
      .select()
      .from(bots)
      .where(
        and(
          eq(bots.userId, userId),
          or(eq(bots.status, "active"), eq(bots.status, "paused")),
        ),
      );

    return c.json({ bots: result.map(formatBot) }, 200);
  });

  app.openapi(getBotRoute, async (c) => {
    const { botId } = c.req.valid("param");
    const userId = c.get("userId");

    const [bot] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, userId)));

    if (!bot) {
      return c.json({ message: `Bot ${botId} not found` }, 404);
    }

    return c.json(formatBot(bot), 200);
  });

  app.openapi(updateBotRoute, async (c) => {
    const { botId } = c.req.valid("param");
    const userId = c.get("userId");
    const input = c.req.valid("json");

    const [bot] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, userId)));

    if (!bot) {
      return c.json({ message: `Bot ${botId} not found` }, 404);
    }

    const now = new Date().toISOString();
    await db
      .update(bots)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.systemPrompt !== undefined && {
          systemPrompt: input.systemPrompt,
        }),
        ...(input.modelId !== undefined && { modelId: input.modelId }),
        updatedAt: now,
      })
      .where(eq(bots.id, botId));

    const [updated] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!updated) {
      throw new Error("Failed to update bot");
    }

    return c.json(formatBot(updated), 200);
  });

  app.openapi(deleteBotRoute, async (c) => {
    const { botId } = c.req.valid("param");
    const userId = c.get("userId");

    const [bot] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, userId)));

    if (!bot) {
      return c.json({ message: `Bot ${botId} not found` }, 404);
    }

    await db
      .delete(gatewayAssignments)
      .where(eq(gatewayAssignments.botId, botId));

    await db
      .update(bots)
      .set({ status: "deleted", updatedAt: new Date().toISOString() })
      .where(eq(bots.id, botId));

    return c.json({ success: true }, 200);
  });

  app.openapi(pauseBotRoute, async (c) => {
    const { botId } = c.req.valid("param");
    const userId = c.get("userId");

    const [bot] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, userId)));

    if (!bot) {
      return c.json({ message: `Bot ${botId} not found` }, 404);
    }

    await db
      .update(bots)
      .set({ status: "paused", updatedAt: new Date().toISOString() })
      .where(eq(bots.id, botId));

    const [updated] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!updated) {
      throw new Error("Failed to pause bot");
    }

    return c.json(formatBot(updated), 200);
  });

  app.openapi(resumeBotRoute, async (c) => {
    const { botId } = c.req.valid("param");
    const userId = c.get("userId");

    const [bot] = await db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, userId)));

    if (!bot) {
      return c.json({ message: `Bot ${botId} not found` }, 404);
    }

    await db
      .update(bots)
      .set({ status: "active", updatedAt: new Date().toISOString() })
      .where(eq(bots.id, botId));

    const [updated] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!updated) {
      throw new Error("Failed to resume bot");
    }

    return c.json(formatBot(updated), 200);
  });
}
