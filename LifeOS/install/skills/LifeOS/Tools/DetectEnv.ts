#!/usr/bin/env bun
/**
 * DetectEnv — Setup step 1. Read-only environment detection for the LifeOS
 * installer. Emits the JSON the Setup workflow branches on (OS, harness, GUI,
 * SSH, bun, existing install, dev-tree refusal flag, settings/CLAUDE.md state).
 *
 * Thin entry point over InstallEngine.detectEnv() — all logic lives there.
 *
 * Usage: bun DetectEnv.ts [--harness <name>] [--json]
 */

import { detectEnv } from "./InstallEngine";

function main(): void {
  const args = process.argv.slice(2);
  const harnessFlag = args.indexOf("--harness");
  if (harnessFlag >= 0) {
    const harness = args[harnessFlag + 1];
    if (!harness || harness.startsWith("--")) {
      console.error("--harness requires a harness name");
      process.exit(1);
    }
    const supported = ["claude-code", "codex", "gemini", "omp", "opencode"];
    if (!supported.includes(harness)) {
      console.error(`unsupported harness: ${harness}; expected one of ${supported.join(", ")}`);
      process.exit(1);
    }
    process.env.LIFEOS_HARNESS = harness;
  }
  const env = detectEnv();
  // Single JSON object, jq-pipeable. The Setup workflow reads these fields by name.
  console.log(JSON.stringify(env, null, 2));
  process.exit(env.os.platform === "unsupported" ? 2 : 0);
}

main();
