import { logger } from "../lib/logger.js";

/**
 * Post a Slack DM to a user using the bot token (direct API call, no gateway).
 *
 * Opens a DM conversation with the user first (conversations.open),
 * then sends the message to that DM channel.
 */
async function postSlackDM(
  botToken: string,
  slackUserId: string,
  text: string,
): Promise<void> {
  // 1. Open a DM channel with the user
  const openResp = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users: slackUserId }),
  });

  const openData = (await openResp.json()) as {
    ok: boolean;
    channel?: { id: string };
    error?: string;
  };
  if (!openData.ok || !openData.channel) {
    logger.warn({
      message: "onboarding_dm_open_failed",
      slack_user_id: slackUserId,
      error: openData.error,
    });
    return;
  }

  const dmChannelId = openData.channel.id;

  // 2. Send the message to the DM channel
  const postResp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: dmChannelId, text }),
  });

  const postData = (await postResp.json()) as { ok: boolean; error?: string };
  if (!postData.ok) {
    logger.warn({
      message: "onboarding_dm_post_failed",
      slack_user_id: slackUserId,
      dm_channel_id: dmChannelId,
      error: postData.error,
    });
  }
}

/**
 * Send a linking prompt DM to an unlinked Slack user.
 *
 * Always sent as a private DM (not in the original channel) so that:
 * - The one-time link token is not exposed in public channels
 * - Other users in the channel are not spammed with linking prompts
 */
export async function sendLinkingPrompt(
  botToken: string,
  slackUserId: string,
  linkUrl: string,
): Promise<void> {
  const text = [
    "Hi! I'm Nexu, your AI assistant. :wave:",
    "",
    "To get started, please link your Nexu account:",
    "",
    `<${linkUrl}|Link your account>`,
    "",
    "_This link is unique to you — please do not share it with others._",
  ].join("\n");

  await postSlackDM(botToken, slackUserId, text);
}

/**
 * Send an onboarding reply to a user in an unregistered workspace.
 *
 * This is for the case where the workspace is installed but the installer
 * hasn't registered a Nexu account yet (nexuUserId is null on the installation).
 */
export async function sendOnboardingReply(
  botToken: string,
  slackUserId: string,
): Promise<void> {
  const webUrl = process.env.WEB_URL ?? "http://localhost:5173";

  const text = [
    "Hi! I'm Nexu, your AI assistant. :wave:",
    "",
    "It looks like this workspace hasn't been fully set up yet. " +
      "To get started, please register your Nexu account:",
    "",
    `<${webUrl}|Register here>`,
    "",
    "Once you're registered, I'll be fully operational and ready to help!",
  ].join("\n");

  await postSlackDM(botToken, slackUserId, text);
}
