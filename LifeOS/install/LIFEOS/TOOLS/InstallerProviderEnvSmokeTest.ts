#!/usr/bin/env bun
/**
 * Verifies installer key/voice discovery honors provider-native framework env files.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExistingEnvKey, findExistingVoiceConfig, primaryEnvCandidatePaths } from "../PAI-Install/engine/actions";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = mkdtempSync(join(tmpdir(), "pai-installer-provider-env-"));
const home = join(root, "home");
const codexHome = join(home, ".codex");
const claudeHome = join(home, ".claude");
const configDir = join(home, ".config", "PAI");
const codexEnv = join(codexHome, ".env");
const claudeEnv = join(claudeHome, ".env");
const configEnv = join(configDir, ".env");

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function resetEnv(): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PAI_CONFIG_DIR = configDir;
  process.env.PAI_FRAMEWORK_DIR = codexHome;
  process.env.CODEX_HOME = codexHome;
  process.env.PAI_FRAMEWORK = "codex";
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOWED_USERS;
}

try {
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  resetEnv();

  writeFileSync(configEnv, "ELEVENLABS_API_KEY=shared-elevenlabs\n", "utf-8");
  writeFileSync(codexEnv, "ELEVENLABS_API_KEY=codex-elevenlabs\nTELEGRAM_BOT_TOKEN=codex-telegram\nTELEGRAM_ALLOWED_USERS=2468\n", "utf-8");
  writeFileSync(claudeEnv, "ELEVENLABS_API_KEY=legacy-claude-elevenlabs\n", "utf-8");

  let paths = primaryEnvCandidatePaths(codexHome);
  check(
    "installer primary env paths include shared config and Codex home",
    paths.includes(configEnv) && paths.includes(codexEnv),
    paths.join(" | "),
  );

  check(
    "installer key lookup prefers shared PAI config",
    findExistingEnvKey("ELEVENLABS_API_KEY", codexHome) === "shared-elevenlabs",
    findExistingEnvKey("ELEVENLABS_API_KEY", codexHome),
  );

  writeFileSync(configEnv, "OTHER=value\n", "utf-8");
  check(
    "installer key lookup falls back to Codex framework env",
    findExistingEnvKey("ELEVENLABS_API_KEY", codexHome) === "codex-elevenlabs",
    findExistingEnvKey("ELEVENLABS_API_KEY", codexHome),
  );

  check(
    "installer Telegram lookup reads Codex framework env",
    findExistingEnvKey("TELEGRAM_BOT_TOKEN", codexHome) === "codex-telegram" &&
      findExistingEnvKey("TELEGRAM_ALLOWED_USERS", codexHome) === "2468",
    `${findExistingEnvKey("TELEGRAM_BOT_TOKEN", codexHome)}:${findExistingEnvKey("TELEGRAM_ALLOWED_USERS", codexHome)}`,
  );

  writeFileSync(codexEnv, "OTHER=value\n", "utf-8");
  check(
    "installer key lookup keeps legacy Claude env as fallback only",
    findExistingEnvKey("ELEVENLABS_API_KEY", codexHome) === "legacy-claude-elevenlabs",
    findExistingEnvKey("ELEVENLABS_API_KEY", codexHome),
  );

  process.env.ELEVENLABS_API_KEY = "live-env-elevenlabs";
  check(
    "installer live environment overrides env files",
    findExistingEnvKey("ELEVENLABS_API_KEY", codexHome) === "live-env-elevenlabs",
    findExistingEnvKey("ELEVENLABS_API_KEY", codexHome),
  );
  delete process.env.ELEVENLABS_API_KEY;

  writeFileSync(join(codexHome, "settings.json"), JSON.stringify({
    daidentity: { name: "Codex DA", voices: { main: { voiceId: "codex-voice-id" } } },
  }, null, 2), "utf-8");
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
    daidentity: { name: "Claude DA", voices: { main: { voiceId: "claude-voice-id" } } },
  }, null, 2), "utf-8");

  const voice = findExistingVoiceConfig(codexHome);
  check(
    "installer voice lookup checks active Codex settings first",
    voice?.voiceId === "codex-voice-id" && voice.aiName === "Codex DA",
    JSON.stringify(voice),
  );

  process.env.PAI_CONFIG_DIR = join(root, "missing-config");
  paths = primaryEnvCandidatePaths(codexHome);
  check(
    "installer missing PAI_CONFIG_DIR falls back to home shared config path",
    paths.includes(configEnv),
    paths.join(" | "),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nInstaller provider env smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log(`\nInstaller provider env smoke passed: ${checks.length} check(s).`);
