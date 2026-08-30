#!/usr/bin/env bun
/**
 * Verifies Pulse performance aggregation understands provider-native transcript
 * shapes without touching live framework homes or provider sessions.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Json = Record<string, any>;

const paiRoot = resolve(import.meta.dir, "..");
const releaseRoot = resolve(paiRoot, "..");
const aggregatorPath = join(paiRoot, "PULSE", "Performance", "cost-aggregator.ts");
const tempRoot = mkdtempSync(join(tmpdir(), "pai-cost-aggregator-smoke-"));

function writeJsonl(filePath: string, rows: Json[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function readCostRows(dataDir: string): Json[] {
  const outputPath = join(dataDir, "MEMORY", "OBSERVABILITY", "session-costs.jsonl");
  if (!existsSync(outputPath)) throw new Error(`Missing cost output: ${outputPath}`);
  return readFileSync(outputPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runAggregator(framework: "claude" | "codex", frameworkDir: string, dataDir: string): void {
  mkdirSync(frameworkDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const result = spawnSync(process.execPath, [aggregatorPath, "--full"], {
    cwd: releaseRoot,
    env: {
      ...process.env,
      HOME: join(tempRoot, "home"),
      USERPROFILE: join(tempRoot, "home"),
      PAI_DIR: paiRoot,
      PAI_DATA_DIR: dataDir,
      PAI_FRAMEWORK: framework,
      PAI_FRAMEWORK_DIR: frameworkDir,
      CODEX_HOME: framework === "codex" ? frameworkDir : "",
      CLAUDE_HOME: framework === "claude" ? frameworkDir : "",
    },
    encoding: "utf-8",
    timeout: 30_000,
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(
      `Aggregator failed for ${framework}: status=${result.status ?? "null"} signal=${result.signal ?? ""}\n${result.stdout}${result.stderr}`,
    );
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

try {
  const codexRoot = join(tempRoot, "codex");
  const codexData = join(tempRoot, "pai-data-codex");
  writeJsonl(join(codexRoot, "sessions", "2026", "06", "24", "codex-session.jsonl"), [
    {
      timestamp: "2026-06-24T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "codex-session-id",
        cwd: join(tempRoot, "work", "codex-project"),
        model_provider: "openai",
      },
    },
    {
      timestamp: "2026-06-24T10:01:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    },
    {
      timestamp: "2026-06-24T10:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 12_000,
            cached_input_tokens: 9_000,
            output_tokens: 600,
            reasoning_output_tokens: 120,
            total_tokens: 12_600,
          },
          model_context_window: 258_400,
        },
        rate_limits: { plan_type: "pro" },
      },
    },
  ]);

  runAggregator("codex", codexRoot, codexData);
  const codexRows = readCostRows(codexData);
  const codex = codexRows[0];
  assert(codexRows.length === 1, `Expected one Codex row, got ${codexRows.length}`);
  assert(codex.framework === "codex", "Codex row should retain framework=codex");
  assert(codex.sessionId === "codex-session-id", "Codex session id should come from session_meta.payload.id");
  assert(codex.project === "codex-project", "Codex project should derive from transcript cwd");
  assert(codex.primaryModel === "codex-subscription-pro", "Codex model should reflect subscription plan");
  assert(codex.billingSource === "subscription", "Codex should be subscription usage, not API estimate");
  assert(codex.pricingSource === "codex-token-count", "Codex should parse token_count events");
  assert(codex.costEstimated === false, "Codex subscription rows should not claim estimated dollar cost");
  assert(codex.costTotal === 0, "Codex subscription rows should not invent API dollar pricing");
  assert(codex.inputTokens === 12_000, "Codex input tokens should come from total_token_usage");
  assert(codex.cacheReadTokens === 9_000, "Codex cached input tokens should be retained");
  assert(codex.totalTokens === 12_600, "Codex total tokens should use reported total without double counting cache");

  const claudeRoot = join(tempRoot, "claude");
  const claudeData = join(tempRoot, "pai-data-claude");
  writeJsonl(join(claudeRoot, "projects", "-tmp-claude-project", "claude-session.jsonl"), [
    {
      timestamp: "2026-06-24T11:00:00.000Z",
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 1_000,
          output_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 500,
        },
      },
    },
  ]);

  runAggregator("claude", claudeRoot, claudeData);
  const claudeRows = readCostRows(claudeData);
  const claude = claudeRows[0];
  assert(claudeRows.length === 1, `Expected one Claude row, got ${claudeRows.length}`);
  assert(claude.framework === "claude", "Claude row should retain framework=claude");
  assert(claude.project === "-tmp-claude-project", "Claude project should derive from project directory");
  assert(claude.primaryModel === "claude-sonnet-4-6", "Claude model should come from assistant message");
  assert(claude.billingSource === "api-estimate", "Claude rows should retain existing API-estimate semantics");
  assert(claude.costEstimated === true, "Claude rows should mark cost as estimated");
  assert(claude.costTotal > 0, "Claude cost should be computed from pricing table");
  assert(claude.totalTokens === 1_650, "Claude total tokens should include cache write/read components");

  console.log("Performance cost aggregator smoke passed.");
} finally {
  const resolved = resolve(tempRoot);
  if (dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-cost-aggregator-smoke-")) {
    rmSync(resolved, { recursive: true, force: true });
  }
}
