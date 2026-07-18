#!/usr/bin/env bun
/**
 * ChangeDetectionSmokeTest
 *
 * Verifies integrity/documentation change detection across Claude and Codex
 * transcript shapes. Codex emits tool activity as response_item function calls,
 * so this protects Stop-time integrity hooks from silently missing writes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = mkdtempSync(join(tmpdir(), "pai-change-detection-smoke-"));
const home = join(root, "home");
const frameworkRoot = join(root, "codex-home");
const paiDir = join(frameworkRoot, "PAI");
const dataDir = join(home, ".pai");
const configDir = join(home, ".config", "PAI");

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function writeJsonl(name: string, rows: unknown[]): string {
  const path = join(root, name);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
  return path;
}

mkdirSync(join(frameworkRoot, "hooks"), { recursive: true });
mkdirSync(join(paiDir, "DOCUMENTATION", "Hooks"), { recursive: true });
mkdirSync(join(paiDir, "TOOLS"), { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(configDir, { recursive: true });
writeFileSync(join(dataDir, "framework.json"), JSON.stringify({ active: "codex", root: frameworkRoot, dataDir }, null, 2));

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PAI_FRAMEWORK = "codex";
process.env.PAI_FRAMEWORK_DIR = frameworkRoot;
process.env.PAI_DIR = paiDir;
process.env.PAI_DATA_DIR = dataDir;
process.env.PAI_CONFIG_DIR = configDir;

try {
  const releaseRoot = resolve(import.meta.dir, "..", "..");
  const changeDetectionPath = join(releaseRoot, "hooks", "lib", "change-detection.ts");
  const changeDetection = await import(pathToFileURL(changeDetectionPath).href) as typeof import("../../hooks/lib/change-detection");

  const claudeTranscript = writeJsonl("claude.jsonl", [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: join(frameworkRoot, "hooks", "ClaudeHook.hook.ts") },
          },
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: join(paiDir, "DOCUMENTATION", "Hooks", "HookSystem.md") },
          },
          {
            type: "tool_use",
            name: "MultiEdit",
            input: {
              file_path: join(paiDir, "TOOLS", "Multi.ts"),
              edits: [{ old_string: "before", new_string: "after" }],
            },
          },
        ],
      },
    },
  ]);

  const codexPatch = [
    "*** Begin Patch",
    "*** Add File: hooks/NewCodexHook.hook.ts",
    "+console.error('new hook');",
    "*** Update File: PAI/TOOLS/PatchedTool.ts",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  const codexTranscript = writeJsonl("codex.jsonl", [
    {
      type: "session_meta",
      payload: { id: "codex-change-session", cwd: frameworkRoot },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "write",
        arguments: JSON.stringify({ file_path: join(frameworkRoot, "hooks", "CodexHook.hook.ts") }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "apply_patch",
        arguments: JSON.stringify({ input: codexPatch }),
      },
    },
  ]);

  const codexNativeConfigTranscript = writeJsonl("codex-native-config.jsonl", [
    {
      type: "session_meta",
      payload: { id: "codex-native-config-session", cwd: frameworkRoot },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "write",
        arguments: JSON.stringify({ file_path: join(frameworkRoot, "hooks.json") }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "edit",
        arguments: JSON.stringify({ file_path: join(frameworkRoot, "config.toml") }),
      },
    },
  ]);

  const claudeChanges = changeDetection.parseToolUseBlocks(claudeTranscript);
  const codexChanges = changeDetection.parseToolUseBlocks(codexTranscript);
  const codexPaths = changeDetection.parseModifiedFilePaths(codexTranscript);
  const codexNativeConfigChanges = changeDetection.parseToolUseBlocks(codexNativeConfigTranscript);

  check(
    "Claude hook write still detected",
    claudeChanges.some((change) => change.path === "hooks/ClaudeHook.hook.ts" && change.category === "hook" && change.tool === "Write"),
    JSON.stringify(claudeChanges),
  );
  check(
    "Claude PAI documentation edit still detected",
    claudeChanges.some((change) => change.path.replace(/\\/g, "/") === "DOCUMENTATION/Hooks/HookSystem.md" && change.category === "documentation"),
    JSON.stringify(claudeChanges),
  );
  check(
    "Claude MultiEdit PAI tool update is detected",
    claudeChanges.some((change) => change.path.replace(/\\/g, "/") === "TOOLS/Multi.ts" && change.category === "tool" && change.tool === "MultiEdit"),
    JSON.stringify(claudeChanges),
  );
  check(
    "Codex response_item write is detected",
    codexChanges.some((change) => change.path === "hooks/CodexHook.hook.ts" && change.category === "hook" && change.tool === "Write"),
    JSON.stringify(codexChanges),
  );
  check(
    "Codex apply_patch hook add is detected",
    codexChanges.some((change) => change.path === "hooks/NewCodexHook.hook.ts" && change.category === "hook" && change.tool === "Write"),
    JSON.stringify(codexChanges),
  );
  check(
    "Codex apply_patch tool update is detected",
    codexChanges.some((change) => change.path === "PAI/TOOLS/PatchedTool.ts" && change.category === "tool" && change.tool === "Edit"),
    JSON.stringify(codexChanges),
  );
  check(
    "Codex modified path set includes function call and patch paths",
    Array.from(codexPaths).some((path) => path.endsWith("/hooks/CodexHook.hook.ts")) &&
      codexPaths.has("hooks/NewCodexHook.hook.ts") &&
      codexPaths.has("PAI/TOOLS/PatchedTool.ts"),
    JSON.stringify(Array.from(codexPaths)),
  );
  check(
    "Codex changes are significant and documentable",
    changeDetection.isSignificantChange(codexChanges) && changeDetection.shouldDocumentChanges(codexChanges),
    JSON.stringify(codexChanges),
  );
  check(
    "Codex hooks.json is native hook registration",
    codexNativeConfigChanges.some((change) =>
      change.path === "hooks.json" &&
      change.category === "hook" &&
      change.tool === "Write" &&
      change.isStructural
    ),
    JSON.stringify(codexNativeConfigChanges),
  );
  check(
    "Codex config.toml is native framework config",
    codexNativeConfigChanges.some((change) =>
      change.path === "config.toml" &&
      change.category === "config" &&
      change.tool === "Edit" &&
      change.isStructural
    ),
    JSON.stringify(codexNativeConfigChanges),
  );
  check(
    "Codex native config changes trigger integrity docs",
    changeDetection.isSignificantChange(codexNativeConfigChanges) &&
      changeDetection.shouldDocumentChanges(codexNativeConfigChanges) &&
      changeDetection.inferChangeType(codexNativeConfigChanges) === "hook_update" &&
      changeDetection.generateDescriptiveTitle(codexNativeConfigChanges).includes("Hook"),
    JSON.stringify({
      changes: codexNativeConfigChanges,
      type: changeDetection.inferChangeType(codexNativeConfigChanges),
      title: changeDetection.generateDescriptiveTitle(codexNativeConfigChanges),
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nChange detection smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log("\nAll change detection smoke checks passed.");
