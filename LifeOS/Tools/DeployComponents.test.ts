import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DEPLOY_COMPONENTS = join(import.meta.dir, "DeployComponents.ts");
const BUN = Bun.which("bun") || process.execPath;
const roots: string[] = [];

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function run(
  home: string,
  skillRoot: string,
  configRoot: string,
  apply = true,
  component = "statusline",
  platform = "linux",
) {
  const args = [BUN, DEPLOY_COMPONENTS, "--skill-root", skillRoot, "--config-root", configRoot, "--components", component, "--platform", platform];
  if (apply) args.push("--apply");
  return Bun.spawnSync(args, { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DeployComponents failure and profile handling", () => {
  test("fails loudly when a selected component payload is absent", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-components-missing-"));
    roots.push(home);
    const result = run(home, join(home, "payload"), join(home, ".profile"), false);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout.toString()).results[0].blockers.length).toBeGreaterThan(0);
  });

  test("wires statusline to the selected config root", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-components-profile-"));
    roots.push(home);
    const skillRoot = join(home, "payload");
    const configRoot = join(home, ".custom-profile");
    const source = join(skillRoot, "install", "LIFEOS", "LIFEOS_StatusLine.sh");
    put(source, "#!/bin/sh\nexit 0\n");
    chmodSync(source, 0o755);

    const result = run(home, skillRoot, configRoot);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const settings = JSON.parse(readFileSync(join(configRoot, "settings.json"), "utf8"));
    expect(settings.statusLine.command).toBe("$HOME/.custom-profile/LIFEOS/LIFEOS_StatusLine.sh");
  });

  test("does not rewrite a structurally invalid settings object", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-components-invalid-"));
    roots.push(home);
    const skillRoot = join(home, "payload");
    const configRoot = join(home, ".profile");
    put(join(skillRoot, "install", "LIFEOS", "LIFEOS_StatusLine.sh"), "#!/bin/sh\nexit 0\n");
    const invalid = "[]\n";
    put(join(configRoot, "settings.json"), invalid);

    const result = run(home, skillRoot, configRoot);
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(configRoot, "settings.json"), "utf8")).toBe(invalid);
    expect(readdirSync(configRoot).sort()).toEqual(["LIFEOS", "settings.json"]);
  });

  test.each([
    ["linux", "manage.sh", "bash"],
    ["win32", "manage.ps1", "powershell"],
  ] as const)("plans the native Pulse service adapter on %s", (platform, manager, command) => {
    const home = mkdtempSync(join(tmpdir(), `lifeos-components-${platform}-`));
    roots.push(home);
    const skillRoot = join(home, "payload");
    const configRoot = join(home, ".profile");
    put(join(skillRoot, "install", "LIFEOS", "PULSE", manager), "");

    const result = run(home, skillRoot, configRoot, false, "pulse", platform);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const parsed = JSON.parse(result.stdout.toString());
    expect(parsed.results[0].ready).toBeTrue();
    expect(parsed.results[0].actions.join("\n")).toContain(command);
  });

  test("fails explicitly for a macOS-only service selected on Linux", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-components-linux-block-"));
    roots.push(home);
    const result = run(home, join(home, "payload"), join(home, ".profile"), false, "worksweep", "linux");
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout.toString()).results[0].blockers[0]).toContain("no linux service adapter");
  });
});
