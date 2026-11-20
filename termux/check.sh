#!/data/data/com.termux/files/usr/bin/bash
# JinCode — Termux / Android preflight check.
#
# Verifies, before starting the server, that the installation is complete and
# coherent, and prints an actionable diagnosis instead of a mid-boot error:
#   1. toolchain: Node.js (>= 22, warns below 24.9) and pnpm
#   2. harness checkout: exists and carries the JinCode fork patch
#   3. build artifacts: web dist and host libs are present
#   4. profile: the `jincode` profile is installed in $DSH_HOME
#   5. model configuration: an API key is saved in $DSH_HOME/.credentials.yaml
#   6. --deep: composes the profile through the harness (`dsh --dump-config`)
#      and confirms the Termux rows are present with no patch warnings
#
# Usage:
#   bash termux/check.sh            # fast checks
#   bash termux/check.sh --deep     # also compose the profile (slower)
# Environment:
#   JINCODE_HARNESS_DIR  harness checkout (default: <repo>/harness)
#   DSH_HOME             harness home (default: ~/.dsh)
#   JINCODE_ENV_FILE     optional env file for endpoint/model settings (default: ~/.jincode/env)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HARNESS_DIR="${JINCODE_HARNESS_DIR:-$REPO_ROOT/harness}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
ENV_FILE="${JINCODE_ENV_FILE:-$HOME/.jincode/env}"
PROFILE_NAME="jincode"
DEEP=0
[[ "${1:-}" == "--deep" ]] && DEEP=1

PASS=0
WARN=0
FAIL=0

pass() { printf '  \033[1;32mPASS\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
warn() { printf '  \033[1;33mWARN\033[0m %s\n' "$*"; WARN=$((WARN + 1)); }
fail() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }

section "JinCode preflight"
if [[ -n "${PREFIX:-}" && "$PREFIX" == *com.termux* ]]; then
  printf '  \033[2menvironment: Termux (%s)\033[0m\n' "$PREFIX"
else
  printf '  \033[2menvironment: %s\033[0m\n' "$(uname -s 2>/dev/null || echo unknown)"
fi
printf '  harness:     %s\n' "$HARNESS_DIR"
printf '  dsh home:    %s\n' "$DSH_HOME"

# ── 1. toolchain ───────────────────────────────────────────────────────────
section "1. Toolchain"
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -v)"
  NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [[ "$NODE_MAJOR" -lt 22 ]]; then
    fail "Node.js $NODE_VERSION is too old — JinCode needs >= 22 (Termux: pkg install nodejs)"
  elif [[ "$NODE_MAJOR" -lt 24 ]]; then
    warn "Node.js $NODE_VERSION — builds and runs, but the harness engine wants >= 24.9"
  else
    pass "Node.js $NODE_VERSION"
  fi
else
  fail "node not found — install Node.js >= 22 (Termux: pkg install nodejs)"
fi

if command -v pnpm >/dev/null 2>&1; then
  pass "pnpm $(pnpm --version)"
else
  warn "pnpm not found — setup.sh installs it (npm i -g pnpm@<version from the harness packageManager field>)"
fi

# ── 2. harness checkout + fork patch ───────────────────────────────────────
section "2. Harness checkout and fork patch"
if [[ -f "$HARNESS_DIR/apps/cli/package.json" ]]; then
  pass "harness checkout present"
  if [[ -f "$HARNESS_DIR/packages/client/ui-layout/src/client/MobileFrame.tsx" \
     && -f "$HARNESS_DIR/packages/client/ui-layout/src/client/RootFrame.tsx" ]]; then
    pass "mobile-first UI patch applied (MobileFrame/RootFrame)"
  else
    fail "mobile-first UI patch NOT applied — re-run termux/setup.sh"
  fi
  if grep -q "defaultMode" "$HARNESS_DIR/packages/shell/bash-local/src/index.ts" 2>/dev/null; then
    pass "bash-local engine change applied (sandboxMode reporting)"
  else
    fail "bash-local engine change NOT applied — re-run termux/setup.sh"
  fi
else
  fail "harness checkout missing at $HARNESS_DIR — run termux/setup.sh first"
fi

