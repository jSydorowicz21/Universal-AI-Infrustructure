/**
 * InstallEngine — shared install logic for the LifeOS bare-skill installer.
 *
 * This is a standalone install engine, reshaped for the bare-skill context
 * from the now-retired pre-6.x GUI installer engine (detect logic + types):
 * no web/electron wizard, no separate types module, plus
 * the bare-skill extras the wizard never needed — harness detection (the skill
 * installs into Claude Code / Hermes / Cursor / OpenClaw) and dev-tree refusal
 * (never mutate the author's source repo).
 *
 * All detection here is READ-ONLY and non-destructive. The 7 setup Tools import
 * from this one sibling module (flat 2-level skill structure forbids a lib/ dir).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, accessSync, constants as fsConstants } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";

// ── Types (inlined — the skill ships without the engine's types.ts) ──

export type Platform = "darwin" | "linux" | "windows";

export interface OsInfo {
  platform: Platform;
  arch: string;
  version: string;
  name: string;
}

export interface ToolInfo {
  installed: boolean;
  version?: string;
  path?: string;
}

export type Harness = "claude-code" | "omp" | "codex" | "opencode" | "hermes" | "cursor" | "openclaw" | "unknown";

export interface HarnessInfo {
  name: Harness;
  /** Where this harness loads skills from (absolute), if known. */
  skillsDir?: string;
  /** The config root the harness resolves (e.g. ~/.claude). */
  configRoot?: string;
  /**
   * "detected" = the harness binary was found on PATH; "assumed" = inferred
   * from a config dir alone, or the clean-machine default. The Setup workflow
   * must confirm an "assumed" harness with the user before branching (#1448 —
   * a leftover ~/.claude dir sent an OpenCode install down the Claude Code path).
   */
  confidence: "detected" | "assumed" | "unselected";
}

export interface EnvDetection {
  os: OsInfo;
  harness: HarnessInfo;
  /** Has a graphical session (vs headless/SSH) — gates GUI-dependent steps. */
  display: boolean;
  /** Running inside an SSH session. */
  ssh: boolean;
  bun: ToolInfo;
  git: ToolInfo;
  /** A prior LifeOS/PAI install is present (settings.json exists in the config root). */
  existingInstall: boolean;
  /**
   * This IS a checked-out LifeOS source tree — refuse mutation. Legacy
   * maintainer trees carry `skills/_LIFEOS`; current source trees are identified
   * structurally by their git metadata and the checked-in LifeOS installer.
   */
  isDevTree: boolean;
  settingsExists: boolean;
  claudeMdExists: boolean;
  homeDir: string;
  configRoot: string;
  timezone: string;
}

export function resolveHomeDir(
  env: Pick<NodeJS.ProcessEnv, "HOME" | "USERPROFILE"> = process.env,
  osHome = homedir(),
): string {
  const configured = env.HOME?.trim() || env.USERPROFILE?.trim();
  return normalize(configured || osHome);
}
export interface ResolvedInstallRoots {
  home: string;
  configRoot: string;
  dataRoot: string;
  lifeosRoot: string;
  userRoot: string;
}

export function resolveInstallRoots(
  env: NodeJS.ProcessEnv = process.env,
  harness: Harness = "claude-code",
  osHome = homedir(),
): ResolvedInstallRoots {
  const home = resolveHomeDir(env, osHome);
  const explicitConfig = env.UAI_CONFIG_DIR?.trim() || env.PAI_CONFIG_DIR?.trim();
  const harnessConfig = harness === "claude-code"
    ? env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude")
    : harness === "codex"
      ? env.CODEX_HOME?.trim() || join(home, ".codex")
      : harness === "opencode"
        ? env.OPENCODE_CONFIG_DIR?.trim() || join(home, ".config", "opencode")
        : harness === "omp"
          ? env.PI_CODING_AGENT_DIR?.trim() || join(home, ".omp", "agent")
          : join(home, ".config", "uai", harness);
  const configRoot = normalize(explicitConfig || harnessConfig);
  const dataRoot = normalize(env.UAI_DATA_DIR?.trim() || env.PAI_DATA_DIR?.trim() || join(home, ".pai"));
  const lifeosRoot = normalize(env.LIFEOS_DIR?.trim() || join(configRoot, "LIFEOS"));
  return { home, configRoot, dataRoot, lifeosRoot, userRoot: join(dataRoot, "USER") };
}


