import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const INSTALL_SETTINGS = join(import.meta.dir, "InstallSettings.ts");
const BUN = Bun.which("bun") || process.execPath;
const roots: string[] = [];

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(current: string) {
  const root = mkdtempSync(join(tmpdir(), "lifeos-install-settings-"));
  roots.push(root);
  const skillRoot = join(root, "payload");
  const configRoot = join(root, "profile");
  put(join(skillRoot, "install", "settings.system.json"), JSON.stringify({ env: { LIFEOS_DIR: "$HOME/.claude/LIFEOS" }, includeGitInstructions: false }));
  put(join(configRoot, "settings.json"), current);
  return { root, skillRoot, configRoot };
}

function install(skillRoot: string, configRoot: string) {
  return Bun.spawnSync([BUN, INSTALL_SETTINGS, "--skill-root", skillRoot, "--config-root", configRoot, "--apply"], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("InstallSettings preserves invalid user configuration", () => {
  for (const [name, current] of [
    ["invalid JSON", "{ not-json\n"],
    ["non-object root", "[]\n"],
    ["non-object env", "{\"env\":[]}\n"],
  ] as const) {
    test(`rejects ${name} before backup or write`, () => {
      const { skillRoot, configRoot } = fixture(current);
      const result = install(skillRoot, configRoot);
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(join(configRoot, "settings.json"), "utf8")).toBe(current);
      expect(readdirSync(configRoot)).toEqual(["settings.json"]);
    });
  }
});
