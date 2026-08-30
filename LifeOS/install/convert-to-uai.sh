#!/usr/bin/env bash
#
# Convert an existing PAI install to UAI (Universal AI Infrastructure).
#
# Thin wrapper over update-installed.sh: overlays the UAI release's managed
# files onto the framework install recorded in ~/.pai/framework.json, then
# writes a UAI distribution marker (~/.pai/distribution.json). Preserves USER,
# MEMORY, settings, config, auth, env files, and hook trust state exactly as
# the updater does.
#
# Examples:
#   # Convert using the UAI content bundled in this clone (offline):
#   bash ./convert-to-uai.sh
#   # Preview without changing anything:
#   bash ./convert-to-uai.sh --dry-run
#   # Pull the UAI repo fresh before overlaying:
#   bash ./convert-to-uai.sh --fetch

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
UPDATER="$SCRIPT_DIR/update-installed.sh"

REPO_URL="https://github.com/jSydorowicz21/Universal-AI-Infrustructure.git"
BRANCH="main"
FRAMEWORK=""
SOURCE_DIR=""
FETCH=0
NO_PULL=0
DRY_RUN=0
ASSUME_YES=0

info() { printf '  [INFO] %s\n' "$*" >&2; }
success() { printf '  [OK] %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*" >&2; }
fail() { printf '  [ERROR] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
UAI | Convert PAI install -> Universal AI Infrastructure

Usage:
  convert-to-uai.sh [options]

Options:
  --framework NAME    claude, codex, or opencode (default: from ~/.pai/framework.json)
  --source-dir PATH   Use a local UAI checkout / release root instead of the bundled one
  --fetch             Clone the UAI repo fresh instead of using the bundled content
  --repo-url URL      UAI repo to fetch when --fetch is used (default: the UAI GitHub repo)
  --branch NAME       Branch to fetch when --fetch is used (default: main)
  --no-pull           With --source-dir, do not git pull the checkout first
  --dry-run           Show planned updates without writing files or the marker
  -y, --yes           Do not prompt for confirmation
  -h, --help          Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --framework) FRAMEWORK="${2:?missing value for --framework}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:?missing value for --source-dir}"; shift 2 ;;
    --repo-url) REPO_URL="${2:?missing value for --repo-url}"; shift 2 ;;
    --branch) BRANCH="${2:?missing value for --branch}"; shift 2 ;;
    --fetch) FETCH=1; shift ;;
    --no-pull) NO_PULL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[ -f "$UPDATER" ] || fail "update-installed.sh not found next to this script: $UPDATER"

printf '\nUAI | Convert PAI install -> Universal AI Infrastructure\n\n'
if [ -n "$SOURCE_DIR" ]; then
  info "Source: $SOURCE_DIR"
elif [ "$FETCH" -eq 1 ]; then
  info "Source: $REPO_URL ($BRANCH)"
else
  info "Source: bundled UAI content in this clone"
fi
info "Overlays UAI managed files onto the install in ~/.pai/framework.json."
info "Does NOT touch USER, MEMORY, settings, config, auth, env, or hook trust state."

if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  printf '  Proceed with conversion? [y/N] ' >&2
  read -r reply || reply=""
  case "$reply" in
    y|Y|yes|YES) : ;;
    *) warn "Aborted; nothing changed."; exit 0 ;;
  esac
fi

args=()
[ -n "$FRAMEWORK" ] && args+=(--framework "$FRAMEWORK")
[ "$DRY_RUN" -eq 1 ] && args+=(--dry-run)
if [ -n "$SOURCE_DIR" ]; then
  args+=(--source-dir "$SOURCE_DIR")
  [ "$NO_PULL" -eq 1 ] && args+=(--no-pull)
elif [ "$FETCH" -eq 1 ]; then
  args+=(--repo-url "$REPO_URL" --branch "$BRANCH")
else
  # No source and no fetch: use the UAI content bundled alongside this script.
  args+=(--no-pull)
fi

info "Running updater: $UPDATER"
bash "$UPDATER" "${args[@]}"

if [ "$DRY_RUN" -eq 1 ]; then
  info "Dry run complete. No files changed and no distribution marker written."
  exit 0
fi

DATA_DIR="${PAI_DATA_DIR:-$HOME/.pai}"
mkdir -p "$DATA_DIR"
MARKER="$DATA_DIR/distribution.json"
CONVERTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
cat > "$MARKER" <<EOF
{
  "name": "UAI",
  "fullName": "Universal AI Infrastructure",
  "upstream": "Personal AI Infrastructure (PAI) by Daniel Miessler",
  "repo": "https://github.com/jSydorowicz21/Universal-AI-Infrustructure",
  "branch": "$BRANCH",
  "convertedAt": "$CONVERTED_AT"
}
EOF
success "Wrote UAI distribution marker: $MARKER"
success "Conversion complete. Restart your agent session so instructions reload."
