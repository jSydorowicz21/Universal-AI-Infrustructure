#!/usr/bin/env bun
/**
 * Verifies IntegrityMaintenance reads provider-native transcript shapes before
 * it asks inference to generate update narratives.
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readTranscriptContext } from "./IntegrityMaintenance";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = mkdtempSync(join(tmpdir(), "pai-integrity-transcript-"));

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
    { type: "session_meta", timestamp: "2026-06-24T12:00:00Z", payload: { id: "codex-integrity-session", cwd: root } },
    {
      type: "response_item",
      timestamp: "2026-06-24T12:00:01Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please fix the Codex integrity transcript context." }] },
    },
    {
      type: "response_item",
      timestamp: "2026-06-24T12:00:02Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Updated IntegrityMaintenance to parse Codex response_item messages." }] },
    },
  ]);

  const codex = readTranscriptContext(codexPath, 20, "codex");
  check(
    "Codex response_item context is parsed",
    codex.length === 2 &&
      codex[0].role === "user" &&
      codex[0].content.includes("Codex integrity transcript") &&
      codex[1].role === "assistant" &&
      codex[1].content.includes("response_item messages"),
    JSON.stringify(codex),
  );

  const claudePath = join(root, "claude.jsonl");
  writeJsonl(claudePath, [
    { type: "user", timestamp: "2026-06-24T12:01:00Z", message: { content: [{ type: "text", text: "Please keep Claude transcript parsing working." }] } },
    { type: "assistant", timestamp: "2026-06-24T12:01:01Z", message: { content: [{ type: "text", text: "Claude transcript context still works." }] } },
  ]);

  const claude = readTranscriptContext(claudePath, 20, "claude");
  check(
    "Claude transcript context still parses",
    claude.length === 2 &&
      claude[0].content.includes("Claude transcript parsing") &&
      claude[1].content.includes("still works"),
    JSON.stringify(claude),
  );

  const openCodePath = join(root, "opencode.jsonl");
  writeJsonl(openCodePath, [
    { type: "message", role: "user", timestamp: "2026-06-24T12:02:00Z", content: [{ type: "text", text: "Please parse OpenCode transcript messages too." }] },
    { type: "message", role: "assistant", timestamp: "2026-06-24T12:02:01Z", content: [{ type: "text", text: "OpenCode transcript context is available." }] },
  ]);

  const opencode = readTranscriptContext(openCodePath, 20, "opencode");
  check(
    "OpenCode transcript context parses",
    opencode.length === 2 &&
      opencode[0].content.includes("OpenCode transcript messages") &&
      opencode[1].content.includes("context is available"),
    JSON.stringify(opencode),
  );

  const bounded = readTranscriptContext(codexPath, 1, "codex");
  check(
    "Integrity context remains bounded",
    bounded.length === 1 && bounded[0].role === "assistant",
    JSON.stringify(bounded),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nIntegrityMaintenance transcript smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log(`\nIntegrityMaintenance transcript smoke passed: ${checks.length} check(s).`);
