#!/usr/bin/env bun
/**
 * ConfigAuditSmokeTest
 *
 * Verifies ConfigAudit handles provider-native Codex config files without
 * reading Claude settings.json or writing snapshots outside shared MEMORY.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = join(tmpdir(), `pai-config-audit-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const home = join(root, "home");
const dataDir = join(root, "pai-data");
const frameworkRoot = join(home, ".codex");
const paiDir = join(frameworkRoot, "PAI");
const hookPath = join(import.meta.dir, "..", "..", "hooks", "ConfigAudit.hook.ts");

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runHook(input: Record<string, unknown>) {
  return spawnSync(process.execPath, [hookPath], {
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
    input: JSON.stringify({
      session_id: "config-audit-smoke",
      transcript_path: join(root, "transcript.jsonl"),
      hook_event_name: "ConfigChange",
      ...input,
    }),
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
}

mkdirSync(paiDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

try {
  const configTomlPath = join(frameworkRoot, "config.toml");
  const hooksJsonPath = join(frameworkRoot, "hooks.json");

  writeFileSync(configTomlPath, 'model = "seed-model"\n', "utf-8");
  const defaultConfigRun = runHook({});

  writeFileSync(configTomlPath, 'model = "changed-model"\n[tools]\nweb_search = true\n', "utf-8");
  const configDiffRun = runHook({ config_path: "config.toml" });

  writeFileSync(hooksJsonPath, JSON.stringify({ hooks: { SessionStart: [] } }, null, 2), "utf-8");
  const hooksInitialRun = runHook({ config_path: hooksJsonPath });

  writeFileSync(hooksJsonPath, JSON.stringify({ hooks: { PreToolUse: [{ command: "bun hook" }] } }, null, 2), "utf-8");
  const hooksDiffRun = runHook({ config_path: hooksJsonPath });

  const auditPath = join(dataDir, "MEMORY", "OBSERVABILITY", "config-changes.jsonl");
  const events = readJsonl(auditPath);
  const snapshotDir = join(dataDir, "MEMORY", "STATE", "config-audit");
  const snapshotFiles = existsSync(snapshotDir) ? readdirSync(snapshotDir) : [];
  const defaultEvent = events.find((event) => event.session_id === "config-audit-smoke" && event.config_path === "config.toml");
  const configEvent = [...events].reverse().find((event) => event.config_path === "config.toml" && String(event.config_key).includes("model"));
  const hooksEvent = [...events].reverse().find((event) => String(event.config_path).replace(/\\/g, "/").endsWith("/hooks.json"));

  check("default Codex config path is config.toml", defaultConfigRun.status === 0 && Boolean(defaultEvent), `status=${defaultConfigRun.status ?? "null"} event=${JSON.stringify(defaultEvent)}`);
  check("config.toml diff logs changed model", configDiffRun.status === 0 && Boolean(configEvent), `status=${configDiffRun.status ?? "null"} event=${JSON.stringify(configEvent)}`);
  check("hooks.json diff logs hook key", hooksDiffRun.status === 0 && Boolean(hooksEvent) && String(hooksEvent?.config_key).includes("hooks"), `status=${hooksDiffRun.status ?? "null"} event=${JSON.stringify(hooksEvent)}`);
  check("hooks.json diff is marked sensitive", hooksDiffRun.stderr.includes("[SENSITIVE]"), hooksDiffRun.stderr.trim());
  check("snapshots are stored in shared MEMORY", snapshotFiles.length >= 2 && snapshotFiles.every((file) => file.endsWith(".json")), `${snapshotDir} ${JSON.stringify(snapshotFiles)}`);
  check("Claude settings.json is not required", !defaultConfigRun.stderr.includes("settings.json") && !configDiffRun.stderr.includes("settings.json"), `${defaultConfigRun.stderr.trim()} | ${configDiffRun.stderr.trim()}`);
  check("absolute hooks path run exits cleanly", hooksInitialRun.status === 0, `status=${hooksInitialRun.status ?? "null"} stderr=${hooksInitialRun.stderr.trim()}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nConfig audit smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log("\nAll config audit smoke checks passed.");
