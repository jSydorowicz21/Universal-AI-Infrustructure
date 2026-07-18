#!/usr/bin/env bun
/**
 * Verifies banner stats count native hook registrations instead of dormant
 * hook files on disk.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { countRegisteredHooks } from "./lib/banner-counts";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = mkdtempSync(join(tmpdir(), "pai-banner-counts-"));
const releaseRoot = resolve(import.meta.dir, "..", "..");
const paiRoot = join(releaseRoot, "PAI");

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

function remove(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

try {
  const frameworkRoot = join(root, "codex-home");
  const hooksDir = join(frameworkRoot, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  for (let i = 0; i < 7; i += 1) {
    write(join(hooksDir, `Dormant${i}.hook.ts`), `console.log("dormant-${i}");\n`);
  }

  write(join(frameworkRoot, "hooks.json"), JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: "bun hooks/One.hook.ts" },
            { type: "command", command: "bun hooks/Two.hook.ts", commandWindows: "& bun.exe hooks/Two.hook.ts" },
          ],
        },
      ],
    },
  }, null, 2));

  write(join(frameworkRoot, "settings.json"), JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: "command", command: "bun hooks/ClaudeOne.hook.ts" },
            { type: "command", command: "bun hooks/ClaudeTwo.hook.ts" },
            { type: "command", command: "bun hooks/ClaudeThree.hook.ts" },
          ],
        },
      ],
    },
  }, null, 2));

  check(
    "Codex hooks.json wins over dormant hook files",
    countRegisteredHooks(frameworkRoot) === 2,
    `count=${countRegisteredHooks(frameworkRoot)} dormantFiles=7`,
  );

  remove(join(frameworkRoot, "hooks.json"));
  check(
    "Claude settings.json remains native fallback",
    countRegisteredHooks(frameworkRoot) === 3,
    `count=${countRegisteredHooks(frameworkRoot)}`,
  );

  remove(join(frameworkRoot, "settings.json"));
  check(
    "Hook files are only compatibility fallback",
    countRegisteredHooks(frameworkRoot) === 7,
    `count=${countRegisteredHooks(frameworkRoot)}`,
  );

  const bannerFiles = ["Banner.ts", "BannerNeofetch.ts", "BannerMatrix.ts", "BannerRetro.ts", "NeofetchBanner.ts"];
  const stale = bannerFiles.filter((file) => {
    const source = read(join(paiRoot, "TOOLS", file));
    return !source.includes("countRegisteredHooks") ||
      source.includes("const CLAUDE_DIR") ||
      source.includes("readdirSync(hooksDir");
  });
  check(
    "Standalone banners use provider-native hook helper",
    stale.length === 0,
    stale.length ? stale.join(", ") : bannerFiles.join(", "),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nBanner provider counts smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log(`\nBanner provider counts smoke passed: ${checks.length} check(s).`);
