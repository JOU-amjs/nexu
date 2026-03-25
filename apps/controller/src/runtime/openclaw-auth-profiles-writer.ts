import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "@nexu/shared";
import { logger } from "../lib/logger.js";

type ApiKeyProfile = {
  type: "api_key";
  provider: string;
  key: string;
};

type AuthProfileStore = {
  version: number;
  profiles: Record<string, unknown>;
  lastGood?: Record<string, unknown>;
  usageStats?: Record<string, unknown>;
};

async function readExistingProfiles(
  filePath: string,
): Promise<AuthProfileStore | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return null;

    const record = parsed as Record<string, unknown>;
    return {
      version: typeof record.version === "number" ? record.version : 1,
      profiles:
        typeof record.profiles === "object" &&
        record.profiles !== null &&
        !Array.isArray(record.profiles)
          ? (record.profiles as Record<string, unknown>)
          : {},
      ...(typeof record.lastGood === "object" && record.lastGood !== null
        ? { lastGood: record.lastGood as Record<string, unknown> }
        : {}),
      ...(typeof record.usageStats === "object" && record.usageStats !== null
        ? { usageStats: record.usageStats as Record<string, unknown> }
        : {}),
    };
  } catch {
    return null;
  }
}

function isApiKeyProfile(profile: unknown): profile is { type: "api_key" } {
  return (
    typeof profile === "object" &&
    profile !== null &&
    "type" in profile &&
    (profile as Record<string, unknown>).type === "api_key"
  );
}

export class OpenClawAuthProfilesWriter {
  async writeForAgents(config: OpenClawConfig): Promise<void> {
    const providers = config.models?.providers ?? {};
    const newApiKeyProfiles: Record<string, ApiKeyProfile> = Object.fromEntries(
      Object.entries(providers)
        .filter(
          ([, provider]) =>
            typeof provider.apiKey === "string" && provider.apiKey.length > 0,
        )
        .map(([providerId, provider]) => [
          `${providerId}:default`,
          {
            type: "api_key" as const,
            provider: providerId,
            key: provider.apiKey as string,
          },
        ]),
    );

    await Promise.all(
      (config.agents?.list ?? []).map(async (agent) => {
        if (
          typeof agent.workspace !== "string" ||
          agent.workspace.length === 0
        ) {
          return;
        }
        const authProfilesPath = path.join(
          agent.workspace,
          "agent",
          "auth-profiles.json",
        );
        await mkdir(path.dirname(authProfilesPath), { recursive: true });

        // Read existing profiles to preserve non-api_key entries (e.g. OAuth)
        const existing = await readExistingProfiles(authProfilesPath);

        // Keep profiles with type !== "api_key" from the existing file
        const preservedProfiles: Record<string, unknown> = {};
        if (existing) {
          for (const [key, profile] of Object.entries(existing.profiles)) {
            if (!isApiKeyProfile(profile)) {
              preservedProfiles[key] = profile;
            }
          }
        }

        const payload: AuthProfileStore = {
          version: existing?.version ?? 1,
          profiles: {
            ...preservedProfiles,
            ...newApiKeyProfiles,
          },
          ...(existing?.lastGood ? { lastGood: existing.lastGood } : {}),
          ...(existing?.usageStats ? { usageStats: existing.usageStats } : {}),
        };

        await writeFile(
          authProfilesPath,
          `${JSON.stringify(payload, null, 2)}\n`,
          "utf8",
        );

        if (Object.keys(preservedProfiles).length > 0) {
          logger.debug(
            {
              agent: agent.workspace,
              preservedKeys: Object.keys(preservedProfiles),
            },
            "Preserved non-api_key auth profiles during config sync",
          );
        }
      }),
    );
  }
}
