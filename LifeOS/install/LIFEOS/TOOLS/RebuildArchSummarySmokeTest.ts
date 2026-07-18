#!/usr/bin/env bun
/**
 * RebuildArchSummarySmokeTest
 *
 * Verifies architecture-summary rebuild triggers include provider-native
 * framework config files. This runs against isolated temp roots and a tiny fake
 * generator, so it does not launch provider CLIs or touch the real install.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const releaseRoot = resolve(import.meta.dir, "..", "..");
const checks: Check[] = [];
const originalEnv = { ...process.env };
const touchedEnvKeys = ["PAI_FRAMEWORK_DIR", "PAI_DIR", "PAI_DATA_DIR", "PAI_USER_DIR", "PAI_FRAMEWORK"];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function setOld(path: string): void {
  const date = new Date(Date.now() - 60_000);
  utimesSync(path, date, date);
}

function setNew(path: string): void {
  const date = new Date(Date.now() + 60_000);
  utimesSync(path, date, date);
}

async function runCase(name: string, changedFile: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pai-rebuild-arch-smoke-"));
  const frameworkRoot = join(root, "framework");
  const paiDir = join(frameworkRoot, "PAI");
  const dataDir = join(root, "data");
  const userDir = join(dataDir, "USER");
  const output = join(paiDir, "DOCUMENTATION", "ARCHITECTURE_SUMMARY.md");
  const marker = join(root, "generator-marker.txt");

  mkdirSync(frameworkRoot, { recursive: true });
  mkdirSync(join(paiDir, "TOOLS"), { recursive: true });
  mkdirSync(join(paiDir, "DOCUMENTATION"), { recursive: true });
  mkdirSync(userDir, { recursive: true });

  write(output, "old summary\n");
  setOld(output);
  write(
    join(paiDir, "TOOLS", "ArchitectureSummaryGenerator.ts"),
    [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "import { dirname, join } from 'node:path';",
      "writeFileSync(join(process.cwd(), 'DOCUMENTATION', 'ARCHITECTURE_SUMMARY.md'), `rebuilt ${Date.now()}\\n`, 'utf-8');",
      `writeFileSync(${JSON.stringify(marker)}, 'ran\\n', 'utf-8');`,
    ].join("\n"),
  );

  const changedPath = join(frameworkRoot, changedFile);
  write(changedPath, `${name}\n`);
  setNew(changedPath);

  process.env.PAI_FRAMEWORK_DIR = frameworkRoot;
  process.env.PAI_DIR = paiDir;
  process.env.PAI_DATA_DIR = dataDir;
  process.env.PAI_USER_DIR = userDir;
  process.env.PAI_FRAMEWORK = changedFile === "opencode.json" ? "opencode" : "codex";

  const modulePath = `${pathToFileURL(join(releaseRoot, "hooks", "handlers", "RebuildArchSummary.ts")).href}?case=${encodeURIComponent(name)}-${Date.now()}`;
  const { handleRebuildArchSummary } = await import(modulePath);
  await handleRebuildArchSummary();

  check(
    `${changedFile} triggers architecture summary rebuild`,
    existsSync(marker) && readFileSync(output, "utf-8").startsWith("rebuilt "),
    existsSync(marker) ? readFileSync(marker, "utf-8").trim() : "generator did not run",
  );

  rmSync(root, { recursive: true, force: true });
}

try {
  await runCase("codex-config", "config.toml");
  await runCase("codex-hooks", "hooks.json");
  await runCase("opencode-config", "opencode.json");
} finally {
  for (const key of touchedEnvKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nRebuild architecture summary smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log(`\nRebuild architecture summary smoke passed: ${checks.length} check(s).`);
