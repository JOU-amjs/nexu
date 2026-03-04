import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type StatusEntry = {
  code: string;
  filePath: string;
  raw: string;
};

const reportPath = process.env.DB_MIGRATION_SYNC_REPORT_PATH;
const baseRef = process.env.DB_MIGRATION_BASE_REF;
const eventName = process.env.DB_MIGRATION_EVENT_NAME;

async function writeReport(content: string) {
  if (!reportPath) {
    return;
  }

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, content, "utf8");
}

function runCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseStatusLine(line: string): StatusEntry | null {
  if (line.length < 4) {
    return null;
  }

  const code = line.slice(0, 2);
  const filePath = line.slice(3).trim();

  if (!filePath) {
    return null;
  }

  return {
    code,
    filePath,
    raw: line,
  };
}

function getPullRequestChangedMigrationFiles(): string[] {
  if (eventName !== "pull_request" || !baseRef) {
    return [];
  }

  const diffResult = runCommand("git", [
    "diff",
    "--name-only",
    `origin/${baseRef}...HEAD`,
    "--",
    "migrations",
  ]);

  if (diffResult.status !== 0) {
    return [];
  }

  return diffResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formatFailureReport(
  entries: StatusEntry[],
  pullRequestChangedMigrations: string[],
): string {
  const untracked = entries.filter((entry) => entry.code === "??");
  const tracked = entries.filter((entry) => entry.code !== "??");
  const hasMigrationChangesInPr = pullRequestChangedMigrations.length > 0;

  const lines: string[] = [
    "### Migration Sync Check Failed",
    "",
    "`drizzle-kit generate` produced changes under `apps/api/migrations` that are not fully reflected in this PR.",
    "",
    "**Detected reasons**",
  ];

  if (untracked.length > 0 && !hasMigrationChangesInPr) {
    lines.push(
      "- Missing migration files in PR: schema changed but no generated migration updates were committed.",
    );
  }

  if (untracked.length > 0 && hasMigrationChangesInPr) {
    lines.push(
      "- Migration files and schema are inconsistent: this PR includes migration edits, but `drizzle-kit generate` still creates additional artifacts.",
    );
  }

  if (tracked.length > 0 && untracked.length === 0) {
    lines.push(
      "- Generated migration output differs from committed files (metadata or SQL drift).",
    );
  }

  if (hasMigrationChangesInPr) {
    lines.push("", "**Migration files changed in this PR**");
    for (const filePath of pullRequestChangedMigrations) {
      lines.push(`- ${filePath}`);
    }
  }

  lines.push("", "**Locations**");

  for (const entry of entries) {
    lines.push(`- ${entry.raw}`);
  }

  lines.push(
    "",
    "**How to fix**",
    "1. Run `pnpm --filter @nexu/api db:generate`.",
    "2. Stage generated files: `git add apps/api/migrations`.",
    "3. Commit and push.",
  );

  return lines.join("\n");
}

async function main() {
  const generateResult = runCommand("pnpm", ["db:generate"]);

  if (generateResult.stdout) {
    process.stdout.write(generateResult.stdout);
  }

  if (generateResult.status !== 0) {
    if (generateResult.stderr) {
      process.stderr.write(generateResult.stderr);
    }

    const message = [
      "### Migration Sync Check Failed",
      "",
      "`pnpm db:generate` failed before sync validation could run.",
      "",
      "```text",
      generateResult.stderr.trim() || "Unknown drizzle generation error",
      "```",
    ].join("\n");

    await writeReport(message);
    process.exitCode = 1;
    return;
  }

  const statusResult = runCommand("git", [
    "status",
    "--porcelain",
    "--",
    "migrations",
  ]);

  if (statusResult.status !== 0) {
    if (statusResult.stderr) {
      process.stderr.write(statusResult.stderr);
    }

    const message = [
      "### Migration Sync Check Failed",
      "",
      "Unable to inspect git status for migration files.",
      "",
      "```text",
      statusResult.stderr.trim() || "Unknown git status error",
      "```",
    ].join("\n");

    await writeReport(message);
    process.exitCode = 1;
    return;
  }

  const entries = statusResult.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map(parseStatusLine)
    .filter((entry): entry is StatusEntry => entry !== null);

  const pullRequestChangedMigrations = getPullRequestChangedMigrationFiles();

  if (entries.length === 0) {
    const success =
      "### Migration Sync Check Passed\n\nSchema and migration files are in sync.";
    await writeReport(success);
    console.log("Migration sync check passed.");
    return;
  }

  const report = formatFailureReport(entries, pullRequestChangedMigrations);
  await writeReport(report);
  console.error(report);
  process.exitCode = 1;
}

await main();
