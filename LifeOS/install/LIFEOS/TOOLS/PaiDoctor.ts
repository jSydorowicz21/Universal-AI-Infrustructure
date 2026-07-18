#!/usr/bin/env bun
/**
 * PaiDoctor
 *
 * Runtime confidence check for a live PAI install.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getConfigDir, getFrameworkDir, getPaiDataDir, getPaiDir } from "./lib/paths";

type FrameworkId = "claude" | "codex" | "opencode";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
  critical?: boolean;
};

type DoctorMode = "safe" | "smoke" | "deep";

const frameworkRoot = getFrameworkDir();
const paiDir = getPaiDir();
const dataDir = getPaiDataDir();
const configDir = getConfigDir();
const toolsDir = import.meta.dir;

function ok(name: string, passed: boolean, detail: string, critical = true): Check {
  return { name, passed, detail, critical };
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function normalizeFramework(value: unknown): FrameworkId | null {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "claude" || normalized === "claudecode") return "claude";
  if (normalized === "codex" || normalized === "openai" || normalized === "openaicodex") return "codex";
  if (normalized === "opencode" || normalized === "open") return "opencode";
  return null;
}

function frameworkName(id: FrameworkId): string {
  if (id === "claude") return "Claude";
  if (id === "opencode") return "OpenCode";
  return "Codex";
}

function decodeEncodedCommand(command: string): string {
  const match = command.match(/(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/=]+)/i);
  if (!match) return "";
  try {
    return Buffer.from(match[1], "base64").toString("utf16le");
  } catch {
    return "";
  }
}

function collectHookCommandTexts(config: any): string[] {
  const hooks = config?.hooks;
  if (!hooks || typeof hooks !== "object") return [];

  const texts: string[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hookList = group?.hooks;
      if (!Array.isArray(hookList)) continue;
      for (const hook of hookList) {
        for (const value of [hook?.command, hook?.commandWindows]) {
          if (typeof value !== "string" || !value) continue;
          texts.push(value);
          const decoded = decodeEncodedCommand(value);
          if (decoded) texts.push(decoded);
        }
      }
    }
  }
  return texts;
}

function windowsDirectBunHookCommandsUseCallOperator(text: string): boolean {
  const commands = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /FrameworkHookAdapter\.ts/i.test(value) && /bun\.exe/i.test(value));
  return commands.length > 0 && commands.every((value) =>
    /^(?:\$env:[A-Z0-9_]+\s*=\s*'(?:[^']|'')*';\s*)*&\s+"[^"]*bun\.exe"/i.test(value)
  );
}

function hasAgentsInstruction(value: unknown): boolean {
  return value === "AGENTS.md" || (Array.isArray(value) && value.includes("AGENTS.md"));
}

function timeoutForTool(name: string): number {
  if (name === "CodexRealSessionHookProof.ts") return 300_000;
  if (name === "HotfixUpdateRollbackSmokeTest.ts") return 180_000;
  if (name === "CodexFreshInstallSmokeTest.ts") return 120_000;
  if (name === "OpenCodeFrameworkAgentExecutionSmokeTest.ts") return 120_000;
  return 60_000;
}

function doctorModeFromArgs(args: string[]): DoctorMode {
  if (args.includes("--deep") || args.includes("--dynamic") || process.env.PAI_DOCTOR_DEEP === "1") return "deep";
  if (args.includes("--smoke") || process.env.PAI_DOCTOR_SMOKE === "1") return "smoke";
  return "safe";
}

function runBunTool(name: string, framework: FrameworkId, mode: DoctorMode): Check {
  const path = join(toolsDir, name);
  const args = [path];
  if (mode === "deep" && (name === "CodexHookContractSmokeTest.ts" || name === "StartupSelfCheckSmokeTest.ts")) {
    args.push("--dynamic");
  }
  const res = spawnSync(process.execPath, args, {
    encoding: "utf-8",
    timeout: timeoutForTool(name),
    windowsHide: true,
    env: {
      ...process.env,
      PAI_DIR: paiDir,
      PAI_DATA_DIR: dataDir,
      PAI_FRAMEWORK: framework,
      PAI_FRAMEWORK_DIR: frameworkRoot,
      PAI_SETTINGS_PATH: join(frameworkRoot, "settings.json"),
      PAI_CONFIG_DIR: configDir,
    },
  });
  const output = `${res.stdout || ""}${res.stderr || ""}`.trim().split("\n").slice(-3).join(" | ");
  return ok(name.replace(/\.ts$/, ""), res.status === 0, output || `status=${res.status ?? "null"}`);
}

async function pulseCheck(path: string, init?: RequestInit): Promise<Check> {
  try {
    const res = await fetch(`http://localhost:31337${path}`, {
      ...init,
      signal: AbortSignal.timeout(3000),
    });
    return ok(`Pulse ${path}`, res.ok, `HTTP ${res.status}`);
  } catch (err) {
    return ok(`Pulse ${path}`, false, err instanceof Error ? err.message : String(err));
  }
}

function systemdPulseChecks(): Check[] {
  if (process.platform === "darwin" || process.platform === "win32") return [];
  const status = spawnSync("systemctl", ["--user", "is-active", "com.pai.pulse.service"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
  const enabled = spawnSync("systemctl", ["--user", "is-enabled", "com.pai.pulse.service"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
  return [
    ok("Pulse systemd service active", status.status === 0, (status.stdout || status.stderr || "").trim() || `status=${status.status}`),
    ok("Pulse systemd service enabled", enabled.status === 0, (enabled.stdout || enabled.stderr || "").trim() || `status=${enabled.status}`),
  ];
}

function optionalSecretChecks(): Check[] {
  const envFiles = [join(frameworkRoot, ".env"), join(dataDir, "USER", "Config", "PAI_CONFIG.yaml")];
  const envText = envFiles.filter(existsSync).map((path) => readFileSync(path, "utf-8")).join("\n");
  return [
    ok("Optional ElevenLabs key configured", /ELEVENLABS_API_KEY\s*=\s*[^#\s]+/.test(envText) || Boolean(process.env.ELEVENLABS_API_KEY), "needed for actual TTS audio", false),
    ok("Optional Telegram bot configured", /TELEGRAM_BOT_TOKEN\s*=\s*[^#\s]+/.test(envText) || Boolean(process.env.TELEGRAM_BOT_TOKEN), "needed for Telegram chat/alerts", false),
    ok("Optional Bright Data token configured", Boolean(process.env.API_TOKEN), "needed for Bright Data MCP", false),
    ok("Optional Apify token configured", Boolean(process.env.APIFY_TOKEN), "needed for Apify MCP", false),
  ];
}

function frameworkSmokeTools(framework: FrameworkId, mode: DoctorMode): string[] {
  if (mode === "safe") return [];

  const staticShared = [
    "PaiDoctorSmokeTest.ts",
    "StartupSelfCheckSmokeTest.ts",
    "PaiSecurityAuditSmokeTest.ts",
    "TranscriptParserSmokeTest.ts",
    "ChangeDetectionSmokeTest.ts",
    "CodexNativeRuntimeSmokeTest.ts",
  ];

  if (mode === "smoke") return staticShared;

  const shared = [
    "HookSharedPathSmokeTest.ts",
    "PaiSecurityAuditSmokeTest.ts",
    "StartupSelfCheckSmokeTest.ts",
    "RepeatDetectionSmokeTest.ts",
    "TranscriptParserSmokeTest.ts",
    "ChangeDetectionSmokeTest.ts",
    "FrameworkCommandResolutionSmokeTest.ts",
    "FrameworkLaunchCwdSmokeTest.ts",
    "MemoryDeleteSmokeTest.ts",
  ];

  if (framework === "codex") {
    return [
      "CodexPaiSecuritySmokeTest.ts",
      ...shared,
      "CodexFrameworkAgentExecutionSmokeTest.ts",
      "CodexHookTriggerSmokeTest.ts",
      "CodexHookContractSmokeTest.ts",
      "CodexRealSessionHookProof.ts",
      "HotfixUpdateRollbackSmokeTest.ts",
      "CodexFreshInstallSmokeTest.ts",
    ];
  }

  if (framework === "opencode") {
    return [
      ...shared,
      "OpenCodeFrameworkAgentExecutionSmokeTest.ts",
    ];
  }

  return shared;
}

function doctorModeCheck(mode: DoctorMode): Check {
  if (mode === "deep") {
    return ok("Doctor mode", true, "--deep: child/session/install probes enabled", false);
  }
  if (mode === "smoke") {
    return ok("Doctor mode", true, "--smoke: static source smoke checks enabled", false);
  }
  return ok("Doctor mode", true, "safe default: pass --smoke for static smoke checks or --deep for child/session/install probes", false);
}

function activeFrameworkFrom(frameworkState: any): FrameworkId {
  return normalizeFramework(frameworkState?.active)
    || normalizeFramework(frameworkState?.framework)
    || normalizeFramework(process.env.PAI_FRAMEWORK)
    || "claude";
}

function instructionFilename(framework: FrameworkId): string {
  return framework === "claude" ? "CLAUDE.md" : "AGENTS.md";
}

function interviewCommandPath(framework: FrameworkId): string {
  return framework === "codex"
    ? join(frameworkRoot, "prompts", "interview.md")
    : join(frameworkRoot, "commands", "interview.md");
}

function frameworkSpecificChecks(framework: FrameworkId): Check[] {
  const name = frameworkName(framework);
  const checks: Check[] = [];

  if (framework === "claude") {
    const settingsPath = join(frameworkRoot, "settings.json");
    const settings = readJson(settingsPath);
    const hookText = collectHookCommandTexts(settings).join("\n");
    checks.push(
      ok("Claude settings.json exists", existsSync(settingsPath), settingsPath),
      ok("Claude settings carry PAI_DATA_DIR", settings?.env?.PAI_DATA_DIR === dataDir || Boolean(settings?.env?.PAI_DATA_DIR), settingsPath),
      ok("Claude hooks configured", Boolean(settings?.hooks && typeof settings.hooks === "object"), settingsPath),
      ok("Claude hooks invoke FrameworkHookAdapter", hookText.includes("FrameworkHookAdapter.ts"), settingsPath),
      ok("Claude hooks include StartupSelfCheck", hookText.includes("StartupSelfCheck.hook.ts"), settingsPath),
      ok("Claude hooks directory exists", existsSync(join(frameworkRoot, "hooks")), join(frameworkRoot, "hooks")),
    );
  }

  if (framework === "codex") {
    const configToml = readText(join(frameworkRoot, "config.toml"));
    const hooksJsonPath = join(frameworkRoot, "hooks.json");
    const hooksConfig = readJson(hooksJsonPath);
    const hookText = collectHookCommandTexts(hooksConfig).join("\n");
    const hasAdapterInvocation = hookText.includes("FrameworkHookAdapter.ts");
    checks.push(
      ok("Codex config.toml has PAI root block", configToml.includes("BEGIN PAI MANAGED ROOT CONFIG"), join(frameworkRoot, "config.toml")),
      ok("Codex config.toml has MCP block", configToml.includes("BEGIN PAI MANAGED MCP CONFIG"), join(frameworkRoot, "config.toml")),
      ok("Codex hooks.json has runnable hook commands", collectHookCommandTexts(hooksConfig).length > 0 && hasAdapterInvocation, hooksJsonPath),
      ok("Codex hooks.json avoids legacy CodexHookRunner", !hookText.includes("CodexHookRunner.cmd"), hooksJsonPath),
      ok("Codex hooks.json carries PAI_DATA_DIR", hookText.includes("PAI_DATA_DIR"), hooksJsonPath),
      ok("Codex Windows hooks invoke quoted bun.exe", process.platform !== "win32" || windowsDirectBunHookCommandsUseCallOperator(hookText), hooksJsonPath),
      ok("Codex hooks.json has StartupSelfCheck", hookText.includes("StartupSelfCheck.hook.ts"), hooksJsonPath),
    );
  }

  if (framework === "opencode") {
    const configPath = join(frameworkRoot, "opencode.json");
    const config = readJson(configPath);
    const pluginPath = join(frameworkRoot, "plugins", "pai-opencode.ts");
    const pluginText = readText(pluginPath);
    checks.push(
      ok("OpenCode opencode.json exists", existsSync(configPath), configPath),
      ok("OpenCode config keeps AGENTS instructions", hasAgentsInstruction(config?.instructions), configPath),
      ok("OpenCode plugin exists", existsSync(pluginPath), pluginPath),
      ok("OpenCode plugin includes StartupSelfCheck", pluginText.includes("StartupSelfCheck.hook.ts"), pluginPath),
      ok("OpenCode plugin includes SessionEndDispatcher", pluginText.includes("SessionEndDispatcher.hook.ts"), pluginPath),
      ok("OpenCode plugin includes KVSync", pluginText.includes("KVSync.hook.ts"), pluginPath),
    );
  }

  const skillPath = join(frameworkRoot, "skills", "Interview", "SKILL.md");
  const commandPath = interviewCommandPath(framework);
  const commandText = readText(commandPath);
  checks.push(
    ok(`${name} Interview skill installed`, existsSync(skillPath), skillPath),
    ok(`${name} Interview command installed`, existsSync(commandPath), commandPath, false),
    ok(`${name} Interview command references skill`, commandText.includes("$Interview") || commandText.includes('Skill("Interview")'), commandPath, false),
  );

  return checks;
}

async function main() {
  const doctorMode = doctorModeFromArgs(process.argv.slice(2));
  const frameworkState = readJson(join(dataDir, "framework.json"));
  const activeFramework = activeFrameworkFrom(frameworkState);
  const activeName = frameworkName(activeFramework);
  const stateFramework = normalizeFramework(frameworkState?.active) || normalizeFramework(frameworkState?.framework);
  const instructionFile = instructionFilename(activeFramework);
  const mcpDir = join(frameworkRoot, "MCPs");

  const checks: Check[] = [
    doctorModeCheck(doctorMode),
    ok(`Active framework is ${activeName}`, stateFramework === activeFramework, join(dataDir, "framework.json"), false),
    ok(`${activeName} root exists`, existsSync(frameworkRoot), frameworkRoot),
    ok(`${instructionFile} exists`, existsSync(join(frameworkRoot, instructionFile)), join(frameworkRoot, instructionFile)),
    ok("RTK.md exists", existsSync(join(frameworkRoot, "RTK.md")), join(frameworkRoot, "RTK.md")),
    ...frameworkSpecificChecks(activeFramework),
    ok("MCP profiles present", existsSync(mcpDir) && readdirSync(mcpDir).some((file) => file.endsWith(".mcp.json")), mcpDir),
    ok("Shared PAI data exists", existsSync(dataDir), dataDir),
    ...systemdPulseChecks(),
    await pulseCheck("/health"),
    await pulseCheck("/voice/health"),
    await pulseCheck("/assistant/health"),
    await pulseCheck("/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "PAI doctor check", voice_enabled: false }),
    }),
    ...frameworkSmokeTools(activeFramework, doctorMode).map((tool) => runBunTool(tool, activeFramework, doctorMode)),
    ...optionalSecretChecks(),
  ];

  let failedCritical = 0;
  let warnings = 0;
  for (const check of checks) {
    const marker = check.passed ? "PASS" : check.critical === false ? "WARN" : "FAIL";
    console.log(`${marker} ${check.name} - ${check.detail}`);
    if (!check.passed && check.critical === false) warnings++;
    else if (!check.passed) failedCritical++;
  }

  console.log("");
  if (failedCritical > 0) {
    console.error(`PAI doctor failed: ${failedCritical} critical check(s), ${warnings} warning(s).`);
    process.exit(1);
  }
  console.log(`PAI doctor passed: ${checks.length - warnings} critical check(s), ${warnings} optional reminder(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
