#!/usr/bin/env bun
/**
 * Verifies llcli resolves Limitless config from provider-neutral PAI paths.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSearchPaths, loadConfig, parseEnvValue } from "../bin/llcli/llcli";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = mkdtempSync(join(tmpdir(), "pai-llcli-smoke-"));
const home = join(root, "home");
const dataDir = join(root, "data");
const configDir = join(root, "config");
const codexHome = join(root, ".codex");
const frameworkEnv = join(codexHome, ".env");
const configEnv = join(configDir, ".env");

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function resetEnv(): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PAI_DATA_DIR = dataDir;
  process.env.PAI_CONFIG_DIR = configDir;
  process.env.PAI_FRAMEWORK_DIR = codexHome;
  process.env.CODEX_HOME = codexHome;
  process.env.PAI_FRAMEWORK = "codex";
  delete process.env.PAI_ENV_PATH;
  delete process.env.LIMITLESS_API_KEY;
}

try {
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(join(codexHome, "PAI"), { recursive: true });
  writeFileSync(join(dataDir, "framework.json"), JSON.stringify({
    active: "codex",
    root: codexHome,
    dataDir,
  }, null, 2));

  resetEnv();
  check(
    "dotenv parser handles quoted values",
    parseEnvValue("LIMITLESS_API_KEY='quoted-key'\n", "LIMITLESS_API_KEY") === "quoted-key",
    "single-quoted env value",
  );

  writeFileSync(configEnv, "LIMITLESS_API_KEY=shared-config-key\n", "utf-8");
  let config = loadConfig();
  check(
    "llcli reads shared PAI config env first",
    config.apiKey === "shared-config-key" && config.envSource === configEnv,
    `${config.envSource}:${config.apiKey}`,
  );

  writeFileSync(configEnv, "OTHER=value\n", "utf-8");
  writeFileSync(frameworkEnv, "LIMITLESS_API_KEY=codex-framework-key\n", "utf-8");
  config = loadConfig();
  check(
    "llcli falls back to active Codex framework env",
    config.apiKey === "codex-framework-key" && config.envSource === frameworkEnv,
    `${config.envSource}:${config.apiKey}`,
  );

  process.env.LIMITLESS_API_KEY = "process-env-key";
  config = loadConfig();
  check(
    "llcli live environment overrides env files",
    config.apiKey === "process-env-key" && config.envSource === "process.env.LIMITLESS_API_KEY",
    `${config.envSource}:${config.apiKey}`,
  );

  const searchPaths = configSearchPaths();
  check(
    "llcli search paths include provider-neutral config",
    searchPaths.includes(configEnv) && searchPaths.includes(frameworkEnv),
    searchPaths.join(" | "),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nLimitless CLI config smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log(`\nLimitless CLI config smoke passed: ${checks.length} check(s).`);
