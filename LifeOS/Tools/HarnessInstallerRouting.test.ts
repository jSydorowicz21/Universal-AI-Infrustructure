import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkSurvivingPlaceholders, detectEnv, setupUserSeparation, substituteTree } from "./InstallEngine";

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

describe("installer receipt regressions", () => {
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

  test("identity substitution is delimited, mode-safe, and excludes redistribution payloads", () => {
    const root = tempRoot("uai-substitution-");
    const liveFile = join(root, "profile.tsx");
    const nestedPayload = join(root, "skills", "LifeOS", "install", "template.js");
    mkdirSync(dirname(nestedPayload), { recursive: true });
    writeFileSync(liveFile, "{{DA_NAME}} HOME\n");
    writeFileSync(nestedPayload, "{{DA_NAME}}\n");
    if (process.platform !== "win32") chmodSync(liveFile, 0o755);

    const result = substituteTree(root, { "{{DA_NAME}}": "PAI", HOME: "corrupted" });

    expect(result.modified).toBe(1);
    expect(readFileSync(liveFile, "utf8")).toBe("PAI HOME\n");
    expect(readFileSync(nestedPayload, "utf8")).toBe("{{DA_NAME}}\n");
    expect(checkSurvivingPlaceholders(root)).toMatchObject({ passed: true, total: 0 });
    if (process.platform !== "win32") expect(statSync(liveFile).mode & 0o777).toBe(0o755);
  });

  test("co-located USER roots are a non-mutating no-op", () => {
    const configRoot = tempRoot("uai-colocated-user-");
    const result = setupUserSeparation(configRoot, join(configRoot, "LIFEOS"));
    expect(result).toMatchObject({ action: "already-linked", copied: 0 });
    expect(existsSync(join(configRoot, "LIFEOS", "USER"))).toBe(false);
  });
});
