#!/usr/bin/env bun
/**
 * Verifies provider-native transcript consumers that feed classification,
 * satisfaction scoring, and low-rating failure capture.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = mkdtempSync(join(tmpdir(), "pai-provider-transcript-consumers-"));
const home = join(root, "home");
const dataDir = join(root, ".pai");
const codexHome = join(home, ".codex");
mkdirSync(codexHome, { recursive: true });
mkdirSync(dataDir, { recursive: true });

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PAI_DATA_DIR = dataDir;
process.env.PAI_FRAMEWORK_DIR = codexHome;
process.env.CODEX_HOME = codexHome;

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

try {
  const satisfaction = await import("../../hooks/SatisfactionCapture.hook");
  const promptProcessing = await import("../../hooks/PromptProcessing.hook");
  const failureCapture = await import("./FailureCapture");

  const codexPath = join(root, "codex.jsonl");
  writeJsonl(codexPath, [
    { type: "session_meta", timestamp: "2026-06-24T12:00:00Z", payload: { id: "codex-consumer-session", cwd: root } },
    {
      type: "response_item",
      timestamp: "2026-06-24T12:00:01Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please keep Codex transcript context available." }] },
    },
    {
      type: "response_item",
      timestamp: "2026-06-24T12:00:02Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "SUMMARY: Codex transcript consumer context works." }] },
    },
    {
      type: "response_item",
      timestamp: "2026-06-24T12:00:03Z",
      payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ patch: "*** Begin Patch\n*** End Patch\n" }) },
    },
    {
      type: "response_item",
      timestamp: "2026-06-24T12:00:04Z",
      payload: { type: "function_call_output", output: "Patch applied" },
    },
  ]);

  process.env.PAI_FRAMEWORK = "codex";
  const satisfactionContext = satisfaction.getRecentContext(codexPath, 4);
  check(
    "Satisfaction context parses Codex response_item messages",
    satisfactionContext.includes("User: Please keep Codex transcript context available.") &&
      satisfactionContext.includes("Assistant: Codex transcript consumer context works."),
    satisfactionContext,
  );

  const promptUserOnly = promptProcessing.getRecentContext(codexPath, 4, false);
  check(
    "Prompt classifier user-only context parses Codex transcript",
    promptUserOnly.includes("User: Please keep Codex transcript context available.") &&
      !promptUserOnly.includes("Assistant:"),
    promptUserOnly,
  );

  const promptWithAssistant = promptProcessing.getRecentContext(codexPath, 4, true);
  check(
    "Prompt classifier assistant context parses Codex transcript",
    promptWithAssistant.includes("Assistant: Codex transcript consumer context works."),
    promptWithAssistant,
  );

  const failure = failureCapture.parseTranscript(codexPath, "codex");
  check(
    "Failure capture conversations parse Codex transcript",
    failure.conversations.length === 2 &&
      failure.conversations[0].role === "user" &&
      failure.conversations[1].content.includes("consumer context works"),
    JSON.stringify(failure.conversations),
  );
  check(
    "Failure capture tool calls parse Codex function_call",
    failure.toolCalls.length === 1 &&
      failure.toolCalls[0].name === "apply_patch" &&
      failure.toolCalls[0].output === "Patch applied",
    JSON.stringify(failure.toolCalls),
  );

  const claudePath = join(root, "claude.jsonl");
  writeJsonl(claudePath, [
    { type: "user", timestamp: "2026-06-24T12:01:00Z", message: { content: [{ type: "text", text: "Please keep Claude transcript consumers working." }] } },
    { type: "assistant", timestamp: "2026-06-24T12:01:01Z", message: { content: [{ type: "text", text: "SUMMARY: Claude transcript consumer context works." }] } },
  ]);

  process.env.PAI_FRAMEWORK = "claude";
  const claudeContext = satisfaction.getRecentContext(claudePath, 4);
  check(
    "Satisfaction context still parses Claude messages",
    claudeContext.includes("User: Please keep Claude transcript consumers working.") &&
      claudeContext.includes("Assistant: Claude transcript consumer context works."),
    claudeContext,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nProvider transcript consumers smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log(`\nProvider transcript consumers smoke passed: ${checks.length} check(s).`);
