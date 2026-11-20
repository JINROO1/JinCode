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
if [[ ! "$HARNESS_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "setup.sh: termux/HARNESS_COMMIT must be a full 40-character commit SHA (found: '$HARNESS_COMMIT')" >&2
  exit 1
fi
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
# This step touches ONLY nodejs and git. It never runs 'pkg upgrade' and never
# runs 'dpkg --configure -a' (that would reconfigure every pending package,
# including unrelated programs such as omniroute or freebuff).
node_ok() { command -v node >/dev/null 2>&1 && node -v >/dev/null 2>&1; }

IS_TERMUX=0
if [[ -n "${PREFIX:-}" && "$PREFIX" == *com.termux* ]]; then
  IS_TERMUX=1
  log "Termux detected ($PREFIX)"
  if command -v node >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
    log "node and git are already installed — no packages changed"
  elif command -v pkg >/dev/null 2>&1; then
    # Install only what is missing, one package at a time. Nothing else is upgraded.
    pkg update -y || log "warning: 'pkg update' reported errors — continuing with current package lists"
    if ! command -v node >/dev/null 2>&1; then
      pkg install -y nodejs || die "could not install nodejs with pkg (other packages were not touched). See termux/README.md > Troubleshooting"
    fi
    if ! command -v git >/dev/null 2>&1; then
      pkg install -y git || die "could not install git with pkg (other packages were not touched). See termux/README.md > Troubleshooting"
    fi
  else
    die "pkg not found — install Node.js >= 22 and git manually"
  fi
else
  log "non-Termux shell — assuming Node.js >= 22 and git are already installed"
fi

command -v git >/dev/null 2>&1 || die "git not found — Termux: pkg install git (see termux/README.md > Troubleshooting)"
command -v node >/dev/null 2>&1 || die "node not found — Termux: pkg install nodejs (see termux/README.md > Troubleshooting)"
if ! node_ok; then
  die "node is installed but cannot start ($(node -v 2>&1 | tail -n 1)). Usually a libicu version mismatch: the nodejs binary needs a libicu.so version that is not on the system. This script does NOT upgrade libicu or other packages on its own, because other programs link against it. Options are in termux/README.md > Troubleshooting (section 'node no arranca')."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  die "Node.js $(node -v) is too old — JinCode needs Node.js >= 22 (24.9+ recommended)"
fi
[[ "$NODE_MAJOR" -ge 24 ]] && log "Node.js $(node -v) — engine requirement satisfied" \
  || log "Node.js $(node -v) — builds and runs, but the harness engine wants >= 24.9 (warning only)"


# ── 2. harness source + fork patch ──────────────────────────────────────────
if [[ ! -d "$HARNESS_DIR/.git" ]]; then
  log "cloning deepseek-harness at $HARNESS_COMMIT into $HARNESS_DIR"
  git clone --depth 1 --branch master https://github.com/deepseek-ai/deepseek-harness "$HARNESS_DIR"
  ( cd "$HARNESS_DIR" && git fetch --depth 1 origin "$HARNESS_COMMIT" \
      && git checkout -q "$HARNESS_COMMIT" ) \
    || die "could not check out the pinned harness commit"
else
  HEAD_NOW="$(cd "$HARNESS_DIR" && git rev-parse HEAD 2>/dev/null || echo unknown)"
  if [[ "$HEAD_NOW" != "$HARNESS_COMMIT" ]]; then
    die "$HARNESS_DIR is at $HEAD_NOW, expected $HARNESS_COMMIT. Remove it (rm -rf \"$HARNESS_DIR\") and re-run setup.sh"
  fi
  log "reusing existing harness checkout at $HARNESS_DIR (pinned commit)"
fi

if ! ( cd "$HARNESS_DIR" && git apply --check "$PATCH_FILE" 2>/dev/null ); then
  # The checkout may already carry the patch (e.g. a re-run after a partial setup).
  if ( cd "$HARNESS_DIR" && git apply --reverse --check "$PATCH_FILE" 2>/dev/null ); then
    log "fork patch already applied — skipping"
  else
    # An older fork state (a previous patch revision) is in this checkout. The
    # checkout belongs to this script, so restore the pinned commit and apply the
    # current patch. Git-ignored build output (node_modules, lib, dist) is kept.
    log "harness carries an older fork state — restoring the pinned commit"
    ( cd "$HARNESS_DIR" && git reset -q --hard HEAD && git clean -fdq ) \
      || die "could not restore $HARNESS_DIR to the pinned commit"
    ( cd "$HARNESS_DIR" && git apply --check "$PATCH_FILE" ) \
      || die "jincode-harness.patch does not apply to the pinned commit — update the patch"
    log "applying the JinCode fork patch (mobile-first UI)"
    ( cd "$HARNESS_DIR" && git apply "$PATCH_FILE" )
  fi
else
  log "applying the JinCode fork patch (mobile-first UI)"
  ( cd "$HARNESS_DIR" && git apply "$PATCH_FILE" )
fi

# ── 3. dependencies + build ─────────────────────────────────────────────────
# pnpm version = packageManager field of the harness. Installed from npm as the
# pure-JavaScript package: Corepack / @pnpm/exe ship native binaries that do not
# exist for android-arm64, so they cannot run on Termux.
ensure_pnpm() {
  local want="$1" have
  have="$(pnpm --version 2>/dev/null || true)"
  if [[ "$have" == "$want" ]]; then
    log "pnpm $have"
    return
  fi
  command -v npm >/dev/null 2>&1 || die "npm not found (Termux: pkg install nodejs)"
  # Remove only the Corepack shims left by an earlier run; npm refuses to overwrite them.
  GBIN="$(npm prefix -g)/bin"
  for f in pnpm pnpx; do
    if [[ -L "$GBIN/$f" && "$(readlink "$GBIN/$f")" == *corepack* ]]; then
      log "removing Corepack shim $GBIN/$f"
      rm -f "$GBIN/$f"
    fi
  done
  log "installing pnpm@$want from npm (pure JavaScript, works on Termux)"
  npm install -g "pnpm@$want" || die "could not install pnpm@$want with npm"
  # Put npm's global bin first so this pnpm wins over any other pnpm on PATH
  # (e.g. a standalone install in ~/.local/share/pnpm or a PNPM_HOME entry).
  export PATH="$GBIN:$PATH"
  hash -r
  have="$(pnpm --version 2>/dev/null || true)"
  [[ "$have" == "$want" ]] || die "pnpm resolves to '$(command -v pnpm)' (version '$have'), expected $want. Remove the other pnpm (see 'which -a pnpm') and re-run setup.sh"
  log "pnpm $have ($(command -v pnpm))"
}
PNPM_WANT="$(cd "$HARNESS_DIR" && node -p "require('./package.json').packageManager" | sed 's/^pnpm@//')"
[[ -n "$PNPM_WANT" ]] || die "could not read the pnpm version from $HARNESS_DIR/package.json"
ensure_pnpm "$PNPM_WANT"
log "installing dependencies (engine-strict off for older Node)"
# Mobile networks drop connections; pnpm's own retries are short, so retry the install a few times.
# Re-running is safe: packages already in the pnpm store are reused.
install_deps() {
  local attempt extra=()
  # koffi (Windows FFI) has no android-arm64 prebuild and fails to compile on Termux.
  # It is only loaded on Windows, so on Termux skip all install scripts and rebuild
  # just what the runtime needs (see below).
  if [[ "$IS_TERMUX" == 1 ]]; then extra+=(--ignore-scripts); fi
  for attempt in 1 2 3; do
    if ( cd "$HARNESS_DIR" && pnpm install --config.engine-strict=false ${extra[@]+"${extra[@]}"} ); then
      break
    fi
    log "pnpm install failed (attempt $attempt of 3) — network drop or registry error; retrying in 20s"
    sleep 20
    if [[ "$attempt" == 3 ]]; then
      die "pnpm install failed after 3 attempts. Check the connection and re-run termux/setup.sh (completed packages are cached)"
    fi
  done
  if [[ "$IS_TERMUX" == 1 ]]; then
    log "Termux: install scripts skipped (koffi is Windows-only). Rebuilding esbuild (required) and node-pty (terminal, optional)"
    ( cd "$HARNESS_DIR" && pnpm rebuild esbuild ) || die "esbuild install step failed"
    ( cd "$HARNESS_DIR" && pnpm rebuild node-pty ) \
      || log "warning: node-pty did not build on this device — the persistent terminal may be unavailable; everything else works"
  fi
}
install_deps

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

  1. Start the server:
       bash $SCRIPT_DIR/start.sh
  2. Open http://127.0.0.1:3080 on the phone. The first visit prints a ?token=...
     URL — open it once to authorize the browser. For another device on the
     same network, start with the phone's LAN address: HOST=<phone-ip> start.sh
  3. Models page: choose the JinCode route, enter your OpenAI-compatible
     endpoint and API key there, as in DeepSeek Harness. The key is stored in
     $DSH_HOME/.credentials.yaml; no environment variable is needed.

The mobile-first UI adapts automatically below 820px width; desktop layouts
are unchanged above that breakpoint.
EOF
