import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

type HookEntry = {
  command?: unknown;
  commandWindows?: unknown;
};

export function countRegisteredHooks(frameworkDir: string): number {
  const codexCount = countHookConfig(join(frameworkDir, "hooks.json"));
  if (codexCount !== null) return codexCount;

  const claudeCount = countHookConfig(join(frameworkDir, "settings.json"));
  if (claudeCount !== null) return claudeCount;

  return countHookFiles(frameworkDir);
}

function countHookConfig(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return countHookCommands(parsed?.hooks ?? {});
  } catch {
    return null;
  }
}

function countHookCommands(events: unknown): number {
  const unique = new Set<string>();
  if (!events || typeof events !== "object" || Array.isArray(events)) return 0;

  for (const matchers of Object.values(events as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const list = (matcher as { hooks?: unknown }).hooks;
      if (!Array.isArray(list)) continue;
      for (const hook of list) {
        const entry = hook as HookEntry;
        const command = typeof entry.command === "string" ? entry.command : "";
        const commandWindows = typeof entry.commandWindows === "string" ? entry.commandWindows : "";
        const signature = command || commandWindows;
        if (signature) unique.add(signature);
      }
    }
  }

  return unique.size;
}

function countHookFiles(frameworkDir: string): number {
  const hooksDir = join(frameworkDir, "hooks");
  if (!existsSync(hooksDir)) return 0;

  try {
    return readdirSync(hooksDir, { withFileTypes: true }).filter((entry) => {
      if (!entry.isFile()) return false;
      const path = join(hooksDir, entry.name);
      try {
        if (!statSync(path).isFile()) return false;
      } catch {
        return false;
      }
      return entry.name.endsWith(".hook.ts") || entry.name.endsWith(".hook.js") || entry.name.endsWith(".ts");
    }).length;
  } catch {
    return 0;
  }
}
