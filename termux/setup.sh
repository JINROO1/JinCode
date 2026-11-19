#!/data/data/com.termux/files/usr/bin/bash
# JinCode — Termux / Android setup.
#
# Prepares a self-contained JinCode installation on a phone:
#   1. toolchain: Node.js + pnpm (Termux packages)
#   2. harness source: shallow clone of deepseek-ai/deepseek-harness at the
#      pinned commit, with the JinCode fork patch applied (mobile-first UI)
#   3. dependencies + full build (host + web client)
#   4. profile: installs the `jincode` profile (Termux sandbox + model route
#      adaptation) into $DSH_HOME/profiles/jincode
#
# Usage (from inside the JinCode repo):
#   bash termux/setup.sh
# Optional flags:
#   --skip-build    install dependencies and the profile, skip the build
#   --harness DIR   use an existing harness checkout instead of cloning
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HARNESS_COMMIT="$(tr -d '[:space:]' < "$SCRIPT_DIR/HARNESS_COMMIT")"
PATCH_FILE="$SCRIPT_DIR/patches/jincode-harness.patch"
PROFILE_NAME="jincode"

SKIP_BUILD=0
HARNESS_DIR="${JINCODE_HARNESS_DIR:-$REPO_ROOT/harness}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --harness) HARNESS_DIR="$2"; shift 2 ;;
    *) echo "setup.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m[jincode]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[jincode] error:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. toolchain ───────────────────────────────────────────────────────────
if [[ -n "${PREFIX:-}" && "$PREFIX" == *com.termux* ]]; then
  log "Termux detected ($PREFIX)"
  if command -v pkg >/dev/null 2>&1; then
    pkg update -y || log "warning: 'pkg update' reported errors — continuing with current package lists"
    if ! pkg install -y nodejs git; then
      # A broken unrelated package (e.g. a post-install script that fails) leaves
      # dpkg half-configured and makes 'pkg install' exit non-zero even when
      # nodejs/git were unpacked. Try to repair dpkg, then retry once.
      log "warning: 'pkg install' reported errors — repairing the package database and retrying"
      dpkg --configure -a || log "warning: dpkg still has unconfigured packages (see the list above)"
      pkg install -y nodejs git || log "warning: 'pkg install' still failing — checking node/git directly"
    fi
  else
    log "warning: 'pkg' not found — checking node/git directly"
  fi
else
  log "non-Termux shell — assuming Node.js >= 22 and git are already installed"
fi

if ! command -v git >/dev/null 2>&1; then
  die "git not found — Termux: pkg install git (if pkg keeps failing, see termux/README.md > Troubleshooting)"
fi
command -v node >/dev/null 2>&1 || die "node not found — Termux: pkg install nodejs. If pkg fails with a dpkg/libicu error, run 'pkg upgrade -y' then 'dpkg --configure -a' and re-run this script (see termux/README.md > Troubleshooting)"
if ! node -v >/dev/null 2>&1; then
  die "node is installed but cannot start ($(node -v 2>&1 | tail -n 1)). This is a libicu mismatch between nodejs and the system ICU library. Fix: 'pkg upgrade -y' then 'dpkg --configure -a'. If it still fails: 'termux-change-repo', choose the official mirror (packages.termux.dev), then 'pkg update -y && pkg upgrade -y' and re-run this script (see termux/README.md > Troubleshooting)."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  die "Node.js $(node -v) is too old — JinCode needs Node.js >= 22 (24.9+ recommended)"
fi
[[ "$NODE_MAJOR" -ge 24 ]] && log "Node.js $(node -v) — engine requirement satisfied" \
  || log "Node.js $(node -v) — builds and runs, but the harness engine wants >= 24.9 (warning only)"

if ! command -v pnpm >/dev/null 2>&1; then
  log "activating pnpm via corepack"
  corepack enable || die "corepack unavailable — install pnpm manually (npm i -g pnpm)"
  corepack prepare pnpm@11.28.5 --activate || die "could not activate pnpm"
fi
log "pnpm $(pnpm --version)"

# ── 2. harness source + fork patch ──────────────────────────────────────────
if [[ ! -d "$HARNESS_DIR/.git" ]]; then
  log "cloning deepseek-harness at $HARNESS_COMMIT into $HARNESS_DIR"
  git clone --depth 1 --branch master https://github.com/deepseek-ai/deepseek-harness "$HARNESS_DIR"
  ( cd "$HARNESS_DIR" && git fetch --depth 1 origin "$HARNESS_COMMIT" \
      && git checkout -q "$HARNESS_COMMIT" ) \
    || die "could not check out the pinned harness commit"
else
  log "reusing existing harness checkout at $HARNESS_DIR"
fi

if ! ( cd "$HARNESS_DIR" && git apply --check "$PATCH_FILE" 2>/dev/null ); then
  # The checkout may already carry the patch (e.g. a re-run after a partial setup).
  if ( cd "$HARNESS_DIR" && git apply --reverse --check "$PATCH_FILE" 2>/dev/null ); then
    log "fork patch already applied — skipping"
  else
    die "jincode-harness.patch does not apply to $HARNESS_DIR — re-clone the harness or update the patch"
  fi
else
  log "applying the JinCode fork patch (mobile-first UI)"
  ( cd "$HARNESS_DIR" && git apply "$PATCH_FILE" )
fi

# ── 3. dependencies + build ─────────────────────────────────────────────────
log "installing dependencies (engine-strict off for older Node)"
( cd "$HARNESS_DIR" && pnpm install --config.engine-strict=false )

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  log "building host + web client (this takes several minutes; see README for swap tips)"
  ( cd "$HARNESS_DIR" && pnpm run build )
else
  log "--skip-build: skipping the build (a stale dist may be served)"
fi

# ── 4. profile ─────────────────────────────────────────────────────────────
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
log "installing profile '$PROFILE_NAME' into $PROFILE_DIR"
mkdir -p "$PROFILE_DIR"
cp "$SCRIPT_DIR/profile.package.json" "$PROFILE_DIR/package.json"
cp "$SCRIPT_DIR/profile.cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"

cat <<EOF

JinCode is ready. Next steps:

  1. Configure the model endpoint (any OpenAI-compatible API):
       cat > ~/.jincode/env <<'ENV'
       JINCODE_API_KEY=sk-...
       JINCODE_BASE_URL=https://your-endpoint/v1
       JINCODE_MODEL=your-model-id
       ENV
  2. Start the server:
       bash $SCRIPT_DIR/start.sh
  3. Open http://127.0.0.1:3080 on the phone (or http://<phone-ip>:3080 from
     another device on the same network). The first visit prints a ?token=...
     URL — open it once to authorize the browser.

The mobile-first UI adapts automatically below 820px width; desktop layouts
are unchanged above that breakpoint.
EOF
