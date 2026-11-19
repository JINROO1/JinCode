#!/usr/bin/env bash
# Launch the JinCode terminal client against a running server.
#   bash termux/jincode.sh "http://127.0.0.1:3080/?token=..."
# The URL is the one `termux/start.sh` prints at start-up. It carries the access token,
# so pass it as an argument or in JINCODE_URL; nothing is stored on disk.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$REPO_ROOT/jincode-cli"

if [ ! -x "$CLI_DIR/node_modules/.bin/tsx" ]; then
  echo "Instalando dependencias del cliente (una sola vez)..."
  (cd "$CLI_DIR" && npm ci --ignore-scripts --no-audit --no-fund)
fi

exec "$CLI_DIR/node_modules/.bin/tsx" "$CLI_DIR/src/cli.tsx" "$@"