export function findExecutable(
  name: string,
  env: Pick<NodeJS.ProcessEnv, "PATH" | "Path" | "PATHEXT"> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathValue = env.PATH || env.Path || "";
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const candidates = isAbsolute(name) || name.includes("/") || name.includes("\\")
    ? [name]
    : pathValue.split(pathDelimiter).filter(Boolean).flatMap((dir) => {
        if (platform !== "win32" || extname(name)) return [join(dir, name)];
        return extensions.map((extension) => join(dir, `${name}${extension.toLowerCase()}`))
          .concat(extensions.map((extension) => join(dir, `${name}${extension.toUpperCase()}`)));
      });
  for (const candidate of candidates) {
    try {
      accessSync(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return normalize(candidate);
    } catch {
      // Continue through PATH/PATHEXT.
    }
  }
  return null;
}

// ── Low-level probes (from engine detect.ts, unchanged) ──

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch {
    return null;
  }
}

export function detectOS(): OsInfo {
  const platform: Platform =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch;
  let version = "";
  let name = "";
  if (platform === "darwin") {
    version = tryExec("sw_vers -productVersion") || "";
    name = `macOS ${version}`.trim();
  } else if (platform === "linux") {
    name = tryExec("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'") || "Linux";
    version = tryExec("uname -r") || "";
  } else {
    name = "Windows";
    version = tryExec("ver") || "";
  }
  return { platform, arch, version, name };
}

export function detectTool(name: string, versionCmd: string): ToolInfo {
  const path = findExecutable(name);
  if (!path) return { installed: false };
  const versionArgs = versionCmd.trim().split(/\s+/).slice(1);
  let out: string | null = null;
  try {
    const result = Bun.spawnSync([path, ...versionArgs], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) out = result.stdout.toString().trim() || result.stderr.toString().trim();
  } catch {
    out = null;
  }
  const m = out?.match(/(\d+\.\d+[.\d]*)/);
  return { installed: true, version: m?.[1] || out || undefined, path };
}

// ── Harness detection (NEW — bare-skill needs to know where it landed) ──

/**
 * Detect which harness is hosting this install and where it loads skills from.
 * Signal strength (#1448): config dir + harness binary on PATH beats config dir
 * alone beats binary alone — a leftover ~/.claude dir on a machine without the
 * claude CLI must not out-rank a live OpenCode install. Anything short of a
 * binary match is reported as confidence "assumed", never as fact.
 */
export function detectHarness(home: string, env: NodeJS.ProcessEnv = process.env): HarnessInfo {
  const candidates: Array<{ name: Exclude<Harness, "unknown">; root: string; skills: string; bin: string }> = [
    { name: "claude-code", root: env.CLAUDE_CONFIG_DIR || join(home, ".claude"), skills: "skills", bin: "claude" },
    { name: "omp", root: env.PI_CODING_AGENT_DIR || join(home, ".omp", "agent"), skills: "skills", bin: "omp" },
    { name: "codex", root: env.CODEX_HOME || join(home, ".codex"), skills: "skills", bin: "codex" },
    { name: "opencode", root: env.OPENCODE_CONFIG_DIR || join(home, ".config", "opencode"), skills: "skills", bin: "opencode" },
    { name: "hermes", root: join(home, ".hermes"), skills: "skills", bin: "hermes" },
    { name: "cursor", root: join(home, ".cursor"), skills: "skills", bin: "cursor" },
    { name: "openclaw", root: join(home, ".openclaw"), skills: "skills", bin: "openclaw" },
  ];
  const hasBin = (candidate: (typeof candidates)[number]) => findExecutable(candidate.bin, env) !== null;
  const info = (candidate: (typeof candidates)[number], confidence: HarnessInfo["confidence"]): HarnessInfo => ({
    name: candidate.name,
    configRoot: candidate.root,
    skillsDir: join(candidate.root, candidate.skills),
    confidence,
  });
  const explicit = (env.UAI_HARNESS || env.PAI_HARNESS || "").trim().toLowerCase();
  const explicitName = explicit === "claude" ? "claude-code" : explicit;
  if (explicitName) {
    const selected = candidates.find((candidate) => candidate.name === explicitName);
    if (selected) return info(selected, hasBin(selected) ? "detected" : "assumed");
    return { name: "unknown", confidence: "unselected" };
  }
  for (const candidate of candidates) {
    if (existsSync(candidate.root) && hasBin(candidate)) return info(candidate, "detected");
  }
  for (const candidate of candidates) {
    if (hasBin(candidate)) return info(candidate, "detected");
  }
  for (const candidate of candidates) {
    if (existsSync(candidate.root)) return info(candidate, "assumed");
  }
  return { name: "unknown", confidence: "unselected" };
}

/**
 * Resolve which harness owns an explicitly selected config root. Explicit
 * UAI_HARNESS/PAI_HARNESS wins; otherwise only a known harness root is accepted.
 * Custom roots must therefore be paired with an explicit harness selection.
 */
