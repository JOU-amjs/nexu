#!/usr/bin/env node

import { createGitHubIssueClient } from "./lib/github-client.mjs";

const ghToken = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const issueNumber = process.env.ISSUE_NUMBER;

if (!ghToken || !repo || !issueNumber) {
  console.error(
    "Missing required env: GITHUB_TOKEN, GITHUB_REPOSITORY, ISSUE_NUMBER",
  );
  process.exit(1);
}

const github = createGitHubIssueClient({
  token: ghToken,
  repo,
  issueNumber,
});

console.log(`Handling assignment for issue #${issueNumber}`);
await github.removeLabel("needs-triage");
console.log("Done.");
