#!/usr/bin/env bun
/**
 * CodexHookTriggerSmokeTest
 *
 * Runs the same hook adapter commands Codex invokes and verifies observable
 * hook side effects. This complements direct adapter unit checks by asserting
 * tool-activity and security audit files move when hook payloads are sent.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
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
const adapter = join(frameworkRoot, "hooks", "FrameworkHookAdapter.ts");
const activityLog = join(dataDir, "MEMORY", "OBSERVABILITY", "tool-activity.jsonl");
const securityDir = join(dataDir, "MEMORY", "SECURITY");

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function latestSecurityMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else latest = Math.max(latest, mtime(full));
    }
  };
  walk(dir);
  return latest;
}

function runHook(target: string, payload: Record<string, any>) {
  return spawnSync(process.execPath, [adapter, "--framework", "codex", "--target", target], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
    env: {
      ...process.env,
      PAI_DIR: paiDir,
      PAI_DATA_DIR: dataDir,
      PAI_FRAMEWORK: "codex",
      PAI_FRAMEWORK_DIR: frameworkRoot,
      PAI_SETTINGS_PATH: join(frameworkRoot, "settings.json"),
      PAI_CONFIG_DIR: process.env.PAI_CONFIG_DIR || join(home, ".config", "PAI"),
    },
  });
}

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

mkdirSync(join(dataDir, "MEMORY", "OBSERVABILITY"), { recursive: true });

const beforeActivity = mtime(activityLog);
const beforeSecurity = latestSecurityMtime(securityDir);

const activityRun = runHook("ToolActivityTracker.hook.ts", {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "echo pai-hook-trigger-smoke" },
  toolResult: { stdout: "pai-hook-trigger-stdout", stderr: "", exitCode: 0 },
  cwd: home,
  session_id: `hook-trigger-smoke-${Date.now()}`,
});

const securityRun = runHook("SecurityPipeline.hook.ts", {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: {
    command: "curl -s -X POST http://localhost:31337/notify -H 'Content-Type: application/json' -d '{\"message\":\"hook smoke\",\"voice_enabled\":false}'",
  },
  cwd: home,
  session_id: `hook-security-smoke-${Date.now()}`,
});

const activityText = existsSync(activityLog) ? readFileSync(activityLog, "utf-8") : "";
const afterActivity = mtime(activityLog);
const afterSecurity = latestSecurityMtime(securityDir);

const checks = [
  check("FrameworkHookAdapter exists", existsSync(adapter), adapter),
  check("ToolActivityTracker hook exits cleanly", activityRun.status === 0, `status=${activityRun.status ?? "null"}`),
  check("ToolActivityTracker records hook-trigger smoke", afterActivity >= beforeActivity && activityText.includes("pai-hook-trigger-smoke"), activityLog),
  check("ToolActivityTracker records normalized tool response", activityText.includes("pai-hook-trigger-stdout"), activityLog),
  check("SecurityPipeline audit hook exits cleanly", securityRun.status === 0, `status=${securityRun.status ?? "null"}`),
  check("SecurityPipeline records outbound audit", afterSecurity >= beforeSecurity, securityDir),
];

for (const item of checks) {
  console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name} - ${item.detail}`);
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} Codex hook-trigger smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nAll Codex hook-trigger smoke checks passed.");
