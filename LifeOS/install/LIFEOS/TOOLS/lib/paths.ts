import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

type FrameworkState = {
  active?: string;
  framework?: string;
  root?: string;
  dataDir?: string;
};

// ── UAI brand env aliases (scoped rename Phase 1) ──────────────────────────
// UAI_* environment variables take precedence over their PAI_* equivalents.
// Mapping them onto PAI_* at module load lets every PAI_*-reading resolver in
// this file honor the UAI names with zero duplicated logic. No data is moved;
// a no-op when no UAI_* var is set. See PAI/DOCUMENTATION/UaiScopedRenamePlan.md.
const UAI_ENV_KEYS = ["DIR", "DATA_DIR", "CONFIG_DIR", "FRAMEWORK_DIR", "FRAMEWORK", "ENV_PATH", "MEMORY_DIR", "USER_DIR"] as const;
export function applyUaiEnvAliases(): void {
  for (const key of UAI_ENV_KEYS) {
    const uaiVal = process.env[`UAI_${key}`];
    if (uaiVal !== undefined && uaiVal !== "") process.env[`PAI_${key}`] = uaiVal;
  }
}
applyUaiEnvAliases();

export function homeDir(): string {
  const home = process.env.HOME;
  if (home && existsSync(home)) return home;
  const userProfile = process.env.USERPROFILE;
  if (userProfile && existsSync(userProfile)) return userProfile;
  return home || userProfile || homedir();
}

export function getLifeosConfigRoot(): string {
  if (process.env.LIFEOS_CONFIG_ROOT) return expandHome(process.env.LIFEOS_CONFIG_ROOT);
  if (process.env.CLAUDE_CONFIG_DIR) return expandHome(process.env.CLAUDE_CONFIG_DIR);
  if (process.env.LIFEOS_DIR) return dirname(expandHome(process.env.LIFEOS_DIR));
  return join(homeDir(), ".claude");
}

export function getLifeosDir(): string {
  if (process.env.LIFEOS_DIR) return expandHome(process.env.LIFEOS_DIR);
  return join(getLifeosConfigRoot(), "LIFEOS");
}

export function expandHome(value: string): string {
  const home = homeDir();
  return value
    .replace(/^~(?=\/|\\|$)/, home)
    .replace(/^\$HOME(?=\/|\\|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|\\|$)/, home);
}

function readFrameworkStateAt(dataDir: string): FrameworkState | null {
  try {
    const statePath = join(dataDir, "framework.json");
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as FrameworkState;
  } catch {
    return null;
  }
}

function readFrameworkState(): FrameworkState | null {
  const state = readFrameworkStateAt(getPaiDataDir());
  if (state?.root && !existsSync(expandHome(state.root))) return null;
  return state;
}

