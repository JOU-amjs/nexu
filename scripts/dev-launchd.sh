#!/usr/bin/env bash
#
# Launchd-based development script for Nexu Desktop
#
# Usage:
#   ./scripts/dev-launchd.sh         # Start services
#   ./scripts/dev-launchd.sh stop    # Stop services
#   ./scripts/dev-launchd.sh status  # Show service status
#   ./scripts/dev-launchd.sh logs    # Tail all logs
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.nexu/logs"
PLIST_DIR="$REPO_ROOT/.tmp/launchd"
UID_VAL=$(id -u)
DOMAIN="gui/$UID_VAL"

# Service labels (dev mode)
CONTROLLER_LABEL="io.nexu.controller.dev"
OPENCLAW_LABEL="io.nexu.openclaw.dev"

# Ports
CONTROLLER_PORT="${CONTROLLER_PORT:-50814}"
WEB_PORT="${WEB_PORT:-50810}"

# Paths
NODE_PATH="${NODE_PATH:-$(which node)}"
CONTROLLER_ENTRY="$REPO_ROOT/apps/controller/dist/index.js"
OPENCLAW_PATH="$REPO_ROOT/openclaw-runtime/node_modules/openclaw/openclaw.mjs"
# Must match controller defaults in apps/controller/src/app/env.ts
OPENCLAW_STATE_DIR="$HOME/.nexu/runtime/openclaw/state"
OPENCLAW_CONFIG="$OPENCLAW_STATE_DIR/openclaw.json"

mkdir -p "$LOG_DIR" "$PLIST_DIR" "$OPENCLAW_STATE_DIR"

# Cleanup function
cleanup() {
  echo "Cleaning up..."
  launchctl kill SIGTERM "$DOMAIN/$OPENCLAW_LABEL" 2>/dev/null || true
  launchctl kill SIGTERM "$DOMAIN/$CONTROLLER_LABEL" 2>/dev/null || true
}

generate_controller_plist() {
  cat > "$PLIST_DIR/$CONTROLLER_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$CONTROLLER_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$CONTROLLER_ENTRY</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT/apps/controller</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>$CONTROLLER_PORT</string>
        <key>NODE_ENV</key>
        <string>development</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/controller.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/controller.error.log</string>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF
}

generate_openclaw_plist() {
  cat > "$PLIST_DIR/$OPENCLAW_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$OPENCLAW_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$OPENCLAW_PATH</string>
        <string>gateway</string>
        <string>--auth</string>
        <string>none</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OPENCLAW_CONFIG_PATH</key>
        <string>$OPENCLAW_CONFIG</string>
        <key>OPENCLAW_STATE_DIR</key>
        <string>$OPENCLAW_STATE_DIR</string>
        <key>OPENCLAW_LAUNCHD_LABEL</key>
        <string>$OPENCLAW_LABEL</string>
        <key>OPENCLAW_SERVICE_MARKER</key>
        <string>launchd</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/openclaw.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/openclaw.error.log</string>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>OtherJobEnabled</key>
        <dict>
            <key>$CONTROLLER_LABEL</key>
            <true/>
        </dict>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF
}

bootstrap_service() {
  local label=$1
  local plist="$PLIST_DIR/$label.plist"

  if ! launchctl print "$DOMAIN/$label" &>/dev/null; then
    echo "Bootstrapping $label..."
    if ! launchctl bootstrap "$DOMAIN" "$plist" 2>&1; then
      echo "Note: $label may already be bootstrapped"
    fi
  else
    echo "$label already bootstrapped"
  fi
}

start_services() {
  echo "=== Nexu Desktop (launchd mode) ==="
  echo "Log directory: $LOG_DIR"
  echo "Plist directory: $PLIST_DIR"
  echo ""

  # Generate plists
  echo "Generating plist files..."
  generate_controller_plist
  generate_openclaw_plist

  # Bootstrap services
  bootstrap_service "$CONTROLLER_LABEL"
  bootstrap_service "$OPENCLAW_LABEL"

  # Start services
  echo "Starting services..."
  launchctl kickstart -k "$DOMAIN/$CONTROLLER_LABEL"

  # Wait for controller
  echo "Waiting for Controller..."
  for i in {1..30}; do
    if curl -s "http://127.0.0.1:$CONTROLLER_PORT/api/auth/get-session" >/dev/null 2>&1; then
      echo "Controller is ready"
      break
    fi
    sleep 1
  done

  launchctl kickstart -k "$DOMAIN/$OPENCLAW_LABEL"
  echo "OpenClaw started"

  echo ""
  echo "=== Services running ==="
  show_status
  echo ""
  echo "View logs: $0 logs"
  echo "Stop services: $0 stop"
}

stop_services() {
  echo "Stopping services..."

  # Stop OpenClaw first
  if launchctl print "$DOMAIN/$OPENCLAW_LABEL" &>/dev/null; then
    echo "Stopping $OPENCLAW_LABEL..."
    launchctl kill SIGTERM "$DOMAIN/$OPENCLAW_LABEL" 2>/dev/null || true
    sleep 2
  fi

  # Stop Controller
  if launchctl print "$DOMAIN/$CONTROLLER_LABEL" &>/dev/null; then
    echo "Stopping $CONTROLLER_LABEL..."
    launchctl kill SIGTERM "$DOMAIN/$CONTROLLER_LABEL" 2>/dev/null || true
    sleep 2
  fi

  echo "Services stopped"
}

show_status() {
  echo "Controller ($CONTROLLER_LABEL):"
  launchctl print "$DOMAIN/$CONTROLLER_LABEL" 2>/dev/null | grep -E "state|pid" || echo "  Not running"
  echo ""
  echo "OpenClaw ($OPENCLAW_LABEL):"
  launchctl print "$DOMAIN/$OPENCLAW_LABEL" 2>/dev/null | grep -E "state|pid" || echo "  Not running"
}

tail_logs() {
  echo "Tailing logs from $LOG_DIR..."
  echo "(Press Ctrl+C to stop)"
  echo ""
  tail -f "$LOG_DIR"/*.log
}

# Main
case "${1:-start}" in
  start)
    start_services
    ;;
  stop)
    stop_services
    ;;
  restart)
    stop_services
    sleep 1
    start_services
    ;;
  status)
    show_status
    ;;
  logs)
    tail_logs
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
