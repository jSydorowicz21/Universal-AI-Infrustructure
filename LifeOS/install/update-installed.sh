#!/usr/bin/env bash
#
# PAI Installed Hotfix Updater
#
# Fetches a PAI release bundle, reads hotfix-manifest.json, and overlays only
# the managed files listed there into an existing framework install. It
# intentionally does not touch USER, MEMORY, settings.json, config.toml, auth,
# env files, or hook trust state.

set -euo pipefail

REPO_URL="https://github.com/haydencj/Personal_AI_Infrastructure.git"
BRANCH="pai-codex-flawless-runtime"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
FRAMEWORK=""
INSTALL_ROOT=""
AGENTS_SKILLS_ROOT=""
SOURCE_DIR=""
MANIFEST_PATH=""
DRY_RUN=0
NO_PULL=0
KEEP_TEMP=0
TEMP_ROOT=""

info() { printf '  [INFO] %s\n' "$*" >&2; }
success() { printf '  [OK] %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*" >&2; }
fail() { printf '  [ERROR] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
PAI Installed Hotfix Updater

Usage:
  update-installed.sh [options]

Options:
  --repo-url URL          Git repository to fetch when --source-dir is omitted
  --branch NAME           Git branch to fetch
  --framework NAME        claude, codex, or opencode
  --install-root PATH     Existing framework home to patch
  --source-dir PATH       Local checkout or release root to use
  --manifest-path PATH    Override manifest path
  --dry-run               Show planned updates without writing files
  --no-pull               Do not fetch; without --source-dir use this updater's bundle
  --keep-temp             Keep the temporary clone
  -h, --help              Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-url) REPO_URL="${2:?missing value for --repo-url}"; shift 2 ;;
    --branch) BRANCH="${2:?missing value for --branch}"; shift 2 ;;
    --framework) FRAMEWORK="${2:?missing value for --framework}"; shift 2 ;;
    --install-root) INSTALL_ROOT="${2:?missing value for --install-root}"; shift 2 ;;
    --agents-skills-root) AGENTS_SKILLS_ROOT="${2:?missing value for --agents-skills-root}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:?missing value for --source-dir}"; shift 2 ;;
    --manifest-path) MANIFEST_PATH="${2:?missing value for --manifest-path}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-pull) NO_PULL=1; shift ;;
    --keep-temp) KEEP_TEMP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

cleanup() {
  if [ -n "$TEMP_ROOT" ] && [ "$KEEP_TEMP" -eq 0 ]; then
    case "$TEMP_ROOT" in
      "${TMPDIR:-/tmp}"/pai-hotfix-*|/tmp/pai-hotfix-*) rm -rf -- "$TEMP_ROOT" ;;
    esac
  elif [ -n "$TEMP_ROOT" ]; then
    info "Kept temp checkout: $TEMP_ROOT"
  fi
}
trap cleanup EXIT

absolute_path() {
  local path="$1"
  if [ -d "$path" ]; then
    (cd "$path" && pwd -P)
  else
    local dir base
    dir="$(dirname "$path")"
    base="$(basename "$path")"
    (cd "$dir" && printf '%s/%s\n' "$(pwd -P)" "$base")
  fi
}

normalize_framework() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | tr -d ' _-')"
  case "$value" in
    claude|claudecode) printf 'claude\n' ;;
    codex|openai|openaicodex) printf 'codex\n' ;;
    opencode) printf 'opencode\n' ;;
    *) printf '\n' ;;
  esac
}

json_tool() {
  if command -v python3 >/dev/null 2>&1; then
    printf 'python3\n'
  elif command -v python >/dev/null 2>&1; then
    printf 'python\n'
  elif command -v node >/dev/null 2>&1; then
    printf 'node\n'
  elif command -v bun >/dev/null 2>&1; then
    printf 'bun\n'
  else
    printf '\n'
  fi
}

