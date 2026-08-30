#!/usr/bin/env bun
/**
 * TranscriptParserSmokeTest
 *
 * Verifies Stop-hook transcript parsing across Claude and Codex transcript
 * shapes. This protects voice completion, response tab reset, last-response
 * cache, and other hooks that depend on TranscriptParser.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscript } from "./TranscriptParser";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const tempRoot = mkdtempSync(join(tmpdir(), "pai-transcript-parser-smoke-"));
const checks: Check[] = [];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function writeJsonl(name: string, rows: unknown[]): string {
  const path = join(tempRoot, name);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
  return path;
}

try {
  const claudeTranscript = writeJsonl("claude.jsonl", [
    {
      type: "user",
      message: { content: [{ type: "text", text: "Old prompt" }] },
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "🎯 COMPLETED: Old Claude result" }] },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", content: "tool output is not a new prompt" }] },
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Tool continuation" }] },
    },
    {
      type: "user",
      message: { content: [{ type: "text", text: "Current prompt" }] },
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "📋 SUMMARY: Claude summary\n🎯 COMPLETED: Claude done" }] },
    },
  ]);

  const codexTranscript = writeJsonl("codex.jsonl", [
    {
      type: "session_meta",
      payload: { id: "codex-session", cwd: tempRoot },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Old prompt" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "🎯 COMPLETED: Old Codex result" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Current prompt" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "📋 SUMMARY: Codex summary\n🎯 COMPLETED: Codex done" }],
      },
    },
  ]);

  const codexQuestionTranscript = writeJsonl("codex-question.jsonl", [
    {
      type: "session_meta",
      payload: { id: "codex-question-session", cwd: tempRoot },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Need a decision" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        arguments: "{}",
      },
    },
  ]);

  const claudeQuestionTranscript = writeJsonl("claude-question.jsonl", [
    {
      type: "user",
      message: { content: [{ type: "text", text: "Need a decision" }] },
    },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: {} }] },
    },
  ]);

  const claude = parseTranscript(claudeTranscript);
  check("Claude last assistant parsed", claude.lastMessage.includes("Claude done"), claude.lastMessage);
  check("Claude current turn excludes prior completion", !claude.currentResponseText.includes("Old Claude result"), claude.currentResponseText);
  check("Claude voice completion parsed", claude.voiceCompletion === "Claude done", claude.voiceCompletion);
  check("Claude plain completion parsed", claude.plainCompletion === "Claude done", claude.plainCompletion);
  check("Claude structured summary parsed", claude.structured.summary === "Claude summary", claude.structured.summary || "");

  const codex = parseTranscript(codexTranscript);
  check("Codex last assistant parsed", codex.lastMessage.includes("Codex done"), codex.lastMessage);
  check("Codex current turn excludes prior completion", !codex.currentResponseText.includes("Old Codex result"), codex.currentResponseText);
  check("Codex voice completion parsed", codex.voiceCompletion === "Codex done", codex.voiceCompletion);
  check("Codex plain completion parsed", codex.plainCompletion === "Codex done", codex.plainCompletion);
  check("Codex structured summary parsed", codex.structured.summary === "Codex summary", codex.structured.summary || "");

  const codexQuestion = parseTranscript(codexQuestionTranscript);
  check("Codex request_user_input sets awaitingInput", codexQuestion.responseState === "awaitingInput", codexQuestion.responseState);

  const claudeQuestion = parseTranscript(claudeQuestionTranscript);
  check("Claude AskUserQuestion still sets awaitingInput", claudeQuestion.responseState === "awaitingInput", claudeQuestion.responseState);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nTranscript parser smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log("\nAll transcript parser smoke checks passed.");
