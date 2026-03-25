import type { OpenClawConfig } from "@nexu/shared";
import { logger } from "../lib/logger.js";
import type {
  AuthProfilesData,
  OpenClawAuthProfilesStore,
} from "./openclaw-auth-profiles-store.js";

type ApiKeyProfile = {
  type: "api_key";
  provider: string;
  key: string;
};

function isApiKeyProfile(profile: unknown): profile is { type: "api_key" } {
  return (
    typeof profile === "object" &&
    profile !== null &&
    "type" in profile &&
    (profile as Record<string, unknown>).type === "api_key"
  );
}

export class OpenClawAuthProfilesWriter {
  constructor(private readonly authProfilesStore: OpenClawAuthProfilesStore) {}

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
        const authProfilesPath =
          this.authProfilesStore.authProfilesPathForWorkspace(agent.workspace);
        const preservedKeys: string[] = [];

        await this.authProfilesStore.updateAuthProfiles(
          authProfilesPath,
          async (existing) => {
            const preservedProfiles: Record<string, unknown> = {};
            for (const [key, profile] of Object.entries(existing.profiles)) {
              if (!isApiKeyProfile(profile)) {
                preservedProfiles[key] = profile;
                preservedKeys.push(key);
              }
            }

            return {
              ...existing,
              profiles: {
                ...preservedProfiles,
                ...newApiKeyProfiles,
              },
            } satisfies AuthProfilesData;
          },
        );

        if (preservedKeys.length > 0) {
          logger.debug(
            {
              agent: agent.workspace,
              preservedKeys,
            },
            "Preserved non-api_key auth profiles during config sync",
          );
        }
      }),
    );
  }
}
