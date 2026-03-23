#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$APP_DIR/scripts/dev-cli.mjs" "$@"
