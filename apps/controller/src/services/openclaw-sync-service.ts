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
  private pendingSync: Promise<{ configPushed: boolean }> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEBOUNCE_MS = 500;

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

  /**
   * Debounced sync: coalesces rapid calls within 500ms into a single
   * execution, preventing OpenClaw from restart-looping during setup.
   */
  async syncAll(): Promise<{ configPushed: boolean }> {
    // If a sync is already in flight, wait for it and schedule another after
    if (this.pendingSync) {
      await this.pendingSync.catch(() => {});
    }

    return new Promise((resolve, reject) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        const p = this.doSync();
        this.pendingSync = p;
        p.then(resolve, reject).finally(() => {
          this.pendingSync = null;
        });
      }, OpenClawSyncService.DEBOUNCE_MS);
    });
  }

  /**
   * Immediate sync bypassing debounce. Used during bootstrap where
   * we need the config written before OpenClaw starts.
   */
  async syncAllImmediate(): Promise<{ configPushed: boolean }> {
    return this.doSync();
  }

  private async doSync(): Promise<{ configPushed: boolean }> {
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
