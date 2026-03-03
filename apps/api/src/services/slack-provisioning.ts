import { createId } from "@paralleldrive/cuid2";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import {
  botChannels,
  bots,
  channelCredentials,
  gatewayAssignments,
  gatewayPools,
  slackInstallations,
  webhookRoutes,
} from "../db/schema/index.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { ServiceError } from "../lib/error.js";
import { logger } from "../lib/logger.js";
import { publishPoolConfigSnapshot } from "./runtime/pool-config-service.js";

interface ProvisionResult {
  botId: string;
  botChannelId: string;
  poolId: string;
  accountId: string;
}

/**
 * Provision a workspace agent for a Slack installation.
 *
 * Creates (or reuses) a bot, botChannel, credentials, and webhook route
 * so that the workspace is fully configured to receive Slack events
 * through the OpenClaw gateway.
 */
export async function provisionWorkspaceAgent(
  db: Database,
  installation: typeof slackInstallations.$inferSelect,
): Promise<ProvisionResult> {
  const { teamId, teamName, appId, botToken } = installation;
  const slug = `slack-ws-${teamId.toLowerCase()}`;
  const accountId = `slack-${appId}-${teamId}`;
  const slackExternalId = `${teamId}:${appId}`;
  const now = new Date().toISOString();

  // 1. Find or assign a pool
  let poolId = installation.poolId;
  if (!poolId) {
    const pools = await db
      .select()
      .from(gatewayPools)
      .where(eq(gatewayPools.status, "active"));

    const pool = pools.find((p) => p.podIp) ?? pools[0];
    if (!pool) {
      throw ServiceError.from("slack-provisioning", {
        code: "no_active_pool",
        team_id: teamId,
      });
    }
    poolId = pool.id;
  }

  // 2. Find or create a bot for this workspace
  const [existingBot] = await db
    .select()
    .from(bots)
    .where(eq(bots.slug, slug));

  let botId: string;

  if (existingBot) {
    botId = existingBot.id;
    // Ensure it's active and assigned to the right pool
    await db
      .update(bots)
      .set({ status: "active", poolId, updatedAt: now })
      .where(eq(bots.id, botId));
  } else {
    botId = createId();
    // Use a system user ID for auto-provisioned bots
    const systemUserId = "system-slack-oauth";

    await db.insert(bots).values({
      id: botId,
      userId: systemUserId,
      name: teamName,
      slug,
      modelId: process.env.DEFAULT_MODEL_ID ?? "anthropic/claude-sonnet-4",
      poolId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // Create gateway assignment
    await db.insert(gatewayAssignments).values({
      id: createId(),
      botId,
      poolId,
      assignedAt: now,
    });
  }

  // 3. Create or update botChannel
  const [existingChannel] = await db
    .select()
    .from(botChannels)
    .where(
      and(
        eq(botChannels.botId, botId),
        eq(botChannels.channelType, "slack"),
        eq(botChannels.accountId, accountId),
      ),
    );

  let botChannelId: string;

  if (existingChannel) {
    botChannelId = existingChannel.id;
    await db
      .update(botChannels)
      .set({
        status: "connected",
        channelConfig: JSON.stringify({ teamId, teamName, appId }),
        updatedAt: now,
      })
      .where(eq(botChannels.id, botChannelId));

    // Replace credentials
    await db
      .delete(channelCredentials)
      .where(eq(channelCredentials.botChannelId, botChannelId));
  } else {
    botChannelId = createId();
    await db.insert(botChannels).values({
      id: botChannelId,
      botId,
      channelType: "slack",
      accountId,
      status: "connected",
      channelConfig: JSON.stringify({ teamId, teamName, appId }),
      createdAt: now,
      updatedAt: now,
    });
  }

  // 4. Store credentials (botToken is already encrypted in slackInstallations — decrypt first)
  const plainBotToken = decrypt(botToken);
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";

  await db.insert(channelCredentials).values([
    {
      id: createId(),
      botChannelId,
      credentialType: "botToken",
      encryptedValue: encrypt(plainBotToken),
      createdAt: now,
    },
    {
      id: createId(),
      botChannelId,
      credentialType: "signingSecret",
      encryptedValue: encrypt(signingSecret),
      createdAt: now,
    },
  ]);

  // 5. Create or update webhook route
  const [existingRoute] = await db
    .select()
    .from(webhookRoutes)
    .where(
      and(
        eq(webhookRoutes.channelType, "slack"),
        eq(webhookRoutes.externalId, slackExternalId),
      ),
    );

  if (existingRoute) {
    await db
      .update(webhookRoutes)
      .set({
        poolId,
        botChannelId,
        botId,
        accountId,
        updatedAt: now,
      })
      .where(eq(webhookRoutes.id, existingRoute.id));
  } else {
    await db.insert(webhookRoutes).values({
      id: createId(),
      channelType: "slack",
      externalId: slackExternalId,
      poolId,
      botChannelId,
      botId,
      accountId,
      createdAt: now,
      updatedAt: now,
    });
  }

  // 6. Update installation record with bot/pool references
  await db
    .update(slackInstallations)
    .set({ botId, poolId, updatedAt: now })
    .where(eq(slackInstallations.id, installation.id));

  // 7. Publish config snapshot so gateway picks up the new agent
  try {
    await publishPoolConfigSnapshot(db, poolId);
  } catch (err) {
    logger.warn({
      message: "slack_provision_snapshot_failed",
      team_id: teamId,
      pool_id: poolId,
      error: String(err),
    });
  }

  logger.info({
    message: "slack_workspace_provisioned",
    team_id: teamId,
    team_name: teamName,
    bot_id: botId,
    pool_id: poolId,
    account_id: accountId,
  });

  return { botId, botChannelId, poolId, accountId };
}
