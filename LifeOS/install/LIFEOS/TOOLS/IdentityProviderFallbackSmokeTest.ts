#!/usr/bin/env bun
/**
 * Verifies provider-native installs can resolve identity from shared USER
 * markdown when settings.json only contains framework metadata.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const root = mkdtempSync(join(tmpdir(), "pai-identity-provider-fallback-"));
const home = join(root, "home");
const dataDir = join(root, ".pai");
const userDir = join(dataDir, "USER");
const codexHome = join(home, ".codex");

mkdirSync(userDir, { recursive: true });
mkdirSync(codexHome, { recursive: true });

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PAI_FRAMEWORK = "codex";
process.env.PAI_FRAMEWORK_DIR = codexHome;
process.env.CODEX_HOME = codexHome;
process.env.PAI_DATA_DIR = dataDir;
process.env.PAI_SETTINGS_PATH = join(codexHome, "settings.json");

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function write(path: string, content: string): void {
  writeFileSync(path, content);
}

try {
  write(process.env.PAI_SETTINGS_PATH, JSON.stringify({
    pai: { framework: "codex" },
    env: {
      PAI_FRAMEWORK: "codex",
      PAI_DATA_DIR: dataDir,
    },
  }, null, 2));

  write(join(userDir, "DA_IDENTITY.md"), [
    "# DA Identity - Astra",
    "",
    "- **Name:** Astra | **Full Name:** Astra Prime | **Display:** Astra",
    "- **Color:** #10B981 | **Role:** primary",
    "- **Voice (main):** `main-voice-id` (Main test voice)",
    "- **Voice (algorithm):** `algorithm-voice-id` (Ada - test voice)",
    "",
  ].join("\n"));

  write(join(userDir, "PRINCIPAL_IDENTITY.md"), [
    "# Principal Identity - Jordan",
    "",
    "## Quick Reference",
    "",
    "- **Name:** Jordan",
    "- **Pronunciation:** JOR-dan",
    "- **Timezone:** America/Los_Angeles",
    "",
  ].join("\n"));

  const identity = await import("../../hooks/lib/identity");
  identity.clearCache();

  const da = identity.getIdentity();
  check(
    "Codex identity falls back to shared USER markdown",
    da.name === "Astra" &&
      da.fullName === "Astra Prime" &&
      da.displayName === "Astra" &&
      da.color === "#10B981" &&
      da.mainDAVoiceID === "main-voice-id",
    JSON.stringify(da),
  );

  const principal = identity.getPrincipal();
  check(
    "Codex principal falls back to shared USER markdown",
      principal.name === "Jordan" &&
      principal.pronunciation === "JOR-dan" &&
      principal.timezone === "America/Los_Angeles",
    JSON.stringify(principal),
  );

  const algorithmVoice = identity.getAlgorithmVoice();
  check(
    "Algorithm voice falls back to shared DA identity",
    algorithmVoice?.voiceId === "algorithm-voice-id" &&
      algorithmVoice.voiceName === "Ada" &&
      algorithmVoice.useSpeakerBoost === true,
    JSON.stringify(algorithmVoice),
  );

  write(process.env.PAI_SETTINGS_PATH, JSON.stringify({
    daidentity: {
      name: "SettingsDA",
      fullName: "Settings DA",
      displayName: "Settings",
      color: "#EF4444",
      voices: {
        main: { voiceId: "settings-main", stability: 0.7, similarityBoost: 0.8, style: 0.1, speed: 1, useSpeakerBoost: true },
        algorithm: { voiceId: "settings-algorithm", voiceName: "Settings Algorithm", stability: 0.6, similarityBoost: 0.7, style: 0.2, speed: 1, useSpeakerBoost: false },
      },
    },
    principal: {
      name: "SettingsPrincipal",
      pronunciation: "settings-principal",
      timezone: "UTC",
    },
  }, null, 2));

  identity.clearCache();
  const settingsDa = identity.getIdentity();
  const settingsPrincipal = identity.getPrincipal();
  const settingsAlgorithmVoice = identity.getAlgorithmVoice();
  check(
    "Explicit settings identity overrides shared markdown",
    settingsDa.name === "SettingsDA" &&
      settingsDa.mainDAVoiceID === "settings-main" &&
      settingsPrincipal.name === "SettingsPrincipal" &&
      settingsAlgorithmVoice?.voiceId === "settings-algorithm",
    JSON.stringify({ settingsDa, settingsPrincipal, settingsAlgorithmVoice }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nIdentity provider fallback smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log(`\nIdentity provider fallback smoke passed: ${checks.length} check(s).`);
