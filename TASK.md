# Handoff Notes

## Branch

- Current branch: `feat/local-dev-workflow-optimization`
- Branch pushed to: `origin/feat/local-dev-workflow-optimization`
- Latest commit from before this session: `01bd29a` `refactor: clarify scripts dev module boundaries`
- Workspace status at handoff: code changes for desktop/controller/scripts-dev integration plus this `TASK.md` update

## What Changed In This Session

### Desktop runtime ownership was split into `external | internal`

- `apps/desktop/shared/runtime-config.ts` now exposes `runtimeMode: "external" | "internal"`
- `apps/desktop/main/platforms/shared/runtime-common.ts` now has an external runtime adapter path
- `apps/desktop/main/platforms/index.ts` selects an external adapter when desktop is launched in external mode
- `apps/desktop/main/runtime/manifests.ts` marks `web`, `controller`, and `openclaw` runtime units as `external` when desktop is attaching instead of owning processes
- `apps/desktop/main/runtime/daemon-supervisor.ts` now probes external runtime units by port and reports external availability state instead of trying to manage them
- `apps/desktop/main/index.ts` logs the effective desktop runtime mode and the external runtime targets during cold start

### Controller OpenClaw ownership was split into `external | internal`

- `apps/controller/src/app/env.ts` now accepts:
  - `NEXU_CONTROLLER_OPENCLAW_MODE=external|internal`
  - `OPENCLAW_BASE_URL`
  - `OPENCLAW_LOG_DIR`
- Legacy `RUNTIME_MANAGE_OPENCLAW_PROCESS` is now treated as a compatibility input; the effective owner is derived from the explicit mode when present
- `apps/controller/src/runtime/gateway-client.ts`, `apps/controller/src/runtime/runtime-health.ts`, and `apps/controller/src/runtime/openclaw-ws-client.ts` now connect through `OPENCLAW_BASE_URL` instead of hard-coded `127.0.0.1:${port}`
- `apps/controller/src/app/bootstrap.ts` now logs the runtime contract and only starts OpenClaw when controller is in `internal` mode
- `apps/controller/src/services/model-provider-service.ts` and `apps/controller/src/services/desktop-local-service.ts` now skip runtime restarts when controller is attached to an external OpenClaw instance
- `apps/controller/src/runtime/openclaw-process.ts` now exposes `managesProcess()` so ownership checks are explicit at call sites

### `scripts/dev` now owns OpenClaw local-dev startup

- Added `scripts/dev/src/shared/dev-runtime-config.ts`
  - reads `scripts/dev/.env` when present
  - defines the cross-service local-dev contract for ports, URLs, state dirs, config path, log dir, and gateway token
- Added `scripts/dev/.env.example` as the source-of-truth example for dev-only external injection
- Added `scripts/dev/src/services/openclaw.ts`
- Added `scripts/dev/src/supervisors/openclaw.ts`
- Updated `scripts/dev/src/index.ts` so `pnpm dev start|restart|stop|status|logs` now includes `openclaw`
- Updated existing `scripts/dev` controller/web assembly to consume injected values from `scripts/dev/.env` instead of assuming only hard-coded defaults

### Small controller-chain robustness fix

- `apps/controller/src/runtime/openclaw-config-writer.ts` now derives a fallback state dir from `openclawConfigPath` when the full env shape is not present, which fixed the related config-writer regression in tests

## Validation Already Done

- `pnpm --filter @nexu/desktop typecheck` passed
- `pnpm --filter @nexu/desktop build` passed earlier in the session after the desktop external-runtime split
- `pnpm --filter @nexu/controller typecheck` passed
- `pnpm --filter @nexu/controller build` passed
- `pnpm --dir ./scripts/dev exec tsc --noEmit` passed
- Root-entrypoint local-dev acceptance for the current three-service flow passed:
  - `pnpm dev status`
  - `pnpm dev start`
  - `pnpm dev status`
  - `pnpm dev logs openclaw`
  - `pnpm dev logs controller`
  - `pnpm dev restart`
  - `pnpm dev stop`
  - `pnpm dev status`
- Verified controller now boots in `external` OpenClaw mode and successfully reaches `openclaw_ws_connected` through the `scripts/dev`-managed OpenClaw process

## Important Current Behavior

- OpenClaw local dev is now expected to be orchestrated by `scripts/dev`, not by its own dedicated `.env`
- `scripts/dev/.env` is intended to become the single dev-only source of truth for cross-service injected runtime values
- Controller local dev is already consuming OpenClaw through that external contract when launched via `scripts/dev`
- Desktop code is prepared for the same external-runtime shape, but desktop is not yet wired into `scripts/dev`

## Known Existing Issues

- `pnpm lint` still fails due to pre-existing repo-wide Biome formatting issues unrelated to this branch
- `pnpm --filter @nexu/controller test` still has pre-existing failures not introduced by this session:
  - `tests/nexu-config-store.test.ts`
  - `tests/openclaw-sync.test.ts`
  - `tests/openclaw-runtime-plugin-writer.test.ts` (Windows symlink permission issue)
- Desktop is not yet started/stopped through `scripts/dev`; only `openclaw + controller + web` are wired today

## Suggested Next Steps

1. Wire `desktop` into `scripts/dev` using the same `scripts/dev/.env` contract and `NEXU_DESKTOP_RUNTIME_MODE=external`
2. Decide whether to expand `pnpm dev` into explicit single-service targeting like `pnpm dev start openclaw` / `pnpm dev stop controller`
3. Continue tightening the `scripts/dev/.env` contract so every external injection is documented, named consistently, and traced to a single owner
