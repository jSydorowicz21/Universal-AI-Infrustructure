import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkSymlinkContract, detectHarness, detectOS, setupUserSeparation } from "./InstallEngine";

const roots: string[] = [];

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("installer platform gate", () => {
  test.each([
    ["darwin", "darwin"],
    ["linux", "linux"],
    ["win32", "windows"],
  ] as const)("maps supported runtime %s", (runtime, expected) => {
    expect(detectOS(runtime).platform).toBe(expected);
  });

  test("does not misclassify unknown kernels as Linux", () => {
    const os = detectOS("freebsd");
    expect(os.platform).toBe("unsupported");
    expect(os.name).toContain("freebsd");
  });

  test.each([
    ["claude-code", ".claude"],
    ["omp", ".claude"],
    ["codex", ".codex"],
    ["gemini", ".gemini"],
    ["opencode", join(".config", "opencode")],
  ] as const)("resolves the explicit %s harness profile", (harness, suffix) => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-harness-"));
    roots.push(home);
    const previous = process.env.LIFEOS_HARNESS;
    try {
      process.env.LIFEOS_HARNESS = harness;
      const detected = detectHarness(home);
      expect(detected.name).toBe(harness);
      expect(detected.configRoot).toBe(join(home, suffix));
      expect(detected.skillsDir).toBe(join(home, suffix, "skills"));
    } finally {
      if (previous === undefined) delete process.env.LIFEOS_HARNESS;
      else process.env.LIFEOS_HARNESS = previous;
    }
  });
});

describe("USER separation", () => {
  test("migrates live USER data losslessly before linking", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-user-link-"));
    roots.push(root);
    const configRoot = join(root, "profile");
    const configDir = join(root, "private");
    put(join(configRoot, "LIFEOS", "USER", "identity.txt"), "live value\n");
    put(join(configDir, "USER", "identity.txt"), "template value\n");

    const result = setupUserSeparation(configRoot, configDir);
    expect(result.error).toBeUndefined();
    expect(result.backup).toBeDefined();
    expect(existsSync(result.backup!)).toBeTrue();
    expect(readFileSync(join(configDir, "USER", "identity.txt"), "utf8")).toBe("live value\n");
    expect(checkSymlinkContract(configRoot, configDir).passed).toBeTrue();
  });

  test("accepts a validated Windows copy-fallback marker", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-user-copy-"));
    roots.push(root);
    const configRoot = join(root, "profile");
    const configDir = join(root, "private");
    const live = join(configRoot, "LIFEOS", "USER");
    const target = join(configDir, "USER");
    put(join(live, "identity.txt"), "copied\n");
    put(join(live, ".lifeos-user-copy-fallback.json"), JSON.stringify({ target, createdAt: new Date(0).toISOString() }));

    expect(checkSymlinkContract(configRoot, configDir)).toEqual({
      passed: true,
      detail: `${live} is the Windows copy fallback for ${target}`,
    });
  });

  test("falls back to a complete USER copy when Windows junction creation fails", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-user-win-copy-"));
    roots.push(root);
    const configRoot = join(root, "profile");
    const configDir = join(root, "private");
    put(join(configDir, "USER", "identity.txt"), "windows fallback\n");

    const result = setupUserSeparation(configRoot, configDir, {
      platform: "win32",
      link: () => {
        throw new Error("junction privilege unavailable");
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.action).toBe("copied-fallback");
    expect(readFileSync(join(configRoot, "LIFEOS", "USER", "identity.txt"), "utf8")).toBe("windows fallback\n");
    expect(checkSymlinkContract(configRoot, configDir).passed).toBeTrue();
  });

  test("leaves an already-correct USER link in place", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-user-correct-link-"));
    roots.push(root);
    const configRoot = join(root, "profile");
    const configDir = join(root, "private");
    const live = join(configRoot, "LIFEOS", "USER");
    const target = join(configDir, "USER");
    mkdirSync(target, { recursive: true });
    mkdirSync(dirname(live), { recursive: true });
    symlinkSync(target, live, process.platform === "win32" ? "junction" : "dir");

    const result = setupUserSeparation(configRoot, configDir);

    expect(result).toEqual({ action: "already-linked", target, copied: 0 });
    expect(checkSymlinkContract(configRoot, configDir).passed).toBeTrue();
  });

  test.skipIf(process.platform === "win32")("accepts an equivalent relative USER link", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-user-relative-link-"));
    roots.push(root);
    const configRoot = join(root, "profile");
    const configDir = join(root, "private");
    const live = join(configRoot, "LIFEOS", "USER");
    const target = join(configDir, "USER");
    mkdirSync(target, { recursive: true });
    mkdirSync(dirname(live), { recursive: true });
    symlinkSync(relative(dirname(live), target), live, "dir");

    const result = setupUserSeparation(configRoot, configDir);

    expect(result).toEqual({ action: "already-linked", target, copied: 0 });
    expect(checkSymlinkContract(configRoot, configDir).passed).toBeTrue();
  });

  test("backs up and replaces a USER symlink with the wrong target", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-user-stale-link-"));
    roots.push(root);
    const configRoot = join(root, "profile");
    const configDir = join(root, "private");
    const live = join(configRoot, "LIFEOS", "USER");
    const staleTarget = join(root, "old-user");
    mkdirSync(staleTarget, { recursive: true });
    mkdirSync(dirname(live), { recursive: true });
    symlinkSync(staleTarget, live, process.platform === "win32" ? "junction" : "dir");

    const result = setupUserSeparation(configRoot, configDir);

    expect(result.error).toBeUndefined();
    expect(result.backup).toBeDefined();
    expect(lstatSync(result.backup!).isSymbolicLink()).toBeTrue();
    expect(checkSymlinkContract(configRoot, configDir).passed).toBeTrue();
  });

  test("backs up and replaces a dangling USER symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-user-dangling-link-"));
    roots.push(root);
    const configRoot = join(root, "profile");
    const configDir = join(root, "private");
    const live = join(configRoot, "LIFEOS", "USER");
    const staleTarget = join(root, "deleted-user");
    mkdirSync(staleTarget, { recursive: true });
    mkdirSync(dirname(live), { recursive: true });
    symlinkSync(staleTarget, live, process.platform === "win32" ? "junction" : "dir");
    rmSync(staleTarget, { recursive: true });

    const result = setupUserSeparation(configRoot, configDir);

    expect(result.error).toBeUndefined();
    expect(result.backup).toBeDefined();
    expect(lstatSync(result.backup!).isSymbolicLink()).toBeTrue();
    expect(checkSymlinkContract(configRoot, configDir).passed).toBeTrue();
  });
});
