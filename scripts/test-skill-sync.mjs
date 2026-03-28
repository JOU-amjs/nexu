#!/usr/bin/env node

/**
 * Skill Config Sync — Manual Test Inspector
 *
 * Usage:
 *   node scripts/test-skill-sync.mjs              # Show all diagnostics
 *   node scripts/test-skill-sync.mjs ledger        # Show ledger only
 *   node scripts/test-skill-sync.mjs config        # Show config skills only
 *   node scripts/test-skill-sync.mjs workspace     # Show workspace skills on disk
 *   node scripts/test-skill-sync.mjs watch         # Watch config for changes
 *   node scripts/test-skill-sync.mjs create-ws     # Create a test workspace skill
 *   node scripts/test-skill-sync.mjs create-zip    # Create a test custom skill zip
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const HOME = homedir();
const NEXU_HOME = join(HOME, ".nexu");
const OPENCLAW_STATE = join(
  HOME,
  "Library",
  "Application Support",
  "@nexu",
  "desktop",
  "runtime",
  "openclaw",
  "state",
);
const OPENCLAW_CONFIG = join(OPENCLAW_STATE, "openclaw.json");
const LEDGER = join(NEXU_HOME, "skill-ledger.json");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function heading(text) {
  console.log(`\n${BOLD}${CYAN}═══ ${text} ═══${RESET}\n`);
}

function ok(text) {
  console.log(`  ${GREEN}✓${RESET} ${text}`);
}

function warn(text) {
  console.log(`  ${YELLOW}⚠${RESET} ${text}`);
}

function fail(text) {
  console.log(`  ${RED}✗${RESET} ${text}`);
}

function dim(text) {
  console.log(`  ${DIM}${text}${RESET}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ── Ledger ──

function showLedger() {
  heading("Skill Ledger");
  dim(LEDGER);

  if (!existsSync(LEDGER)) {
    warn("No ledger file — fresh install or pre-SkillHub version");
    return;
  }

  const data = readJson(LEDGER);
  if (!data?.skills) {
    fail("Ledger file exists but cannot be parsed");
    return;
  }

  const installed = data.skills.filter((s) => s.status === "installed");
  const uninstalled = data.skills.filter((s) => s.status === "uninstalled");
  const shared = installed.filter((s) => s.source !== "workspace");
  const workspace = installed.filter((s) => s.source === "workspace");

  if (installed.length === 0) {
    warn("Ledger is empty (0 installed skills)");
    return;
  }

  console.log(`  Shared skills (${shared.length}):`);
  for (const s of shared) {
    ok(
      `${s.slug} ${DIM}[${s.source}] installed ${s.installedAt ?? "?"}${RESET}`,
    );
  }

  if (workspace.length > 0) {
    console.log(`\n  Workspace skills (${workspace.length}):`);
    for (const s of workspace) {
      ok(
        `${s.slug} ${DIM}[agent: ${s.agentId}] installed ${s.installedAt ?? "?"}${RESET}`,
      );
    }
  }

  if (uninstalled.length > 0) {
    console.log(`\n  Uninstalled (${uninstalled.length}):`);
    for (const s of uninstalled) {
      dim(`${s.slug} [${s.source}]`);
    }
  }
}

// ── Config ──

function showConfig() {
  heading("OpenClaw Config — Agent Skills");
  dim(OPENCLAW_CONFIG);

  if (!existsSync(OPENCLAW_CONFIG)) {
    fail("Config file not found — is the app running?");
    return;
  }

  const data = readJson(OPENCLAW_CONFIG);
  if (!data?.agents?.list) {
    fail("Config exists but agents.list missing");
    return;
  }

  for (const agent of data.agents.list) {
    const label = `${agent.name ?? agent.id}${agent.default ? " (default)" : ""}`;
    if (!agent.skills) {
      warn(
        `${label}: skills field omitted — all skills auto-discovered (legacy mode)`,
      );
    } else if (agent.skills.length === 0) {
      fail(`${label}: skills = [] — agent has NO skills!`);
    } else {
      ok(`${label}: ${agent.skills.length} skills`);
      for (const slug of agent.skills) {
        dim(`  → ${slug}`);
      }
    }
  }
}

// ── Workspace ──

function showWorkspace() {
  heading("Workspace Skills on Disk");
  dim(join(OPENCLAW_STATE, "agents", "*", "skills", "*", "SKILL.md"));

  const agentsDir = join(OPENCLAW_STATE, "agents");
  if (!existsSync(agentsDir)) {
    warn("No agents directory — no workspace skills possible");
    return;
  }

  let found = 0;
  for (const agentEntry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agentEntry.isDirectory()) continue;
    const skillsDir = join(agentsDir, agentEntry.name, "skills");
    if (!existsSync(skillsDir)) continue;

    for (const skillEntry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skillEntry.isDirectory() && !skillEntry.isSymbolicLink()) continue;
      const skillMd = join(skillsDir, skillEntry.name, "SKILL.md");
      if (existsSync(skillMd)) {
        ok(`Agent ${agentEntry.name}: ${skillEntry.name}`);
        found++;
      }
    }
  }

  if (found === 0) {
    warn("No workspace skills found on disk");
  }
}

// ── Watch ──

function watchConfig() {
  heading("Watching config for changes (Ctrl+C to stop)");
  dim(OPENCLAW_CONFIG);

  if (!existsSync(OPENCLAW_CONFIG)) {
    fail("Config file not found");
    return;
  }

  console.log(`  Waiting for changes...\n`);
  watch(dirname(OPENCLAW_CONFIG), (event, filename) => {
    if (filename === basename(OPENCLAW_CONFIG)) {
      const now = new Date().toISOString().slice(11, 19);
      ok(`${now} — config file ${event}`);
    }
  });
}

// ── Create test workspace skill ──

function createWorkspaceSkill() {
  heading("Create Test Workspace Skill");

  const config = readJson(OPENCLAW_CONFIG);
  if (!config?.agents?.list?.length) {
    fail("No agents found in config — start the app first");
    return;
  }

  const agent = config.agents.list[0];
  const botId = agent.id;
  const slug = "test-ws-skill";
  const dir = join(OPENCLAW_STATE, "agents", botId, "skills", slug);

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${slug}\ndescription: Test workspace skill for manual QA\n---\nYou are a test workspace skill. Respond with "Workspace skill working!"\n`,
  );

  ok(`Created: ${dir}/SKILL.md`);
  ok(`Agent: ${agent.name} (${botId})`);
  console.log(`\n  ${BOLD}Next steps:${RESET}`);
  dim("1. Restart the app to trigger reconciliation");
  dim(`2. Run: node scripts/test-skill-sync.mjs`);
  dim(
    "3. Check that the skill appears in ledger (source: workspace) and config",
  );
}

// ── Create test custom zip ──

function createCustomZip() {
  heading("Create Test Custom Skill Zip");

  const slug = "my-custom-skill";
  const dir = `/tmp/test-skill/${slug}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${slug}\ndescription: A test custom skill for manual QA\n---\nYou are a custom test skill. Respond with "Custom skill working!"\n`,
  );

  ok(`Created: ${dir}/SKILL.md`);
  console.log(`\n  ${BOLD}Next steps:${RESET}`);
  dim(`1. Run: cd /tmp/test-skill && zip -r ${slug}.zip ${slug}/`);
  dim(`2. Open app UI → Skills → Import → upload /tmp/test-skill/${slug}.zip`);
  dim(`3. Run: node scripts/test-skill-sync.mjs`);
}

// ── Main ──

const command = process.argv[2];

switch (command) {
  case "ledger":
    showLedger();
    break;
  case "config":
    showConfig();
    break;
  case "workspace":
    showWorkspace();
    break;
  case "watch":
    watchConfig();
    break;
  case "create-ws":
    createWorkspaceSkill();
    break;
  case "create-zip":
    createCustomZip();
    break;
  default:
    // Show all diagnostics
    showLedger();
    showConfig();
    showWorkspace();

    heading("Quick Commands");
    dim(
      "node scripts/test-skill-sync.mjs watch      — Watch config for changes",
    );
    dim(
      "node scripts/test-skill-sync.mjs create-ws   — Create test workspace skill",
    );
    dim(
      "node scripts/test-skill-sync.mjs create-zip  — Create test custom skill zip",
    );
    break;
}
