#!/usr/bin/env bun
/**
 * StartupSelfCheckSmokeTest
 *
 * Verifies the lightweight startup self-check hook is installed, registered in
 * Codex hooks.json generation, and emits an advisory reminder when a critical
 * runtime surface is missing. Defaults to an AV-safe static smoke; pass
 * --dynamic to spawn the hook against a temporary framework home.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homeDir } from "./lib/paths";

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

function decodeEncodedCommand(command: string): string {
  const match = command.match(/(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/=]+)/i);
  if (!match) return "";
  try {
    return Buffer.from(match[1], "base64").toString("utf16le");
  } catch {
    return "";
  }
}

function hookCommandText(hooksJson: string): string {
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
  return values.join("\n");
}

const keep = process.argv.includes("--keep");
const dynamic = process.argv.includes("--dynamic") || process.env.PAI_SMOKE_DYNAMIC === "1";
const home = homeDir();
const frameworkRoot = process.env.PAI_FRAMEWORK_DIR || process.env.CODEX_HOME || join(home, ".codex");
const paiDir = process.env.PAI_DIR || join(frameworkRoot, "PAI");
const hookPath = join(frameworkRoot, "hooks", "StartupSelfCheck.hook.ts");
const hooksJsonPath = join(frameworkRoot, "hooks.json");
const configGenPath = join(paiDir, "PAI-Install", "engine", "config-gen.ts");
const paiToolPath = join(paiDir, "TOOLS", "pai.ts");

const root = join(tmpdir(), `pai-startup-self-check-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const tempFramework = join(root, "framework");
const tempData = join(root, "data");
let run: ReturnType<typeof spawnSync> | undefined;
let output = "";
if (dynamic) {
  mkdirSync(tempFramework, { recursive: true });
  mkdirSync(tempData, { recursive: true });
  writeFileSync(join(tempFramework, "config.toml"), [
    "# BEGIN PAI MANAGED ROOT CONFIG",
    "# END PAI MANAGED ROOT CONFIG",
    "# BEGIN PAI MANAGED MCP CONFIG",
    "# END PAI MANAGED MCP CONFIG",
  ].join("\n"));
  writeFileSync(join(tempFramework, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
  mkdirSync(join(tempFramework, "MCPs"), { recursive: true });
  writeFileSync(join(tempFramework, "MCPs", "none.mcp.json"), JSON.stringify({ mcpServers: {} }));

  run = spawnSync(process.execPath, [hookPath], {
    encoding: "utf-8",
    timeout: 10_000,
    windowsHide: true,
    env: {
      ...process.env,
      PAI_FRAMEWORK: "codex",
      PAI_FRAMEWORK_DIR: tempFramework,
      PAI_DIR: join(tempFramework, "PAI"),
      PAI_DATA_DIR: tempData,
      PAI_SETTINGS_PATH: join(tempFramework, "settings.json"),
    },
    input: JSON.stringify({ session_id: "startup-self-check-smoke", source: "startup" }),
  });
  output = `${run.stdout || ""}${run.stderr || ""}`;
} else {
  console.log("INFO AV-safe static smoke mode; pass --dynamic to spawn StartupSelfCheck.");
}
const hooksJson = existsSync(hooksJsonPath) ? readFileSync(hooksJsonPath, "utf-8") : "";
const hooksText = hookCommandText(hooksJson);
const configGen = existsSync(configGenPath) ? readFileSync(configGenPath, "utf-8") : "";
const paiTool = existsSync(paiToolPath) ? readFileSync(paiToolPath, "utf-8") : "";
const hookSource = existsSync(hookPath) ? readFileSync(hookPath, "utf-8") : "";
const branchCi = process.env.PAI_BRANCH_CI === "1";

const checks: Check[] = [
  check("StartupSelfCheck hook exists", existsSync(hookPath), hookPath),
  check("live hooks.json registers StartupSelfCheck", hooksText.includes("StartupSelfCheck.hook.ts") || branchCi, branchCi ? "branch CI verifies generated hooks via installer smokes" : hooksJsonPath),
  check("installer hook generator registers StartupSelfCheck", configGen.includes("StartupSelfCheck.hook.ts"), configGenPath),
  check("pai tool reuses canonical hook generator", paiTool.includes("generateCodexHooksJson"), paiToolPath),
  check("self-check branches for Codex config", hookSource.includes('framework === "codex"') && hookSource.includes("config.toml") && hookSource.includes("hooks.json"), hookPath),
  check("self-check branches for OpenCode config", hookSource.includes('framework === "opencode"') && hookSource.includes("opencode.json") && hookSource.includes("pai-opencode.ts"), hookPath),
  check("self-check branches for Claude config", hookSource.includes("CLAUDE.md") && hookSource.includes("settings.json"), hookPath),
];

if (dynamic) {
  checks.push(
    check("self-check exits cleanly", run?.status === 0, `status=${run?.status ?? "null"}`),
    check("self-check reports missing AGENTS.md", output.includes("AGENTS.md exists"), output.trim().split("\n").slice(0, 4).join(" | ")),
    check("self-check points to k doctor", output.includes("k doctor"), output.trim().split("\n").slice(-2).join(" | ")),
  );
}

print(checks);

if (dynamic) {
  if (keep) {
    console.log(`\nKept smoke root: ${root}`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} startup self-check smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nAll startup self-check smoke checks passed.");
