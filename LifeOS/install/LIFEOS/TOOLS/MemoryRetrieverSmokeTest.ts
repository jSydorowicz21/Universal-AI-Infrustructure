#!/usr/bin/env bun
/**
 * MemoryRetrieverSmokeTest
 *
 * AV-safe/runtime-safe proof that MemoryRetriever reads PAI_DATA_DIR shared
 * knowledge and resolves compression through the active PAI_DIR/TOOLS path.
 * The compression check uses a fake temp Inference.ts, so no provider CLI or
 * model call is started.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Check = { name: string; passed: boolean; detail: string };

const checks: Check[] = [];
const toolPath = join(import.meta.dir, "MemoryRetriever.ts");

function check(name: string, passed: boolean, detail = ""): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

function runRetriever(args: string[], env: Record<string, string>, cwd: string) {
  return spawnSync(process.execPath, [toolPath, ...args], {
    cwd,
    env,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
}

const root = mkdtempSync(join(tmpdir(), "pai-memory-retriever-smoke-"));
try {
  const dataDir = join(root, "pai-data");
  const fakePaiDir = join(root, "fake-pai");
  const knowledgeDir = join(dataDir, "MEMORY", "KNOWLEDGE", "Ideas");
  mkdirSync(knowledgeDir, { recursive: true });
  mkdirSync(join(fakePaiDir, "TOOLS"), { recursive: true });

  writeFileSync(join(knowledgeDir, "provider-parity.md"), [
    "---",
    "title: Provider Parity Memory",
    "tags: [provider, parity, codex]",
    "---",
    "Codex and Claude should retrieve the same shared PAI knowledge from PAI_DATA_DIR.",
    "",
  ].join("\n"));

  writeFileSync(join(fakePaiDir, "TOOLS", "Inference.ts"), [
    "#!/usr/bin/env bun",
    "console.log('FAKE_MEMORY_RETRIEVER_COMPRESSED_OUTPUT');",
    "",
  ].join("\n"));

  const env = {
    ...process.env,
    PAI_DATA_DIR: dataDir,
    PAI_DIR: fakePaiDir,
    PAI_FRAMEWORK: "codex",
  } as Record<string, string>;
  delete env.PAI_FRAMEWORK_DIR;

  const raw = runRetriever(["provider parity", "--raw"], env, root);
  check(
    "MemoryRetriever raw mode reads shared PAI_DATA_DIR knowledge",
    raw.status === 0 && raw.stdout.includes("Provider Parity Memory"),
    `status=${raw.status ?? "null"} ${raw.stderr.trim().slice(0, 160)}`,
  );

  const compressed = runRetriever(["provider parity"], env, root);
  check(
    "MemoryRetriever compression uses active PAI_DIR/TOOLS/Inference.ts",
    compressed.status === 0 && compressed.stdout.includes("FAKE_MEMORY_RETRIEVER_COMPRESSED_OUTPUT"),
    `status=${compressed.status ?? "null"} ${compressed.stderr.trim().slice(0, 160)}`,
  );

  const failed = checks.filter((item) => !item.passed);
  if (failed.length > 0) {
    console.error(`\nMemoryRetriever smoke failed: ${failed.length} check(s).`);
    process.exit(1);
  }
  console.log("\nAll MemoryRetriever smoke checks passed.");
} finally {
  const resolved = resolve(root);
  if (existsSync(resolved) && dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-memory-retriever-smoke-")) {
    rmSync(resolved, { recursive: true, force: true });
  }
}