export function resolveSelectedHarness(
  configRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  home = resolveHomeDir(env),
): Harness {
  if ((env.UAI_HARNESS || env.PAI_HARNESS || "").trim()) return detectHarness(home, env).name;
  const normalizedRoot = normalize(configRoot);
  for (const harness of ["claude-code", "omp", "codex", "opencode", "hermes", "cursor", "openclaw"] as const) {
    if (normalizedRoot === resolveInstallRoots(env, harness, home).configRoot) return harness;
  }
  return "unknown";
}

/**
 * Refuse a source checkout rather than treating it as a live harness profile.
 * Legacy maintainer trees retain `skills/_LIFEOS`; current repositories are
 * identified by git metadata plus the installer source layout. A normal profile
 * may contain LIFEOS after installation but never this complete source shape.
 */
export function detectDevTree(configRoot: string): boolean {
  return existsSync(join(configRoot, "skills", "_LIFEOS")) || (
    existsSync(join(configRoot, ".git")) &&
    existsSync(join(configRoot, "LifeOS", "install")) &&
    existsSync(join(configRoot, "LifeOS", "Tools", "InstallEngine.ts"))
  );
}

// ── Composite env detection (the DetectEnv Tool payload) ──

export function detectEnv(env: NodeJS.ProcessEnv = process.env): EnvDetection {
  const home = resolveHomeDir(env);
  const os = detectOS();
  const discoveredHarness = detectHarness(home, env);
  const roots = resolveInstallRoots(env, discoveredHarness.name, home);
  const harness = discoveredHarness.name === "unknown"
    ? discoveredHarness
    : { ...discoveredHarness, configRoot: roots.configRoot, skillsDir: join(roots.configRoot, "skills") };
  const configRoot = roots.configRoot;
  const settingsPath = join(configRoot, "settings.json");
  const claudeMdPath = join(configRoot, harness.name === "codex" || harness.name === "opencode" ? "AGENTS.md" : "CLAUDE.md");
  const ssh = !!(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
  // GUI session: macOS always has one locally; Linux needs DISPLAY/WAYLAND and not pure-SSH.
  const display =
    os.platform === "darwin" ? !ssh : !!(env.DISPLAY || env.WAYLAND_DISPLAY) && !ssh;

  return {
    os,
    harness,
    display,
    ssh,
    bun: detectTool("bun", "bun --version"),
    git: detectTool("git", "git --version"),
    existingInstall: existsSync(settingsPath),
    isDevTree: detectDevTree(configRoot),
    settingsExists: existsSync(settingsPath),
    claudeMdExists: existsSync(claudeMdPath),
    homeDir: home,
    configRoot,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ── Existing-content + API-key scan (from engine detect.ts, inlined types) ──

export interface ApiKeyScan {
  elevenLabs?: string;
  anthropic?: string;
  openai?: string;
  google?: string;
  xai?: string;
  perplexity?: string;
}

/**
 * Scan shell rc files + config dirs for API-key VALUES. Returns provider → key.
 * Only well-formed assignments are accepted (no `$VAR` indirection, no
 * obvious placeholders). Read-only.
 */
export function scanApiKeys(home: string, configDir: string): ApiKeyScan {
  const candidates = [
    join(home, ".zshenv"),
    join(home, ".zshrc"),
    join(home, ".zprofile"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
    join(configDir, ".env"),
    join(configDir, "credentials.env"),
    join(home, ".config", "LIFEOS", ".env"),
  ];
  const patterns: Array<[keyof ApiKeyScan, RegExp]> = [
    ["elevenLabs", /(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s#]+)/],
    ["anthropic", /(?:^|\n)\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s#]+)/],
    ["openai", /(?:^|\n)\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?([^"'\s#]+)/],
    ["google", /(?:^|\n)\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_API_KEY)\s*=\s*["']?([^"'\s#]+)/],
    ["xai", /(?:^|\n)\s*(?:export\s+)?(?:XAI_API_KEY|GROK_API_KEY)\s*=\s*["']?([^"'\s#]+)/],
    ["perplexity", /(?:^|\n)\s*(?:export\s+)?PERPLEXITY_API_KEY\s*=\s*["']?([^"'\s#]+)/],
  ];
  const placeholder = /^(your-key-here|sk-xxxxxxxx|xxxxx|REPLACE_ME|TODO)/i;
  const found: ApiKeyScan = {};
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const [provider, regex] of patterns) {
      if (found[provider]) continue;
      const m = content.match(regex);
      if (!m) continue;
      const value = m[1];
      if (value.startsWith("$")) continue;
      if (placeholder.test(value)) continue;
      if (value.length < 12) continue;
      found[provider] = value;
    }
  }
  return found;
}

function fileExists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

export interface ExistingUserContent {
  telosPresent: boolean;
  identityPresent: boolean;
  contactsPresent: boolean;
  projectsPresent: boolean;
  /** True if the user config tree already holds real (non-template) content. */
  populated: boolean;
}

/**
 * Read-only scan of a user config tree for already-present content, so setup
 * can branch on "populated tree" vs "fresh scaffold" without overwriting.
 */
export function detectExistingUserContent(paiUserDir: string): ExistingUserContent {
  // Covers both the current single-file schema (TELOS/TELOS.md) and the legacy
  // split layout (TELOS/MISSION.md, TELOS/GOALS.md).
  const telosPresent =
    fileExists(paiUserDir, "TELOS/TELOS.md") ||
    fileExists(paiUserDir, "TELOS/MISSION.md") ||
    fileExists(paiUserDir, "TELOS/GOALS.md");
  const identityPresent =
    fileExists(paiUserDir, "PRINCIPAL/PRINCIPAL_IDENTITY.md") ||
    fileExists(paiUserDir, "PRINCIPAL_IDENTITY.md") ||
    fileExists(paiUserDir, "DIGITAL_ASSISTANT/DA_IDENTITY.md");
  const contactsPresent = fileExists(paiUserDir, "CONTACTS.md");
  const projectsPresent = fileExists(paiUserDir, "PROJECTS.md");
  return {
    telosPresent,
    identityPresent,
    contactsPresent,
    projectsPresent,
    populated: telosPresent || identityPresent,
  };
}

// ── Settings.json hook inspection (read-only; InstallHooks does the writes) ──

export interface SettingsHookScan {
  exists: boolean;
  hookEventCount: number;
  hookEntryCount: number;
}

/**
 * Read-only count of existing hooks in a harness settings.json, so ScanConflicts
 * can report what's already wired before InstallHooks proposes a merge.
 */
export function scanSettingsHooks(settingsPath: string): SettingsHookScan {
  if (!existsSync(settingsPath)) return { exists: false, hookEventCount: 0, hookEntryCount: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return { exists: true, hookEventCount: 0, hookEntryCount: 0 };
  }
  if (typeof parsed !== "object" || parsed === null) return { exists: true, hookEventCount: 0, hookEntryCount: 0 };
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null) return { exists: true, hookEventCount: 0, hookEntryCount: 0 };
  const events = Object.keys(hooks as Record<string, unknown>);
  let entries = 0;
  for (const ev of events) {
    const bucket = (hooks as Record<string, unknown>)[ev];
    if (Array.isArray(bucket)) entries += bucket.length;
  }
  return { exists: true, hookEventCount: events.length, hookEntryCount: entries };
}

// ════════════════════════════════════════════════════════════════════
//  Mutating helpers (used by ScaffoldUser / LinkUser / ActivateImports /
//  InstallHooks). Each is purpose-built for the bare-skill installer but
//  follows the proven logic from the legacy engine actions.ts.
// ════════════════════════════════════════════════════════════════════

import { closeSync, cpSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";

const TEMPLATE_EXTENSIONS = new Set([".md", ".json", ".txt", ".ts", ".toml", ".yaml", ".yml", ".sh"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "MEMORY"]);

/**
 * Recursive, existsSync-GUARDED copy. Copies only files/dirs absent at dst —
 * NEVER overwrites a populated target. Returns count + any failures. (Ported
 * from engine actions.ts copyMissing.)
 */
export function copyMissing(src: string, dst: string): { copied: number; failures: string[] } {
  const failures: string[] = [];
  let copied = 0;
  const sourceFailure = physicalTreeFailure(src, "payload source");
  const destinationFailure = physicalTreeFailure(dst, "payload destination");
  if (sourceFailure) failures.push(sourceFailure);
  if (destinationFailure) failures.push(destinationFailure);
  if (failures.length > 0) return { copied, failures };
  const walk = (s: string, d: string): void => {
    let stat;
    try {
      stat = lstatSync(s);
    } catch (error) {
      failures.push(`payload artifact is unreadable: ${s}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (stat.isSymbolicLink()) {
      failures.push(`payload link is not allowed: ${s}`);
      return;
    }
    if (stat.isFile()) {
      if (!existsSync(d)) {
        try {
          mkdirSync(dirname(d), { recursive: true });
          cpSync(s, d);
          copied++;
        } catch (err) {
          failures.push(`${s} → ${d}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    if (!stat.isDirectory()) {
      failures.push(`payload contains an unsupported artifact: ${s}`);
      return;
    }
    for (const entry of readdirSync(s, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const sp = join(s, entry.name);
      const dp = join(d, entry.name);
      const child = lstatSync(sp);
      if (child.isSymbolicLink()) {
        failures.push(`payload link is not allowed: ${sp}`);
        continue;
      }
      if (child.isDirectory()) {
        if (existsSync(dp)) {
          const destination = lstatSync(dp);
          if (destination.isSymbolicLink() || !destination.isDirectory()) {
            failures.push(`payload destination must be a physical directory: ${dp}`);
            continue;
          }
        } else {
          mkdirSync(dp, { recursive: true });
        }
        walk(sp, dp);
      } else if (child.isFile()) {
        walk(sp, dp);
      } else {
        failures.push(`payload contains an unsupported artifact: ${sp}`);
      }
    }
  };
  walk(src, dst);
  return { copied, failures };
}

export interface TemplateVars {
  [placeholder: string]: string;
}

/**
 * Walk a tree and replace `{{PLACEHOLDER}}` tokens in template-extension files.
 * Atomic per-file (tmp + rename). Skips node_modules/.git/LIFEOS_INSTALL/MEMORY.
 * (Simplified from engine actions.ts substituteTemplates.)
 */
export function substituteTree(rootDir: string, vars: TemplateVars): { scanned: number; modified: number; applied: number } {
  const failure = physicalTreeFailure(rootDir, "template source");
  if (failure) throw new Error(failure);
  let scanned = 0;
  let modified = 0;
  let applied = 0;
  const entries = Object.entries(vars);
  const processFile = (filePath: string): void => {
    if (!TEMPLATE_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf(".")))) return;
    scanned++;
    const before = readFileSync(filePath, "utf-8");
    let after = before;
    for (const [placeholder, value] of entries) {
      const parts = after.split(placeholder);
      applied += parts.length - 1;
      after = parts.join(value);
    }
    if (after !== before) {
      const temporary = join(dirname(filePath), `.${randomUUID()}.uai-tmp`);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(temporary, "wx", 0o600);
        writeFileSync(descriptor, after, "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, filePath);
        modified++;
      } catch (error) {
        if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best effort */ }
        try { unlinkSync(temporary); } catch { /* only our temporary */ }
        throw error;
      }
    }
  };
  const walk = (directory: string): void => {
    const metadata = lstatSync(directory);
    if (metadata.isFile()) {
      processFile(directory);
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory() || entry.isFile()) walk(child);
    }
  };
  if (existsSync(rootDir)) walk(rootDir);
  return { scanned, modified, applied };
}

/**
 * Establish the system/user separation contract: the live `<configRoot>/LIFEOS/USER`
 * becomes a SYMLINK to `<configDir>/USER` (the private user-data home). Copies any
 * live USER content into the data home first (existsSync-guarded), then replaces
 * the live dir with a symlink. Idempotent — a correct symlink is left untouched.
 * EXDEV (cross-filesystem) rename falls back to cp + rm. (Ported from engine.)
 */
/** Byte-compare two files; treats unreadable as "differs" (conservative). */
export function filesDiffer(a: string, b: string): boolean {
  try {
    return !readFileSync(a).equals(readFileSync(b));
  } catch {
    return true;
  }
}

/**
 * Merge `src` into `dst` with LIVE-WINS semantics for the USER migration: a
 * missing dst file is copied; a byte-identical one is skipped; a DIFFERING one
 * is overwritten with src AFTER the displaced dst file is preserved aside as
 * `<file>.replaced-<stamp>`. Lossless in every direction — nothing is removed
 * without a recoverable copy. Symlinked entries are skipped (Dirent semantics).
 */
export function physicalTreeFailure(root: string, label: string): string | undefined {
  try {
    lstatSync(root);
  } catch {
    return undefined;
  }
  const visit = (path: string): string | undefined => {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      return `${label} cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (metadata.isSymbolicLink()) return label === "payload source" ? `payload link is not allowed: ${path}` : `${label} links are not allowed: ${path}`;
    if (metadata.isFile()) return undefined;
    if (!metadata.isDirectory()) return `${label} contains an unsupported artifact: ${path}`;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch (error) {
      return `${label} cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`;
    }
    for (const name of names) {
      const failure = visit(join(path, name));
      if (failure) return failure;
    }
    return undefined;
  };
  return visit(root);
}

/**
 * Single-file merge primitive — the shared core of mergeTree (and the PAI
 * migrator's per-entry apply). LIVE-WINS semantics: a missing destination is
 * copied; a byte-identical destination is skipped; a DIFFERING destination is
 * overwritten with the source AFTER the displaced destination is preserved
 * aside as `<file>.replaced-<stamp>`. Lossless in every direction. A symlinked
 * destination is refused (never followed). Returns the classification so
 * callers that need per-file reporting (the migrator) can use it directly.
 */
export interface MergeFileOptions {
  /** Create the destination parent directory if missing (mergeTree does this
   * inline; the migrator pre-creates). Default false. */
  createMissingParent?: boolean;
}

export type MergeFileAction = "copied" | "overwritten" | "skipped-identical" | "skipped-missing-dest-link";

export interface MergeFileResult {
  action: MergeFileAction;
  /** Absolute destination path. */
  destination: string;
  /** Path of the displaced copy when action === "overwritten"; else undefined. */
  preservedPath?: string;
  /** Error message if the copy failed (action is still set to the intended one). */
  failure?: string;
}

function nextPreservedPath(destination: string, stamp: string): string {
  const base = `${destination}.replaced-${stamp}`;
  let candidate = base;
  let suffix = 1;
  while (true) {
    try {
      lstatSync(candidate);
      candidate = `${base}-${suffix++}`;
    } catch {
      return candidate;
    }
  }
}

export function mergeFile(src: string, dst: string, stamp: string, options: MergeFileOptions = {}): MergeFileResult {
  let dstStat;
  try {
    dstStat = lstatSync(dst);
  } catch {
    try {
      if (options.createMissingParent) mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst);
      return { action: "copied", destination: dst };
    } catch (err) {
      return { action: "copied", destination: dst, failure: `${src} → ${dst}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (dstStat.isSymbolicLink()) {
    return { action: "skipped-missing-dest-link", destination: dst, failure: `destination link is not allowed: ${dst}` };
  }
  if (!filesDiffer(src, dst)) {
    return { action: "skipped-identical", destination: dst };
  }
  try {
    const preservedPath = nextPreservedPath(dst, stamp);
    cpSync(dst, preservedPath);
    cpSync(src, dst);
    return { action: "overwritten", destination: dst, preservedPath };
  } catch (err) {
    return { action: "overwritten", destination: dst, failure: `${src} → ${dst}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
export function mergeTree(src: string, dst: string, stamp: string): { copied: number; overwritten: number; preserved: number; failures: string[] } {
  let copied = 0;
  let overwritten = 0;
  let preserved = 0;
  const failures: string[] = [];
  const sourceFailure = physicalTreeFailure(src, "live USER source");
  const destinationFailure = physicalTreeFailure(dst, "data USER destination");
  if (sourceFailure) failures.push(sourceFailure);
  if (destinationFailure) failures.push(destinationFailure);
  if (failures.length > 0) return { copied, overwritten, preserved, failures };
  const walk = (s: string, d: string): void => {
    const sourceMetadata = lstatSync(s);
    if (sourceMetadata.isFile()) {
      const result = mergeFile(s, d, stamp, { createMissingParent: true });
      if (result.action === "copied") copied++;
      else if (result.action === "overwritten") { overwritten++; preserved++; }
      else if (result.action === "skipped-identical") { /* byte-equal; no-op */ }
      if (result.failure) failures.push(result.failure);
      return;
    }
    for (const entry of readdirSync(s, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const sp = join(s, entry.name);
      const dp = join(d, entry.name);
      const metadata = lstatSync(sp);
      if (metadata.isDirectory()) {
        if (existsSync(dp) && lstatSync(dp).isSymbolicLink()) {
          failures.push(`data USER destination links are not allowed: ${dp}`);
          continue;
        }
        if (!existsSync(dp)) mkdirSync(dp, { recursive: true });
        walk(sp, dp);
      } else if (metadata.isFile()) {
        walk(sp, dp);
      } else {
        failures.push(`live USER source contains an unsupported artifact: ${sp}`);
      }
    }
  };
  walk(src, dst);
  return { copied, overwritten, preserved, failures };
}

export function setupUserSeparation(
  configRoot: string,
  configDir: string,
): { action: "already-linked" | "linked" | "scaffolded-linked"; target: string; copied: number; overwritten?: number; preserved?: number; backup?: string; error?: string } {
  const liveUserDir = join(configRoot, "LIFEOS", "USER");
  const dataUserDir = join(configDir, "USER");

  // Branch (a): already a correct symlink → no-op. A relative link is correct
  // when it resolves to the selected data root, not merely when its raw text
  // happens to match the absolute target.
  if (existsSync(liveUserDir)) {
    const st = lstatSync(liveUserDir);
    if (st.isSymbolicLink()) {
      try {
        const target = readlinkSync(liveUserDir);
        const resolvedTarget = isAbsolute(target) ? normalize(target) : resolve(dirname(liveUserDir), target);
        if (resolvedTarget === normalize(dataUserDir)) return { action: "already-linked", target: dataUserDir, copied: 0 };
      } catch { /* reject below without mutating a foreign link */ }
      return { action: "linked", target: dataUserDir, copied: 0, error: `live USER is linked to an unrecognized target: ${liveUserDir}` };
    }
  }

  // No mutation (including mkdir/rename) is allowed until both physical trees
  // have been walked with lstat. This prevents a destination link/junction from
  // redirecting merge copies outside the selected user-data root.
  const destinationFailure = physicalTreeFailure(dataUserDir, "data USER destination");
  if (destinationFailure) return { action: "linked", target: dataUserDir, copied: 0, error: destinationFailure };
  if (existsSync(liveUserDir)) {
    const liveMetadata = lstatSync(liveUserDir);
    if (!liveMetadata.isDirectory()) {
      return { action: "linked", target: dataUserDir, copied: 0, error: `live USER is not a physical directory: ${liveUserDir}` };
    }
    const sourceFailure = physicalTreeFailure(liveUserDir, "live USER source");
    if (sourceFailure) return { action: "linked", target: dataUserDir, copied: 0, error: sourceFailure };
  }

  mkdirSync(dataUserDir, { recursive: true });
  let copied = 0;

  // Branch (b): move the verified live tree aside, then merge it losslessly.
  if (existsSync(liveUserDir) && lstatSync(liveUserDir).isDirectory()) {
    const stamp = String(Date.now());
    const backupDir = `${liveUserDir}.pre-link-backup-${stamp}`;
    try {
      renameSync(liveUserDir, backupDir);
    } catch (err) {
      return { action: "linked", target: dataUserDir, copied: 0, error: `could not move live USER aside before symlink: ${err instanceof Error ? err.message : String(err)}` };
    }
    const merged = mergeTree(backupDir, dataUserDir, stamp);
    copied = merged.copied;
    if (merged.failures.length > 0) {
      return {
        action: "linked",
        target: dataUserDir,
        copied,
        overwritten: merged.overwritten,
        preserved: merged.preserved,
        backup: backupDir,
        error: `USER migration failed; live USER preserved at ${backupDir}: ${merged.failures.join("; ")}`,
      };
    }
    try {
      mkdirSync(dirname(liveUserDir), { recursive: true });
      symlinkSync(dataUserDir, liveUserDir, process.platform === "win32" ? "junction" : "dir");
      return { action: "linked", target: dataUserDir, copied, overwritten: merged.overwritten, preserved: merged.preserved, backup: backupDir };
    } catch (err) {
      return { action: "linked", target: dataUserDir, copied, overwritten: merged.overwritten, preserved: merged.preserved, backup: backupDir, error: `symlink creation failed (live USER preserved at ${backupDir}): ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Branch (c): fresh install — scaffold the data home (if empty) + symlink.
  try {
    mkdirSync(dirname(liveUserDir), { recursive: true });
    symlinkSync(dataUserDir, liveUserDir, process.platform === "win32" ? "junction" : "dir");
    return { action: "scaffolded-linked", target: dataUserDir, copied };
  } catch (err) {
    return { action: "scaffolded-linked", target: dataUserDir, copied, error: `symlink creation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Validate the symlink contract: `<configRoot>/LIFEOS/USER` is a symlink → `<configDir>/USER`.
 * (Ported from engine validate.ts runSymlinkContractCheck.)
 */
export function checkSymlinkContract(configRoot: string, configDir: string): { passed: boolean; detail: string } {
  const liveUserDir = join(configRoot, "LIFEOS", "USER");
  const expected = join(configDir, "USER");
  if (!existsSync(liveUserDir)) return { passed: false, detail: `missing: ${liveUserDir}` };
  const st = lstatSync(liveUserDir);
  if (!st.isSymbolicLink()) return { passed: false, detail: `${liveUserDir} is not a symlink (system/user separation broken)` };
  let target: string;
  try {
    target = readlinkSync(liveUserDir);
  } catch (err) {
    return { passed: false, detail: `readlink failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const resolvedTarget = isAbsolute(target) ? normalize(target) : resolve(dirname(liveUserDir), target);
  if (resolvedTarget !== normalize(expected)) return { passed: false, detail: `link points to ${resolvedTarget}, expected ${normalize(expected)}` };
  return { passed: true, detail: `${liveUserDir} → ${expected}` };
}

// ── Hooks merge (InstallHooks core — the one genuinely-new piece) ──
const DORMANT_USER_IMPORTS: Record<string, true> = {
  "@LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md": true,
  "@LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md": true,
  "@LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY.md": true,
  "@LIFEOS/USER/PROJECTS.md": true,
  "@LIFEOS/USER/CONFIG/OPERATIONAL_RULES.md": true,
};

function atomicWriteOwned(path: string, contents: string): void {
  const temporary = join(dirname(path), `.${randomUUID()}.uai-tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best effort */ }
    try { unlinkSync(temporary); } catch { /* only our unpredictable temporary */ }
    throw error;
  }
}

export function activateImports(claudeMdPath: string, configRoot: string): { activated: string[]; skipped: string[] } {
  const activated: string[] = [];
  const skipped: string[] = [];
  const normalizedRoot = resolve(configRoot);
  const normalizedFile = resolve(claudeMdPath);
  if (dirname(normalizedFile) !== normalizedRoot) return { activated, skipped };
  if (!existsSync(normalizedFile)) return { activated, skipped };
  let metadata;
  try {
    metadata = lstatSync(normalizedFile);
  } catch {
    return { activated, skipped };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return { activated, skipped };
  const lines = readFileSync(normalizedFile, "utf-8").split("\n");
  const commented = /^\s*#\s+(@LIFEOS\/USER\/[\w./-]+)\s*$|^\s*<!--\s*(@LIFEOS\/USER\/[\w./-]+)\s*-->\s*$/;
  const out = lines.map((line) => {
    const match = line.match(commented);
    if (!match) return line;
    const importPath = match[1] || match[2];
    if (!DORMANT_USER_IMPORTS[importPath]) return line;
    const relativeImport = importPath.slice(1);
    const target = resolve(normalizedRoot, relativeImport);
    if (!target.startsWith(`${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`)) {
      skipped.push(importPath);
      return line;
    }
    if (existsSync(target)) {
      activated.push(importPath);
      return importPath;
    }
    skipped.push(importPath);
    return line;
  });
  if (activated.length > 0) atomicWriteOwned(normalizedFile, out.join("\n"));
  return { activated, skipped };
}

type HookEntry = { type?: string; command?: string; url?: string; [k: string]: unknown };
type MatcherGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type HooksMap = Record<string, MatcherGroup[]>;

function normalizeCommand(cmd: string): string {
  return cmd
    .replace(/\$\{?LIFEOS_DIR\}?|\$\{?CLAUDE_PROJECT_DIR\}?|\$\{?CLAUDE_PLUGIN_ROOT\}?|~\/\.claude|\$HOME\/\.claude|\$\{HOME\}\/\.claude/g, "§ROOT§")
    .replace(/\s+/g, " ")
    .trim();
}

function hookKey(h: HookEntry): string {
  if (h.type === "http" && h.url) return `http:${h.url}`;
  if (h.command) return `cmd:${normalizeCommand(h.command)}`;
  return `raw:${JSON.stringify(h)}`;
}

export function validateHooksMap(hooks: unknown, label: string): asserts hooks is HooksMap {
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error(`${label} hooks must be an object`);
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`${label} hook event '${event}' must be an array`);
    for (const [index, group] of groups.entries()) {
      if (group === null || typeof group !== "object" || Array.isArray(group)) throw new Error(`${label} hook group '${event}' at ${index} must be an object`);
      const record = group as Record<string, unknown>;
      if (record.matcher !== undefined && typeof record.matcher !== "string") throw new Error(`${label} hook matcher '${event}' at ${index} must be a string`);
      if (!Array.isArray(record.hooks)) throw new Error(`${label} hook group '${event}' at ${index} must contain a hooks array`);
      for (const [hookIndex, hook] of record.hooks.entries()) {
        if (hook === null || typeof hook !== "object" || Array.isArray(hook)) throw new Error(`${label} hook '${event}' at ${index}/${hookIndex} must be an object`);
        const entry = hook as Record<string, unknown>;
        if (entry.type !== undefined && typeof entry.type !== "string") throw new Error(`${label} hook type '${event}' at ${index}/${hookIndex} must be a string`);
        if (entry.command !== undefined && typeof entry.command !== "string") throw new Error(`${label} hook command '${event}' at ${index}/${hookIndex} must be a string`);
        if (entry.url !== undefined && typeof entry.url !== "string") throw new Error(`${label} hook url '${event}' at ${index}/${hookIndex} must be a string`);
      }
    }
  }
}
/**
 * Additively merge `incoming` hooks into `existing` settings.hooks, per matcher
 * bucket, idempotent by normalized-command (and url for http). NEVER removes or
 * reorders a foreign entry. Returns the merged map + counts. Pure (no I/O).
 */
export function mergeHooks(existing: HooksMap, incoming: HooksMap): { merged: HooksMap; added: number; skipped: number } {
  validateHooksMap(existing, "existing");
  validateHooksMap(incoming, "incoming");
  const merged: HooksMap = JSON.parse(JSON.stringify(existing));
  let added = 0;
  let skipped = 0;
  for (const [event, incomingGroups] of Object.entries(incoming)) {
    const eventBucket = merged[event] ?? (merged[event] = []);
    for (const inGroup of incomingGroups) {
      const matcher = inGroup.matcher ?? "";
      const inHooks = inGroup.hooks!;
      let target = eventBucket.find((group) => (group.matcher ?? "") === matcher);
      if (!target) {
        target = { matcher, hooks: [] };
        eventBucket.push(target);
      }
      const targetHooks = target.hooks!;
      const present = new Set(targetHooks.map(hookKey));
      for (const hook of inHooks) {
        const key = hookKey(hook);
        if (present.has(key)) skipped++;
        else {
          targetHooks.push(hook);
          present.add(key);
          added++;
        }
      }
    }
  }
  return { merged, added, skipped };
}

export { resolve };
