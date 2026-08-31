import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";

export function resolveExecutable(
  binary: string,
  env: Pick<NodeJS.ProcessEnv, "PATH" | "PATHEXT"> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathSeparator = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32" && extname(binary) === ""
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  for (const rawDirectory of (env.PATH || "").split(pathSeparator)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${binary}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function requiresExecutableBit(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}
export function firstCommandToken(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const closing = trimmed.indexOf(quote, 1);
    return closing === -1 ? trimmed.slice(1) : trimmed.slice(1, closing);
  }
  return trimmed.split(/\s+/, 1)[0];
}

export function bareCommandProblem(
  path: string,
  mode: number,
  firstLine: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const name = basename(path);
  if (platform === "win32") {
    const nativeExtensions = new Set([".exe", ".com", ".bat", ".cmd"]);
    return nativeExtensions.has(extname(path).toLowerCase())
      ? null
      : name + ": bare script requires an explicit interpreter on Windows";
  }
  if (!(mode & 0o111)) return name + ": not executable (chmod +x)";
  if (!firstLine.startsWith("#!")) return name + ": no #! shebang";
  return null;
}
