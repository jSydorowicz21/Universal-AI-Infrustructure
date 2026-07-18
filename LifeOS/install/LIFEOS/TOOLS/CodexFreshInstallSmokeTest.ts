#!/usr/bin/env bun
/**
 * CodexFreshInstallSmokeTest
 *
 * Exercises the real installer repository/configuration path against a
 * temporary HOME/CODEX_HOME/PAI_DATA_DIR. This catches packaging regressions
 * without touching the user's live framework install.
 */

import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

function print(checks: Check[]) {
  for (const item of checks) {
    console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name} - ${item.detail}`);
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function normalizePathText(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
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

function codexHookCommandTexts(hooksJson: string): string[] {
  const values: string[] = [];
  function visit(value: unknown): void {
    if (typeof value === "string") {
      values.push(value);
      const decoded = decodeEncodedCommand(value);
      if (decoded) values.push(decoded);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  }
  try {
    visit(JSON.parse(hooksJson));
  } catch {}
  return values;
}

function windowsDirectBunHookCommandsUseCallOperator(text: string): boolean {
  const commands = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /FrameworkHookAdapter\.ts/i.test(value) && /bun\.exe/i.test(value));
  return commands.length > 0 && commands.every((value) =>
    /^(?:\$env:[A-Z0-9_]+\s*=\s*'(?:[^']|'')*';\s*)*&\s+"[^"]*bun\.exe"/i.test(value)
  );
}

function codexHookConfigDirs(hooksJson: string): string[] {
  const values: string[] = [];
  for (const text of codexHookCommandTexts(hooksJson)) {
    for (const match of text.matchAll(/(?:^|\s)(?:\$env:)?PAI_CONFIG_DIR='([^']*)'/g)) {
      values.push(match[1]);
    }
  }
  return values;
}

const keep = process.argv.includes("--keep");
const root = join(tmpdir(), `pai-codex-fresh-install-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const home = join(root, "home");
const codexHome = join(home, ".codex");
const dataDir = join(home, ".pai");
const configDir = join(home, ".config", "PAI");
const staleConfigDir = join(root, "deleted-config", "PAI");
const shellProfile = join(home, ".bashrc");
const releaseRoot = resolve(import.meta.dir, "..", "..");

process.env.HOME = home;
process.env.CODEX_HOME = codexHome;
process.env.PAI_DATA_DIR = dataDir;
process.env.PAI_CONFIG_DIR = staleConfigDir;
process.env.PAI_FRAMEWORK = "codex";
process.env.PAI_BUNDLE_DIR = releaseRoot;
process.env.PAI_SHELL_PROFILE = shellProfile;
process.env.PAI_USER_ENV_TARGET = "Process";
process.env.SHELL = "/bin/bash";

const { createFreshState, completeStep } = await import("../PAI-Install/engine/state.ts");
const { runSystemDetect, runRepository, runConfiguration } = await import("../PAI-Install/engine/actions.ts");

const events: string[] = [];
const emit = async (event: any) => {
  if (event?.content) events.push(event.content);
};

const state = createFreshState("cli");
state.collected.framework = "codex";
state.collected.principalName = "Smoke User";
state.collected.aiName = "SMOKE";
state.collected.catchphrase = "Smoke ready";
state.collected.scanConsent = "no";
state.collected.timezone = "America/Chicago";

try {
  await runSystemDetect(state, emit);
  completeStep(state, "system-detect");
  await runRepository(state, emit);
  completeStep(state, "repository");
  await runConfiguration(state, emit);
  completeStep(state, "configuration");

  const configToml = existsSync(join(codexHome, "config.toml")) ? readFileSync(join(codexHome, "config.toml"), "utf-8") : "";
  const hooksJson = existsSync(join(codexHome, "hooks.json")) ? readFileSync(join(codexHome, "hooks.json"), "utf-8") : "";
  const agentsMd = existsSync(join(codexHome, "AGENTS.md")) ? readFileSync(join(codexHome, "AGENTS.md"), "utf-8") : "";
  const codexAgentPath = join(codexHome, "agents", "engineer.toml");
  const codexAgent = existsSync(codexAgentPath) ? readFileSync(codexAgentPath, "utf-8") : "";
  const interviewPromptPath = join(codexHome, "prompts", "interview.md");
  const interviewPrompt = existsSync(interviewPromptPath) ? readFileSync(interviewPromptPath, "utf-8") : "";
  const profile = existsSync(shellProfile) ? readFileSync(shellProfile, "utf-8") : "";
  const frameworkState = existsSync(join(dataDir, "framework.json")) ? readJson(join(dataDir, "framework.json")) : {};
  const hookConfigDirs = codexHookConfigDirs(hooksJson).map(normalizePathText);
  const hookCommandText = codexHookCommandTexts(hooksJson).join("\n");
  const expectedConfigDir = normalizePathText(configDir);
  const staleConfigSegment = normalizePathText(staleConfigDir);
  const expectedStatePath = join(configDir, "PAI-Install", "install-state.json");
  const staleStatePath = join(staleConfigDir, "PAI-Install", "install-state.json");

  const checks: Check[] = [
    check("Codex home created", existsSync(codexHome), codexHome),
    check("AGENTS.md generated", agentsMd.includes("# AGENTS.md") || agentsMd.includes("PAI"), join(codexHome, "AGENTS.md")),
    check("RTK.md generated", existsSync(join(codexHome, "RTK.md")), join(codexHome, "RTK.md")),
    check("config.toml has PAI root block", configToml.includes("BEGIN PAI MANAGED ROOT CONFIG"), join(codexHome, "config.toml")),
    check("config.toml supports AGENTS/RTK fallback", configToml.includes("AGENTS.md") && configToml.includes("RTK.md"), "project_doc_fallback_filenames"),
    check("hooks.json generated", hookCommandText.includes("FrameworkHookAdapter.ts") && !hookCommandText.includes("CodexHookRunner.cmd"), join(codexHome, "hooks.json")),
    check("startup self-check hook generated", hookCommandText.includes("StartupSelfCheck.hook.ts"), join(codexHome, "hooks.json")),
    check("PromptProcessing timeout leaves adapter headroom", hooksJson.includes('"timeout": 40') && hookCommandText.includes("--timeout-ms") && hookCommandText.includes("35000"), join(codexHome, "hooks.json")),
    check("hooks use direct Bun adapter commands", process.platform !== "win32" || (hookCommandText.includes("bun.exe") && hookCommandText.includes("FrameworkHookAdapter.ts") && !hookCommandText.includes("-EncodedCommand") && !hookCommandText.includes("powershell.exe")), join(codexHome, "hooks.json")),
    check("hooks use PowerShell call operator for quoted bun.exe", process.platform !== "win32" || windowsDirectBunHookCommandsUseCallOperator(hookCommandText), join(codexHome, "hooks.json")),
    check("hooks ignore stale PAI_CONFIG_DIR", !normalizePathText(hookCommandText).includes(staleConfigSegment), JSON.stringify(hookConfigDirs)),
    check("installer state ignores stale PAI_CONFIG_DIR", existsSync(expectedStatePath) && !existsSync(staleStatePath), expectedStatePath),
    check("interview prompt generated", interviewPrompt.includes("$Interview") && !interviewPrompt.includes('Skill("'), interviewPromptPath),
    check("Codex native agent generated", codexAgent.includes("developer_instructions") && codexAgent.includes("provider-neutral PAI agent contract"), codexAgentPath),
    check("Codex native agent avoids Claude provenance", codexAgent.length > 0 && !codexAgent.includes("shared Claude-style PAI agent definition") && !codexAgent.includes("~/.claude"), codexAgentPath),
    check("Codex native agent avoids duplicate instruction fallback", codexAgent.length > 0 && !codexAgent.includes("AGENTS.md or AGENTS.md"), codexAgentPath),
    check("MCP profiles packaged", existsSync(join(codexHome, "MCPs", "dev-work.mcp.json")), join(codexHome, "MCPs", "dev-work.mcp.json")),
    check("MCP profile JSON parses", readJson(join(codexHome, "MCPs", "dev-work.mcp.json"))?.mcpServers?.shadcn?.command === "bunx", "dev-work.mcp.json"),
    check("framework state points to Codex", frameworkState.active === "codex" && frameworkState.root === codexHome, join(dataDir, "framework.json")),
    check("shell profile isolated to temp HOME", existsSync(shellProfile), shellProfile),
    check("shell k alias points to temp Codex", profile.includes(`bun ${JSON.stringify(join(codexHome, "PAI", "TOOLS", "pai.ts"))}`), shellProfile),
    check("shell pai alias points to temp data", profile.includes(`PAI_DATA_DIR=${JSON.stringify(dataDir)}`), shellProfile),
    check("shell pai alias exports PAI_DIR", profile.includes(`PAI_DIR=${JSON.stringify(join(codexHome, "PAI"))}`), shellProfile),
    check("installer refreshes PAI environment variables", process.platform !== "win32" || events.some((event) => event.includes("Windows user environment updated")), "process-scope user env test"),
    check("shared MEMORY link exists", existsSync(join(codexHome, "PAI", "MEMORY")) && lstatSync(join(codexHome, "PAI", "MEMORY")).isSymbolicLink(), join(codexHome, "PAI", "MEMORY")),
    check("shared USER link exists", existsSync(join(codexHome, "PAI", "USER")) && lstatSync(join(codexHome, "PAI", "USER")).isSymbolicLink(), join(codexHome, "PAI", "USER")),
    check("shared security patterns installed", existsSync(join(dataDir, "USER", "SECURITY", "PATTERNS.yaml")), join(dataDir, "USER", "SECURITY", "PATTERNS.yaml")),
  ];

  print(checks);
  const failed = checks.filter((item) => !item.passed);
  if (failed.length > 0) {
    console.error(`\n${failed.length} Codex fresh-install smoke check(s) failed.`);
    process.exit(1);
  }

  console.log("\nAll Codex fresh-install smoke checks passed.");
} finally {
  if (keep) {
    console.log(`\nKept smoke root: ${root}`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
}
