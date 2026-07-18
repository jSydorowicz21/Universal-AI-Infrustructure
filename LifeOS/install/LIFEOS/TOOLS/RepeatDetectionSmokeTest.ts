#!/usr/bin/env bun
/**
 * RepeatDetectionSmokeTest
 *
 * Verifies repeated prompts produce advisory context without blocking
 * UserPromptSubmit. Codex treats non-zero UserPromptSubmit hooks as blocked
 * prompts, so repeat detection must exit 0.
 */

import { mkdirSync, rmSync } from "node:fs";
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

const keep = process.argv.includes("--keep");
const home = homeDir();
const frameworkRoot = process.env.PAI_FRAMEWORK_DIR || process.env.CODEX_HOME || join(home, ".codex");
const hookPath = join(frameworkRoot, "hooks", "RepeatDetection.hook.ts");
const root = join(tmpdir(), `pai-repeat-detection-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const dataDir = join(root, "pai-data");
mkdirSync(join(dataDir, "MEMORY", "STATE"), { recursive: true });

const prompt = "great. lets move to 8 for update rollback proof";
const env = {
  ...process.env,
  PAI_DATA_DIR: dataDir,
  PAI_FRAMEWORK: "codex",
  PAI_FRAMEWORK_DIR: frameworkRoot,
};

function runPrompt() {
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({
      session_id: "repeat-detection-smoke",
      hook_event_name: "UserPromptSubmit",
      prompt,
    }),
    encoding: "utf-8",
    timeout: 10_000,
    windowsHide: true,
    env,
  });
}

const first = runPrompt();
const second = runPrompt();
const output = `${second.stdout || ""}${second.stderr || ""}`;

const checks: Check[] = [
  check("first prompt exits cleanly", first.status === 0, `status=${first.status ?? "null"}`),
  check("repeat prompt does not block", second.status === 0, `status=${second.status ?? "null"}`),
  check("repeat prompt emits additional context", output.includes("hookSpecificOutput") && output.includes("additionalContext"), output.trim()),
  check("repeat guidance continues newest request", output.includes("Continue by addressing the newest request directly"), output.trim()),
  check("repeat guidance avoids hard STOP wording", !output.includes("STOP."), output.trim()),
];

print(checks);

if (keep) {
  console.log(`\nKept smoke root: ${root}`);
} else {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} repeat-detection smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nAll repeat-detection smoke checks passed.");
