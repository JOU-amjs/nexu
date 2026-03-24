#!/usr/bin/env node

/**
 * Send a Feishu interactive card notification via incoming webhook.
 *
 * Environment variables:
 *   WEBHOOK_URL        — Feishu bot webhook URL
 *   EVENT_TYPE         — "issue" or "discussion"
 *   TITLE              — Event title
 *   URL                — Event HTML URL
 *   NUMBER             — Event number
 *   AUTHOR             — Event author login
 *   BODY               — Event body (may be empty)
 *   LABELS_OR_CATEGORY — Comma-separated labels or discussion category name
 *   REPO               — owner/repo
 */

const webhookUrl = process.env.WEBHOOK_URL;
const eventType = process.env.EVENT_TYPE ?? "issue";
const title = process.env.TITLE ?? "";
const url = process.env.URL ?? "";
const number = process.env.NUMBER ?? "";
const author = process.env.AUTHOR ?? "";
const body = process.env.BODY ?? "";
const labelsOrCategory = process.env.LABELS_OR_CATEGORY || "none";
const repo = process.env.REPO ?? "";

if (!webhookUrl) {
  console.error("WEBHOOK_URL is required");
  process.exit(1);
}

const isDiscussion = eventType === "discussion";
const typeLabel = isDiscussion ? "Discussion" : "Issue";
const headerColor = isDiscussion ? "turquoise" : "orange";
const metaLabel = isDiscussion ? "Category" : "Labels";

const bodySnippet =
  body.length > 200 ? `${body.slice(0, 200)}...` : body || "(no description)";

const payload = {
  msg_type: "interactive",
  card: {
    schema: "2.0",
    header: {
      title: {
        tag: "plain_text",
        content: `[${repo}] New ${typeLabel} #${number}: ${title}`,
      },
      template: headerColor,
    },
    body: {
      direction: "vertical",
      elements: [
        { tag: "markdown", content: `**Author:** ${author}` },
        { tag: "markdown", content: `**${metaLabel}:** ${labelsOrCategory}` },
        { tag: "markdown", content: bodySnippet },
        {
          tag: "button",
          text: { tag: "plain_text", content: `View ${typeLabel}` },
          url,
          type: "primary",
        },
      ],
    },
  },
};

const response = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  const text = await response.text();
  console.error(`Webhook request failed (${response.status}): ${text}`);
  process.exit(1);
}
