import { existsSync, readdirSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type { SkillDb } from "./skill-db.js";
import type { SkillSource } from "./types.js";

export type SkillDirWatcherLogFn = (
  level: "info" | "warn" | "error",
  message: string,
) => void;

const defaultLog: SkillDirWatcherLogFn = () => {};

export class SkillDirWatcher {
  private readonly skillsDir: string;
  private readonly db: SkillDb;
  private readonly log: SkillDirWatcherLogFn;
  private readonly debounceMs: number;
  private readonly isSlugInFlight: (slug: string) => boolean;
  private readonly openclawStateDir: string | null;
  private botIds: readonly string[];
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    skillsDir: string;
    skillDb: SkillDb;
    log?: SkillDirWatcherLogFn;
    debounceMs?: number;
    /** Returns true if the slug is currently being installed by the queue. */
    isSlugInFlight?: (slug: string) => boolean;
    /** Root of the OpenClaw state directory (contains agents/<botId>/skills/). */
    openclawStateDir?: string;
    /** Bot IDs whose workspace skill directories should be reconciled. */
    botIds?: readonly string[];
  }) {
    this.skillsDir = opts.skillsDir;
    this.db = opts.skillDb;
    this.log = opts.log ?? defaultLog;
    this.debounceMs = opts.debounceMs ?? 500;
    this.isSlugInFlight = opts.isSlugInFlight ?? (() => false);
    this.openclawStateDir = opts.openclawStateDir ?? null;
    this.botIds = opts.botIds ?? [];
  }

  setBotIds(botIds: readonly string[]): void {
    this.botIds = botIds;
  }

  syncNow(): void {
    this.syncSharedDir();
    this.syncWorkspaceDirs();
  }

  private syncSharedDir(): void {
    if (!existsSync(this.skillsDir)) {
      return;
    }

    const diskSlugs = this.scanDirSlugs(this.skillsDir);
    if (diskSlugs === null) {
      this.log("warn", "sync: directory scan failed, skipping reconciliation");
      return;
    }
    const diskSet = new Set(diskSlugs);

    // Only consider non-workspace skills for shared-dir reconciliation
    const installed = this.db
      .getAllInstalled()
      .filter((r) => r.source !== "workspace");
    const installedSlugs = new Set(installed.map((r) => r.slug));

    // Disk has it, ledger doesn't -> record as managed
    // Skip slugs currently in the install queue — the queue will record with the correct source.
    const added = diskSlugs.filter(
      (slug) => !installedSlugs.has(slug) && !this.isSlugInFlight(slug),
    );
    if (added.length > 0) {
      this.db.recordBulkInstall(added, "managed");
      this.log(
        "info",
        `Synced ${added.length} new skill(s) from disk: ${added.join(", ")}`,
      );
    }

    // Ledger has it, disk doesn't -> mark as uninstalled (preserves user's install history).
    const missing = installed.filter((r) => !diskSet.has(r.slug));
    const missingBySource = new Map<SkillSource, string[]>();

    for (const record of missing) {
      const list = missingBySource.get(record.source) ?? [];
      list.push(record.slug);
      missingBySource.set(record.source, list);
    }

    for (const [source, slugs] of missingBySource) {
      this.db.markUninstalledBySlugs(slugs, source);
      this.log(
        "info",
        `Marked ${slugs.length} ${source} skill(s) as uninstalled: ${slugs.join(", ")}`,
      );
    }
  }

  private syncWorkspaceDirs(): void {
    if (!this.openclawStateDir || this.botIds.length === 0) return;

    for (const botId of this.botIds) {
      const wsSkillsDir = resolve(
        this.openclawStateDir,
        "agents",
        botId,
        "skills",
      );

      const diskSlugs = existsSync(wsSkillsDir)
        ? this.scanDirSlugs(wsSkillsDir)
        : [];
      if (diskSlugs === null) continue;

      const diskSet = new Set(diskSlugs);
      const ledgerWs = this.db.getInstalledByAgent(botId);
      const ledgerSlugs = new Set(ledgerWs.map((r) => r.slug));

      // Disk has it, ledger doesn't → record as workspace
      const added = diskSlugs.filter((slug) => !ledgerSlugs.has(slug));
      for (const slug of added) {
        this.db.recordInstall(slug, "workspace", undefined, botId);
      }
      if (added.length > 0) {
        this.log(
          "info",
          `Agent ${botId}: synced ${added.length} workspace skill(s): ${added.join(", ")}`,
        );
      }

      // Ledger has it, disk doesn't → mark uninstalled
      const missingSlugs = ledgerWs
        .filter((r) => !diskSet.has(r.slug))
        .map((r) => r.slug);
      if (missingSlugs.length > 0) {
        this.db.markUninstalledBySlugs(missingSlugs, "workspace");
        this.log(
          "info",
          `Agent ${botId}: marked ${missingSlugs.length} workspace skill(s) as uninstalled`,
        );
      }
    }
  }

  start(): void {
    if (this.watcher !== null) {
      return;
    }

    if (!existsSync(this.skillsDir)) {
      this.log(
        "warn",
        `Skills directory does not exist, skipping watch: ${this.skillsDir}`,
      );
      return;
    }

    this.watcher = watch(
      this.skillsDir,
      { recursive: true },
      (_event, filename) => {
        if (filename?.endsWith("SKILL.md")) {
          this.scheduleSync();
        }
      },
    );

    this.watcher.on("error", (err: unknown) => {
      this.log(
        "error",
        `Watcher error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    this.log("info", `Watching skills directory: ${this.skillsDir}`);
  }

  stop(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleSync(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.syncNow();
    }, this.debounceMs);
  }

  private scanDirSlugs(dir: string): string[] | null {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(resolve(dir, entry.name, "SKILL.md")),
        )
        .map((entry) => entry.name);
    } catch {
      return null;
    }
  }
}
