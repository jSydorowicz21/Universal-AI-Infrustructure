#!/usr/bin/env bun
/**
 * DetectEnv — Setup step 1. Read-only environment detection for the LifeOS
 * installer. Emits the JSON the Setup workflow branches on (OS, harness, GUI,
 * SSH, bun, existing install, dev-tree refusal flag, settings/CLAUDE.md state).
 *
 * Thin entry point over InstallEngine.detectEnv() — all logic lives there.
 *
 * Usage: bun DetectEnv.ts [--json] [--config-root <dir>]
 */

import { detectEnv } from "./InstallEngine";

function selectedConfigRoot(argv = process.argv.slice(2)): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith("--config-root=")) {
      const value = arg.slice("--config-root=".length).trim();
      if (!value) throw new Error("--config-root requires a value");
      return value;
    }
    if (arg === "--config-root") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) throw new Error("--config-root requires a value");
      return value;
    }
  }
  return undefined;
}

function main(): void {
  const configRoot = selectedConfigRoot();
  const env = detectEnv(configRoot ? { ...process.env, UAI_CONFIG_DIR: configRoot } : process.env);
  // Single JSON object, jq-pipeable. The Setup workflow reads these fields by name.
  console.log(JSON.stringify(env, null, 2));
  // A clean, unselected machine must not silently mutate a Claude profile.
  process.exit(env.harness.name === "unknown" ? 2 : 0);
}

main();