read_framework_state_at() {
  local data_dir="$1"
  local state_path="$data_dir/framework.json"
  [ -f "$state_path" ] || return 0
  local tool
  tool="$(json_tool)"
  [ -n "$tool" ] || return 0

  if [ "$tool" = "python3" ] || [ "$tool" = "python" ]; then
    "$tool" - "$state_path" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
print("{}\t{}\t{}".format(data.get("active", "") or "", data.get("root", "") or "", data.get("dataDir", "") or ""))
PY
  else
    "$tool" -e 'const fs=require("fs"); try { const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(`${data.active||""}\t${data.root||""}\t${data.dataDir||""}`); } catch {}' "$state_path"
  fi
}

read_framework_state() {
  read_framework_state_at "$HOME/.pai"
}

framework_state_usable() {
  local root="${1:-}"
  [ -z "$root" ] || [ -e "$root" ]
}

stale_framework_env() {
  if [ -n "${PAI_FRAMEWORK_DIR:-}" ] && [ ! -e "$PAI_FRAMEWORK_DIR" ]; then
    return 0
  fi
  if [ -n "${PAI_DIR:-}" ] && [ ! -e "$PAI_DIR" ]; then
    return 0
  fi
  return 1
}

resolve_pai_data_dir() {
  local default_data_dir="$HOME/.pai"
  local state active root data_dir
  state="$(read_framework_state || true)"
  root="$(printf '%s' "$state" | awk -F '\t' 'NR==1 {print $2}')"
  data_dir="$(printf '%s' "$state" | awk -F '\t' 'NR==1 {print $3}')"

  if [ -n "${PAI_DATA_DIR:-}" ] && [ -e "$PAI_DATA_DIR" ]; then
    local env_state env_root
    env_state="$(read_framework_state_at "$PAI_DATA_DIR" || true)"
    env_root="$(printf '%s' "$env_state" | awk -F '\t' 'NR==1 {print $2}')"
    if { [ -z "$env_state" ] && { ! framework_state_usable "$root" || ! stale_framework_env; }; } || framework_state_usable "$env_root"; then
      absolute_path "$PAI_DATA_DIR"
      return 0
    fi
  fi

  if framework_state_usable "$root" && [ -n "$data_dir" ]; then
    absolute_path "$data_dir"
    return 0
  fi

  absolute_path "$default_data_dir"
}

resolve_pai_config_dir() {
  if [ -n "${PAI_CONFIG_DIR:-}" ] && [ -e "$PAI_CONFIG_DIR" ]; then
    absolute_path "$PAI_CONFIG_DIR"
    return 0
  fi
  printf '%s\n' "$HOME/.config/PAI"
}

resolve_target() {
  local state active root fw
  state="$(read_framework_state || true)"
  active="$(printf '%s' "$state" | awk -F '\t' 'NR==1 {print $1}')"
  root="$(printf '%s' "$state" | awk -F '\t' 'NR==1 {print $2}')"

  fw="$(normalize_framework "$FRAMEWORK")"
  if [ -z "$fw" ] && [ -n "${PAI_FRAMEWORK:-}" ]; then fw="$(normalize_framework "$PAI_FRAMEWORK")"; fi
  if [ -z "$fw" ] && [ -n "$active" ]; then fw="$(normalize_framework "$active")"; fi
  if [ -z "$fw" ]; then
    if [ -n "${CODEX_HOME:-}" ] || [ -d "$HOME/.codex" ]; then fw="codex"
    elif [ -n "${CLAUDE_HOME:-}" ] || [ -d "$HOME/.claude" ]; then fw="claude"
    elif [ -n "${OPENCODE_CONFIG_DIR:-}" ] || [ -d "$HOME/.config/opencode" ]; then fw="opencode"
    fi
  fi
  [ -n "$fw" ] || fail "Could not determine framework. Pass --framework codex|claude|opencode."

  local target_root="$INSTALL_ROOT"
  if [ -z "$target_root" ] && [ -n "$active" ] && [ "$(normalize_framework "$active")" = "$fw" ] && [ -n "$root" ]; then
    target_root="$root"
  fi
  if [ -z "$target_root" ]; then
    case "$fw" in
      codex) target_root="${CODEX_HOME:-$HOME/.codex}" ;;
      claude) target_root="${CLAUDE_HOME:-$HOME/.claude}" ;;
      opencode) target_root="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}" ;;
    esac
  fi

  target_root="$(absolute_path "$target_root")"
  [ -d "$target_root" ] || fail "Install root does not exist: $target_root"
  printf '%s\t%s\n' "$fw" "$target_root"
}