function normalizeFramework(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function frameworkStateId(state: FrameworkState | null): string {
  return normalizeFramework(state?.active || state?.framework);
}

function canUseExplicitFrameworkRoot(state: FrameworkState | null, frameworkDir: string): boolean {
  const expanded = expandHome(frameworkDir);
  if (!existsSync(expanded)) return false;

  const stateRoot = state?.root ? resolve(expandHome(state.root)) : "";
  if (!stateRoot) return true;
  if (resolve(expanded) === stateRoot) return true;

  const explicitFramework = normalizeFramework(process.env.PAI_FRAMEWORK);
  const stateFramework = frameworkStateId(state);
  if (!explicitFramework) return false;
  if (stateFramework && explicitFramework === stateFramework) return false;

  return true;
}

function activeFrameworkHomeEnv(): string {
  const framework = normalizeFramework(process.env.PAI_FRAMEWORK);
  if (framework === "codex" || framework === "openai" || framework === "openaicodex") return process.env.CODEX_HOME || "";
  if (framework === "opencode" || framework === "open") return process.env.OPENCODE_CONFIG_DIR || "";
  if (framework === "claude" || framework === "claudecode") return process.env.CLAUDE_HOME || process.env.PAI_CLAUDE_HOME || "";
  return "";
}

function activeFrameworkRootFromEnv(state: FrameworkState | null, requirePaiDir = false): string {
  const providerHome = activeFrameworkHomeEnv();
  if (!providerHome) return "";
  const expanded = expandHome(providerHome);
  if (!existsSync(expanded)) return "";
  if (requirePaiDir && !existsSync(join(expanded, "PAI"))) return "";
  if (!canUseExplicitFrameworkRoot(state, expanded)) return "";
  return expanded;
}

function matchesActiveFrameworkHome(path: string): boolean {
  const providerHome = activeFrameworkHomeEnv();
  return Boolean(providerHome && resolve(expandHome(providerHome)) === resolve(path));
}

function hasStaleFrameworkEnv(): boolean {
  if (process.env.PAI_FRAMEWORK_DIR) {
    const frameworkDir = expandHome(process.env.PAI_FRAMEWORK_DIR);
    return !existsSync(frameworkDir) && !matchesActiveFrameworkHome(frameworkDir);
  }
  if (process.env.PAI_DIR) {
    const paiDir = expandHome(process.env.PAI_DIR);
    const frameworkDir = process.env.PAI_FRAMEWORK_DIR ? expandHome(process.env.PAI_FRAMEWORK_DIR) : "";
    return !existsSync(paiDir) && !(frameworkDir && resolve(paiDir) === resolve(frameworkDir, "PAI") && matchesActiveFrameworkHome(frameworkDir));
  }
  return false;
}

export function getPaiDir(): string {
  const state = readFrameworkState();
  if (process.env.PAI_DIR) {
    const envPaiDir = expandHome(process.env.PAI_DIR);
    if (existsSync(envPaiDir) && canUseExplicitFrameworkRoot(state, resolve(envPaiDir, ".."))) return envPaiDir;
  }
  if (process.env.PAI_FRAMEWORK_DIR) {
    const envFrameworkDir = expandHome(process.env.PAI_FRAMEWORK_DIR);
    const envPaiDir = join(envFrameworkDir, "PAI");
    if (existsSync(envFrameworkDir) && existsSync(envPaiDir) && canUseExplicitFrameworkRoot(state, envFrameworkDir)) return envPaiDir;
  }
  const providerFrameworkDir = activeFrameworkRootFromEnv(state, true);
  if (providerFrameworkDir) return join(providerFrameworkDir, "PAI");
  const frameworkRoot = state?.root;
  if (frameworkRoot) return join(expandHome(frameworkRoot), "PAI");
  return resolve(import.meta.dir, "..", "..");
}

export function getFrameworkDir(): string {
  const state = readFrameworkState();
  if (process.env.PAI_FRAMEWORK_DIR) {
    const envFrameworkDir = expandHome(process.env.PAI_FRAMEWORK_DIR);
    if (existsSync(envFrameworkDir) && canUseExplicitFrameworkRoot(state, envFrameworkDir)) return envFrameworkDir;
  }
  if (process.env.PAI_DIR) {
    const envPaiDir = expandHome(process.env.PAI_DIR);
    const envFrameworkDir = resolve(envPaiDir, "..");
    if (existsSync(envPaiDir) && canUseExplicitFrameworkRoot(state, envFrameworkDir)) return envFrameworkDir;
  }
  const providerFrameworkDir = activeFrameworkRootFromEnv(state);
  if (providerFrameworkDir) return providerFrameworkDir;
  const frameworkRoot = state?.root;
  if (frameworkRoot) return expandHome(frameworkRoot);
  return resolve(getPaiDir(), "..");
}

export function getPaiDataDir(): string {
  const defaultDataDir = join(homeDir(), ".pai");
  const defaultState = readFrameworkStateAt(defaultDataDir);
  const defaultStateUsable = Boolean(defaultState?.root && existsSync(expandHome(defaultState.root)));
  if (process.env.PAI_DATA_DIR) {
    const envDataDir = expandHome(process.env.PAI_DATA_DIR);
    if (existsSync(envDataDir)) {
      const state = readFrameworkStateAt(envDataDir);
      if (!state && (!defaultStateUsable || !hasStaleFrameworkEnv())) return envDataDir;
      if (state) {
        if (state.root && existsSync(expandHome(state.root))) return envDataDir;
        if (defaultStateUsable) return defaultDataDir;
        return envDataDir;
      }
    }
    if (!defaultStateUsable || !hasStaleFrameworkEnv()) return envDataDir;
  }
  return defaultDataDir;
}

export function getConfigDir(): string {
  const envConfigDir = process.env.PAI_CONFIG_DIR ? expandHome(process.env.PAI_CONFIG_DIR) : "";
  if (envConfigDir && existsSync(envConfigDir)) return envConfigDir;
  return join(homeDir(), ".config", "PAI");
}

export function getEnvPath(): string {
  if (process.env.PAI_ENV_PATH) return expandHome(process.env.PAI_ENV_PATH);
  const configEnv = join(getConfigDir(), ".env");
  if (existsSync(configEnv)) return configEnv;
  return join(getFrameworkDir(), ".env");
}

export function getMemoryDir(): string {
  const envMemoryDir = process.env.PAI_MEMORY_DIR ? expandHome(process.env.PAI_MEMORY_DIR) : "";
  if (envMemoryDir && existsSync(envMemoryDir)) return envMemoryDir;
  return join(getPaiDataDir(), "MEMORY");
}

export function getUserDir(): string {
  const envUserDir = process.env.PAI_USER_DIR ? expandHome(process.env.PAI_USER_DIR) : "";
  if (envUserDir && existsSync(envUserDir)) return envUserDir;
  return join(getPaiDataDir(), "USER");
}

export function paiPath(...segments: string[]): string {
  return join(getPaiDir(), ...segments);
}

export function memoryPath(...segments: string[]): string {
  return join(getMemoryDir(), ...segments);
}

export function userPath(...segments: string[]): string {
  return join(getUserDir(), ...segments);
}
