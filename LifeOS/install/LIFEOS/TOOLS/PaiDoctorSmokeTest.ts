#!/usr/bin/env bun
/**
 * PaiDoctorSmokeTest
 *
 * Source-level guards for provider-native doctor wiring.
 * Runtime doctor checks talk to live Pulse. Expensive provider probes are
 * opt-in, so branch CI keeps the parity contract focused and deterministic.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const doctor = readFileSync(join(import.meta.dir, "PaiDoctor.ts"), "utf-8");
const checks: Check[] = [];

function check(name: string, passed: boolean, detail = ""): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

check(
  "doctor resolves active framework",
  doctor.includes("function activeFrameworkFrom") &&
    doctor.includes("normalizeFramework(process.env.PAI_FRAMEWORK)") &&
    doctor.includes("const activeFramework = activeFrameworkFrom(frameworkState)"),
  "framework.json/env selection",
);

check(
  "doctor does not force Codex into child smoke tools",
  !doctor.includes('PAI_FRAMEWORK: "codex"') &&
    doctor.includes("PAI_FRAMEWORK: framework"),
  "runBunTool uses selected framework",
);

check(
  "doctor has Claude-native checks",
  doctor.includes('framework === "claude"') &&
    doctor.includes("Claude settings.json exists") &&
    doctor.includes("Claude hooks invoke FrameworkHookAdapter") &&
    doctor.includes('return framework === "claude" ? "CLAUDE.md" : "AGENTS.md"'),
  "settings.json/CLAUDE.md path",
);

check(
  "doctor has Codex-native checks",
  doctor.includes('framework === "codex"') &&
    doctor.includes("Codex config.toml has PAI root block") &&
    doctor.includes("Codex hooks.json has runnable hook commands") &&
    doctor.includes("Codex hooks.json carries PAI_DATA_DIR") &&
    doctor.includes("Codex Windows hooks invoke quoted bun.exe"),
  "config.toml/hooks.json",
);

check(
  "doctor has OpenCode-native checks",
  doctor.includes('framework === "opencode"') &&
    doctor.includes("OpenCode opencode.json exists") &&
    doctor.includes("OpenCode plugin includes SessionEndDispatcher") &&
    doctor.includes("OpenCodeFrameworkAgentExecutionSmokeTest.ts"),
  "opencode.json/plugin",
);

check(
  "doctor default skips child smoke tools",
  doctor.includes('type DoctorMode = "safe" | "smoke" | "deep"') &&
    doctor.includes('if (mode === "safe") return []') &&
    doctor.includes("safe default: pass --smoke"),
  "AV-safe default mode",
);

check(
  "doctor smoke mode is static",
  doctor.includes('if (mode === "smoke") return staticShared') &&
    doctor.includes("PaiDoctorSmokeTest.ts") &&
    doctor.includes("CodexNativeRuntimeSmokeTest.ts"),
  "--smoke static source checks",
);

check(
  "doctor deep mode keeps provider probes opt-in",
  doctor.includes("CodexRealSessionHookProof.ts") &&
    doctor.includes("HotfixUpdateRollbackSmokeTest.ts") &&
    doctor.includes("CodexFreshInstallSmokeTest.ts") &&
    doctor.includes('name === "CodexHookContractSmokeTest.ts"') &&
    doctor.includes('args.push("--dynamic")'),
  "--deep child/session/install probes",
);

check(
  "doctor hides Windows smoke child windows",
  doctor.includes("windowsHide: true"),
  "spawnSync options",
);

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nPaiDoctor smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log("\nAll PaiDoctor smoke checks passed.");