resolve_release_root() {
  local path candidate
  path="$(absolute_path "$1")"
  if [ -f "$path/CLAUDE.md" ] && [ -d "$path/PAI" ]; then
    printf '%s\n' "$path"
    return 0
  fi
  candidate="$path/Releases/v5.0.0/.claude"
  if [ -f "$candidate/CLAUDE.md" ] && [ -d "$candidate/PAI" ]; then
    absolute_path "$candidate"
    return 0
  fi
  fail "Could not locate release root under $path"
}

get_release_root() {
  if [ -n "$SOURCE_DIR" ]; then
    local source_abs
    source_abs="$(absolute_path "$SOURCE_DIR")"
    info "Using local source: $source_abs"
    if [ "$NO_PULL" -eq 0 ] && [ -d "$source_abs/.git" ]; then
      command -v git >/dev/null 2>&1 || fail "Git is required to update local source. Install Git or pass --no-pull."
      info "Updating local source with git fetch + pull --ff-only"
      git -C "$source_abs" fetch --prune >&2
      git -C "$source_abs" pull --ff-only >&2
    fi
    resolve_release_root "$source_abs"
    return 0
  fi

  if [ "$NO_PULL" -eq 1 ]; then
    local script_abs
    script_abs="$(absolute_path "$SCRIPT_DIR")"
    info "Using bundled source because --no-pull was passed without --source-dir: $script_abs"
    resolve_release_root "$script_abs"
    return 0
  fi

  command -v git >/dev/null 2>&1 || fail "Git is required for fetching hotfixes. Install Git or pass --source-dir."
  TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pai-hotfix-XXXXXX")"
  info "Fetching $REPO_URL ($BRANCH) into $TEMP_ROOT"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TEMP_ROOT" >&2
  resolve_release_root "$TEMP_ROOT"
}

manifest_entries() {
  local manifest="$1"
  local framework="$2"
  local tool
  tool="$(json_tool)"
  [ -n "$tool" ] || fail "Need python3, python, node, or bun to parse $manifest"

  if [ "$tool" = "python3" ] || [ "$tool" = "python" ]; then
    "$tool" - "$manifest" "$framework" <<'PY'
import json, sys
manifest, framework = sys.argv[1], sys.argv[2]
with open(manifest, "r", encoding="utf-8") as f:
    data = json.load(f)
for entry in data.get("entries", []):
    source = entry.get("source", "")
    target = ""
    if isinstance(entry.get("targets"), dict):
        target = entry["targets"].get(framework, "") or ""
    else:
        target = entry.get("target", "") or source
    if not target:
        continue
    transform = "1" if entry.get("transformInstructions") else "0"
    mirror = "1" if entry.get("mirrorToCodexAgentsSkills") else "0"
    print("\t".join([source, target, transform, mirror]))
PY
  else
    "$tool" -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const fw=process.argv[2]; for (const e of data.entries||[]) { const source=e.source||""; const target=e.targets ? (e.targets[fw]||"") : (e.target||source); if (!target) continue; console.log([source,target,e.transformInstructions?1:0,e.mirrorToCodexAgentsSkills?1:0].join("\t")); }' "$manifest" "$framework"
  fi
}

convert_instruction_content() {
  local source="$1"
  local framework="$2"
  local name="OpenCode"
  [ "$framework" = "codex" ] && name="Codex"

  sed \
    -e 's/\bCLAUDE\.md\b/AGENTS.md/g' \
    -e "s/Claude Code/$name/g" \
    -e 's#~/\.claude/PAI#$PAI_DIR#g' \
    -e 's#~/\.claude#$PAI_FRAMEWORK_DIR#g' \
    -e 's#\$PAI_FRAMEWORK_DIR/PAI#$PAI_DIR#g' \
    -e 's/^# AGENTS\.md.*$/# AGENTS.md/' \
    "$source"
}

