import { execFileSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { env } from "./env.js";
import { logger } from "./log.js";

/**
 * Resolve the OpenClaw bundled extensions directory.
 *
 * Strategy: check env override first, then resolve the `openclaw` binary,
 * follow symlinks, and walk up the directory tree looking for an
 * `extensions/` folder (matching OpenClaw's own `resolveBundledPluginsDir`).
 */
function resolveExtensionsDir(): string | undefined {
  const override = process.env.OPENCLAW_EXTENSIONS_DIR?.trim();
  if (override && existsSync(override)) return override;

  try {
    const binPath = execFileSync("which", [env.OPENCLAW_BIN], {
      encoding: "utf-8",
    }).trim();
    const realPath = realpathSync(binPath);
    let cursor = dirname(realPath);
    for (let i = 0; i < 8; i++) {
      const candidate = join(cursor, "extensions");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch {
    // openclaw binary not found or not resolvable
  }

  return undefined;
}

/**
 * Copy SKILL.md files (and references/ subdirectories) from OpenClaw's
 * bundled extensions to `${OPENCLAW_STATE_DIR}/plugin-docs/` on the PVC.
 *
 * Sandbox containers bind-mount this directory at the original extensions
 * path, so agents can read extension SKILL.md files transparently.
 */
export async function syncPluginDocs(): Promise<void> {
  const extensionsDir = resolveExtensionsDir();
  if (!extensionsDir) {
    logger.debug(
      "no openclaw extensions directory found; skipping plugin docs sync",
    );
    return;
  }

  const destDir = join(env.OPENCLAW_STATE_DIR, "plugin-docs");
  await mkdir(destDir, { recursive: true });

  let synced = 0;
  const extEntries = await readdir(extensionsDir, { withFileTypes: true });

  for (const ext of extEntries) {
    if (!ext.isDirectory()) continue;

    const skillsDir = join(extensionsDir, ext.name, "skills");
    let skillEntries: Dirent[];
    try {
      skillEntries = await readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const skill of skillEntries) {
      if (!skill.isDirectory()) continue;

      const srcSkillDir = join(skillsDir, skill.name);
      const dstSkillDir = join(destDir, ext.name, "skills", skill.name);

      const skillMdSrc = join(srcSkillDir, "SKILL.md");
      try {
        await stat(skillMdSrc);
      } catch {
        continue;
      }

      await mkdir(dstSkillDir, { recursive: true });
      await cp(skillMdSrc, join(dstSkillDir, "SKILL.md"));

      // Copy references/ if present (some skills include reference docs)
      const refsSrc = join(srcSkillDir, "references");
      try {
        const refsStat = await stat(refsSrc);
        if (refsStat.isDirectory()) {
          await cp(refsSrc, join(dstSkillDir, "references"), {
            recursive: true,
          });
        }
      } catch {
        // no references/ dir
      }

      synced++;
    }
  }

  if (synced > 0) {
    logger.info(
      { count: synced, source: extensionsDir, dest: destDir },
      "synced plugin skill docs to PVC",
    );
  }
}
