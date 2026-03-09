import { describe, expect, it } from "vitest";
import { buildSlackSessionKey } from "../slack-events.js";

describe("buildSlackSessionKey", () => {
  it("builds canonical channel session keys", () => {
    expect(
      buildSlackSessionKey({
        botId: "Bot-Test-1",
        channelId: "C0AJKG60H6D",
        isIm: false,
      }),
    ).toBe("agent:bot-test-1:slack:channel:c0ajkg60h6d");
  });

  it("builds canonical channel thread session keys", () => {
    expect(
      buildSlackSessionKey({
        botId: "Bot-Test-1",
        channelId: "C0AJKG60H6D",
        threadTs: "1770408518.451689",
        isIm: false,
      }),
    ).toBe(
      "agent:bot-test-1:slack:channel:c0ajkg60h6d:thread:1770408518.451689",
    );
  });

  it("collapses DMs to the main session key", () => {
    expect(
      buildSlackSessionKey({
        botId: "Bot-Test-1",
        channelId: "D0AJKG60H6D",
        isIm: true,
      }),
    ).toBe("agent:bot-test-1:main");
  });

  it("isolates DMs by Slack user id when available", () => {
    expect(
      buildSlackSessionKey({
        botId: "Bot-Test-1",
        channelId: "D0AJKG60H6D",
        isIm: true,
        dmUserId: "U0AHLMC6C8G",
      }),
    ).toBe("agent:bot-test-1:main:user:u0ahlmc6c8g");
  });

  it("appends thread ids to DM main session keys", () => {
    expect(
      buildSlackSessionKey({
        botId: "Bot-Test-1",
        channelId: "D0AJKG60H6D",
        threadTs: "1770408518.451689",
        isIm: true,
      }),
    ).toBe("agent:bot-test-1:main:thread:1770408518.451689");
  });
});
