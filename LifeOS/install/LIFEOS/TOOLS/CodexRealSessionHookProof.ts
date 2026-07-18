#!/usr/bin/env bun
/**
 * CodexRealSessionHookProof
 *
 * Runs a real `codex exec` turn and verifies Codex itself loads hooks.json by
 * observing the ToolActivityTracker log move for a unique shell command marker.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homeDir } from "./lib/paths";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const home = homeDir();
function existingEnvPath(key: string): string {
  const value = process.env[key];
  return value && existsSync(value) ? value : "";
}
const frameworkRoot = existingEnvPath("PAI_FRAMEWORK_DIR") || existingEnvPath("CODEX_HOME") || join(home, ".codex");
const paiDir = existingEnvPath("PAI_DIR") || join(frameworkRoot, "PAI");
const dataDir = existingEnvPath("PAI_DATA_DIR") || join(home, ".pai");
const activityLog = join(dataDir, "MEMORY", "OBSERVABILITY", "tool-activity.jsonl");
const hooksJson = join(frameworkRoot, "hooks.json");

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

function print(checks: Check[]) {
  for (const item of checks) {
    console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name} - ${item.detail}`);
  }
}

function readLog(): string {
  try {
    return readFileSync(activityLog, "utf-8");
  } catch {
    return "";
  }
}

function outputTail(stdout: string, stderr: string): string {
  return `${stdout || ""}${stderr || ""}`.trim().split("\n").slice(-6).join(" | ");
}

function runDetail(): string {
  if (!run) return "codex not found";
  if (run.status === 0) return `status=0 marker=${marker} attempt=${attemptUsed}`;
  return outputTail(run.stdout || "", run.stderr || "") || `status=${run.status ?? "null"}`;
}

function waitForLogMarker(beforeLength: number, needle: string, timeoutMs = 15_000): string {
  const started = Date.now();
  let text = readLog();
  while (Date.now() - started < timeoutMs) {
    const delta = text.slice(beforeLength);
    if (delta.includes(needle)) return delta;
    Bun.sleepSync(250);
    text = readLog();
  }
  return text.slice(beforeLength);
}

mkdirSync(join(dataDir, "MEMORY", "OBSERVABILITY"), { recursive: true });

const codexPath = Bun.which("codex") || "";
const codexArgs = [
  "exec",
  "--skip-git-repo-check",
  "--cd",
  home,
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "-c",
  "mcp_servers={}",
  "--json",
  "-",
];
const spawnCommand = process.platform === "win32" && codexPath.toLowerCase().endsWith(".cmd")
  ? (process.env.ComSpec || "cmd.exe")
  : codexPath;
const spawnArgs = spawnCommand === codexPath ? codexArgs : ["/d", "/c", codexPath, ...codexArgs];

let marker = "";
let attemptUsed = 0;
let run: ReturnType<typeof spawnSync> | null = null;
let logDelta = "";

const maxAttempts = Math.max(1, Number(process.env.PAI_REAL_CODEX_PROOF_ATTEMPTS || "2"));
for (let attempt = 1; codexPath && attempt <= maxAttempts; attempt++) {
  attemptUsed = attempt;
  marker = `pai-real-codex-hook-proof-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const beforeLog = readLog();
  const proofCommand = process.platform === "win32"
    ? `Write-Output '${marker}'`
    : `printf '${marker}\\n'`;
  const prompt = [
    "Use the shell tool to run exactly this command now, then stop.",
    "Do not explain. Do not run any other command.",
    "",
    proofCommand,
  ].join("\n");

  run = spawnSync(spawnCommand, spawnArgs, {
      input: prompt,
      encoding: "utf-8",
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...process.env,
        CODEX_HOME: frameworkRoot,
        PAI_DIR: paiDir,
        PAI_DATA_DIR: dataDir,
        PAI_FRAMEWORK: "codex",
        PAI_FRAMEWORK_DIR: frameworkRoot,
        PAI_SETTINGS_PATH: join(frameworkRoot, "settings.json"),
        PAI_CONFIG_DIR: process.env.PAI_CONFIG_DIR || join(home, ".config", "PAI"),
      },
    });
  logDelta = waitForLogMarker(beforeLog.length, marker, 30_000);
  const commandEvent = Boolean(run.stdout?.includes('"type":"command_execution"') && run.stdout.includes(marker));
  if (run.status === 0 && commandEvent && logDelta.includes(marker)) break;
}

const checks: Check[] = [
  check("codex executable found", Boolean(codexPath), codexPath || "$PATH"),
  check("Codex hooks.json exists", existsSync(hooksJson), hooksJson),
  check("codex exec real session exits cleanly", run?.status === 0, runDetail()),
  check("Codex real session emitted command event", Boolean(run?.stdout?.includes('"type":"command_execution"') && run.stdout.includes(marker)), marker),
  check("ToolActivityTracker recorded real Codex marker", logDelta.includes(marker), activityLog),
];

print(checks);

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} real Codex session hook proof check(s) failed.`);
  process.exit(1);
}

console.log("\nReal Codex session hook proof passed.");
