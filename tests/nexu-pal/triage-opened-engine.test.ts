import { describe, expect, it, vi } from "vitest";
import {
  buildOpenedIssueTriagePlan,
  createTriagePlan,
} from "../../scripts/nexu-pal/lib/triage-opened-engine.mjs";

describe("createTriagePlan", () => {
  it("returns the stable triage plan shape", () => {
    expect(createTriagePlan()).toEqual({
      labelsToAdd: [],
      labelsToRemove: [],
      commentsToAdd: [],
      closeIssue: false,
      diagnostics: [],
    });
  });
});

describe("buildOpenedIssueTriagePlan", () => {
  it("returns a full plan with stub diagnostics and bug-only labeling", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          is_non_english: false,
          detected_language: null,
          translated_title: "App crashes on launch",
          translated_body: "Steps to reproduce...",
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          is_bug: true,
          reason: "clear broken behavior",
        }),
      );

    const plan = await buildOpenedIssueTriagePlan({
      issueTitle: "App crashes on launch",
      issueBody: "Steps to reproduce...",
      issueAssignee: "",
      chat,
    });

    expect(plan).toMatchObject({
      labelsToAdd: ["bug", "needs-triage"],
      labelsToRemove: [],
      commentsToAdd: [],
      closeIssue: false,
    });
    expect(plan.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining("roadmap matcher stub"),
        expect.stringContaining("duplicate detector stub"),
        "bug classification: clear broken behavior",
      ]),
    );
  });
});
