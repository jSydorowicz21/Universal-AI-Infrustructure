import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const BUN = Bun.which("bun") || process.execPath;
const PATHS_URL = pathToFileURL(join(import.meta.dir, "../install/LIFEOS/TOOLS/lib/paths.ts")).href;
const PULSE_LIB_URL = pathToFileURL(join(import.meta.dir, "../install/LIFEOS/PULSE/lib.ts")).href;
const GITHUB_CHECK_URL = pathToFileURL(join(import.meta.dir, "../install/LIFEOS/PULSE/checks/github.ts")).href;
const TELEGRAM_SESSIONS_URL = pathToFileURL(join(import.meta.dir, "../install/LIFEOS/PULSE/lib/telegram-sessions.ts")).href;
const roots: string[] = [];

function freshEnv(home: string): Record<string, string> {
  const env = { ...process.env, HOME: home } as Record<string, string>;
  delete env.LIFEOS_CONFIG_ROOT;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.LIFEOS_DIR;
  return env;
}

function run(code: string, env: Record<string, string>) {
  return Bun.spawnSync([BUN, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pulse selected-profile paths", () => {
  test("derives the config root from an explicit LIFEOS_DIR", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-pulse-paths-"));
    roots.push(home);
    const lifeosDir = join(home, "profiles", "primary", "LIFEOS");
    const code = `import { getLifeosConfigRoot, getLifeosDir } from ${JSON.stringify(PATHS_URL)}; console.log(JSON.stringify({ configRoot: getLifeosConfigRoot(), lifeosDir: getLifeosDir() }));`;
    const result = run(code, { ...freshEnv(home), LIFEOS_DIR: lifeosDir });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ configRoot: dirname(lifeosDir), lifeosDir });
  });

  test("loads the user cron file from the selected LifeOS tree", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-pulse-cron-"));
    roots.push(home);
    const configRoot = join(home, "profile");
    const lifeosDir = join(home, "runtime", "LIFEOS");
    const code = `import { USER_CRON_PATH } from ${JSON.stringify(PULSE_LIB_URL)}; process.stdout.write(USER_CRON_PATH);`;
    const result = run(code, { ...freshEnv(home), LIFEOS_CONFIG_ROOT: configRoot, LIFEOS_DIR: lifeosDir });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe(join(lifeosDir, "USER", "CONFIG", "PULSE.user.toml"));
  });

  test.skipIf(process.platform === "win32")("runs script jobs from the selected Pulse directory", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-pulse-cwd-"));
    roots.push(home);
    const lifeosDir = join(home, "runtime", "LIFEOS");
    const pulseDir = join(lifeosDir, "PULSE");
    mkdirSync(pulseDir, { recursive: true });
    const code = `import { spawnScript } from ${JSON.stringify(PULSE_LIB_URL)}; process.stdout.write(await spawnScript("pwd"));`;
    const result = run(code, { ...freshEnv(home), LIFEOS_DIR: lifeosDir });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(realpathSync(result.stdout.toString().trim())).toBe(realpathSync(pulseDir));
  });
  test.skipIf(process.platform === "win32")("suppresses child stderr that may contain credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-pulse-stderr-"));
    roots.push(home);
    const lifeosDir = join(home, "runtime", "LIFEOS");
    mkdirSync(join(lifeosDir, "PULSE"), { recursive: true });
    const command = "printf 'secret-token' >&2; exit 7";
    const code = `import { spawnScript } from ${JSON.stringify(PULSE_LIB_URL)}; try { await spawnScript(${JSON.stringify(command)}); } catch (error) { process.stdout.write(String(error)); }`;
    const result = run(code, { ...freshEnv(home), LIFEOS_DIR: lifeosDir });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("Script exited 7");
    expect(result.stdout.toString()).not.toContain("secret-token");
  });

  test("persists GitHub state inside the selected LifeOS tree", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-pulse-github-"));
    roots.push(home);
    const lifeosDir = join(home, "runtime", "LIFEOS");
    const code = `import { appendSeen } from ${JSON.stringify(GITHUB_CHECK_URL)}; await appendSeen(["owner/repo#1"]);`;
    const result = run(code, { ...freshEnv(home), LIFEOS_DIR: lifeosDir });
    const stateFile = join(lifeosDir, "PULSE", "state", "github-seen.jsonl");

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(stateFile, "utf8")).toContain("owner/repo#1");
    expect(existsSync(join(home, ".claude", "LIFEOS", "PULSE", "state", "github-seen.jsonl"))).toBeFalse();
  });

  test("persists Telegram sessions inside the selected LifeOS tree", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-pulse-telegram-"));
    roots.push(home);
    const lifeosDir = join(home, "runtime", "LIFEOS");
    const code = `import { closeDb, upsertSession } from ${JSON.stringify(TELEGRAM_SESSIONS_URL)}; upsertSession("chat", "session"); closeDb();`;
    const result = run(code, { ...freshEnv(home), LIFEOS_DIR: lifeosDir });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(join(lifeosDir, "PULSE", "state", "telegram", "sessions.db"))).toBeTrue();
    expect(existsSync(join(home, ".claude", "LIFEOS", "PULSE", "state", "telegram", "sessions.db"))).toBeFalse();
  });
});
