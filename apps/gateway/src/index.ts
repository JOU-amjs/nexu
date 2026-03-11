import "./datadog.js";
import { bootstrapGateway } from "./bootstrap.js";
import { BaseError, logger } from "./log.js";
import {
  runDiscordSessionSyncLoop,
  runFeishuSessionSyncLoop,
  runGatewayHealthLoops,
  runHeartbeatLoop,
  runPollLoop,
  runSkillsPollLoop,
  runSlackTokenHealthLoop,
  runWorkspaceTemplatesPollLoop,
} from "./loops.js";
import { stopManagedOpenclawGateway } from "./openclaw-process.js";
import { createRuntimeState } from "./state.js";

const state = createRuntimeState();

function shutdown() {
  logger.info("shutting down gateway sidecar");
  stopManagedOpenclawGateway();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main(): Promise<void> {
  await bootstrapGateway(state);

  runGatewayHealthLoops(state);
  void runHeartbeatLoop(state);
  void runDiscordSessionSyncLoop();
  void runFeishuSessionSyncLoop();
  void runSkillsPollLoop(state);
  void runSlackTokenHealthLoop();
  void runWorkspaceTemplatesPollLoop(state);
  await runPollLoop(state);
}

main().catch((error: unknown) => {
  stopManagedOpenclawGateway();
  logger.error(BaseError.from(error).toJSON(), "fatal error");
  process.exitCode = 1;
});
