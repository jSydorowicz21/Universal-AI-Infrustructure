#!/usr/bin/env bun
/**
 * HookSharedPathSmokeTest - verify hook-side path helpers honor PAI_DATA_DIR.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const keep = process.argv.includes("--keep");

function uniqueRoot(): string {
  return join(tmpdir(), `pai-hook-shared-path-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function printChecks(checks: Check[]) {
  for (const check of checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name} - ${check.detail}`);
  }
}

const root = uniqueRoot();
const home = join(root, "home");
const data = join(root, "pai-data");
const framework = join(home, ".codex");
const paiDir = join(framework, "PAI");

mkdirSync(home, { recursive: true });
mkdirSync(join(data, "MEMORY", "WORK", "20260617-120000_shared-hook-path"), { recursive: true });
mkdirSync(join(data, "USER"), { recursive: true });
mkdirSync(paiDir, { recursive: true });

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PAI_DATA_DIR = data;
process.env.PAI_FRAMEWORK_DIR = framework;
process.env.PAI_DIR = paiDir;

const paths = await import("../../hooks/lib/paths.ts");
const isa = await import("../../hooks/lib/isa-utils.ts");
const adapterPath = join(import.meta.dir, "..", "..", "hooks", "FrameworkHookAdapter.ts");
const smartApproverPath = join(import.meta.dir, "..", "..", "hooks", "SmartApprover.hook.ts");

const artifactPath = join(data, "MEMORY", "WORK", "20260617-120000_shared-hook-path", "ISA.md");
writeFileSync(artifactPath, [
  "---",
  "slug: 20260617-120000_shared-hook-path",
  "title: Shared Hook Path",
  "phase: build",
  "progress: 1/1",
  "effort: standard",
  "mode: interactive",
  "started: 2026-06-17T12:00:00.000Z",
  "---",
  "",
  "# Shared Hook Path",
  "",
  "## ISC Criteria",
  "- [x] ISC-1: Hook state uses shared memory",
  "",
].join("\n"));

isa.writeRegistry({
  sessions: {
    smoke: {
      task: "shared hook path",
      phase: "native",
      started: "2026-06-17T12:00:00.000Z",
      updatedAt: "2026-06-17T12:00:00.000Z",
    },
  },
});
isa.syncToWorkJson({ slug: "20260617-120000_shared-hook-path", title: "Shared Hook Path" }, artifactPath, readFileSync(artifactPath, "utf-8"), "hook-smoke-session");

const adapterEnv = {
  ...process.env,
  PAI_DATA_DIR: data,
  PAI_FRAMEWORK: "codex",
  PAI_FRAMEWORK_DIR: framework,
  PAI_DIR: paiDir,
  KITTY_LISTEN_ON: "unix:/tmp/pai-smoke-kitty.sock",
  KITTY_WINDOW_ID: "42",
} as Record<string, string>;
const adapterRun = spawnSync(process.execPath, [adapterPath, "--framework", "codex", "--target", "KittyEnvPersist.hook.ts"], {
  cwd: framework,
  env: adapterEnv,
  input: JSON.stringify({ sessionId: "adapter-smoke", source: "startup", cwd: framework }),
  encoding: "utf-8",
  timeout: 20_000,
});
const adapterSessionPath = join(data, "MEMORY", "STATE", "kitty-sessions", "adapter-smoke.json");

const subagentData = join(root, "subagent-data");
mkdirSync(join(subagentData, "MEMORY", "STATE"), { recursive: true });
const subagentEnv = {
  ...adapterEnv,
  PAI_DATA_DIR: subagentData,
} as Record<string, string>;
const subagentRun = spawnSync(process.execPath, [adapterPath, "--framework", "codex", "--target", "KittyEnvPersist.hook.ts"], {
  cwd: framework,
  env: subagentEnv,
  input: JSON.stringify({ sessionId: "adapter-subagent", isSubagent: true, source: "startup", cwd: framework }),
  encoding: "utf-8",
  timeout: 20_000,
});
const subagentKittyEnvPath = join(subagentData, "MEMORY", "STATE", "kitty-env.json");
const smartApproverRun = spawnSync(process.execPath, [smartApproverPath], {
  cwd: framework,
  env: adapterEnv,
  input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(framework, "PAI", "SMOKE.md") } }),
  encoding: "utf-8",
  timeout: 20_000,
  windowsHide: true,
});

const workJsonPath = join(data, "MEMORY", "STATE", "work.json");
const workJsonText = existsSync(workJsonPath) ? readFileSync(workJsonPath, "utf-8") : "";
let workJson: any = {};
try {
  workJson = JSON.parse(workJsonText);
} catch {}

const checks: Check[] = [
  {
    name: "hook memory dir uses PAI_DATA_DIR",
    passed: paths.getMemoryDir() === join(data, "MEMORY"),
    detail: paths.getMemoryDir(),
  },
  {
    name: "hook user dir uses PAI_DATA_DIR",
    passed: paths.getUserDir() === join(data, "USER"),
    detail: paths.getUserDir(),
  },
  {
    name: "hook path expands Windows HOME separators",
    passed: paths.expandPath("$HOME\\.codex\\PAI") === join(home, ".codex", "PAI"),
    detail: paths.expandPath("$HOME\\.codex\\PAI"),
  },
  {
    name: "isa work dir uses shared MEMORY",
    passed: isa.WORK_DIR === join(data, "MEMORY", "WORK"),
    detail: isa.WORK_DIR,
  },
  {
    name: "findArtifactPath reads shared WORK",
    passed: isa.findArtifactPath("20260617-120000_shared-hook-path") === artifactPath,
    detail: isa.findArtifactPath("20260617-120000_shared-hook-path") || "null",
  },
  {
    name: "writeRegistry writes shared work.json",
    passed: existsSync(workJsonPath),
    detail: workJsonPath,
  },
  {
    name: "syncToWorkJson stores shared MEMORY-relative ISA",
    passed: workJson.sessions?.["20260617-120000_shared-hook-path"]?.isa === "MEMORY/WORK/20260617-120000_shared-hook-path/ISA.md",
    detail: workJson.sessions?.["20260617-120000_shared-hook-path"]?.isa || "missing",
  },
  {
    name: "adapter normalizes camelCase sessionId",
    passed: adapterRun.status === 0 && existsSync(adapterSessionPath),
    detail: `status=${adapterRun.status ?? "null"} ${adapterSessionPath}`,
  },
  {
    name: "adapter subagent marker skips session state",
    passed: subagentRun.status === 0 && !existsSync(subagentKittyEnvPath),
    detail: `status=${subagentRun.status ?? "null"} ${subagentKittyEnvPath}`,
  },
  {
    name: "SmartApprover trusts active framework home",
    passed: smartApproverRun.status === 0 && smartApproverRun.stdout.includes('"behavior":"allow"'),
    detail: `status=${smartApproverRun.status ?? "null"} stdout=${smartApproverRun.stdout.trim()}`,
  },
];

printChecks(checks);

if (keep) {
  console.log(`\nKept smoke test root: ${root}`);
} else {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((check) => !check.passed).length;
if (failed > 0) {
  console.error(`\n${failed} hook shared-path smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nAll hook shared-path smoke checks passed.");
