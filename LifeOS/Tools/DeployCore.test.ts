import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DEPLOY_CORE = join(import.meta.dir, "DeployCore.ts");
const BUN = Bun.which("bun") || process.execPath;
const ACTIVE_MEMORY_SUBDIRS = [
  "KNOWLEDGE",
  "WORK",
  "LEARNING",
  "WISDOM",
  "RESEARCH",
  "SECURITY",
  "STATE",
  "OBSERVABILITY",
  "VOICE",
  "RELATIONSHIP",
  "VERIFICATION",
  "TEAMS",
  "SKILLS",
  "SYSTEMUPDATES",
  "PLANS",
  "REFERENCE",
  "BOOKMARKS",
  "DATA",
  "SCRATCHPAD",
  "PROJECT",
  "ARCHIVE",
  "_AIRGRADIENT",
  "_HELIOS",
  "_NETWORK",
  "PULSE_DATA",
];
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lifeos-deploy-core-"));
  roots.push(root);
  return root;
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function payload(root: string, dependencies: Record<string, string> = {}): string {
  const skillRoot = join(root, "payload");
  put(join(skillRoot, "install", "skills", "Example", "SKILL.md"), "new skill\n");
  put(join(skillRoot, "install", "LIFEOS", "ALGORITHM", "LATEST"), "7.0.0\n");
  put(join(skillRoot, "install", "hooks", "managed.hook.ts"), "export {};\n");
  put(join(skillRoot, "install", "package.json"), JSON.stringify({ private: true, dependencies }, null, 2));
  return skillRoot;
}

function deploy(skillRoot: string, configRoot: string) {
  return Bun.spawnSync([BUN, DEPLOY_CORE, "--skill-root", skillRoot, "--config-root", configRoot, "--apply"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: dirname(configRoot) },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DeployCore transactional cutover", () => {
  test("replaces managed runtime and skills while preserving unrelated hooks", () => {
    const root = tempRoot();
    const skillRoot = payload(root);
    const configRoot = join(root, "profile");
    put(join(configRoot, "LIFEOS", "ALGORITHM", "STALE"), "obsolete\n");
    put(join(configRoot, "skills", "Example", "SKILL.md"), "old skill\n");
    put(join(configRoot, "hooks", "custom.hook.ts"), "export const custom = true;\n");
    put(join(configRoot, "package.json"), JSON.stringify({ name: "user-profile", private: true, dependencies: {} }, null, 2) + "\n");

    const result = deploy(skillRoot, configRoot);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(join(configRoot, "LIFEOS", "ALGORITHM", "LATEST"), "utf8")).toBe("7.0.0\n");
    expect(existsSync(join(configRoot, "LIFEOS", "ALGORITHM", "STALE"))).toBeFalse();
    expect(readFileSync(join(configRoot, "skills", "Example", "SKILL.md"), "utf8")).toBe("new skill\n");
    expect(existsSync(join(configRoot, "hooks", "custom.hook.ts"))).toBeTrue();
    expect(existsSync(join(configRoot, "hooks", "managed.hook.ts"))).toBeTrue();
    for (const subdir of ACTIVE_MEMORY_SUBDIRS) {
      expect(existsSync(join(configRoot, "LIFEOS", "MEMORY", subdir)), subdir).toBeTrue();
    }
    expect(JSON.parse(readFileSync(join(configRoot, "package.json"), "utf8")).name).toBe("user-profile");
  });

  test("restores the original dependency manifest when bun install fails", () => {
    const root = tempRoot();
    const skillRoot = payload(root, { unavailable: "file:./definitely-missing-package" });
    const configRoot = join(root, "profile");
    const original = JSON.stringify({ name: "user-profile", private: true, dependencies: {} }, null, 2) + "\n";
    put(join(configRoot, "package.json"), original);
    put(join(configRoot, "node_modules", "existing", "sentinel.txt"), "keep me\n");
    put(join(configRoot, "bun.lock"), "existing lock\n");

    const result = deploy(skillRoot, configRoot);
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(configRoot, "package.json"), "utf8")).toBe(original);
    expect(readFileSync(join(configRoot, "bun.lock"), "utf8")).toBe("existing lock\n");
    expect(readFileSync(join(configRoot, "node_modules", "existing", "sentinel.txt"), "utf8")).toBe("keep me\n");
  });

  test("rejects a non-object dependency manifest without rewriting it", () => {
    const root = tempRoot();
    const skillRoot = payload(root);
    const configRoot = join(root, "profile");
    const invalid = "[]\n";
    put(join(configRoot, "package.json"), invalid);

    const result = deploy(skillRoot, configRoot);
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(configRoot, "package.json"), "utf8")).toBe(invalid);
  });
});
