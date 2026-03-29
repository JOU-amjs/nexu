#!/usr/bin/env bash
#
# Run desktop E2E tests against a signed nightly build.
#
# Usage:
#   bash scripts/run-e2e.sh smoke    # DMG install + codesign + cold start
#   bash scripts/run-e2e.sh login    # smoke + login + wait for agent running
#   bash scripts/run-e2e.sh model    # smoke + model switch scenario
#   bash scripts/run-e2e.sh update   # smoke + update scenario
#   bash scripts/run-e2e.sh full     # smoke + model + update
#
set -euo pipefail

MODE="${1:-full}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR="$REPO_ROOT/artifacts"
CAPTURE_DIR="$REPO_ROOT/captures"
RUN_ROOT="${TMPDIR:-/tmp}/nexu-desktop-e2e"
PERSISTENT_HOME="$REPO_ROOT/.tmp/home"
SKIP_CODESIGN="${NEXU_DESKTOP_E2E_SKIP_CODESIGN:-false}"

log() { printf '[e2e:%s] %s\n' "$MODE" "$1" >&2; }

# -----------------------------------------------------------------------
# Cleanup helpers
# -----------------------------------------------------------------------
cleanup_machine() {
  mkdir -p "$CAPTURE_DIR"
  log "Cleaning existing Nexu processes"
  bash "$REPO_ROOT/scripts/kill-all.sh" > "$CAPTURE_DIR/kill-all.log" 2>&1 || true

  if [ -d "$RUN_ROOT/dmg-mount" ]; then
    hdiutil detach "$RUN_ROOT/dmg-mount" -force 2>/dev/null || true
  fi
  rm -rf "$RUN_ROOT"
  mkdir -p "$RUN_ROOT"
}

wait_ports_free() {
  local waited=0
  while true; do
    local busy
    busy=$(lsof -iTCP:50800 -iTCP:50810 -iTCP:18789 -sTCP:LISTEN -n -P 2>/dev/null || true)
    if [ -z "$busy" ]; then break; fi
    if [ "$waited" -ge 20 ]; then
      log "WARNING: ports still occupied after 20s"
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  [ "$waited" -gt 0 ] && log "Ports cleared after ${waited}s" || true
}

