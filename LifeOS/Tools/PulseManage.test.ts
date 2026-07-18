import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MANAGER = join(dirname(fileURLToPath(import.meta.url)), "../install/LIFEOS/PULSE/manage.sh");
const roots: string[] = [];

function executable(path: string, content: string): void {
  writeFileSync(path, `#!/bin/sh\n${content}\n`);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("Pulse service installation", () => {
  test("installs dependencies before activation and retries a failed health probe once", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-pulse-manage-"));
    roots.push(root);
    const home = join(root, "home");
    const lifeosDir = join(root, "profile", "LIFEOS");
    const pulseDir = join(lifeosDir, "PULSE");
    const fakeBin = join(root, "bin");
    const bunBin = join(home, ".bun", "bin");
    const log = join(root, "calls.log");
    const curlCount = join(root, "curl-count");
    mkdirSync(pulseDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(bunBin, { recursive: true });
    writeFileSync(join(pulseDir, "com.lifeos.pulse.service"), [
      "[Service]",
      "WorkingDirectory=__LIFEOS_DIR__/PULSE",
      "ExecStart=__BUN_PATH__ run pulse.ts",
      "Environment=LIFEOS_CONFIG_ROOT=__CONFIG_ROOT__",
      "Environment=LIFEOS_DIR=__LIFEOS_DIR__",
    ].join("\n"));

    const quotedLog = JSON.stringify(log);
    executable(join(bunBin, "bun"), `printf 'bun %s\\n' "$*" >> ${quotedLog}`);
    executable(join(fakeBin, "uname"), "printf 'Linux\\n'");
    executable(join(fakeBin, "sleep"), ":");
    for (const command of ["systemctl", "pkill", "loginctl"]) {
      executable(join(fakeBin, command), `printf '${command} %s\\n' "$*" >> ${quotedLog}`);
    }
    executable(join(fakeBin, "curl"), [
      `printf 'curl %s\\n' "$*" >> ${quotedLog}`,
      `count=0; [ ! -f ${JSON.stringify(curlCount)} ] || count=$(cat ${JSON.stringify(curlCount)})`,
      "count=$((count + 1))",
      `printf '%s' "$count" > ${JSON.stringify(curlCount)}`,
      "[ \"$count\" -gt 60 ]",
    ].join("\n"));

    const result = Bun.spawnSync(["/bin/bash", MANAGER, "install"], {
      env: {
        ...process.env,
        HOME: home,
        USER: "tester",
        LIFEOS_DIR: lifeosDir,
        LIFEOS_CONFIG_ROOT: join(root, "profile"),
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const calls = readFileSync(log, "utf8");

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("verified after one restart");
    expect(calls).toContain("bun install --frozen-lockfile");
    expect(calls).toContain("systemctl --user restart com.lifeos.pulse");
    expect(calls).toContain("http://localhost:31337/healthz");
    expect(calls.indexOf("bun install --frozen-lockfile")).toBeLessThan(calls.indexOf("systemctl --user start com.lifeos.pulse"));
    expect(readFileSync(curlCount, "utf8")).toBe("61");
    expect(existsSync(join(home, ".config", "systemd", "user", "com.lifeos.pulse.service"))).toBeTrue();
  });
});
