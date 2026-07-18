import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")("launchd installers materialize the selected config root", () => {
  const home = mkdtempSync(join(tmpdir(), "lifeos-service-profile-"));
  roots.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const launchctl = join(bin, "launchctl");
  writeFileSync(launchctl, "#!/bin/sh\nexit 0\n");
  chmodSync(launchctl, 0o755);

  const sourceLifeos = join(import.meta.dir, "../install/LIFEOS");
  const configRoot = join(home, ".custom-profile");
  const lifeosDir = join(configRoot, "LIFEOS");
  const toolsDir = join(lifeosDir, "TOOLS");
  mkdirSync(toolsDir, { recursive: true });
  copyFileSync(join(sourceLifeos, "TOOLS", "com.lifeos.worksweep.plist.template"), join(toolsDir, "com.lifeos.worksweep.plist.template"));
  const installer = join(sourceLifeos, "TOOLS", "InstallWorkSweep.ts");
  const result = Bun.spawnSync([Bun.which("bun") || process.execPath, installer], {
    env: {
      ...process.env,
      HOME: home,
      LIFEOS_CONFIG_ROOT: configRoot,
      LIFEOS_DIR: lifeosDir,
      PATH: `${bin}:${process.env.PATH || ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const plistPath = join(home, "Library", "LaunchAgents", "com.lifeos.worksweep.plist");
  expect(existsSync(plistPath)).toBeTrue();
  const plist = readFileSync(plistPath, "utf8");
  expect(plist).toContain(configRoot);
  expect(plist).not.toContain(join(home, ".claude"));
});
