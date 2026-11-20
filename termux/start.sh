#!/data/data/com.termux/files/usr/bin/bash
# JinCode — Termux / Android launcher.
#
# Starts the JinCode web agent on the `jincode` profile:
#   - binds 127.0.0.1 by default: the phone browser reaches it. The harness refuses
#     the wildcard 0.0.0.0 (it would expose code execution to the network); for LAN
#     access pass a concrete address of this phone, e.g. HOST=192.168.1.20
#   - telemetry off (DSH_TELEMETRY_DISABLED — config alone cannot disable the row)
#   - runs Node with --expose-internals (no native addon on Android; see README)
#   - loads model/endpoint settings from ~/.jincode/env when present
#
# Environment (in ~/.jincode/env or the shell):
#   JINCODE_API_KEY      optional fallback key. The normal path is the Models page
#                        in the browser, which saves the key in $DSH_HOME/.credentials.yaml
#   JINCODE_BASE_URL     endpoint base, e.g. https://api.openai.com/v1
#   JINCODE_MODEL        model id served by that endpoint
#   JINCODE_CONTEXT_WINDOW / JINCODE_MAX_TOKENS   route capacity fallbacks
#   JINCODE_BASH_TIMEOUT_MS   per-command bash timeout (default 120000)
#   DSH_PERMISSION_MODE  sandbox policy (default danger-full-access on Termux)
#   PORT / HOST          bind address (default 127.0.0.1:3080; a concrete LAN IP for other devices)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HARNESS_DIR="${JINCODE_HARNESS_DIR:-$REPO_ROOT/harness}"

[[ -d "$HARNESS_DIR/.git" ]] || { echo "start.sh: harness checkout missing at $HARNESS_DIR — run termux/setup.sh first" >&2; exit 1; }
[[ -f "$HARNESS_DIR/apps/cli/package.json" ]] || { echo "start.sh: $HARNESS_DIR does not look like the harness source" >&2; exit 1; }

# Model/endpoint configuration, shell env wins over the file.
ENV_FILE="${JINCODE_ENV_FILE:-$HOME/.jincode/env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"
export DSH_TELEMETRY_DISABLED="${DSH_TELEMETRY_DISABLED:-1}"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3080}"

# The key is entered in the browser (Models page), not required in the environment.
STORE_FILE="${DSH_HOME:-$HOME/.dsh}/.credentials.yaml"
if [[ -z "${JINCODE_API_KEY:-}" ]] && ! { [[ -f "$STORE_FILE" ]] && grep -q '^[[:space:]]*JINCODE_API_KEY:' "$STORE_FILE"; }; then
  echo "start.sh: no API key saved yet. The server starts anyway: in the terminal client press Ctrl+G and enter it." >&2
fi

echo "JinCode starting: http://$HOST:$PORT  (profile jincode, model ${JINCODE_MODEL:-gpt-4o-mini})"
echo "Terminal client: bash termux/jincode.sh \"<URL con token impresa por el servidor>\""
# Launch the CLI with Node directly (the same command `pnpm dsh` runs). The profile
# resolver reaches Node's internal modules through --expose-internals, because the
# node-addon-require-builtin native addon has no android-arm64 build. This avoids
# pnpm on the launch path, so a different pnpm on PATH cannot interfere.
cd "$HARNESS_DIR"
exec node --expose-internals --import tsx/esm apps/cli/src/bin.ts --profile jincode --no-open --host "$HOST" --port "$PORT"
