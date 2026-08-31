import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkMemorySymlinkContract, checkSurvivingPlaceholders, detectEnv, mergeHooks, setupMemorySeparation, setupUserSeparation, substituteTree } from "./InstallEngine";

const roots: string[] = [];
const toolsRoot = import.meta.dir;
const lifeosRoot = dirname(toolsRoot);

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runTool(script: string, configRoot: string, args: string[] = []) {
  const home = dirname(configRoot);
  return Bun.spawnSync({
    cmd: ["bun", join(toolsRoot, script), "--config-root", configRoot, "--skill-root", lifeosRoot, ...args],
    cwd: toolsRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      UAI_HARNESS: "codex",
      UAI_CONFIG_DIR: configRoot,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("harness-aware setup tools", () => {
  test("refuses Claude settings payload for a Codex profile without creating settings.json", () => {
    const home = tempRoot("uai-codex-settings-");
    const configRoot = join(home, ".codex");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(join(configRoot, "config.toml"), "model = \"gpt-5\"\n");

    const result = runTool("InstallSettings.ts", configRoot, ["--apply"]);

    expect(result.exitCode).toBe(1);
    expect(Buffer.from(result.stdout).toString()).toContain("does not consume settings.json");
    expect(existsSync(join(configRoot, "settings.json"))).toBe(false);
    expect(readFileSync(join(configRoot, "config.toml"), "utf-8")).toBe("model = \"gpt-5\"\n");
  });

  test("activates LifeOS imports in Codex AGENTS.md", () => {
    const home = tempRoot("uai-codex-imports-");
    const configRoot = join(home, ".codex");
    mkdirSync(join(configRoot, "LIFEOS", "USER", "PRINCIPAL"), { recursive: true });
    writeFileSync(join(configRoot, "LIFEOS", "USER", "PRINCIPAL", "PRINCIPAL_IDENTITY.md"), "# Principal\n");
    writeFileSync(join(configRoot, "AGENTS.md"), "# @LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md\n");

    const result = runTool("ActivateImports.ts", configRoot, ["--apply"]);

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString()).toContain("PRINCIPAL_IDENTITY.md");
    expect(readFileSync(join(configRoot, "AGENTS.md"), "utf-8")).toBe("@LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md\n");
  });
  test("refuses Claude hook payload for a Codex profile without creating hook files", () => {
    const home = tempRoot("uai-codex-hooks-");
    const configRoot = join(home, ".codex");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(join(configRoot, "config.toml"), "model = \"gpt-5\"\n");

    const result = runTool("InstallHooks.ts", configRoot, ["--apply"]);

    expect(result.exitCode).toBe(1);
    expect(Buffer.from(result.stdout).toString()).toContain("does not consume Claude hooks");
    expect(existsSync(join(configRoot, "hooks"))).toBe(false);
    expect(existsSync(join(configRoot, "settings.json"))).toBe(false);
  });
});
  test("LinkUser establishes both USER and MEMORY data links", () => {
    const home = tempRoot("uai-private-data-links-");
    const configRoot = join(home, ".claude");
    const dataRoot = join(home, ".pai");
    mkdirSync(join(configRoot, "LIFEOS", "USER"), { recursive: true });
    mkdirSync(join(configRoot, "LIFEOS", "MEMORY"), { recursive: true });
    writeFileSync(join(configRoot, "LIFEOS", "USER", "identity.md"), "user\n");
    writeFileSync(join(configRoot, "LIFEOS", "MEMORY", "state.json"), "memory\n");

    const result = runTool("LinkUser.ts", configRoot, ["--config-dir", dataRoot, "--apply"]);
    const output = JSON.parse(Buffer.from(result.stdout).toString()) as {
      ok: boolean;
      contract: { passed: boolean };
      memoryContract: { passed: boolean };
    };

    expect(result.exitCode).toBe(0);
    expect(output).toMatchObject({ ok: true, contract: { passed: true }, memoryContract: { passed: true } });
    expect(realpathSync(join(configRoot, "LIFEOS", "USER"))).toBe(realpathSync(join(dataRoot, "USER")));
    expect(realpathSync(join(configRoot, "LIFEOS", "MEMORY"))).toBe(realpathSync(join(dataRoot, "MEMORY")));
  });

describe("installer receipt regressions", () => {
  test("hook merge treats Windows and POSIX profile paths as the same command", () => {
    const existing = {
      PostToolUse: [
        { matcher: "Write", hooks: [{ type: "command", command: "\"C:\\Users\\Ada User\\.claude\\hooks\\ISASync.hook.ts\"" }] },
        { matcher: "Write", hooks: [{ type: "command", command: "foreign-tool --check" }] },
      ],
    };
    const incoming = {
      PostToolUse: [
        { matcher: "Write", hooks: [{ type: "command", command: "$HOME/.claude/hooks/ISASync.hook.ts" }] },
      ],
    };

    const result = mergeHooks(existing, incoming);

    expect(result).toMatchObject({ added: 0, skipped: 1 });
    expect(result.merged).toEqual(existing);
  });

  test("hook merge normalizes USERPROFILE command paths", () => {
    const existing = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "$USERPROFILE/.claude/hooks/ContextReduction.hook.sh" }] }],
    };
    const incoming = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${HOME}/.claude/hooks/ContextReduction.hook.sh" }] }],
    };

    expect(mergeHooks(existing, incoming)).toMatchObject({ added: 0, skipped: 1, merged: existing });
  });
  test("settings alone do not impersonate an existing LifeOS install", () => {
    const home = tempRoot("uai-install-marker-");
    const configRoot = join(home, ".claude");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(join(configRoot, "settings.json"), "{}\n");
    const env = { ...process.env, HOME: home, USERPROFILE: home, UAI_HARNESS: "claude-code", UAI_CONFIG_DIR: configRoot };

    expect(detectEnv(env).existingInstall).toBe(false);
    mkdirSync(join(configRoot, "LIFEOS"), { recursive: true });
    writeFileSync(join(configRoot, "LIFEOS", "VERSION"), "7.40.4\n");
    expect(detectEnv(env).existingInstall).toBe(true);
  });

  test("identity substitution is delimited, mode-safe, and excludes installer control planes", () => {
    const root = tempRoot("uai-substitution-");
    const liveFile = join(root, "profile.tsx");
    const nestedPayload = join(root, "skills", "LifeOS", "install", "template.js");
    const installerControl = join(root, "skills", "LifeOS", "Tools", "RenderIdentity.ts");
    mkdirSync(dirname(nestedPayload), { recursive: true });
    mkdirSync(dirname(installerControl), { recursive: true });
    writeFileSync(liveFile, "{{DA_NAME}} HOME\n");
    writeFileSync(nestedPayload, "{{DA_NAME}}\n");
    writeFileSync(installerControl, "{{DA_NAME}}\n");
    if (process.platform !== "win32") chmodSync(liveFile, 0o755);

    const result = substituteTree(root, { "{{DA_NAME}}": "PAI", HOME: "corrupted" });

    expect(result.modified).toBe(1);
    expect(readFileSync(liveFile, "utf8")).toBe("PAI HOME\n");
    expect(readFileSync(nestedPayload, "utf8")).toBe("{{DA_NAME}}\n");
    expect(readFileSync(installerControl, "utf8")).toBe("{{DA_NAME}}\n");
    expect(checkSurvivingPlaceholders(root)).toMatchObject({ passed: true, total: 0 });
    if (process.platform !== "win32") expect(statSync(liveFile).mode & 0o777).toBe(0o755);
  });

  test("identity substitution skips the linked USER data root", () => {
    const root = tempRoot("uai-substitution-link-");
    const userRoot = tempRoot("uai-private-user-");
    const liveFile = join(root, "hooks", "identity.ts");
    const privateFile = join(userRoot, "identity.md");
    mkdirSync(dirname(liveFile), { recursive: true });
    mkdirSync(join(root, "LIFEOS"), { recursive: true });
    writeFileSync(liveFile, "{{DA_NAME}}\n");
    writeFileSync(privateFile, "{{DA_NAME}}\n");
    symlinkSync(userRoot, join(root, "LIFEOS", "USER"), process.platform === "win32" ? "junction" : "dir");

    const result = substituteTree(root, { "{{DA_NAME}}": "PAI" });

    expect(result.modified).toBe(1);
    expect(readFileSync(liveFile, "utf8")).toBe("PAI\n");
    expect(readFileSync(privateFile, "utf8")).toBe("{{DA_NAME}}\n");
  });

  test("co-located USER roots are a non-mutating no-op", () => {
    const configRoot = tempRoot("uai-colocated-user-");
    const result = setupUserSeparation(configRoot, join(configRoot, "LIFEOS"));
    expect(result).toMatchObject({ action: "already-linked", copied: 0 });
    expect(existsSync(join(configRoot, "LIFEOS", "USER"))).toBe(false);
  });
  test("memory separation merges live state into the canonical data root and links it", () => {
    const configRoot = tempRoot("uai-memory-config-");
    const dataRoot = tempRoot("uai-memory-data-");
    const liveMemory = join(configRoot, "LIFEOS", "MEMORY");
    const canonicalMemory = join(dataRoot, "MEMORY");
    mkdirSync(join(liveMemory, "STATE"), { recursive: true });
    mkdirSync(join(canonicalMemory, "STATE"), { recursive: true });
    mkdirSync(join(canonicalMemory, "KNOWLEDGE"), { recursive: true });
    writeFileSync(join(liveMemory, "STATE", "work.json"), "live-state\n");
    writeFileSync(join(canonicalMemory, "STATE", "work.json"), "synced-state\n");
    writeFileSync(join(canonicalMemory, "KNOWLEDGE", "README.md"), "durable\n");

    const result = setupMemorySeparation(configRoot, dataRoot);

    expect(result).toMatchObject({ action: "linked", overwritten: 1, preserved: 1 });
    expect(lstatSync(liveMemory).isSymbolicLink()).toBe(true);
    expect(realpathSync(liveMemory)).toBe(realpathSync(canonicalMemory));
    expect(readFileSync(join(liveMemory, "STATE", "work.json"), "utf8")).toBe("live-state\n");
    expect(readFileSync(join(liveMemory, "KNOWLEDGE", "README.md"), "utf8")).toBe("durable\n");
    expect(readdirSync(join(canonicalMemory, "STATE")).some((name) => name.startsWith("work.json.replaced-"))).toBe(true);
    expect(checkMemorySymlinkContract(configRoot, dataRoot).passed).toBe(true);
  });
});