# -----------------------------------------------------------------------
# Artifact resolution
# -----------------------------------------------------------------------
resolve_artifact() {
  local ext="$1"
  shopt -s nullglob
  local candidates=("$ARTIFACT_DIR"/*."$ext")
  shopt -u nullglob

  if [ "${#candidates[@]}" -eq 0 ]; then
    log "No .$ext artifacts in $ARTIFACT_DIR — run: npm run download"
    return 1
  fi
  printf '%s\n' "${candidates[0]}"
}

# -----------------------------------------------------------------------
# DMG install + codesign verification
# -----------------------------------------------------------------------
install_from_dmg() {
  local dmg_path="$1"
  local mount_dir="$RUN_ROOT/dmg-mount"
  local install_root="$RUN_ROOT/Applications"
  local installed_app="$install_root/Nexu.app"

  rm -rf "$mount_dir" "$install_root"
  mkdir -p "$mount_dir" "$install_root"

  log "Mounting DMG: $(basename "$dmg_path")"
  hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_dir" >/dev/null

  if [ ! -d "$mount_dir/Nexu.app" ]; then
    hdiutil detach "$mount_dir" -force >/dev/null 2>&1 || true
    log "ERROR: Nexu.app not found in DMG"
    return 1
  fi

  log "Copying app from DMG"
  ditto "$mount_dir/Nexu.app" "$installed_app"

  if [ "$SKIP_CODESIGN" = "true" ]; then
    log "Skipping codesign/spctl (unsigned local build)"
  else
    log "Verifying codesign"
    codesign --verify --deep --strict --verbose=2 "$installed_app" > "$CAPTURE_DIR/codesign-verify.log" 2>&1
    log "Verifying Gatekeeper (spctl)"
    spctl --assess --type execute -vv "$installed_app" > "$CAPTURE_DIR/spctl-assess.log" 2>&1
    log "codesign + spctl PASSED"
  fi

  hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  printf '%s\n' "$installed_app"
}

# -----------------------------------------------------------------------
# Launch app and wait for runtime health
# -----------------------------------------------------------------------
launch_and_wait() {
  local app_path="$1"
  local executable="$app_path/Contents/MacOS/Nexu"
  local home_dir="$PERSISTENT_HOME"
  local user_data_dir="$home_dir/Library/Application Support/@nexu/desktop"
  local logs_dir="$user_data_dir/logs"
  local runtime_logs_dir="$logs_dir/runtime-units"
  local log_path="$CAPTURE_DIR/packaged-app.log"
  local pid_path="$CAPTURE_DIR/packaged-app.pid"

  mkdir -p "$home_dir" "$CAPTURE_DIR"

  HOME="$home_dir" \
  TMPDIR="$RUN_ROOT/tmp" \
  NEXU_DESKTOP_USER_DATA_ROOT="$user_data_dir" \
    "$executable" > "$log_path" 2>&1 &

  local app_pid=$!
  printf '%s\n' "$app_pid" > "$pid_path"
  log "Launched app pid=$app_pid"

  local attempt=0
  local max_attempts=90
  while [ "$attempt" -lt "$max_attempts" ]; do
    attempt=$((attempt + 1))
    if curl -sf http://127.0.0.1:50800/api/internal/desktop/ready >/dev/null 2>&1; then
      if curl -sf http://127.0.0.1:50810/api/internal/desktop/ready >/dev/null 2>&1; then
        log "Runtime healthy after $attempt attempts"
        export PACKAGED_APP="$app_path"
        export PACKAGED_EXECUTABLE="$executable"
        export PACKAGED_HOME="$home_dir"
        export PACKAGED_USER_DATA_DIR="$user_data_dir"
        export PACKAGED_LOGS_DIR="$logs_dir"
        export PACKAGED_RUNTIME_LOGS_DIR="$runtime_logs_dir"
        export NEXU_DESKTOP_E2E_CAPTURE_DIR="$CAPTURE_DIR"
        return 0
      fi
    fi
    sleep 2
  done

  log "ERROR: runtime health check failed after $max_attempts attempts"
  tail -20 "$log_path" >&2 || true
  return 1
}

# -----------------------------------------------------------------------
# Quit app (osascript for dialog, fallback to kill)
# -----------------------------------------------------------------------
quit_app() {
  local pid_path="$CAPTURE_DIR/packaged-app.pid"
  if [ ! -f "$pid_path" ]; then return 0; fi

  local app_pid
  app_pid="$(cat "$pid_path")"
  if [ -z "$app_pid" ] || ! kill -0 "$app_pid" 2>/dev/null; then return 0; fi

  log "Quitting app pid=$app_pid"
  kill "$app_pid" 2>/dev/null || true

  (
    sleep 1
    local attempts=0
    while kill -0 "$app_pid" 2>/dev/null && [ "$attempts" -lt 20 ]; do
      for label in "完全退出" "Quit Completely"; do
        osascript -e "tell application \"System Events\" to tell process \"Nexu\" to click button \"$label\" of window 1" 2>/dev/null && exit 0 || true
      done
      sleep 0.5
      attempts=$((attempts + 1))
    done
  ) &
  local clicker_pid=$!

  local waited=0
  while kill -0 "$app_pid" 2>/dev/null; do
    if [ "$waited" -ge 20 ]; then
      log "Force killing pid=$app_pid"
      kill -9 "$app_pid" 2>/dev/null || true
      break
    fi
    sleep 0.5
    waited=$((waited + 1))
  done

  kill "$clicker_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  wait "$clicker_pid" 2>/dev/null || true
  log "App exited"
}

# -----------------------------------------------------------------------
# System screen recording
# -----------------------------------------------------------------------
SCREEN_RECORDING_PID=""

start_screen_recording() {
  local video_path="$CAPTURE_DIR/screen-recording.mov"
  screencapture -v -C -G 0 "$video_path" &
  SCREEN_RECORDING_PID=$!
  log "Screen recording started (pid=$SCREEN_RECORDING_PID)"
}

stop_screen_recording() {
  if [ -n "$SCREEN_RECORDING_PID" ] && kill -0 "$SCREEN_RECORDING_PID" 2>/dev/null; then
    kill -INT "$SCREEN_RECORDING_PID" 2>/dev/null || true
    sleep 2
    kill -0 "$SCREEN_RECORDING_PID" 2>/dev/null && kill -9 "$SCREEN_RECORDING_PID" 2>/dev/null || true
    wait "$SCREEN_RECORDING_PID" 2>/dev/null || true
    log "Screen recording saved"
  fi
  SCREEN_RECORDING_PID=""
}

# -----------------------------------------------------------------------
# Diagnostics capture
# -----------------------------------------------------------------------
capture_logs() {
  local home_dir="$PERSISTENT_HOME"
  local user_data_dir="$home_dir/Library/Application Support/@nexu/desktop"

  mkdir -p "$CAPTURE_DIR/packaged-logs" \
           "$CAPTURE_DIR/runtime-unit-logs" \
           "$CAPTURE_DIR/state-snapshot"

  # App logs
  if [ -d "${PACKAGED_LOGS_DIR:-}" ]; then
    cp -r "$PACKAGED_LOGS_DIR"/* "$CAPTURE_DIR/packaged-logs/" 2>/dev/null || true
  fi
  if [ -d "${PACKAGED_RUNTIME_LOGS_DIR:-}" ]; then
    cp -r "$PACKAGED_RUNTIME_LOGS_DIR"/* "$CAPTURE_DIR/runtime-unit-logs/" 2>/dev/null || true
  fi

  # State snapshot
  local state_dir="$CAPTURE_DIR/state-snapshot"
  if [ -d "$home_dir/.nexu" ]; then
    mkdir -p "$state_dir/dot-nexu"
    cp "$home_dir/.nexu/config.json" "$state_dir/dot-nexu/" 2>/dev/null || true
    cp "$home_dir/.nexu/cloud-profiles.json" "$state_dir/dot-nexu/" 2>/dev/null || true
    if [ -f "$state_dir/dot-nexu/config.json" ]; then
      sed -i '' 's/"apiKey":\s*"[^"]*"/"apiKey": "***REDACTED***"/g' "$state_dir/dot-nexu/config.json" 2>/dev/null || true
    fi
  fi

  local openclaw_state="$user_data_dir/runtime/openclaw/state"
  if [ -d "$openclaw_state" ]; then
    mkdir -p "$state_dir/openclaw-state"
    cp "$openclaw_state/openclaw.json" "$state_dir/openclaw-state/" 2>/dev/null || true
    cp "$openclaw_state/nexu-runtime-model.json" "$state_dir/openclaw-state/" 2>/dev/null || true
  fi

  find "$home_dir" -name "runtime-ports.json" -exec cp {} "$state_dir/" \; 2>/dev/null || true

  {
    echo "=== Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
    echo "=== Processes ==="
    ps aux | grep -E "Nexu|openclaw|controller|clawhub" | grep -v grep || echo "(none)"
    echo "=== Launchd ==="
    launchctl list 2>/dev/null | grep nexu || echo "(none)"
    echo "=== Ports ==="
    lsof -iTCP:50800 -iTCP:50810 -iTCP:18789 -sTCP:LISTEN -n -P 2>/dev/null || echo "(none)"
    echo "=== Controller ==="
    curl -sf http://127.0.0.1:50800/api/internal/desktop/ready 2>/dev/null || echo "(unreachable)"
    echo "=== Cloud ==="
    curl -sf http://127.0.0.1:50800/api/internal/desktop/cloud-status 2>/dev/null || echo "(unreachable)"
    echo "=== OpenClaw ==="
    curl -sf http://127.0.0.1:18789/health 2>/dev/null || echo "(unreachable)"
  } > "$state_dir/runtime-snapshot.txt" 2>&1

  log "Diagnostics captured"
}

on_failure() {
  log "!!! TEST FAILED — capturing diagnostics ==="
  screencapture -x "$CAPTURE_DIR/failure-screenshot.png" 2>/dev/null || true
  capture_logs
  stop_screen_recording
}

# -----------------------------------------------------------------------
# Main flow
# -----------------------------------------------------------------------
mkdir -p "$PERSISTENT_HOME" "$CAPTURE_DIR"

cleanup_on_exit() {
  local rc=$?
  stop_screen_recording
  if [ "$rc" -ne 0 ]; then on_failure; fi
  quit_app
  bash "$REPO_ROOT/scripts/kill-all.sh" >/dev/null 2>&1 || true
}
trap 'cleanup_on_exit' EXIT

start_screen_recording

dmg_path="$(resolve_artifact dmg)" || exit 1
zip_path="$(resolve_artifact zip)" || exit 1
export NEXU_DESKTOP_E2E_ZIP_PATH="$zip_path"

# --- SMOKE ---
cleanup_machine
wait_ports_free
app_path="$(install_from_dmg "$dmg_path")"

if [ "$MODE" = "login" ]; then
  log "=== INSTALL PASSED, handing off to Playwright for login ==="
else
  launch_and_wait "$app_path"
  log "=== SMOKE PASSED ==="

  if [ "$MODE" = "smoke" ]; then
    stop_screen_recording
    capture_logs
    exit 0
  fi

  quit_app
  bash "$REPO_ROOT/scripts/kill-all.sh" > "$CAPTURE_DIR/kill-all-post-smoke.log" 2>&1 || true
  wait_ports_free
fi

log "Running Playwright E2E scenarios: $MODE"
node "$REPO_ROOT/tests/packaged-e2e.mjs" "$MODE" \
  --app "$app_path" \
  --exe "$app_path/Contents/MacOS/Nexu" \
  --zip "$zip_path" \
  --user-data "$PERSISTENT_HOME/Library/Application Support/@nexu/desktop" \
  --capture-dir "$CAPTURE_DIR"

stop_screen_recording
capture_logs
log "=== ALL E2E PASSED ($MODE) ==="
