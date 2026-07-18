#!/usr/bin/env bun
/**
 * StartupSelfCheck.hook.ts
 *
 * Lightweight startup reminder for doctor-critical PAI runtime failures. This
 * intentionally does not run the full doctor: no Codex sessions, no installer
 * smoke tests, no provider auth checks. It only checks cheap local invariants
 * and fast Pulse health routes, then prints a concise reminder if anything is
 * broken.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir, getFrameworkDir } from "./lib/paths";
import { isSubagentSession } from "./lib/session";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readText(path));
  } catch {
    return null;
  }
}

function decodeEncodedCommand(command: string): string {
  const match = command.match(/(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/=]+)/i);
  if (!match) return "";
  try {
    return Buffer.from(match[1], "base64").toString("utf16le");
  } catch {
    return "";
  }
}

function collectHookCommandTexts(config: unknown): string[] {
  const hooks = (config as { hooks?: Record<string, unknown[]> } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return [];

  const texts: string[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hookList = (group as { hooks?: unknown[] } | null)?.hooks;
      if (!Array.isArray(hookList)) continue;
      for (const hook of hookList) {
        const entry = hook as { command?: unknown; commandWindows?: unknown };
        for (const value of [entry.command, entry.commandWindows]) {
          if (typeof value !== "string" || !value) continue;
          texts.push(value);
          const decoded = decodeEncodedCommand(value);
          if (decoded) texts.push(decoded);
        }
      }
    }
  }
  return texts;
}

function normalizeFramework(value: string | undefined): string {
  const normalized = (value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "codex" || normalized === "openai" || normalized === "openaicodex") return "codex";
  if (normalized === "opencode" || normalized === "open") return "opencode";
  if (normalized === "claude" || normalized === "claudecode") return "claude";
  return normalized;
}

function inferFramework(frameworkRoot: string): string {
  const explicit = normalizeFramework(process.env.PAI_FRAMEWORK);
  if (explicit) return explicit;
  if (existsSync(join(frameworkRoot, "config.toml")) && existsSync(join(frameworkRoot, "hooks.json"))) return "codex";
  if (existsSync(join(frameworkRoot, "opencode.json"))) return "opencode";
  return "claude";
}

function hasAgentsInstruction(value: unknown): boolean {
  return value === "AGENTS.md" || (Array.isArray(value) && value.includes("AGENTS.md"));
}

async function pulseCheck(path: string): Promise<Check> {
  try {
    const res = await fetch(`http://localhost:31337${path}`, {
      signal: AbortSignal.timeout(900),
    });
    return check(`Pulse ${path}`, res.ok, `HTTP ${res.status}`);
  } catch (err) {
    return check(`Pulse ${path}`, false, err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  if (isSubagentSession()) return;

  const frameworkRoot = getFrameworkDir();
  const framework = inferFramework(frameworkRoot);
  const dataDir = getDataDir();
  const mcpDir = join(frameworkRoot, "MCPs");

  const checks: Check[] = [
    check("FrameworkHookAdapter exists", existsSync(join(frameworkRoot, "hooks", "FrameworkHookAdapter.ts")), join(frameworkRoot, "hooks", "FrameworkHookAdapter.ts")),
    check("MCP profiles present", existsSync(mcpDir) && readdirSync(mcpDir).some((file) => file.endsWith(".mcp.json")), mcpDir),
    check("Shared PAI data exists", existsSync(dataDir), dataDir),
  ];

  if (framework === "codex") {
    const configTomlPath = join(frameworkRoot, "config.toml");
    const hooksJsonPath = join(frameworkRoot, "hooks.json");
    const configToml = readText(configTomlPath);
    const hooksConfig = readJson(hooksJsonPath);
    const hookTexts = collectHookCommandTexts(hooksConfig);
    const hookText = hookTexts.join("\n");
    checks.push(
      check("AGENTS.md exists", existsSync(join(frameworkRoot, "AGENTS.md")), join(frameworkRoot, "AGENTS.md")),
      check("RTK.md exists", existsSync(join(frameworkRoot, "RTK.md")), join(frameworkRoot, "RTK.md")),
      check("config.toml has PAI root block", configToml.includes("BEGIN PAI MANAGED ROOT CONFIG"), configTomlPath),
      check("config.toml has MCP block", configToml.includes("BEGIN PAI MANAGED MCP CONFIG"), configTomlPath),
      check("hooks.json has runnable hook commands", hookTexts.length > 0 && hookText.includes("FrameworkHookAdapter.ts"), hooksJsonPath),
      check("hooks.json avoids legacy CodexHookRunner", !hookText.includes("CodexHookRunner.cmd"), hooksJsonPath),
      check("hooks.json has StartupSelfCheck", hookText.includes("StartupSelfCheck.hook.ts"), hooksJsonPath),
    );
  } else if (framework === "opencode") {
    const configPath = join(frameworkRoot, "opencode.json");
    const pluginPath = join(frameworkRoot, "plugins", "pai-opencode.ts");
    const config = readJson(configPath) as { instructions?: unknown } | null;
    const pluginText = readText(pluginPath);
    checks.push(
      check("AGENTS.md exists", existsSync(join(frameworkRoot, "AGENTS.md")), join(frameworkRoot, "AGENTS.md")),
      check("RTK.md exists", existsSync(join(frameworkRoot, "RTK.md")), join(frameworkRoot, "RTK.md")),
      check("opencode.json exists", existsSync(configPath), configPath),
      check("opencode.json keeps AGENTS instructions", hasAgentsInstruction(config?.instructions), configPath),
      check("OpenCode PAI plugin exists", existsSync(pluginPath), pluginPath),
      check("OpenCode PAI plugin has StartupSelfCheck", pluginText.includes("StartupSelfCheck.hook.ts"), pluginPath),
    );
  } else {
    const settingsPath = join(frameworkRoot, "settings.json");
    const settings = readJson(settingsPath);
    const hookText = collectHookCommandTexts(settings).join("\n");
    checks.push(
      check("CLAUDE.md exists", existsSync(join(frameworkRoot, "CLAUDE.md")), join(frameworkRoot, "CLAUDE.md")),
      check("RTK.md exists", existsSync(join(frameworkRoot, "RTK.md")), join(frameworkRoot, "RTK.md")),
      check("settings.json exists", existsSync(settingsPath), settingsPath),
      check("settings.json has hooks", Boolean((settings as { hooks?: unknown } | null)?.hooks), settingsPath),
      check("Claude hooks avoid legacy CodexHookRunner", !hookText.includes("CodexHookRunner.cmd"), settingsPath),
    );
  }

  checks.push(
    await pulseCheck("/health"),
    await pulseCheck("/voice/health"),
    await pulseCheck("/assistant/health"),
  );

  const failures = checks.filter((item) => !item.passed);
  if (failures.length === 0) return;

  const lines = failures
    .slice(0, 6)
    .map((item) => `- ${item.name}: ${item.detail}`);
  const suffix = failures.length > lines.length ? `\n- ...and ${failures.length - lines.length} more` : "";

  console.log([
    "⚠️ PAI startup self-check found doctor-critical issue(s):",
    ...lines,
    `${suffix}\nRun \`k doctor\` for AV-safe diagnostics.`,
  ].join("\n"));
}

main().catch(() => {
  // Startup self-check is advisory. Never block session startup.
  process.exit(0);
});
