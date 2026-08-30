#!/usr/bin/env bun
/**
 * Verifies LoadContext active-work reminders use provider-neutral PAI paths.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = mkdtempSync(join(tmpdir(), "pai-load-context-smoke-"));
const home = join(root, "home");
const dataDir = join(home, ".pai");
const memoryDir = join(dataDir, "MEMORY");
const paiDir = join(root, "framework", "PAI");
const frameworkDir = join(root, "framework");

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PAI_DATA_DIR = dataDir;
process.env.PAI_MEMORY_DIR = join(dataDir, "MEMORY");
process.env.PAI_DIR = paiDir;
process.env.PAI_FRAMEWORK_DIR = frameworkDir;
process.env.PAI_FRAMEWORK = "codex";

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

try {
  mkdirSync(join(memoryDir, "STATE", "progress"), { recursive: true });
  mkdirSync(join(paiDir, "TOOLS"), { recursive: true });
  write(join(memoryDir, "STATE", "progress", "pulse-progress.json"), JSON.stringify({
    project: "Pulse",
    status: "active",
    updated: new Date().toISOString(),
    objectives: ["Keep dynamic context portable across providers"],
    handoff_notes: "Smoke-test path output",
    next_steps: ["Use provider-neutral SessionProgress path"],
  }, null, 2));

  const loadContext = await import("../../hooks/LoadContext.hook");
  const summary = await loadContext.checkActiveProgress(paiDir);
  const expectedScript = join(paiDir, "TOOLS", "SessionProgress.ts");

  check(
    "Active work summary is generated from shared MEMORY",
    Boolean(summary?.includes("Pulse") && summary.includes("Tracked Projects")),
    summary || "missing",
  );
  check(
    "SessionProgress reminder uses PAI/TOOLS path",
    Boolean(summary?.includes(expectedScript)),
    summary || "missing",
  );
  check(
    "SessionProgress reminder avoids legacy PAI/Tools path",
    !Boolean(summary?.includes("/Tools/") || summary?.includes("\\Tools\\")),
    summary || "missing",
  );
  check(
    "SessionProgress reminder uses bun directly",
    Boolean(summary?.includes(`bun ${expectedScript} resume <project>`) && summary.includes(`bun ${expectedScript} complete <project>`)),
    summary || "missing",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nLoadContext smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log(`\nLoadContext smoke passed: ${checks.length} check(s).`);