copy_directory_contents() {
  local source="$1"
  local destination="$2"
  mkdir -p "$destination"
  (cd "$source" && tar cf - .) | (cd "$destination" && tar xf -)
}

# Decide what to do with an existing directory destination that may sit under a
# symlinked ancestor. absolute_path resolves symlinks (pwd -P), so when the
# resolved path differs from the literal path some ancestor is a symlink:
#   normal -> no symlinked ancestor, behave exactly as before
#   skip   -> destination already resolves to the managed source (dev symlink);
#             it is already current, do not delete/recopy through it
#   fail   -> destination resolves elsewhere through the symlinked ancestor;
#             refuse rather than recursively delete through it
reparse_target_action() {
  local target="$1"
  local source="$2"
  local real_target real_source
  real_target="$(absolute_path "$target")"
  if [ "$real_target" = "$target" ]; then
    printf 'normal\n'
    return 0
  fi
  real_source="$(absolute_path "$source")"
  if [ "$real_target" = "$real_source" ]; then
    printf 'skip\n'
  else
    printf 'fail\n'
  fi
}

# Replace a directory destination with the managed source without ever running
# rm -rf through a symlinked ancestor. Echoes "skipped" or "updated".
update_directory_target() {
  local target="$1"
  local source="$2"
  if [ -e "$target" ] || [ -L "$target" ]; then
    case "$(reparse_target_action "$target" "$source")" in
      skip)
        printf 'skipped\n'
        return 0
        ;;
      fail)
        fail "Refusing to replace '$target' through a symlinked ancestor or leaf (resolves to '$(absolute_path "$target")', not the managed source '$source'). Replace the symlink before updating."
        ;;
    esac
    # A symlinked leaf: remove only the link, never rm -rf through it. A real
    # directory: recursive delete is safe because no symlinked ancestor/leaf
    # remains (skip/fail handled above).
    if [ -L "$target" ]; then
      rm -- "$target"
    else
      rm -rf -- "$target"
    fi
  fi
  copy_directory_contents "$source" "$target"
  printf 'updated\n'
}

