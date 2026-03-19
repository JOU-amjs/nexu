import type { ControllerEnv } from "../app/env.js";
import { compileOpenClawConfig } from "../lib/openclaw-config-compiler.js";
import type { OpenClawConfigWriter } from "../runtime/openclaw-config-writer.js";
import type { OpenClawSkillsWriter } from "../runtime/openclaw-skills-writer.js";
import type { OpenClawWatchTrigger } from "../runtime/openclaw-watch-trigger.js";
import type { WorkspaceTemplateWriter } from "../runtime/workspace-template-writer.js";
import type { CompiledOpenClawStore } from "../store/compiled-openclaw-store.js";
import type { NexuConfigStore } from "../store/nexu-config-store.js";
import type { OpenClawGatewayService } from "./openclaw-gateway-service.js";

const logger = {
  warn: (obj: Record<string, unknown>) => console.warn(JSON.stringify(obj)),
};

export class OpenClawSyncService {
  constructor(
    private readonly env: ControllerEnv,
    private readonly configStore: NexuConfigStore,
    private readonly compiledStore: CompiledOpenClawStore,
    private readonly configWriter: OpenClawConfigWriter,
    private readonly skillsWriter: OpenClawSkillsWriter,
    private readonly templateWriter: WorkspaceTemplateWriter,
    private readonly watchTrigger: OpenClawWatchTrigger,
    private readonly gatewayService: OpenClawGatewayService,
  ) {}

  async compileCurrentConfig(): Promise<
    ReturnType<typeof compileOpenClawConfig>
  > {
    const config = await this.configStore.getConfig();
    return compileOpenClawConfig(config, this.env);
  }

  async syncAll(): Promise<{ configPushed: boolean }> {
    const config = await this.configStore.getConfig();
    const compiled = compileOpenClawConfig(config, this.env);

    // 1. Try WS push first (instant effect)
    let configPushed = false;
    if (this.gatewayService.isConnected()) {
      try {
        configPushed = await this.gatewayService.pushConfig(compiled);
      } catch (err) {
        logger.warn({
          message: "openclaw_ws_push_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Always write files (persistence + cold-start fallback)
    await this.configWriter.write(compiled);
    await this.compiledStore.saveConfig(compiled);
    await this.skillsWriter.materialize(config.skills);
    await this.templateWriter.write(Object.values(config.templates));

    // 3. Only touch watch trigger when WS push failed (file-watch hot-reload)
    if (!configPushed) {
      await this.watchTrigger.touchConfig();
    }

    return { configPushed };
  }
}
