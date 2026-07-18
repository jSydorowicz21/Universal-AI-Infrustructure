#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function assert(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
}

const root = mkdtempSync(join(tmpdir(), "pai-launch-cwd-smoke-"));
try {
  const projectDir = join(root, "project");
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const paiData = join(root, "pai-data");
  const paiConfig = join(root, "pai-config");
  const bin = join(root, "bin");
  const cwdFile = join(root, "codex-cwd.txt");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(paiData, { recursive: true });
  mkdirSync(paiConfig, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(paiData, "framework.json"), JSON.stringify({
    active: "codex",
    frameworkName: "Codex",
    root: codexHome,
    dataDir: paiData,
  }, null, 2));

  if (process.platform === "win32") {
    writeFileSync(join(bin, "codex.cmd"), `@echo off\r\ncd > "${cwdFile}"\r\nexit /b 0\r\n`, "utf-8");
  } else {
    const shim = join(bin, "codex");
    writeFileSync(shim, `#!/usr/bin/env sh\npwd > ${JSON.stringify(cwdFile)}\n`, "utf-8");
    spawnSync("chmod", ["755", shim], { windowsHide: true });
  }

  const testPath = `${bin}${delimiter}${process.env.PATH || process.env.Path || ""}`;
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PAI_FRAMEWORK: "codex",
    CODEX_HOME: codexHome,
    CLAUDE_HOME: "",
    PAI_CLAUDE_HOME: "",
    OPENCODE_CONFIG_DIR: "",
    PAI_FRAMEWORK_DIR: "",
    PAI_DIR: "",
    PAI_DATA_DIR: paiData,
    PAI_MEMORY_DIR: "",
    PAI_USER_DIR: "",
    PAI_CONFIG_DIR: paiConfig,
    PAI_SETTINGS_PATH: "",
    PATH: testPath,
    Path: testPath,
  };

  const result = spawnSync(process.execPath, [join(import.meta.dir, "pai.ts")], {
    cwd: projectDir,
    env,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });

  const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  assert("PAI launch exits 0 with fake Codex", result.status === 0, result.status === 0 ? "" : output);
  assert("fake Codex recorded cwd", existsSync(cwdFile), existsSync(cwdFile) ? "" : output);
  assert("framework launch preserves caller cwd", resolve(readFileSync(cwdFile, "utf-8").trim()) === resolve(projectDir), readFileSync(cwdFile, "utf-8").trim());
} finally {
  const resolved = resolve(root);
  if (dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-launch-cwd-smoke-")) {
    rmSync(resolved, { recursive: true, force: true });
  }
}
