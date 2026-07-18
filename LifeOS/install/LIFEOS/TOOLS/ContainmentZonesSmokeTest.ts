#!/usr/bin/env bun
/**
 * ContainmentZonesSmokeTest
 *
 * Provider-native containment regression test. The release guard and shadow
 * release tooling use hooks/lib/containment-zones.ts as the source of truth, so
 * Codex/OpenCode config and auth files must resolve under the protected zone on
 * Windows paths as well as slash-normalized paths.
 */

import {
  CONTAINMENT_ZONES,
  isContained,
  isContainedInFrameworkRoot,
  isPatternAllowlisted,
  isUnderFrameworkRoot,
  relativeToClaudeRoot,
  relativeToFrameworkRoot,
} from "../../hooks/lib/containment-zones";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const checks: Check[] = [];
const codexRoot = "C:/Users/example/.codex";
const codexRootWindows = "C:\\Users\\example\\.codex";
const providerConfigFiles = [
  "settings.json",
  "settings.local.json",
  "config.toml",
  "hooks.json",
  "opencode.json",
  "auth.json",
];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

const configZone = CONTAINMENT_ZONES.find((zone) => zone.name === "config-secrets");
check(
  "config-secrets zone contains provider-native config",
  Boolean(configZone) && providerConfigFiles.every((file) => configZone.patterns.includes(file)),
  configZone ? configZone.patterns.join(", ") : "missing config-secrets zone",
);

for (const file of providerConfigFiles) {
  check(
    `${file} is contained under framework root`,
    isContainedInFrameworkRoot(`${codexRoot}/${file}`, codexRoot),
    `${codexRoot}/${file}`,
  );
}

check(
  "Windows backslash config path is contained",
  isContainedInFrameworkRoot(`${codexRootWindows}\\config.toml`, codexRootWindows),
  `${codexRootWindows}\\config.toml`,
);

check(
  "Windows backslash auth path is contained",
  isContainedInFrameworkRoot(`${codexRootWindows}\\auth.json`, codexRootWindows),
  `${codexRootWindows}\\auth.json`,
);

check(
  "relative framework root normalizes Windows separators",
  relativeToFrameworkRoot(`${codexRootWindows}\\hooks.json`, codexRootWindows) === "hooks.json",
  relativeToFrameworkRoot(`${codexRootWindows}\\hooks.json`, codexRootWindows),
);

check(
  "legacy Claude aliases remain compatible",
  relativeToClaudeRoot(`${codexRoot}/config.toml`, codexRoot) === "config.toml" &&
    isContained(`${codexRoot}/config.toml`, codexRoot),
  "relativeToClaudeRoot/isContained aliases",
);

check(
  "framework root containment is bounded",
  isUnderFrameworkRoot(`${codexRoot}/PAI/USER/PRINCIPAL_IDENTITY.md`, codexRoot) &&
    !isUnderFrameworkRoot("C:/Users/example/project/README.md", codexRoot),
  "inside root accepted; sibling project rejected",
);

check(
  "ordinary public files stay outside containment",
  !isContainedInFrameworkRoot(`${codexRoot}/README.md`, codexRoot),
  `${codexRoot}/README.md`,
);

check(
  "USER and MEMORY zones stay contained",
  isContainedInFrameworkRoot(`${codexRoot}/PAI/USER/PRINCIPAL_IDENTITY.md`, codexRoot) &&
    isContainedInFrameworkRoot(`${codexRoot}/PAI/MEMORY/WORK/session.md`, codexRoot),
  "PAI/USER and PAI/MEMORY",
);

check(
  "pattern allowlist remains exact relative paths",
  isPatternAllowlisted("hooks/lib/containment-zones.ts") &&
    !isPatternAllowlisted(`${codexRoot}/hooks/lib/containment-zones.ts`),
  "allowlist expects framework-relative paths",
);

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nContainment zone smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log(`\nContainment zone smoke passed: ${checks.length} check(s).`);
