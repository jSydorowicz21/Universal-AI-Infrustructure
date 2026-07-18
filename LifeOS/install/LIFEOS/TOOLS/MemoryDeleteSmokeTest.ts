#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function assert(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
}

const root = mkdtempSync(join(tmpdir(), "pai-memory-delete-smoke-"));
let keep = false;

function smokeEnv(data: string, home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PAI_DATA_DIR: data,
    PAI_MEMORY_DIR: "",
    PAI_USER_DIR: "",
    PAI_FRAMEWORK_DIR: "",
    PAI_DIR: "",
  };
}

try {
  const home = join(root, "home");
  const data = join(home, ".pai");
  const memory = join(data, "MEMORY");
  const fact = "SMOKE_DELETE_FACT_do_not_remember_12345";
  const note = join(memory, "RELATIONSHIP", "manual-memory.jsonl");
  const patterns = join(root, "patterns.txt");

  mkdirSync(home, { recursive: true });
  mkdirSync(dirname(note), { recursive: true });
  mkdirSync(join(memory, "STATE"), { recursive: true });
  mkdirSync(join(memory, "VOICE"), { recursive: true });
  mkdirSync(join(memory, "OBSERVABILITY"), { recursive: true });

  writeFileSync(note, JSON.stringify({ fact }) + "\n");
  writeFileSync(join(memory, "STATE", "last-response.txt"), `retrieved ${fact}\n`);
  writeFileSync(join(memory, "VOICE", "voice-events.jsonl"), JSON.stringify({ message: fact }) + "\n");
  writeFileSync(join(memory, "OBSERVABILITY", "tool-activity.jsonl"), JSON.stringify({ preview: fact }) + "\n");
  writeFileSync(patterns, `${fact}\n`);

  const result = spawnSync(process.execPath, [
    join(import.meta.dir, "MemoryDelete.ts"),
    "--path",
    note,
    "--patterns-file",
    patterns,
  ], {
    env: smokeEnv(data, home),
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });

  if (result.status !== 0) {
    keep = true;
    throw new Error(`MemoryDelete failed: ${result.stdout}\n${result.stderr}`);
  }

  assert("canonical memory file deleted", !existsSync(note));
  for (const target of [
    join(memory, "STATE", "last-response.txt"),
    join(memory, "VOICE", "voice-events.jsonl"),
    join(memory, "OBSERVABILITY", "tool-activity.jsonl"),
  ]) {
    const content = readFileSync(target, "utf-8");
    assert(`${target.replace(root, "")} redacted`, !content.includes(fact), content);
    assert(`${target.replace(root, "")} has marker`, content.includes("[PAI_MEMORY_DELETED]"), content);
  }

  const outside = spawnSync(process.execPath, [
    join(import.meta.dir, "MemoryDelete.ts"),
    "--path",
    resolve(root, "outside.txt"),
    "--text",
    "x",
    "--dry-run",
  ], {
    env: smokeEnv(data, home),
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert("outside MEMORY path rejected", outside.status !== 0, outside.stdout + outside.stderr);
} catch (err) {
  keep = true;
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  if (!keep) {
    const resolved = resolve(root);
    if (dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-memory-delete-smoke-")) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}
