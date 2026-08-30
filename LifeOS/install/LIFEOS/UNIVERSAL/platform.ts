import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

export type RuntimeOs = "win32" | "darwin" | "linux" | "unknown";
export interface PlatformFacts {
  os: RuntimeOs;
  arch: string;
  home: string;
  temp: string;
  wsl: boolean;
  container: boolean;
  headless: boolean;
  tier: "P1" | "P2" | "P3" | "P4" | "P5";
}

export function resolveHome(env: Record<string, string | undefined> = process.env, fallback: () => string = homedir): string {
  const value = env.HOME?.trim() || env.USERPROFILE?.trim() || fallback();
  if (!value) throw new Error("Unable to resolve home directory from HOME, USERPROFILE, or homedir()");
  return value;
}

export function resolveDataRoot(env: Record<string, string | undefined> = process.env, fallback: () => string = homedir): string {
  return env.UAI_DATA_DIR?.trim() || env.PAI_DATA_DIR?.trim() || join(resolveHome(env, fallback), ".pai");
}

export function resolveConfigRoot(env: Record<string, string | undefined>, adapterId: string, fallback: () => string = homedir): string {
  const explicit = env.UAI_CONFIG_DIR?.trim() || env.PAI_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  const adapterExplicit = adapterId === "claude"
    ? env.CLAUDE_CONFIG_DIR?.trim()
    : adapterId === "omp"
      ? env.PI_CODING_AGENT_DIR?.trim()
      : adapterId === "codex"
        ? env.CODEX_HOME?.trim()
        : adapterId === "opencode"
          ? env.OPENCODE_CONFIG_DIR?.trim()
          : undefined;
  if (adapterExplicit) return adapterExplicit;
  const home = resolveHome(env, fallback);
  const relativeByAdapter: Record<string, string[]> = {
    claude: [".claude"],
    omp: [".omp", "agent"],
    codex: [".codex"],
    opencode: [".config", "opencode"],
  };
  return join(home, ...(relativeByAdapter[adapterId] ?? [".config", "uai", adapterId]));
}
export function resolveLifeosRoot(env: Record<string, string | undefined>, adapterId: string, fallback: () => string = homedir): string {
  return env.LIFEOS_DIR?.trim() || join(resolveConfigRoot(env, adapterId, fallback), "LIFEOS");
}


export function expandHome(value: string, env: Record<string, string | undefined> = process.env, fallback: () => string = homedir): string {
  const home = resolveHome(env, fallback);
  return value
    .replace(/^~(?=$|[\\/])/, home)
    .replaceAll("${HOME}", home)
    .replaceAll("$HOME", home)
    .replaceAll("%USERPROFILE%", env.USERPROFILE || home);
}

export function executableCandidates(command: string, options: { platform: RuntimeOs; pathext?: string }): string[] {
  if (options.platform !== "win32" || /\.[a-z0-9]+$/i.test(command)) return [command];
  const extensions = (options.pathext || ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.trim()).filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.startsWith(".") ? extension : `.${extension}`}`)];
}

export function executableSearchPlan(command: string, options: { platform: RuntimeOs; env?: Record<string, string | undefined>; pathDelimiter?: string }): string[] {
  const env = options.env ?? process.env;
  const candidates = executableCandidates(command, { platform: options.platform, pathext: env.PATHEXT });
  if (/[\\/]/.test(command)) return candidates;
  const pathApi = options.platform === "win32" ? win32 : posix;
  const directories = (env.PATH || "").split(options.pathDelimiter ?? pathApi.delimiter).filter(Boolean);
  return directories.flatMap((directory) => candidates.map((candidate) => pathApi.join(directory, candidate)));
}

export async function resolveExecutable(command: string, options: { platform: RuntimeOs; env?: Record<string, string | undefined>; exists?: (path: string) => Promise<boolean> }): Promise<string | undefined> {
  const exists = options.exists ?? (async (path: string) => Bun.file(path).exists());
  for (const candidate of executableSearchPlan(command, options)) if (await exists(candidate)) return candidate;
  return undefined;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderHookCommand(input: { platform: RuntimeOs; executable: string; args: string[] }): string {
  if (input.platform === "win32") return `& ${[input.executable, ...input.args].map(quotePowerShell).join(" ")}`;
  return [input.executable, ...input.args].map(quotePosix).join(" ");
}

export interface LinkPlan { kind: "junction" | "symlink"; source: string; destination: string; operation: "link" }
export function planDirectoryLink(source: string, destination: string, platform: RuntimeOs): LinkPlan {
  return { operation: "link", kind: platform === "win32" ? "junction" : "symlink", source, destination };
}

export interface ProcessPlan { executable: string; args: string[]; cwd?: string; env: Record<string, string>; shell: false }
export function planProcess(input: { executable: string; args?: string[]; cwd?: string; env?: Record<string, string> }): ProcessPlan {
  return { executable: input.executable, args: input.args ?? [], cwd: input.cwd, env: { ...(input.env ?? {}) }, shell: false };
}

export function platformFacts(input: {
  platform?: NodeJS.Platform | string;
  arch?: string;
  env?: Record<string, string | undefined>;
  release?: string;
  homedir?: () => string;
  tmpdir?: () => string;
} = {}): PlatformFacts {
  const env = input.env ?? process.env;
  const rawPlatform = input.platform ?? process.platform;
  const os: RuntimeOs = rawPlatform === "win32" || rawPlatform === "darwin" || rawPlatform === "linux" ? rawPlatform : "unknown";
  const release = (input.release ?? "").toLowerCase();
  const wsl = os === "linux" && Boolean(env.WSL_DISTRO_NAME || release.includes("microsoft"));
  const container = env.UAI_CONTAINER === "1" || env.CONTAINER === "1" || Boolean(env.KUBERNETES_SERVICE_HOST);
  const explicitHeadless = env.UAI_HEADLESS === "1" || env.CI === "1" || Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
  const missingLinuxDisplay = os === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  const headless = container || explicitHeadless || missingLinuxDisplay;
  const tier = container || headless ? "P4" : os === "darwin" ? "P1" : os === "linux" ? "P2" : os === "win32" ? "P3" : "P5";
  return { os, arch: input.arch ?? process.arch, home: resolveHome(env, input.homedir ?? homedir), temp: (input.tmpdir ?? tmpdir)(), wsl, container, headless, tier };
}