# ── 3. build artifacts ─────────────────────────────────────────────────────
section "3. Build artifacts"
if [[ -f "$HARNESS_DIR/apps/web/dist/index.html" ]]; then
  pass "web client dist present (apps/web/dist)"
else
  fail "web client dist missing — run termux/setup.sh (or rebuild: pnpm run build)"
fi
if [[ -f "$HARNESS_DIR/apps/cli/lib/bin.js" ]]; then
  pass "CLI lib present (apps/cli/lib)"
else
  warn "CLI lib missing — the server runs from source via tsx, but a full build is recommended"
fi

# ── 4. profile ─────────────────────────────────────────────────────────────
section "4. Profile"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
if [[ -f "$PROFILE_DIR/cordis.patch.yml" && -f "$PROFILE_DIR/package.json" ]]; then
  pass "profile '$PROFILE_NAME' installed ($PROFILE_DIR)"
else
  fail "profile '$PROFILE_NAME' missing — run termux/setup.sh"
fi

# ── 5. model configuration ────────────────────────────────────────────────
section "5. Model configuration"
if [[ -z "${JINCODE_API_KEY:-}" && -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
STORE_FILE="$DSH_HOME/.credentials.yaml"
if [[ -f "$STORE_FILE" ]] && grep -q '^[[:space:]]*JINCODE_API_KEY:' "$STORE_FILE"; then
  pass "API key saved on the Models page ($STORE_FILE)"
  mode="$(stat -c %a "$STORE_FILE" 2>/dev/null || echo unknown)"
  if [[ "$mode" != 600 ]]; then
    fail "$STORE_FILE has mode $mode — the harness refuses to read it; run: chmod 600 $STORE_FILE"
  fi
elif [[ -n "${JINCODE_API_KEY:-}" ]]; then
  pass "JINCODE_API_KEY set in the environment (a key saved on the Models page takes precedence)"
else
  warn "no API key yet — after starting, open the Models page (JinCode) and enter it"
fi
if [[ -z "${JINCODE_MODEL:-}" ]]; then
  warn "JINCODE_MODEL unset — the route default gpt-4o-mini applies until you pick a model in the Models page"
fi

# ── 6. deep: compose the profile ───────────────────────────────────────────
if [[ "$DEEP" -eq 1 ]]; then
  section "6. Deep check (profile composition)"
  if [[ "$FAIL" -gt 0 ]]; then
    warn "skipped — fix the FAIL items above first"
  elif [[ -f "$HARNESS_DIR/apps/cli/package.json" && -f "$PROFILE_DIR/cordis.patch.yml" ]]; then
    DUMP="$(cd "$HARNESS_DIR" && DSH_HOME="$DSH_HOME" node --import tsx/esm apps/cli/src/bin.ts \
      --profile "$PROFILE_NAME" --dump-config 2>&1)"
    if [[ $? -ne 0 ]]; then
      fail "profile composition failed:"
      printf '%s\n' "$DUMP" | sed 's/^/      /' | head -10
    elif printf '%s' "$DUMP" | grep -q "name mismatch\|did not activate\|warning"; then
      fail "profile composition reported warnings:"
      printf '%s\n' "$DUMP" | grep -i "warning\|mismatch\|did not activate" | sed 's/^/      /' | head -10
    elif printf '%s' "$DUMP" | grep -q "id: bash-local" \
      && printf '%s' "$DUMP" | grep -q "provider: jincode" \
      && printf '%s' "$DUMP" | grep -q "danger-full-access"; then
      pass "profile composes cleanly (bash-local, jincode route, danger-full-access)"
    else
      fail "profile composed but the Termux rows are missing from the tree"
    fi
  fi
fi

# ── summary ───────────────────────────────────────────────────────────────
section "Summary"
printf '  %d passed, %d warning(s), %d failure(s)\n' "$PASS" "$WARN" "$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  printf '\n\033[1;31mThe installation is not ready.\033[0m Fix the failures and re-run: bash termux/check.sh\n'
  exit 1
fi
if [[ "$WARN" -gt 0 ]]; then
  printf '\nReady with warnings — review them above before starting.\n'
else
  printf '\n\033[1;32mReady.\033[0m Start with: bash termux/start.sh\n'
fi
exit 0
