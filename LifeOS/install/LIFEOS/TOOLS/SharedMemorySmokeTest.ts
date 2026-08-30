#!/usr/bin/env bun
/**
 * SharedMemorySmokeTest - verify high-impact tools honor PAI_DATA_DIR.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const keep = process.argv.includes("--keep");
const toolsDir = import.meta.dir;

function uniqueRoot(): string {
  return join(tmpdir(), `pai-shared-memory-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function runTool(tool: string, args: string[], env: Record<string, string>, cwd: string, input?: string) {
  return spawnSync(process.execPath, [join(toolsDir, tool), ...args], {
    cwd,
    env,
    input,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
}

function printChecks(checks: Check[]) {
  for (const check of checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name} - ${check.detail}`);
  }
}

function anyFileUnder(dir: string, predicate: (path: string) => boolean): boolean {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && anyFileUnder(fullPath, predicate)) return true;
    if (entry.isFile() && predicate(fullPath)) return true;
  }
  return false;
}

const root = uniqueRoot();
const data = join(root, "pai-data");
const frameworkRoot = join(root, "framework");
mkdirSync(frameworkRoot, { recursive: true });
mkdirSync(join(frameworkRoot, "skills", "SmokeSkill"), { recursive: true });
writeFileSync(join(frameworkRoot, "skills", "SmokeSkill", "SKILL.md"), "# Smoke Skill\n");
writeFileSync(join(frameworkRoot, "settings.json"), JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: "echo smoke" }],
      },
    ],
  },
}, null, 2));

const env = {
  ...process.env,
  PAI_DATA_DIR: data,
  PAI_FRAMEWORK: "codex",
  PAI_FRAMEWORK_DIR: frameworkRoot,
} as Record<string, string>;

const checks: Check[] = [];

const knowledgeDir = join(data, "MEMORY", "KNOWLEDGE", "Ideas");
mkdirSync(knowledgeDir, { recursive: true });
writeFileSync(join(knowledgeDir, "shared-memory-test.md"), [
  "---",
  "title: Shared Memory Test",
  "tags: [shared, codex, opencode]",
  "---",
  "This note proves Codex Claude and OpenCode read the same shared PAI knowledge archive.",
  "",
].join("\n"));

const currentStateDir = join(data, "USER", "TELOS", "CURRENT_STATE");
mkdirSync(currentStateDir, { recursive: true });
writeFileSync(join(currentStateDir, "CONSUMPTION.md"), "# Consumption\n");
writeFileSync(join(data, "USER", "TELOS", "MISSION.md"), "# Mission\n");
writeFileSync(join(data, "USER", "TELOS", "RESTAURANTS.md"), [
  "# Restaurants",
  "",
  "- name: \"Papaya Thai\"",
  "  cuisine: thai",
  "  rating: 9",
  "",
].join("\n"));
const learningSignalsDir = join(data, "MEMORY", "LEARNING", "SIGNALS");
mkdirSync(learningSignalsDir, { recursive: true });
writeFileSync(join(learningSignalsDir, "shared-signal.md"), "# Shared Signal\n");
writeFileSync(join(learningSignalsDir, "ratings.jsonl"), JSON.stringify({ rating: 1 }) + "\n");
const arthurDir = join(data, "USER", "ARTHUR");
mkdirSync(arthurDir, { recursive: true });
writeFileSync(join(arthurDir, "policies.yaml"), [
  "version: 1",
  "SMOKE_KEY:",
  "  allowed_callers: [smoke]",
  "  purposes: [test]",
  "  risk: low",
  "",
].join("\n"));

const feature = runTool("FeatureRegistry.ts", ["init", "smokeproj"], env, root);
const progress = runTool("SessionProgress.ts", ["create", "smokeproj", "shared memory works"], env, root);
const algorithmNew = runTool("algorithm.ts", ["new", "-t", "Shared memory smoke", "-e", "Standard"], env, root);

const queueDir = join(data, "MEMORY", "KNOWLEDGE", "_harvest-queue");
mkdirSync(queueDir, { recursive: true });
writeFileSync(join(queueDir, "candidate.json"), JSON.stringify({
  title: "decision: shared queue",
  content: "## Decision\n\nWe decided to keep cross-framework harvested memory in PAI_DATA_DIR.",
  domain: "Ideas",
  type: "idea",
  tags: ["test"],
}));
const harvestDryRun = runTool("KnowledgeHarvester.ts", ["harvest", "--source", "memory", "--dry-run"], env, root);
const retriever = runTool("MemoryRetriever.ts", ["shared opencode", "--raw"], env, root);
const fakePaiDir = join(root, "fake-pai");
mkdirSync(join(fakePaiDir, "TOOLS"), { recursive: true });
writeFileSync(join(fakePaiDir, "TOOLS", "Inference.ts"), [
  "#!/usr/bin/env bun",
  "console.log('FAKE_COMPRESSED_SHARED_MEMORY');",
  "",
].join("\n"));
const compressedRetriever = runTool("MemoryRetriever.ts", ["shared opencode"], {
  ...env,
  PAI_DIR: fakePaiDir,
}, root);
const graph = runTool("KnowledgeGraph.ts", ["stats"], env, root);
const wisdom = runTool("WisdomFrameUpdater.ts", [
  "--domain",
  "development",
  "--observation",
  "Shared memory smoke observation",
  "--type",
  "principle",
], env, root);
const wisdomClassify = runTool("WisdomDomainClassifier.ts", ["--text", "fix the shared memory bug"], env, root);
const wisdomSynthesis = runTool("WisdomCrossFrameSynthesizer.ts", [], env, root);
const propose = runTool("ProposeCurrentStateEntry.ts", [
  "--source",
  "manual",
  "--target",
  "CONSUMPTION",
  "--json",
  JSON.stringify({ category: "restaurant", name: "Papaya Thai", visited: "2026-06-17" }),
], env, root);

const proposalFile = join(currentStateDir, "proposals.jsonl");
let approveStatus = -1;
if (existsSync(proposalFile)) {
  const proposal = JSON.parse(readFileSync(proposalFile, "utf-8").trim());
  approveStatus = runTool("ApproveCurrentStateEntries.ts", ["--approve", proposal.id], env, root).status ?? -1;
}

const transcriptPath = join(root, "failure-transcript.jsonl");
writeFileSync(transcriptPath, [
  JSON.stringify({ type: "user", timestamp: "2026-06-17T12:00:00Z", message: { content: "This failed badly." } }),
  JSON.stringify({ type: "assistant", timestamp: "2026-06-17T12:00:01Z", message: { content: "Error: command failed." } }),
  "",
].join("\n"));
const failure = runTool("FailureCapture.ts", [transcriptPath, "2", "Shared memory smoke failure"], env, root);

const idealDir = join(data, "USER", "TELOS", "IDEAL_STATE");
const healthDir = join(data, "USER", "HEALTH");
mkdirSync(idealDir, { recursive: true });
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(idealDir, "HEALTH.md"), "# Health\n\nTBD\n");
writeFileSync(join(healthDir, "METRICS.md"), "");
const gap = runTool("ComputeGap.ts", ["--dimension", "health", "--log"], env, root);
const interviewScan = runTool("InterviewScan.ts", ["--json"], env, root);
const interviewState = runTool("InterviewIdealState.ts", ["--mark-done", "HEALTH"], env, root);
const counts = runTool("GetCounts.ts", [], env, root);
const schedule = runTool("DASchedule.ts", ["add", "--desc", "Shared schedule", "--at", "2026-06-18T09:00:00"], env, root);
const arthur = runTool("Arthur.ts", ["status", "SMOKE_KEY"], env, root);
const migrationSource = join(root, "migration-source.md");
writeFileSync(migrationSource, [
  "## Mission",
  "",
  "My mission is to prove shared PAI migration paths work across Claude Codex and OpenCode.",
  "",
].join("\n"));
const migrateScan = runTool("MigrateScan.ts", ["--source", migrationSource, "--json"], env, root);
const migrationQueue = join(data, "MEMORY", "MIGRATION", "migration-proposals.jsonl");
const migrationQueued = existsSync(migrationQueue)
  && readFileSync(migrationQueue, "utf-8").includes("TELOS/MISSION.md");
let migrateApproveStatus = -1;
if (existsSync(migrationQueue)) {
  const proposal = JSON.parse(readFileSync(migrationQueue, "utf-8").trim().split("\n")[0]);
  migrateApproveStatus = runTool("MigrateApprove.ts", ["--approve", proposal.id], env, root).status ?? -1;
}
const integrity = runTool("IntegrityMaintenance.ts", [], {
  ...env,
  PAI_INTEGRITY_SKIP_NOTIFY: "1",
}, root, JSON.stringify({
  session_id: "shared-memory-smoke",
  transcript_path: join(root, "missing-integrity-transcript.jsonl"),
  changes: [
    {
      tool: "Edit",
      path: "PAI/TOOLS/SharedMemorySmokeTest.ts",
      category: "tool",
      isPhilosophical: false,
      isStructural: false,
    },
  ],
}));

let parsedCounts: Record<string, number> = {};
try {
  parsedCounts = JSON.parse(counts.stdout);
} catch {}

checks.push({
  name: "FeatureRegistry writes shared progress",
  passed: feature.status === 0 && existsSync(join(data, "MEMORY", "STATE", "progress", "smokeproj-features.json")),
  detail: `status=${feature.status ?? "null"}`,
});
checks.push({
  name: "SessionProgress writes shared progress",
  passed: progress.status === 0 && existsSync(join(data, "MEMORY", "STATE", "progress", "smokeproj-progress.json")),
  detail: `status=${progress.status ?? "null"}`,
});
checks.push({
  name: "Algorithm creates ISA in shared WORK",
  passed: algorithmNew.status === 0 && anyFileUnder(join(data, "MEMORY", "WORK"), (file) => file.endsWith(".md") && readFileSync(file, "utf-8").includes("Shared memory smoke")),
  detail: `status=${algorithmNew.status ?? "null"}`,
});
checks.push({
  name: "KnowledgeHarvester reads shared queue without consuming dry-run",
  passed: harvestDryRun.status === 0 && harvestDryRun.stdout.includes("Memory queue: 1 candidates") && existsSync(join(queueDir, "candidate.json")),
  detail: `status=${harvestDryRun.status ?? "null"}`,
});
checks.push({
  name: "MemoryRetriever reads shared knowledge",
  passed: retriever.status === 0 && retriever.stdout.includes("Shared Memory Test"),
  detail: `status=${retriever.status ?? "null"}`,
});
checks.push({
  name: "MemoryRetriever compresses via provider-aware Inference path",
  passed: compressedRetriever.status === 0 && compressedRetriever.stdout.includes("FAKE_COMPRESSED_SHARED_MEMORY"),
  detail: `status=${compressedRetriever.status ?? "null"}`,
});
checks.push({
  name: "KnowledgeGraph reads shared knowledge",
  passed: graph.status === 0 && graph.stdout.includes("Nodes: 1"),
  detail: `status=${graph.status ?? "null"}`,
});
checks.push({
  name: "WisdomFrameUpdater writes shared frame",
  passed: wisdom.status === 0 && existsSync(join(data, "MEMORY", "WISDOM", "FRAMES", "development.md")),
  detail: `status=${wisdom.status ?? "null"}`,
});
checks.push({
  name: "WisdomDomainClassifier reads shared frame",
  passed: wisdomClassify.status === 0 && wisdomClassify.stdout.includes("development.md"),
  detail: `status=${wisdomClassify.status ?? "null"}`,
});
checks.push({
  name: "WisdomCrossFrameSynthesizer writes shared synthesis",
  passed: wisdomSynthesis.status === 0 && existsSync(join(data, "MEMORY", "WISDOM", "PRINCIPLES", "verified.md")),
  detail: `status=${wisdomSynthesis.status ?? "null"}`,
});
checks.push({
  name: "Current state proposal writes shared USER",
  passed: propose.status === 0 && existsSync(proposalFile),
  detail: `status=${propose.status ?? "null"}`,
});
checks.push({
  name: "Current state approval commits shared USER",
  passed: approveStatus === 0 && readFileSync(join(currentStateDir, "CONSUMPTION.md"), "utf-8").includes("Papaya Thai"),
  detail: `status=${approveStatus}`,
});
checks.push({
  name: "FailureCapture writes shared failure",
  passed: failure.status === 0 && anyFileUnder(join(data, "MEMORY", "LEARNING", "FAILURES"), (file) => file.endsWith("CONTEXT.md")),
  detail: `status=${failure.status ?? "null"}`,
});
checks.push({
  name: "ComputeGap reads shared USER and logs shared MEMORY",
  passed: gap.status === 0 && existsSync(join(data, "MEMORY", "OBSERVABILITY", "gap-history.jsonl")),
  detail: `status=${gap.status ?? "null"}`,
});
checks.push({
  name: "InterviewScan reads shared USER",
  passed: interviewScan.status === 0 && interviewScan.stdout.includes("IDEAL_STATE/HEALTH"),
  detail: `status=${interviewScan.status ?? "null"}`,
});
checks.push({
  name: "InterviewIdealState writes shared USER state",
  passed: interviewState.status === 0 && existsSync(join(data, "USER", "TELOS", "CURRENT_STATE", "interview-state.json")),
  detail: `status=${interviewState.status ?? "null"}`,
});
checks.push({
  name: "GetCounts reads active framework and shared data",
  passed: counts.status === 0
    && parsedCounts.skills === 1
    && parsedCounts.hooks === 1
    && parsedCounts.signals >= 1
    && parsedCounts.files >= 1
    && parsedCounts.ratings === 1,
  detail: `status=${counts.status ?? "null"} counts=${JSON.stringify(parsedCounts)}`,
});
checks.push({
  name: "DASchedule writes shared scheduled tasks",
  passed: schedule.status === 0
    && existsSync(join(data, "MEMORY", "STATE", "da", "scheduled-tasks.jsonl"))
    && readFileSync(join(data, "MEMORY", "STATE", "da", "scheduled-tasks.jsonl"), "utf-8").includes("Shared schedule"),
  detail: `status=${schedule.status ?? "null"}`,
});
checks.push({
  name: "Arthur reads shared USER policies",
  passed: arthur.status === 0 && arthur.stdout.includes("SMOKE_KEY") && arthur.stdout.includes("allowed_callers"),
  detail: `status=${arthur.status ?? "null"}`,
});
checks.push({
  name: "MigrateScan writes shared migration queue",
  passed: migrateScan.status === 0 && migrationQueued,
  detail: `status=${migrateScan.status ?? "null"}`,
});
checks.push({
  name: "MigrateApprove commits to shared USER and logs shared MEMORY",
  passed: migrateApproveStatus === 0
    && readFileSync(join(data, "USER", "TELOS", "MISSION.md"), "utf-8").includes("shared PAI migration paths")
    && existsSync(join(data, "MEMORY", "MIGRATION", "committed.jsonl")),
  detail: `status=${migrateApproveStatus}`,
});
checks.push({
  name: "IntegrityMaintenance writes shared system update",
  passed: integrity.status === 0
    && anyFileUnder(join(data, "MEMORY", "PAISYSTEMUPDATES"), (file) => file.endsWith(".md") && readFileSync(file, "utf-8").includes("SharedMemorySmokeTest")),
  detail: `status=${integrity.status ?? "null"}`,
});

printChecks(checks);

if (keep) {
  console.log(`\nKept smoke test root: ${root}`);
} else {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((check) => !check.passed).length;
if (failed > 0) {
  console.error(`\n${failed} shared-memory smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nAll shared-memory smoke checks passed.");
