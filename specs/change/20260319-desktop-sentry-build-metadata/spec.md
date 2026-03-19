---
id: "20260319-desktop-sentry-build-metadata"
name: "Desktop Sentry Build Metadata"
status: new
created: "2026-03-19"
---

## Overview

- Add desktop build metadata to Sentry events so crash and exception issues can be tied back to the exact packaged artifact without relying on branch-specific tags.
- Keep Sentry naming aligned with standard release management:
  - `release`: `nexu-desktop@<version>`
  - `dist`: `nexu-desktop@<version>+<commit>`
- Focus the operator experience on packaged crash triage first. Local dev-only metadata such as branch and build source should remain available as event context, but should not become primary issue filters.
- Apply the same metadata model to both Electron main and renderer pipelines so JavaScript exceptions and native crashes share the same release/dist identity in Sentry.

## Research

<!-- What have we found out? What are the alternatives considered? -->

## Design

### Design conclusions

- Use `runtimeConfig.buildInfo` as the single source of truth for all Sentry build metadata. This already resolves values from dev env injection and packaged `build-config.json`.
- Rename the Sentry release from `@nexu/desktop@<version>` to `nexu-desktop@<version>` to match the desired Sentry naming convention.
- Set `dist` to `nexu-desktop@<version>+<commit>` when commit metadata is available.
- Do not add `build_source`, `build_branch`, or `build_commit` as Sentry tags. They are mainly useful during development, while packaged issue triage can use `release` + `dist`.
- Preserve full build metadata under a structured Sentry context such as `build`, including `version`, `source`, `branch`, `commit`, and `builtAt`.

### Architecture

`build-config.json` / dev env injection -> `getDesktopRuntimeConfig()` -> `runtimeConfig.buildInfo` -> `Sentry.init({ release, dist })` + `Sentry.setContext("build", ...)`

### Implementation shape

1. Main process initialization
   - Update `apps/desktop/main/index.ts` to derive `release` and `dist` from `runtimeConfig.buildInfo` during `Sentry.init(...)`.
   - Add a shared helper or local utility to attach the `build` context immediately after Sentry startup.
2. Renderer process initialization
   - Ensure the renderer Sentry setup in `apps/desktop/src/main.tsx` uses the same release/dist format as the main process.
   - Reuse the runtime config returned through the existing host bridge so renderer and main cannot drift.
3. Fallback behavior
   - If commit metadata is missing, keep `release` set from version and omit `dist` rather than inventing a synthetic identifier.
   - Keep the existing non-Sentry crashReporter fallback unchanged except for optional local crash metadata if needed later.

### Files to modify

- `apps/desktop/main/index.ts` - set Sentry `release`, `dist`, and build context for main/native crash events
- `apps/desktop/src/main.tsx` - set matching Sentry `release`, `dist`, and build context for renderer exceptions
- `apps/desktop/shared/runtime-config.ts` - reuse existing build metadata model as the shared source of truth; no schema expansion expected

## Plan

<!-- Break down implementation and verification into steps -->

- [ ] Phase 1: Implement the first part of the feature
  - [ ] Task 1
  - [ ] Task 2
  - [ ] Task 3
- [ ] Phase 2: Implement the second part of the feature
  - [ ] Task 1
  - [ ] Task 2
  - [ ] Task 3
- [ ] Phase 3: Test and verify
  - [ ] Test criteria 1
  - [ ] Test criteria 2

## Notes

<!-- Optional: Alternatives considered, open questions, etc. -->
