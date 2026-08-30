#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function assert(name: string, condition: boolean, detail = ""): void {
  if (!condition) {
    throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  }
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
}

const tempRoot = mkdtempSync(join(tmpdir(), "pai-codex-install-smoke-"));
let keepTemp = false;
let installOutput = "";

function installerTail(): string {
  return installOutput.split(/\r?\n/).slice(-120).join("\n");
}

function decodePowerShellCommands(text: string): string {
  return text.replace(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/g, (_match, encoded) => {
    try {
      return Buffer.from(String(encoded), "base64").toString("utf16le");
    } catch {
      return "";
    }
  });
}

try {
  const codexHome = join(tempRoot, ".codex");
  const paiData = join(tempRoot, ".pai");
  const paiConfig = join(tempRoot, ".config", "PAI");
  const profilePath = join(tempRoot, "profile.ps1");
  const shellProfilePath = process.platform === "win32" ? profilePath : join(tempRoot, ".zshrc");
  const junctionTarget = join(tempRoot, "junction-target");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(junctionTarget, { recursive: true });

  writeFileSync(join(codexHome, "config.toml"), `model = "seed-model"

[model_providers.keepme]
name = "KeepMe"
base_url = "http://127.0.0.1:9999"

[profiles.keepme]
model = "keepme-model"
model_provider = "keepme"

[plugins."browser@openai-bundled"]
enabled = true
`);

  symlinkSync(junctionTarget, join(codexHome, "commands"), "junction");

  const installerDir = resolve(import.meta.dir, "..", "PAI-Install");
  const bundleDir = resolve(import.meta.dir, "..", "..");
  const mainTs = join(installerDir, "main.ts");
  const result = spawnSync(process.execPath, ["run", mainTs, "--mode", "cli"], {
    cwd: installerDir,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
    windowsHide: true,
    env: {
      ...process.env,
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      SHELL: "",
      CODEX_HOME: codexHome,
      PAI_DATA_DIR: paiData,
      PAI_CONFIG_DIR: paiConfig,
      PAI_BUNDLE_DIR: bundleDir,
      PAI_POWERSHELL_PROFILE: profilePath,
      PAI_SHELL_PROFILE: shellProfilePath,
      PAI_FRAMEWORK: "codex",
      PAI_USER_ENV_TARGET: "Process",
      PAI_TEST_AUTOMATED: "1",
      PAI_SKIP_PULSE_INSTALL: "1",
    },
  });

  if (result.status !== 0) {
    keepTemp = true;
    installOutput = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(`installer exited status=${result.status} signal=${result.signal ?? ""} error=${result.error?.message ?? ""}; temp=${tempRoot}\n${installerTail()}`);
  }
  installOutput = `${result.stdout || ""}\n${result.stderr || ""}`.trim();

  const config = readFileSync(join(codexHome, "config.toml"), "utf-8");
  if (!existsSync(shellProfilePath)) {
    throw new Error(`Shell profile was not written at ${shellProfilePath}; temp=${tempRoot}\n${installerTail()}`);
  }
  const profile = readFileSync(shellProfilePath, "utf-8");
  const backupExists = readdirSync(tempRoot, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && entry.name.startsWith(".codex.backup-"));

  assert("Codex managed block", config.includes("PAI MANAGED ROOT CONFIG"));
  assert("Codex RTK doc configured", config.includes('project_doc_fallback_filenames = ["AGENTS.md", "RTK.md", "CLAUDE.md"]'));
  assert("Codex RTK doc installed", existsSync(join(codexHome, "RTK.md")));
  assert("Codex profile preserved", config.includes("[profiles.keepme]"));
  assert("Codex provider preserved", config.includes("[model_providers.keepme]"));
  assert("Codex plugin preserved", config.includes("[plugins.\"browser@openai-bundled\"]"));
  assert("Shell k alias", profile.includes("function k") || profile.includes("alias k"));
  assert("Shell pai alias", profile.includes("function pai") || profile.includes("alias pai"));
  assert("Windows user env repaired", process.platform !== "win32" || installOutput.includes("Windows user environment updated"));
  assert("Backup created", backupExists);
  assert("Pulse Windows manager installed", existsSync(join(codexHome, "PAI", "PULSE", "manage.ps1")));
  assert("Pulse Assistant module installed", existsSync(join(codexHome, "PAI", "PULSE", "Assistant", "module.ts")));
  assert("Pulse Assistant checks installed", existsSync(join(codexHome, "PAI", "PULSE", "Assistant", "checks", "tasks.ts")));
  assert("Memory delete tool installed", existsSync(join(codexHome, "PAI", "TOOLS", "MemoryDelete.ts")));
  assert("Shared security patterns installed", existsSync(join(paiData, "USER", "SECURITY", "PATTERNS.yaml")));
  assert("Codex agents generated", existsSync(join(codexHome, "agents")));
  assert("Codex hooks generated", existsSync(join(codexHome, "hooks.json")));
  const interviewPromptPath = join(codexHome, "prompts", "interview.md");
  assert("Codex interview prompt generated", existsSync(interviewPromptPath));
  const interviewPrompt = readFileSync(interviewPromptPath, "utf-8");
  assert("Codex interview prompt invokes skill", interviewPrompt.includes("$Interview") && !interviewPrompt.includes('Skill("'));
  const hooks = readFileSync(join(codexHome, "hooks.json"), "utf-8");
  const decodedHooks = decodePowerShellCommands(hooks);
  assert("Codex PromptProcessing hook", hooks.includes("PromptProcessing.hook.ts"));
  assert("Codex PromptProcessing timeout headroom", hooks.includes('"timeout": 40') && decodedHooks.includes("--timeout-ms") && decodedHooks.includes("35000"));
  assert("Codex hooks avoid encoded PowerShell", process.platform !== "win32" || (!hooks.includes("-EncodedCommand") && !hooks.includes("powershell.exe") && decodedHooks.includes("bun.exe") && decodedHooks.includes("FrameworkHookAdapter.ts")));
  assert("Codex satisfaction capture hook", hooks.includes("SatisfactionCapture.hook.ts"));
  assert("Codex satisfaction capture timeout", hooks.includes('"timeout": 10') && decodedHooks.includes("SatisfactionCapture.hook.ts") && decodedHooks.includes("5000"));
  assert("Codex RTK rewrite hook", hooks.includes("RtkPreToolUse.hook.js"));
  assert("Codex question tab hook", hooks.includes("SetQuestionTab.hook.ts"));
  assert("Codex agent invocation hook", hooks.includes("AgentInvocation.hook.ts"));
  assert("Codex StartupSelfCheck hook", hooks.includes("StartupSelfCheck.hook.ts"));
  assert("Codex KVSync hook", hooks.includes("KVSync.hook.ts"));
} catch (err) {
  keepTemp = true;
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  if (!keepTemp) {
    const resolved = resolve(tempRoot);
    const tempBase = resolve(tmpdir());
    if (dirname(resolved) === tempBase && resolved.includes("pai-codex-install-smoke-")) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}
