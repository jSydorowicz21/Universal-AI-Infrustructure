#!/usr/bin/env bun
/**
 * ReferenceCheckSmokeTest
 *
 * Verifies ReferenceCheck resolves provider-native Codex framework-home paths
 * while scanning the full active framework root.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = join(tmpdir(), `pai-referencecheck-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const home = join(root, "home");
const dataDir = join(root, "pai-data");
const frameworkRoot = join(home, ".codex");
const paiDir = join(frameworkRoot, "PAI");
const referenceCheckPath = join(import.meta.dir, "ReferenceCheck.ts");

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

mkdirSync(join(paiDir, "DOCUMENTATION", "Hooks"), { recursive: true });
mkdirSync(join(paiDir, "TOOLS"), { recursive: true });
mkdirSync(join(frameworkRoot, "hooks"), { recursive: true });
mkdirSync(join(frameworkRoot, "commands"), { recursive: true });
mkdirSync(dataDir, { recursive: true });

try {
  writeFileSync(join(paiDir, "TOOLS", "RefTarget.ts"), "export const ok = true;\n", "utf-8");
  writeFileSync(join(frameworkRoot, "hooks", "CodexHook.hook.ts"), "console.error('hook');\n", "utf-8");
  writeFileSync(join(frameworkRoot, "commands", "cs.md"), "# Context search\n", "utf-8");

  writeFileSync(join(paiDir, "DOCUMENTATION", "Hooks", "HookSystem.md"), [
    "# Hook System",
    "",
    "Runtime hook: `~/.codex/hooks/CodexHook.hook.ts`",
    "Tool reference: `PAI/TOOLS/RefTarget.ts`",
    "Command reference: `$HOME/.codex/commands/cs.md`",
    "",
  ].join("\n"), "utf-8");

  writeFileSync(join(frameworkRoot, "AGENTS.md"), [
    "# Agent Instructions",
    "",
    "@PAI/DOCUMENTATION/Hooks/HookSystem.md",
    "",
  ].join("\n"), "utf-8");

  writeFileSync(join(frameworkRoot, "RTK.md"), [
    "# RTK",
    "",
    "| Path |",
    "| --- |",
    "| `hooks/CodexHook.hook.ts` |",
    "",
  ].join("\n"), "utf-8");

  const run = spawnSync(process.execPath, [referenceCheckPath, "--json", "--quiet"], {
    cwd: frameworkRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PAI_FRAMEWORK: "codex",
      PAI_FRAMEWORK_DIR: frameworkRoot,
      PAI_DIR: paiDir,
      PAI_DATA_DIR: dataDir,
    },
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });

  let result: any = {};
  try {
    result = JSON.parse(run.stdout);
  } catch {}

  check("ReferenceCheck exits cleanly", run.status === 0, `status=${run.status ?? "null"} stderr=${run.stderr.trim()}`);
  check("full framework root is scanned", result.scannedFiles >= 5, JSON.stringify(result));
  check("Codex framework-home references are resolved", result.scannedRefs >= 5, JSON.stringify(result));
  check("no references are missing", result.summary?.missing === 0, JSON.stringify(result.findings ?? []));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nReferenceCheck smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log("\nAll ReferenceCheck smoke checks passed.");
