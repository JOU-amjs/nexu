import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  sharedSlackClaimResponseSchema,
  sharedSlackClaimSchema,
} from "@nexu/shared";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { slackUserClaims, users } from "../db/schema/index.js";
import type { AppBindings } from "../types.js";

const sharedSlackClaimRoute = createRoute({
  method: "post",
  path: "/api/v1/shared-slack/claim",
  tags: ["Shared Slack App"],
  request: {
    body: {
      content: { "application/json": { schema: sharedSlackClaimSchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: sharedSlackClaimResponseSchema },
      },
      description: "Shared Slack user identity claimed",
    },
  },
});

export function registerSharedSlackClaimRoutes(app: OpenAPIHono<AppBindings>) {
  app.openapi(sharedSlackClaimRoute, async (c) => {
    const authUserId = c.get("userId");
    const input = c.req.valid("json");
    const now = new Date().toISOString();

    let [appUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.authUserId, authUserId));

    if (!appUser) {
      await db.insert(users).values({
        id: createId(),
        authUserId,
        inviteAcceptedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      [appUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.authUserId, authUserId));
    }

    await db
      .insert(slackUserClaims)
      .values({
        id: createId(),
        teamId: input.teamId,
        teamName: input.teamName ?? null,
        slackUserId: input.slackUserId,
        authUserId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [slackUserClaims.teamId, slackUserClaims.slackUserId],
        set: {
          teamName: input.teamName ?? null,
          authUserId,
          updatedAt: now,
        },
      });

    const detail = JSON.stringify({
      teamId: input.teamId,
      teamName: input.teamName ?? null,
      slackUserId: input.slackUserId,
    });
    await db
      .update(users)
      .set({
        authSource: "slack_shared_claim",
        authSourceDetail: detail,
        updatedAt: now,
      })
      .where(eq(users.authUserId, authUserId));

    return c.json({ ok: true, orgAuthorized: true }, 200);
  });
}
