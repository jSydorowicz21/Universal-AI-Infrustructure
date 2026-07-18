#!/usr/bin/env bun
/**
 * Verifies RelationshipMemory reads provider-native transcript messages and
 * turns Codex user preference signals into relationship notes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyzeForRelationship, readTranscriptEntries } from "../../hooks/RelationshipMemory.hook";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = mkdtempSync(join(tmpdir(), "pai-relationship-transcript-"));

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

try {
  const codexPath = join(root, "codex.jsonl");
  writeJsonl(codexPath, [
    { type: "session_meta", timestamp: "2026-06-24T12:00:00Z", payload: { id: "codex-relationship-session", cwd: root } },
    {
      type: "response_item",
      timestamp: "2026-06-24T12:00:01Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "I prefer when you do the edits yourself and keep subagents out unless I ask." }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-06-24T12:00:02Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "SUMMARY: Updated provider parity directly." }],
      },
    },
  ]);

  const codexEntries = readTranscriptEntries(codexPath, "codex");
  check(
    "Codex relationship transcript includes user and assistant turns",
    codexEntries.length === 2 &&
      codexEntries[0].type === "user" &&
      codexEntries[0].text.includes("do the edits yourself") &&
      codexEntries[1].type === "assistant",
    JSON.stringify(codexEntries),
  );

  const notes = analyzeForRelationship(codexEntries);
  check(
    "Codex user preference becomes relationship opinion note",
    notes.some((note) =>
      note.type === "O" &&
      note.content.includes("do the edits yourself") &&
      note.confidence === 0.65
    ),
    JSON.stringify(notes),
  );

  check(
    "Assistant summary remains biographical relationship note",
    notes.some((note) => note.type === "B" && note.content.includes("Updated provider parity directly")),
    JSON.stringify(notes),
  );

  const claudePath = join(root, "claude.jsonl");
  writeJsonl(claudePath, [
    { type: "user", timestamp: "2026-06-24T12:01:00Z", message: { content: [{ type: "text", text: "I prefer when Claude transcript parsing still works." }] } },
    { type: "assistant", timestamp: "2026-06-24T12:01:01Z", message: { content: [{ type: "text", text: "SUMMARY: Claude relationship parsing still works." }] } },
  ]);

  const claudeEntries = readTranscriptEntries(claudePath, "claude");
  check(
    "Claude relationship transcript still parses",
    claudeEntries.length === 2 &&
      claudeEntries[0].text.includes("Claude transcript parsing") &&
      claudeEntries[1].text.includes("relationship parsing"),
    JSON.stringify(claudeEntries),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nRelationshipMemory transcript smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log(`\nRelationshipMemory transcript smoke passed: ${checks.length} check(s).`);
