import type { ControllerContainer } from "./container.js";

export async function bootstrapController(
  container: ControllerContainer,
): Promise<() => void> {
  await container.openclawProcess.prepare();

  // Validate default model against available models before first sync
  await container.modelProviderService.ensureValidDefaultModel();

  // Write config files BEFORE starting OpenClaw so it boots with the
  // correct configuration, avoiding a SIGUSR1 restart cycle on first connect.
  await container.openclawSyncService.syncAll();

  // Pre-seed the push hash so the onConnected syncAll() sees no change
  // and skips the redundant config.apply RPC.
  container.gatewayService.preSeedConfigHash(
    await container.openclawSyncService.compileCurrentConfig(),
  );

  container.openclawProcess.enableAutoRestart();
  container.openclawProcess.start();

  // Start WS client — connects to OpenClaw gateway
  container.wsClient.connect();

  // When WS handshake completes, push current config (skipped if unchanged)
  container.wsClient.onConnected(() => {
    void container.openclawSyncService.syncAll().catch(() => {});
  });

  return container.startBackgroundLoops();
}