backup_relative_path() {
  local install_root="$1"
  local path="$2"
  local root_full path_full
  root_full="$(absolute_path "$install_root")"
  path_full="$(absolute_path "$path")"
  case "$path_full" in
    "$root_full") basename "$path_full" ;;
    "$root_full"/*) printf '%s\n' "${path_full#"$root_full"/}" ;;
    *) printf '%s\n' "$path_full" | sed 's#[:/\\]\+#_#g' ;;
  esac
}

backup_existing() {
  local install_root="$1"
  local path="$2"
  local backup_root="$3"
  [ -e "$path" ] || return 0
  local relative backup_path
  relative="$(backup_relative_path "$install_root" "$path")"
  backup_path="$backup_root/$relative"
  mkdir -p "$(dirname "$backup_path")"
  cp -R "$path" "$backup_path"
  printf '%s\n' "$backup_path"
}

apply_entry() {
  local release_root="$1"
  local install_root="$2"
  local framework="$3"
  local backup_root="$4"
  local source_rel="$5"
  local target_rel="$6"
  local transform="$7"
  local mirror="$8"

  source_rel="$(printf '%s' "$source_rel" | tr '\\' '/')"
  target_rel="$(printf '%s' "$target_rel" | tr '\\' '/')"
  local source="$release_root/$source_rel"
  local target="$install_root/$target_rel"
  [ -e "$source" ] || fail "Manifest source missing: $source"

  if [ "$DRY_RUN" -eq 1 ]; then
    info "DRY RUN $source_rel -> $target_rel"
    return 0
  fi

  # Dev installs symlink managed dirs back into the source tree. absolute_path
  # resolves a symlinked leaf AND symlinked ancestors, so this single guard covers
  # both. Same-source -> already current (skip rather than copy onto itself).
  # Foreign target -> refuse BEFORE any backup/copy so files are never written and
  # directories are never deleted or dumped through an unmanaged symlink.
  if [ -e "$target" ] || [ -L "$target" ]; then
    case "$(reparse_target_action "$target" "$source")" in
      skip)
        success "$target (dev symlink resolves to managed source; left unchanged)"
        return 0
        ;;
      fail)
        fail "Refusing to update '$target' through a symlinked ancestor or leaf (resolves to '$(absolute_path "$target")', not the managed source '$source'). Replace the symlink before updating."
        ;;
    esac
  fi

  local backup=""
  backup="$(backup_existing "$install_root" "$target" "$backup_root" || true)"
  mkdir -p "$(dirname "$target")"

  if [ -d "$source" ]; then
    if [ "$(update_directory_target "$target" "$source")" = "skipped" ]; then
      success "$target (dev symlink resolves to managed source; left unchanged)"
      return 0
    fi
  elif [ "$transform" = "1" ] && [ "$framework" != "claude" ]; then
    convert_instruction_content "$source" "$framework" > "$target"
  else
    cp "$source" "$target"
  fi

  if [ "$framework" = "codex" ] && [ "$mirror" = "1" ]; then
    case "$target_rel" in
      skills/*)
        local skill_name agents_root agents_target
        skill_name="$(basename "$target_rel")"
        agents_root="${AGENTS_SKILLS_ROOT:-$HOME/.agents/skills}"
        agents_target="$agents_root/$skill_name"
        backup_existing "$install_root" "$agents_target" "$backup_root" >/dev/null || true
        mkdir -p "$agents_root"
        update_directory_target "$agents_target" "$source" >/dev/null
        ;;
    esac
  fi

  if [ -n "$backup" ]; then
    success "$target (backup: $backup)"
  else
    success "$target (new file/dir)"
  fi
}

verify_install() {
  local install_root="$1"
  local framework="$2"
  local pai_dir="$install_root/PAI"
  local latest_path="$pai_dir/ALGORITHM/LATEST"
  if [ -f "$latest_path" ]; then
    local latest normalized algo_path
    latest="$(tr -d '[:space:]' < "$latest_path")"
    case "$latest" in v*) normalized="$latest" ;; *) normalized="v$latest" ;; esac
    algo_path="$pai_dir/ALGORITHM/$normalized.md"
    [ -f "$algo_path" ] || fail "Algorithm path does not resolve: $algo_path"
    success "Algorithm path resolves: $algo_path"
  fi

  local instruction="$install_root/AGENTS.md"
  [ "$framework" = "claude" ] && instruction="$install_root/CLAUDE.md"
  if [ -f "$instruction" ]; then
    if grep -Fq '$PAI_DIR/ALGORITHM/LATEST' "$instruction"; then
      success 'Instruction file points at $PAI_DIR/ALGORITHM/LATEST.'
    else
      warn "Instruction file does not mention \$PAI_DIR/ALGORITHM/LATEST: $instruction"
    fi
  fi
}

regenerate_codex_hooks_json() {
  local install_root="$1"
  local backup_root="$2"
  command -v bun >/dev/null 2>&1 || fail "Bun is required to regenerate Codex hooks.json after hotfix update."

  local script_path="$backup_root/regenerate-codex-hooks.ts"
  cat > "$script_path" <<'TS'
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const dataDir = process.argv[3];
const configDir = process.argv[4];

if (!root || !dataDir || !configDir) {
  console.error("Usage: regenerate-codex-hooks.ts <install-root> <data-dir> <config-dir>");
  process.exit(1);
}

const { generateCodexHooksJson } = await import(pathToFileURL(join(root, "PAI", "PAI-Install", "engine", "config-gen.ts")).href);
const config = {
  framework: "codex",
  principalName: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  aiName: "PAI",
  catchphrase: "",
  paiDir: root,
  configDir,
  dataDir,
};

await Bun.write(join(root, "hooks.json"), `${JSON.stringify(generateCodexHooksJson(config), null, 2)}\n`);
TS

  local data_dir
  data_dir="$(resolve_pai_data_dir)"
  local config_dir
  config_dir="$(resolve_pai_config_dir)"
  (cd "$install_root" && bun "$script_path" "$install_root" "$data_dir" "$config_dir")
  success "Regenerated Codex hooks.json from installed generator."
}

regenerate_opencode_native_artifacts() {
  local install_root="$1"
  local backup_root="$2"
  command -v bun >/dev/null 2>&1 || fail "Bun is required to regenerate OpenCode native artifacts after hotfix update."

  local pai_cli="$install_root/PAI/TOOLS/pai.ts"
  [ -f "$pai_cli" ] || fail "PAI CLI not found for OpenCode native regeneration: $pai_cli"

  backup_existing "$install_root" "$install_root/opencode.json" "$backup_root" >/dev/null || true
  backup_existing "$install_root" "$install_root/agents" "$backup_root" >/dev/null || true
  backup_existing "$install_root" "$install_root/commands" "$backup_root" >/dev/null || true

  local data_dir
  data_dir="$(resolve_pai_data_dir)"
  local config_dir
  config_dir="$(resolve_pai_config_dir)"
  (
    cd "$install_root"
    HOME="$HOME" \
    USERPROFILE="${USERPROFILE:-$HOME}" \
    OPENCODE_CONFIG_DIR="$install_root" \
    PAI_DATA_DIR="$data_dir" \
    PAI_CONFIG_DIR="$config_dir" \
    PAI_FRAMEWORK_DIR="$install_root" \
    PAI_FRAMEWORK="opencode" \
    PAI_SKIP_USER_ENV_UPDATE="1" \
    bun "$pai_cli" framework switch opencode
  )
  success "Regenerated OpenCode opencode.json, agents, and commands from installed PAI CLI."
}

migrate_claude_sessionend_lifecycle() {
  local install_root="$1"
  local backup_root="$2"
  local settings="$install_root/settings.json"
  [ -f "$settings" ] || { info "No settings.json to migrate: $settings"; return 0; }
  command -v bun >/dev/null 2>&1 || { warn "Bun not found; skipping SessionEnd lifecycle migration."; return 0; }
  local migrator="$install_root/PAI/TOOLS/SessionEndLifecycleMigrate.ts"
  [ -f "$migrator" ] || { warn "SessionEnd migrator not found: $migrator"; return 0; }
  backup_existing "$install_root" "$settings" "$backup_root" >/dev/null || true
  if bun "$migrator" --settings "$settings"; then
    success "SessionEnd lifecycle migration complete."
  else
    warn "SessionEnd lifecycle migration reported an error (left settings unchanged)."
  fi
}

write_pai_framework_state() {
  local install_root="$1"
  local framework="$2"
  local data_dir config_dir state_path
  data_dir="$(resolve_pai_data_dir)"
  config_dir="$(resolve_pai_config_dir)"
  state_path="$data_dir/framework.json"
  mkdir -p "$data_dir" "$config_dir"

  local tool
  tool="$(json_tool)"
  [ -n "$tool" ] || fail "Need python, node, or bun to write $state_path"
  if [ "$tool" = "python3" ] || [ "$tool" = "python" ]; then
    "$tool" - "$state_path" "$framework" "$install_root" "$install_root/PAI" "$data_dir" "$config_dir" <<'PY'
import json, sys
path, framework, root, pai_dir, data_dir, config_dir = sys.argv[1:7]
with open(path, "w", encoding="utf-8") as f:
    json.dump({
        "active": framework,
        "root": root,
        "paiDir": pai_dir,
        "dataDir": data_dir,
        "configDir": config_dir,
    }, f, indent=2)
    f.write("\n")
PY
  else
    "$tool" -e 'const fs=require("fs"); const [path, framework, root, paiDir, dataDir, configDir]=process.argv.slice(1); fs.writeFileSync(path, JSON.stringify({active:framework, root, paiDir, dataDir, configDir}, null, 2)+"\n");' "$state_path" "$framework" "$install_root" "$install_root/PAI" "$data_dir" "$config_dir"
  fi

  export PAI_FRAMEWORK="$framework"
  export PAI_FRAMEWORK_DIR="$install_root"
  export PAI_DIR="$install_root/PAI"
  export PAI_DATA_DIR="$data_dir"
  export PAI_CONFIG_DIR="$config_dir"
  success "Wrote PAI framework state: $state_path"
}

pai_shell_block() {
  local install_root="$1"
  local framework="$2"
  local data_dir config_dir pai_dir pai_script
  data_dir="$(resolve_pai_data_dir)"
  config_dir="$(resolve_pai_config_dir)"
  pai_dir="$install_root/PAI"
  pai_script="$pai_dir/TOOLS/pai.ts"
  cat <<EOF
# PAI aliases
initialize_pai_environment() {
  local default_pai_data_dir="$data_dir"
  if [ -z "\${PAI_DATA_DIR:-}" ] || [ ! -f "\$PAI_DATA_DIR/framework.json" ]; then export PAI_DATA_DIR="\$default_pai_data_dir"; fi
  pai_read_framework_state() {
    local path="\$1/framework.json"
    [ -f "\$path" ] || return 0
    if command -v python3 >/dev/null 2>&1; then
      python3 - "\$path" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
print("{}\t{}\t{}".format(data.get("active", "") or "", data.get("root", "") or "", data.get("dataDir", "") or ""))
PY
    elif command -v python >/dev/null 2>&1; then
      python - "\$path" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
print("{}\t{}\t{}".format(data.get("active", "") or "", data.get("root", "") or "", data.get("dataDir", "") or ""))
PY
    elif command -v node >/dev/null 2>&1; then
      node -e 'const fs=require("fs"); try { const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log((data.active||"")+"\t"+(data.root||"")+"\t"+(data.dataDir||"")); } catch {}' "\$path"
    elif command -v bun >/dev/null 2>&1; then
      bun -e 'const fs=require("fs"); try { const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log((data.active||"")+"\t"+(data.root||"")+"\t"+(data.dataDir||"")); } catch {}' "\$path"
    fi
  }
  local state_path="\$PAI_DATA_DIR/framework.json"
  if [ -f "\$state_path" ]; then
    local state_line state_root state_active state_data
    state_line="\$(pai_read_framework_state "\$PAI_DATA_DIR" 2>/dev/null || true)"
    state_active="\$(printf '%s' "\$state_line" | awk -F '\t' 'NR==1 {print \$1}')"
    state_root="\$(printf '%s' "\$state_line" | awk -F '\t' 'NR==1 {print \$2}')"
    state_data="\$(printf '%s' "\$state_line" | awk -F '\t' 'NR==1 {print \$3}')"
    if [ -n "\$state_root" ] && [ -d "\$state_root" ]; then export PAI_FRAMEWORK_DIR="\$state_root"; export PAI_DIR="\$PAI_FRAMEWORK_DIR/PAI"; fi
    if [ -n "\$state_active" ]; then export PAI_FRAMEWORK="\$state_active"; fi
    if [ -n "\$state_data" ] && [ -d "\$state_data" ]; then export PAI_DATA_DIR="\$state_data"; fi
  fi
  if [ -z "\${PAI_FRAMEWORK_DIR:-}" ] || [ ! -d "\$PAI_FRAMEWORK_DIR" ]; then export PAI_FRAMEWORK_DIR="$install_root"; fi
  if [ -z "\${PAI_DIR:-}" ] || [ ! -d "\$PAI_DIR" ]; then export PAI_DIR="$pai_dir"; fi
  if [ -z "\${PAI_FRAMEWORK:-}" ]; then export PAI_FRAMEWORK="$framework"; fi
  if [ -z "\${PAI_CONFIG_DIR:-}" ] || [ ! -d "\$PAI_CONFIG_DIR" ]; then export PAI_CONFIG_DIR="$config_dir"; fi
  export UAI_DIR="\$PAI_DIR"
  export UAI_DATA_DIR="\$PAI_DATA_DIR"
  export UAI_CONFIG_DIR="\$PAI_CONFIG_DIR"
  export UAI_FRAMEWORK_DIR="\$PAI_FRAMEWORK_DIR"
  export UAI_FRAMEWORK="\$PAI_FRAMEWORK"
}
initialize_pai_environment
pai() {
  initialize_pai_environment
  bun "$pai_script" "\$@"
}
uai() {
  initialize_pai_environment
  bun "$pai_script" "\$@"
}
k() {
  pai "\$@"
}
EOF
}

shell_profile_candidates() {
  [ -n "${PAI_SHELL_PROFILE:-}" ] && printf '%s\n' "$PAI_SHELL_PROFILE"
  printf '%s\n' "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"
}

repair_shell_profiles() {
  local install_root="$1"
  local framework="$2"
  local backup_root="$3"
  local block
  block="$(pai_shell_block "$install_root" "$framework")"
  while IFS= read -r profile_path; do
    [ -n "$profile_path" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      info "DRY RUN repair shell profile $profile_path"
      continue
    fi
    mkdir -p "$(dirname "$profile_path")"
    if [ -f "$profile_path" ]; then
      backup_existing "$install_root" "$profile_path" "$backup_root" >/dev/null || true
      local cleaned
      cleaned="$(awk '
        /^# PAI aliases$/ { skip=1; next }
        skip && /^# / { skip=0 }
        !skip { print }
      ' "$profile_path")"
      printf '%s\n\n%s\n' "$cleaned" "$block" > "$profile_path"
    else
      printf '%s\n' "$block" > "$profile_path"
    fi
    success "Repaired shell PAI bootstrap: $profile_path"
  done < <(shell_profile_candidates | awk 'NF && !seen[$0]++')
}

printf '\nPAI | Installed Hotfix Updater\n\n'

target="$(resolve_target)"
target_framework="$(printf '%s' "$target" | awk -F '\t' 'NR==1 {print $1}')"
target_root="$(printf '%s' "$target" | awk -F '\t' 'NR==1 {print $2}')"
info "Framework: $target_framework"
info "Install root: $target_root"

release_root="$(get_release_root)"
info "Release root: $release_root"

manifest_file="${MANIFEST_PATH:-$release_root/hotfix-manifest.json}"
manifest_file="$(absolute_path "$manifest_file")"
[ -f "$manifest_file" ] || fail "Manifest not found: $manifest_file"
info "Manifest: $manifest_file"

stamp="$(date -u +%Y%m%d-%H%M%S)"
backup_root="$HOME/.pai/BACKUPS/hotfix-$stamp"
if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$backup_root"
  info "Backups: $backup_root"
fi

while IFS=$'\t' read -r source_rel target_rel transform mirror; do
  [ -n "$source_rel" ] || continue
  apply_entry "$release_root" "$target_root" "$target_framework" "$backup_root" "$source_rel" "$target_rel" "$transform" "$mirror"
done < <(manifest_entries "$manifest_file" "$target_framework")

if [ "$DRY_RUN" -eq 0 ]; then
  if [ "$target_framework" = "codex" ]; then
    regenerate_codex_hooks_json "$target_root" "$backup_root"
  elif [ "$target_framework" = "opencode" ]; then
    regenerate_opencode_native_artifacts "$target_root" "$backup_root"
  elif [ "$target_framework" = "claude" ]; then
    migrate_claude_sessionend_lifecycle "$target_root" "$backup_root"
  fi
  write_pai_framework_state "$target_root" "$target_framework"
  repair_shell_profiles "$target_root" "$target_framework" "$backup_root"
  verify_install "$target_root" "$target_framework"
  success "Hotfix update complete. Restart the agent session so instructions reload."
else
  info "Dry run complete. No files changed."
fi
