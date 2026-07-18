#!/usr/bin/env bun
/**
 * CodexNativeRuntimeSmokeTest
 *
 * Source-level regression checks for the product-critical native Codex paths:
 * Algorithm execution, Pulse AI jobs, Pulse chat modules, and Pulse static build.
 *
 * These are wiring/source-string guards only — they confirm the launchers are
 * shaped correctly but do NOT execute anything. The end-to-end runtime proof
 * (that runFrameworkAgent() and inference() actually spawn `codex exec` with the
 * contracted sandbox/flags/stdin) lives in CodexFrameworkAgentExecutionSmokeTest.ts.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const releaseRoot = resolve(import.meta.dir, "..", "..");
const paiRoot = join(releaseRoot, "PAI");
const checks: Check[] = [];

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

function check(name: string, passed: boolean, detail = ""): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

function walkTextFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "cache"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTextFiles(path, acc);
    else if (/\.(ts|tsx|js|html|txt|json|md|css)$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

const frameworkAgent = read(join(paiRoot, "TOOLS", "lib", "framework-agent.ts"));
const canonicalAgentCommandSources = [
  ...walkTextFiles(join(releaseRoot, "agents")),
  ...walkTextFiles(join(releaseRoot, "commands")),
].map((file) => `${file}\n${read(file)}`).join("\n\n");
const algorithm = read(join(paiRoot, "TOOLS", "algorithm.ts"));
const paiCli = read(join(paiRoot, "TOOLS", "pai.ts"));
const limitlessCli = read(join(paiRoot, "bin", "llcli", "llcli.ts"));
const limitlessCliSmoke = read(join(paiRoot, "TOOLS", "LimitlessCliConfigSmokeTest.ts"));
const configGen = read(join(paiRoot, "PAI-Install", "engine", "config-gen.ts"));
const installMain = read(join(paiRoot, "PAI-Install", "main.ts"));
const installActions = read(join(paiRoot, "PAI-Install", "engine", "actions.ts"));
const installerProviderEnvSmoke = read(join(paiRoot, "TOOLS", "InstallerProviderEnvSmokeTest.ts"));
const installDetect = read(join(paiRoot, "PAI-Install", "engine", "detect.ts"));
const installValidate = read(join(paiRoot, "PAI-Install", "engine", "validate.ts"));
const inferenceTool = read(join(paiRoot, "TOOLS", "Inference.ts"));
const integrityMaintenance = read(join(paiRoot, "TOOLS", "IntegrityMaintenance.ts"));
const integrityMaintenanceTranscriptSmoke = read(join(paiRoot, "TOOLS", "IntegrityMaintenanceTranscriptSmokeTest.ts"));
const transcriptParser = read(join(paiRoot, "TOOLS", "TranscriptParser.ts"));
const transcriptRoots = read(join(paiRoot, "TOOLS", "lib", "transcripts.ts"));
const providerTranscriptConsumersSmoke = read(join(paiRoot, "TOOLS", "ProviderTranscriptConsumersSmokeTest.ts"));
const identityProviderFallbackSmoke = read(join(paiRoot, "TOOLS", "IdentityProviderFallbackSmokeTest.ts"));
const failureCapture = read(join(paiRoot, "TOOLS", "FailureCapture.ts"));
const architectureSummaryGenerator = read(join(paiRoot, "TOOLS", "ArchitectureSummaryGenerator.ts"));
const costAggregator = read(join(paiRoot, "PULSE", "Performance", "cost-aggregator.ts"));
const costTracker = read(join(paiRoot, "TOOLS", "CostTracker.ts"));
const performanceModule = read(join(paiRoot, "PULSE", "Performance", "module.ts"));
const pulseHooks = read(join(paiRoot, "PULSE", "modules", "hooks.ts"));
const pulseObservability = read(join(paiRoot, "PULSE", "Observability", "observability.ts"));
const pulseSecurityPage = read(join(paiRoot, "PULSE", "Observability", "src", "app", "security", "page.tsx"));
const paiSystemPrompt = read(join(paiRoot, "PAI_SYSTEM_PROMPT.md"));
const releaseClaudeMd = read(join(releaseRoot, "CLAUDE.md"));
const removeBg = read(join(paiRoot, "TOOLS", "RemoveBg.ts"));
const forgeProgress = read(join(paiRoot, "TOOLS", "ForgeProgress.ts"));
const anvilProgress = read(join(paiRoot, "TOOLS", "AnvilProgress.ts"));
const crossVendorAudit = read(join(paiRoot, "TOOLS", "CrossVendorAudit.ts"));
const docCheck = read(join(paiRoot, "TOOLS", "DocCheck.ts"));
const gmailTool = read(join(paiRoot, "TOOLS", "gmail.ts"));
const referenceCheck = read(join(paiRoot, "TOOLS", "ReferenceCheck.ts"));
const secretScan = read(join(paiRoot, "TOOLS", "SecretScan.ts"));
const splitAndTranscribe = read(join(paiRoot, "TOOLS", "SplitAndTranscribe.ts"));
const compactSkillDescriptions = read(join(paiRoot, "TOOLS", "CompactSkillDescriptions.ts"));
const frameworkDisplay = read(join(paiRoot, "TOOLS", "lib", "framework-display.ts"));
const bannerCounts = read(join(paiRoot, "TOOLS", "lib", "banner-counts.ts"));
const bannerProviderCountsSmoke = read(join(paiRoot, "TOOLS", "BannerProviderCountsSmokeTest.ts"));
const bannerSources = [
  "Banner.ts",
  "BannerNeofetch.ts",
  "BannerMatrix.ts",
  "BannerRetro.ts",
  "NeofetchBanner.ts",
].map((file) => read(join(paiRoot, "TOOLS", file))).join("\n");
const promptProcessing = read(join(releaseRoot, "hooks", "PromptProcessing.hook.ts"));
const satisfactionCapture = read(join(releaseRoot, "hooks", "SatisfactionCapture.hook.ts"));
const loadContext = read(join(releaseRoot, "hooks", "LoadContext.hook.ts"));
const loadContextSmoke = read(join(paiRoot, "TOOLS", "LoadContextSmokeTest.ts"));
const hookAdapter = read(join(releaseRoot, "hooks", "FrameworkHookAdapter.ts"));
const smartApprover = read(join(releaseRoot, "hooks", "SmartApprover.hook.ts"));
const checkpointPerIsc = read(join(releaseRoot, "hooks", "CheckpointPerISC.hook.ts"));
const rtkHook = read(join(releaseRoot, "hooks", "RtkPreToolUse.hook.js"));
const hookPathHelpers = read(join(releaseRoot, "hooks", "lib", "paths.ts"));
const identityLoader = read(join(releaseRoot, "hooks", "lib", "identity.ts"));
const toolPathHelpers = read(join(paiRoot, "TOOLS", "lib", "paths.ts"));
const toolActivityTracker = read(join(releaseRoot, "hooks", "ToolActivityTracker.hook.ts"));
const telosSummaryHook = read(join(releaseRoot, "hooks", "TelosSummarySync.hook.ts"));
const tabSetter = read(join(releaseRoot, "hooks", "lib", "tab-setter.ts"));
const isaUtils = read(join(releaseRoot, "hooks", "lib", "isa-utils.ts"));
const restoreContext = read(join(releaseRoot, "hooks", "RestoreContext.hook.ts"));
const relationshipMemory = read(join(releaseRoot, "hooks", "RelationshipMemory.hook.ts"));
const relationshipMemoryTranscriptSmoke = read(join(paiRoot, "TOOLS", "RelationshipMemoryTranscriptSmokeTest.ts"));
const patternInspector = read(join(releaseRoot, "hooks", "security", "inspectors", "PatternInspector.ts"));
const codexHookContractSmoke = read(join(paiRoot, "TOOLS", "CodexHookContractSmokeTest.ts"));
const codexFreshInstallSmoke = read(join(paiRoot, "TOOLS", "CodexFreshInstallSmokeTest.ts"));
const codexHookTriggerSmoke = read(join(paiRoot, "TOOLS", "CodexHookTriggerSmokeTest.ts"));
const codexRealSessionHookProof = read(join(paiRoot, "TOOLS", "CodexRealSessionHookProof.ts"));
const repeatDetectionSmoke = read(join(paiRoot, "TOOLS", "RepeatDetectionSmokeTest.ts"));
const startupSelfCheckSmoke = read(join(paiRoot, "TOOLS", "StartupSelfCheckSmokeTest.ts"));
const codexFrameworkExecutionSmoke = read(join(paiRoot, "TOOLS", "CodexFrameworkAgentExecutionSmokeTest.ts"));
const openCodeFrameworkExecutionSmoke = read(join(paiRoot, "TOOLS", "OpenCodeFrameworkAgentExecutionSmokeTest.ts"));
const sessionEndLifecycleSmoke = read(join(paiRoot, "TOOLS", "SessionEndLifecycleSmokeTest.ts"));
const installerCodexSmoke = read(join(paiRoot, "TOOLS", "InstallerCodexSmokeTest.ts"));
const frameworkLaunchCwdSmoke = read(join(paiRoot, "TOOLS", "FrameworkLaunchCwdSmokeTest.ts"));
const changeDetection = read(join(releaseRoot, "hooks", "lib", "change-detection.ts"));
const configAudit = read(join(releaseRoot, "hooks", "ConfigAudit.hook.ts"));
const docCrossRefIntegrity = read(join(releaseRoot, "hooks", "handlers", "DocCrossRefIntegrity.ts"));
const rebuildArchSummary = read(join(releaseRoot, "hooks", "handlers", "RebuildArchSummary.ts"));
const rebuildArchSummarySmoke = read(join(paiRoot, "TOOLS", "RebuildArchSummarySmokeTest.ts"));
const systemIntegrity = read(join(releaseRoot, "hooks", "handlers", "SystemIntegrity.ts"));
const updateCounts = read(join(releaseRoot, "hooks", "handlers", "UpdateCounts.ts"));
const getCountsTool = read(join(paiRoot, "TOOLS", "GetCounts.ts"));
const branchValidation = read(join(paiRoot, "TOOLS", "CodexBranchValidation.ts"));
const frameworkSmoke = read(join(paiRoot, "TOOLS", "FrameworkSmokeTest.ts"));
const frameworkCommandResolutionSmoke = read(join(paiRoot, "TOOLS", "FrameworkCommandResolutionSmokeTest.ts"));
const hotfixUpdateRollbackSmoke = read(join(paiRoot, "TOOLS", "HotfixUpdateRollbackSmokeTest.ts"));
const junctionSafeUpdateSmoke = read(join(paiRoot, "TOOLS", "JunctionSafeUpdateSmokeTest.ts"));
const memoryDeleteSmoke = read(join(paiRoot, "TOOLS", "MemoryDeleteSmokeTest.ts"));
const paiSecurityAuditSmoke = read(join(paiRoot, "TOOLS", "PaiSecurityAuditSmokeTest.ts"));
const updateInstalledPs1 = read(join(releaseRoot, "update-installed.ps1"));
const updateInstalledSh = read(join(releaseRoot, "update-installed.sh"));
const containmentZones = read(join(releaseRoot, "hooks", "lib", "containment-zones.ts"));
const containmentGuard = read(join(releaseRoot, "hooks", "ContainmentGuard.hook.ts"));
const containmentZonesSmoke = read(join(paiRoot, "TOOLS", "ContainmentZonesSmokeTest.ts"));
const checkpointTool = read(join(paiRoot, "TOOLS", "Checkpoint.ts"));
const opencodePlugin = read(join(releaseRoot, "plugins", "pai-opencode.ts"));
const pulseManage = read(join(paiRoot, "PULSE", "manage.ps1"));
const pulseLib = read(join(paiRoot, "PULSE", "lib.ts"));
const pulse = read(join(paiRoot, "PULSE", "pulse.ts"));
const githubWork = read(join(paiRoot, "PULSE", "checks", "github-work.ts"));
const telegram = read(join(paiRoot, "PULSE", "modules", "telegram.ts"));
const imessage = read(join(paiRoot, "PULSE", "modules", "imessage.ts"));
const pulseToml = read(join(paiRoot, "PULSE", "PULSE.toml"));
const pulsePackage = read(join(paiRoot, "PULSE", "package.json"));
const setup = read(join(paiRoot, "PULSE", "setup.ts"));
const nextConfig = read(join(paiRoot, "PULSE", "Observability", "next.config.ts"));
const claudeAgentSdkPackage = ["@anthropic-ai", "claude-agent-sdk"].join("/");

check(
  "framework agent launches Codex exec with workspace-write",
  frameworkAgent.includes('"codex"') &&
    frameworkAgent.includes('"exec"') &&
    frameworkAgent.includes('"--sandbox"') &&
    frameworkAgent.includes('"workspace-write"') &&
    frameworkAgent.indexOf('if (framework === "codex")') < frameworkAgent.indexOf('Bun.which("claude")'),
  "PAI/TOOLS/lib/framework-agent.ts (source shape; runtime: CodexFrameworkAgentExecutionSmokeTest)",
);

check(
  "Inference chooses Codex before Claude fallback",
  inferenceTool.includes('const framework = getActiveFramework()') &&
    inferenceTool.includes('const useOpenCode = framework === "opencode"') &&
    inferenceTool.includes('const useCodex = !useOpenCode && (framework === "codex"') &&
    inferenceTool.indexOf('if (useCodex)') < inferenceTool.indexOf("const claudePath"),
  "PAI/TOOLS/Inference.ts (source shape; runtime: CodexFrameworkAgentExecutionSmokeTest)",
);

check(
  "Codex fast classifier inference stays small and isolated",
  inferenceTool.includes('const CODEX_DEFAULT_CLASSIFIER_MODEL = "gpt-5.3-codex-spark"') &&
    inferenceTool.includes('if (level === "fast" && process.env.PAI_CODEX_MODEL_CLASSIFIER)') &&
    inferenceTool.includes('if (level === "fast")') &&
    inferenceTool.includes("return CODEX_DEFAULT_CLASSIFIER_MODEL") &&
    inferenceTool.includes("return process.env.PAI_CODEX_MODEL || CODEX_DEFAULT_MODEL") &&
    inferenceTool.includes('fast: "low"') &&
    inferenceTool.includes('"--ignore-user-config"') &&
    inferenceTool.includes('"--ignore-rules"') &&
    inferenceTool.includes('"--disable", "memories"') &&
    inferenceTool.includes('"--disable", "plugins"') &&
    inferenceTool.includes('"--sandbox", "read-only"') &&
    inferenceTool.includes('"-c", `model_reasoning_effort="${codexReasoning}"`') &&
    inferenceTool.includes('"-c", `plan_mode_reasoning_effort="${codexReasoning}"`'),
  "PAI/TOOLS/Inference.ts (runtime argv proof: CodexFrameworkAgentExecutionSmokeTest)",
);

check(
  "Prompt classifier reads bounded transcript context",
  promptProcessing.includes("DEFAULT_CLASSIFIER_CONTEXT_BYTES") &&
    promptProcessing.includes("PAI_PROMPT_CLASSIFIER_CONTEXT_BYTES") &&
    promptProcessing.includes("DEFAULT_CLASSIFIER_CONTEXT_TURNS") &&
    promptProcessing.includes("PAI_PROMPT_CLASSIFIER_CONTEXT_TURNS") &&
    promptProcessing.includes("readFileTail(transcriptPath, classifierContextBytes())") &&
    promptProcessing.includes("getRecentContext(data.transcript_path, classifierContextTurns(), !isFirstPrompt)") &&
    !promptProcessing.includes("const content = readFileSync(transcriptPath, 'utf-8');"),
  "hooks/PromptProcessing.hook.ts",
);

check(
  "PromptProcessing resolves provider-native session transcripts",
  promptProcessing.includes("findSessionJsonlInDir") &&
    promptProcessing.includes("join(frameworkDir, 'sessions')") &&
    promptProcessing.includes("data.transcript_path") &&
    !promptProcessing.includes("Bun.spawnSync(['find'"),
  "hooks/PromptProcessing.hook.ts",
);

check(
  "Algorithm uses framework agent launcher",
  algorithm.includes("buildFrameworkAgentCommand") &&
    !/spawnSync\(\s*["']claude["']/.test(algorithm) &&
    !/spawn\(\s*["']claude["']/.test(algorithm) &&
    !/Bun\.spawn\(\s*\[\s*["']claude["']/.test(algorithm) &&
    !algorithm.includes("--bare"),
  "loop, parallel, interactive, and ideate modes",
);

check(
  "Core PAI tools use Windows-aware home helper",
  algorithm.includes('import { homeDir, memoryPath } from "./lib/paths"') &&
    algorithm.includes("const HOME = homeDir()") &&
    !algorithm.includes('const HOME = process.env.HOME || "~"') &&
    costTracker.includes("homeDir, memoryPath") &&
    costTracker.includes("const HOME = homeDir()") &&
    !costTracker.includes("process.env.HOME ?? process.env.USERPROFILE") &&
    architectureSummaryGenerator.includes('import { getFrameworkDir, getPaiDir, homeDir } from "./lib/paths"') &&
    architectureSummaryGenerator.includes("const HOME = homeDir()") &&
    !architectureSummaryGenerator.includes('process.env.HOME || process.env.USERPROFILE || ""'),
  "PAI/TOOLS/algorithm.ts, CostTracker.ts, and ArchitectureSummaryGenerator.ts",
);

check(
  "CostTracker guards Codex subscription usage without dollarizing it",
  costTracker.includes("codex_usage: CodexUsageSnapshot") &&
    costTracker.includes('const SESSION_COSTS_PATH = memoryPath("OBSERVABILITY", "session-costs.jsonl")') &&
    costTracker.includes("function readCodexUsage()") &&
    costTracker.includes('row?.framework !== "codex"') &&
    costTracker.includes("PAI_CODEX_DAILY_TOKEN_ALERT") &&
    costTracker.includes("PAI_CODEX_SESSION_TOKEN_ALERT") &&
    costTracker.includes("Codex subscription usage") &&
    performanceModule.includes("codex_usage?:"),
  "PAI/TOOLS/CostTracker.ts and PAI/PULSE/Performance/module.ts",
);

check(
  "Pulse hook health reads Codex hooks.json",
  pulseHooks.includes('join(frameworkDir, "hooks.json")') &&
    pulseHooks.includes('collectHooksFromCodexJson') &&
    pulseHooks.includes('commandWindows || hook.command') &&
    pulseHooks.includes('missingHooks') &&
    pulseObservability.includes('const CODEX_HOOKS_PATH = join(FRAMEWORK_DIR, "hooks.json")') &&
    pulseObservability.includes("loadSecurityHookHealth()") &&
    pulseObservability.includes('commandWindows || hook.command') &&
    pulseSecurityPage.includes("settings.json") &&
    pulseSecurityPage.includes("hooks.json") &&
    !pulseSecurityPage.includes("~/.claude/settings.json"),
  "PAI/PULSE/modules/hooks.ts and Observability security API/UI",
);

check(
  "SmartApprover uses active framework home helper",
  hookPathHelpers.includes("export function homeDir()") &&
    smartApprover.includes("import { getFrameworkDir, homeDir, userPath } from './lib/paths'") &&
    smartApprover.includes("const HOME = homeDir()") &&
    !smartApprover.includes("from 'os'"),
  "hooks/SmartApprover.hook.ts and hooks/lib/paths.ts",
);

check(
  "Path helpers resolve provider home env without PAI_DIR",
  hookPathHelpers.includes("function activeFrameworkRootFromEnv") &&
    hookPathHelpers.includes("activeFrameworkRootFromEnv(state, true)") &&
    hookPathHelpers.includes("activeFrameworkRootFromEnv(state)") &&
    hookPathHelpers.includes("process.env.CODEX_HOME") &&
    hookPathHelpers.includes("process.env.OPENCODE_CONFIG_DIR") &&
    toolPathHelpers.includes("function activeFrameworkRootFromEnv") &&
    toolPathHelpers.includes("activeFrameworkRootFromEnv(state, true)") &&
    toolPathHelpers.includes("activeFrameworkRootFromEnv(state)") &&
    toolPathHelpers.includes("process.env.CODEX_HOME") &&
    toolPathHelpers.includes("process.env.OPENCODE_CONFIG_DIR") &&
    frameworkSmoke.includes("tools path uses provider home env without PAI_DIR") &&
    frameworkSmoke.includes("hooks path uses provider home env without PAI_DIR"),
  "hooks/lib/paths.ts, PAI/TOOLS/lib/paths.ts, and FrameworkSmokeTest.ts",
);

check(
  "Limitless CLI reads provider-neutral PAI config",
  limitlessCli.includes("getConfigDir, getEnvPath, getFrameworkDir, homeDir") &&
    limitlessCli.includes("export function configSearchPaths") &&
    limitlessCli.includes("process.env.LIMITLESS_API_KEY") &&
    limitlessCli.includes("join(getConfigDir(), '.env')") &&
    limitlessCli.includes("join(getFrameworkDir(), '.env')") &&
    limitlessCli.includes("if (import.meta.main)") &&
    !limitlessCli.includes("LIMITLESS_API_KEY not found in ~/.claude/.env") &&
    limitlessCliSmoke.includes("llcli reads shared PAI config env first") &&
    limitlessCliSmoke.includes("llcli falls back to active Codex framework env"),
  "PAI/bin/llcli/llcli.ts and LimitlessCliConfigSmokeTest.ts",
);

check(
  "LoadContext active-work reminders use provider PAI/TOOLS path",
  loadContext.includes("export async function checkActiveProgress") &&
    loadContext.includes("join(paiDir, 'TOOLS', 'SessionProgress.ts')") &&
    loadContext.includes("if (import.meta.main)") &&
    !loadContext.includes("paiDir + '/Tools'") &&
    loadContextSmoke.includes("SessionProgress reminder uses PAI/TOOLS path") &&
    loadContextSmoke.includes("SessionProgress reminder avoids legacy PAI/Tools path") &&
    loadContextSmoke.includes("SessionProgress reminder uses bun directly"),
  "hooks/LoadContext.hook.ts and LoadContextSmokeTest.ts",
);

check(
  "Checkpoint allowlists use active home and hidden git probes",
  checkpointPerIsc.includes("import { getFrameworkDir, homeDir } from './lib/paths'") &&
    checkpointPerIsc.includes("const HOME = homeDir()") &&
    !checkpointPerIsc.includes("from 'node:os'") &&
    checkpointPerIsc.includes("windowsHide: true") &&
    checkpointTool.includes("import { getFrameworkDir, homeDir, memoryPath } from './lib/paths'") &&
    checkpointTool.includes("const HOME = homeDir()") &&
    !checkpointTool.includes("from 'node:os'") &&
    checkpointTool.includes("windowsHide: true"),
  "hooks/CheckpointPerISC.hook.ts and PAI/TOOLS/Checkpoint.ts",
);

check(
  "Tool activity tracker hides git snapshots on Windows",
  toolActivityTracker.includes("CAPTURE_GIT_SNAPSHOT") &&
    toolActivityTracker.includes("windowsHide: true") &&
    (toolActivityTracker.match(/windowsHide:\s*true/g)?.length ?? 0) >= 2,
  "hooks/ToolActivityTracker.hook.ts",
);

check(
  "Pulse cron jobs use active AI launcher",
  pulseLib.includes("export async function spawnAI") &&
    pulseLib.includes("export const spawnClaude = spawnAI") &&
    pulse.includes("spawnAI") &&
    !pulse.includes("spawnClaude"),
  "legacy alias remains in lib only",
);

check(
  "Pulse worker uses framework agent launcher",
  githubWork.includes("runFrameworkAgent") &&
    !githubWork.includes('Bun.which("claude")') &&
    !githubWork.includes("claudePath") &&
    !githubWork.includes("claude --print"),
  "PAI/PULSE/checks/github-work.ts",
);

check(
  "Pulse chat modules route from active framework state",
    telegram.includes("await inference({") &&
    imessage.includes("await inference({") &&
    !telegram.includes(claudeAgentSdkPackage) &&
    !imessage.includes(claudeAgentSdkPackage) &&
    !pulsePackage.includes(claudeAgentSdkPackage),
  "Telegram and iMessage use PAI Inference, not Claude Agent SDK",
);

check(
  "PAI one-shot prompt uses Codex exec stdin",
  paiCli.includes('"exec", "--sandbox", "workspace-write"') &&
    paiCli.includes('new Blob([prompt])') &&
    !paiCli.includes('["claude", "-p", prompt]'),
  "PAI/TOOLS/pai.ts",
);

check(
  "PAI CLI update/version paths are Windows-native",
  paiCli.includes("spawnSync([process.execPath, BANNER_SCRIPT]") &&
    paiCli.includes("function frameworkCliPackage") &&
    paiCli.includes("function getGlobalCliPackageVersion") &&
    paiCli.includes('join(process.env.APPDATA, "npm", "node_modules")') &&
    paiCli.includes('process.platform === "win32"') &&
    paiCli.includes("getGlobalCliPackageVersion(frameworkCliPackage(framework))") &&
    paiCli.includes('spawnSync([process.execPath, "install", "-g", frameworkCliPackage(activeFramework)]') &&
    paiCli.includes("result.stderr?.toString()") &&
    paiCli.includes("...frameworkEnv(root, framework)"),
  "PAI/TOOLS/pai.ts",
);

check(
  "PAI CLI MCP profile detection avoids readlink child process",
  paiCli.includes("realpathSync(ACTIVE_MCP)") &&
    !paiCli.includes('Bun.spawnSync(["readlink"'),
  "PAI/TOOLS/pai.ts",
);

check(
  "Codex hook generation avoids encoded PowerShell",
  configGen.includes("function windowsBunExe") &&
    configGen.includes("FrameworkHookAdapter.ts") &&
    configGen.includes("windowsCommandArg(windowsBunExe())") &&
    !configGen.includes("-EncodedCommand") &&
    !configGen.includes("powershell.exe") &&
    !configGen.includes("hookCommandPowerShell") &&
    !paiCli.includes("powerShellEncodedCommand") &&
    !paiCli.includes("-EncodedCommand"),
  "PAI/PAI-Install/engine/config-gen.ts and PAI/TOOLS/pai.ts",
);

check(
  "Framework switch adapts provider system prompt",
  paiCli.includes('const systemPromptPath = join(root, "PAI", "PAI_SYSTEM_PROMPT.md")') &&
    paiCli.includes('writeFileSync(systemPromptPath, frameworkInstructionContent(readFileSync(systemPromptPath, "utf-8"), id))') &&
    installActions.includes('const systemPromptPath = join(paiDir, "PAI", "PAI_SYSTEM_PROMPT.md")') &&
    installActions.includes('frameworkInstructionContent(readFileSync(systemPromptPath, "utf-8"), target)'),
  "PAI/TOOLS/pai.ts and PAI/PAI-Install/engine/actions.ts",
);

check(
  "Canonical agent and command sources are not provider-rendered outputs",
  !canonicalAgentCommandSources.includes("This PAI agent was rendered from the provider-neutral PAI agent contract for OpenCode") &&
    !canonicalAgentCommandSources.includes("This PAI command was generated for OpenCode from the shared PAI command definition") &&
    !canonicalAgentCommandSources.includes("If framework state is missing, treat `$PAI_DIR` as `~/.config/opencode/PAI`") &&
    !canonicalAgentCommandSources.includes("OpenCode defaults (history, project memories)"),
  "release agents/ and commands/ remain canonical source, not generated provider output",
);

check(
  "Installer avoids shell-string exec on Windows-sensitive paths",
  !installMain.includes("execSync") &&
    !installMain.includes('spawn("bun"') &&
    !installMain.includes('spawnSync("bun"') &&
    installMain.includes("spawnSync(process.execPath, [\"install\"]") &&
    installMain.includes("spawn(process.execPath, [\"run\", \"start\"]") &&
    (installMain.match(/windowsHide:\s*true/g)?.length ?? 0) >= 4 &&
    !installActions.includes("execSync") &&
    !installDetect.includes("execSync") &&
    (installValidate.match(/windowsHide:\s*true/g)?.length ?? 0) >= 3 &&
    installActions.includes("function trySpawn") &&
    installActions.includes("windowsHide: true") &&
    installActions.includes('tryGit(["clone", "https://github.com/danielmiessler/PAI.git", paiDir]') &&
    installDetect.includes("execFileSync") &&
    installDetect.includes("windowsHide: true"),
  "PAI/PAI-Install/main.ts, engine/actions.ts, engine/detect.ts, and engine/validate.ts",
);

check(
  "Installer preserves bundled shared USER defaults",
  installActions.includes("function ensureLinkedDirectory") &&
    installActions.includes("const resolvedPath = realpathSync(srcPath)") &&
    installActions.includes("const resolvedStat = lstatSync(resolvedPath)") &&
    installActions.includes("const copied = copyMissing(localPath, globalPath)") &&
    installActions.includes("if (!existsSync(dst)) mkdirSync(dst, { recursive: true })") &&
    installerCodexSmoke.includes("Shared security patterns installed") &&
    codexFreshInstallSmoke.includes("shared security patterns installed") &&
    installValidate.includes('join(getPaiDataDir(), "USER", "SECURITY", "PATTERNS.yaml")'),
  "PAI/PAI-Install/engine/actions.ts plus installer/fresh-install smokes",
);

check(
  "Installer key discovery checks active provider env files",
  installActions.includes("export function primaryEnvCandidatePaths") &&
    installActions.includes("export function findExistingEnvKey(keyName: string, activeFrameworkDir?: string)") &&
    installActions.includes("process.env.CODEX_HOME") &&
    installActions.includes("process.env.OPENCODE_CONFIG_DIR") &&
    installActions.includes('findExistingEnvKey("ELEVENLABS_API_KEY", activeFrameworkDir)') &&
    installActions.includes('findExistingEnvKey("TELEGRAM_BOT_TOKEN", paiDir)') &&
    installerProviderEnvSmoke.includes("installer key lookup falls back to Codex framework env") &&
    installerProviderEnvSmoke.includes("installer Telegram lookup reads Codex framework env") &&
    installerProviderEnvSmoke.includes("installer voice lookup checks active Codex settings first"),
  "PAI/PAI-Install/engine/actions.ts and InstallerProviderEnvSmokeTest.ts",
);

check(
  "Framework hook adapter derives PAI env fallback",
  hookAdapter.includes("const frameworkDir = resolve(join(hooksDir, \"..\"))") &&
    hookAdapter.includes('import { homeDir } from "./lib/paths"') &&
    !hookAdapter.includes('from "os"') &&
    !hookAdapter.includes("process.env.HOME || process.env.USERPROFILE || homedir()") &&
    hookAdapter.includes("PAI_DIR: paiDir") &&
    hookAdapter.includes("PAI_DATA_DIR: dataDir") &&
    hookAdapter.includes("PAI_FRAMEWORK_DIR: frameworkDir") &&
    hookAdapter.includes("PAI_CONFIG_DIR: configDir"),
  "hooks/FrameworkHookAdapter.ts",
);

check(
  "Framework AI launchers hide child windows on Windows",
  frameworkAgent.includes("windowsHide: true") &&
    inferenceTool.match(/windowsHide:\s*true/g)?.length >= 3 &&
    algorithm.includes("windowsHide: true") &&
    paiCli.includes("windowsHide: true"),
  "PAI/TOOLS/Inference.ts, algorithm.ts, pai.ts, and lib/framework-agent.ts",
);

check(
  "Forge and Anvil progress tools resolve Windows homes",
  forgeProgress.includes('import { homeDir, memoryPath } from "./lib/paths"') &&
    anvilProgress.includes('import { getEnvPath, homeDir, memoryPath } from "./lib/paths"') &&
    !forgeProgress.includes('throw new Error("HOME is not set")') &&
    !anvilProgress.includes('throw new Error("HOME is not set")'),
  "PAI/TOOLS/ForgeProgress.ts and AnvilProgress.ts",
);

check(
  "Image tools use shared home helper and hidden child processes",
  removeBg.includes('import { homeDir } from "./lib/paths"') &&
    removeBg.includes("resolve(homeDir(), \".local/bin/rembg\")") &&
    removeBg.includes("windowsHide: true") &&
    !removeBg.includes("const home = process.env.HOME"),
  "PAI/TOOLS/RemoveBg.ts",
);

check(
  "Forge progress resolves Codex without hardcoded bun path",
  forgeProgress.includes("process.env.PAI_CODEX_BIN") &&
    forgeProgress.includes('Bun.which("codex")') &&
    forgeProgress.includes("function windowsSpawnArgs") &&
    forgeProgress.includes("windowsHide: true") &&
    !forgeProgress.includes('const codexPath = join(home, ".bun", "bin", "codex")'),
  "PAI/TOOLS/ForgeProgress.ts",
);

const nonNullHomePattern = "process.env." + "HOME!";
const homeBangFiles = walkTextFiles(join(paiRoot, "TOOLS"))
  .filter((path) => read(path).includes(nonNullHomePattern));
check(
  "PAI tools avoid non-null HOME assumptions",
  homeBangFiles.length === 0,
  homeBangFiles.length ? homeBangFiles.slice(0, 8).join("\n") : "PAI/TOOLS scanned",
);

const manualToolShellFiles = [
  "CostTracker.ts",
  "DocCheck.ts",
  "GetTranscript.ts",
  "KnowledgeHarvester.ts",
  "ReferenceCheck.ts",
  "RelationshipReflect.ts",
].map((file) => join(paiRoot, "TOOLS", file))
  .filter((path) => {
    const source = read(path);
    return source.includes("execSync(") || source.includes("require(\"child_process\")");
  });
check(
  "Manual PAI tools avoid shell-string exec",
  manualToolShellFiles.length === 0,
  manualToolShellFiles.length ? manualToolShellFiles.slice(0, 8).join("\n") : "manual tools scanned",
);

check(
  "Manual PAI tools use shared home helpers",
  !docCheck.includes("const HOME = process.env.HOME ||") &&
    !referenceCheck.includes("const HOME = process.env.HOME ||") &&
    gmailTool.includes('import { expandHome, userPath } from "./lib/paths"') &&
    gmailTool.includes("expandHome(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE)") &&
    !gmailTool.includes('from "node:os"') &&
    crossVendorAudit.includes('import { expandHome, homeDir, memoryPath } from "./lib/paths"') &&
    crossVendorAudit.includes("const HOME = homeDir()") &&
    crossVendorAudit.includes("function resolveCodexBin()") &&
    crossVendorAudit.includes('Bun.which("codex")') &&
    crossVendorAudit.includes("function windowsSpawnArgs") &&
    crossVendorAudit.includes("windowsHide: true") &&
    !crossVendorAudit.includes('from "node:os"') &&
    !crossVendorAudit.includes('const CODEX_BIN = join(HOME, ".bun", "bin", "codex")'),
  "PAI/TOOLS/CrossVendorAudit.ts, DocCheck.ts, gmail.ts, ReferenceCheck.ts",
);

check(
  "DocCheck scans provider-native instruction and nested doc paths",
  docCheck.includes("const FRAMEWORK_DIR = getFrameworkDir()") &&
    docCheck.includes(".codex") &&
    docCheck.includes("opencode") &&
    docCheck.includes("function listFilesRecursive") &&
    docCheck.includes("'CLAUDE.md', 'AGENTS.md', 'RTK.md'") &&
    !docCheck.includes("const CLAUDE_DIR"),
  "PAI/TOOLS/DocCheck.ts",
);

check(
  "ReferenceCheck resolves provider-native framework paths",
  referenceCheck.includes("const FRAMEWORK_DIR = getFrameworkDir()") &&
    referenceCheck.includes(".codex") &&
    referenceCheck.includes("opencode") &&
    referenceCheck.includes("commands|plugins") &&
    !referenceCheck.includes("const CLAUDE_DIR"),
  "PAI/TOOLS/ReferenceCheck.ts",
);

check(
  "Runtime helper child processes stay hidden on Windows",
  secretScan.includes("spawn('trufflehog', args, { windowsHide: true })") &&
    splitAndTranscribe.includes("], { windowsHide: true })") &&
    compactSkillDescriptions.includes("windowsHide: true") &&
    (algorithm.match(/windowsHide:\s*true/g)?.length ?? 0) >= 4 &&
    (paiCli.match(/windowsHide:\s*true/g)?.length ?? 0) >= 10,
  "PAI/TOOLS/SecretScan.ts, SplitAndTranscribe.ts, CompactSkillDescriptions.ts, algorithm.ts, pai.ts",
);

check(
  "PAI banner startup avoids Windows-visible POSIX probes",
  paiCli.includes("spawnSync([process.execPath, BANNER_SCRIPT]") &&
    paiCli.includes("windowsHide: true") &&
    bannerSources.includes("process.stdout.columns") &&
    (bannerSources.match(/process\.platform !== "win32" && \(!width \|\| width <= 0\)/g)?.length ?? 0) >= 10 &&
    (bannerSources.match(/windowsHide:\s*true/g)?.length ?? 0) >= 11,
  "PAI/TOOLS/Banner*.ts and pai.ts",
);

check(
  "PAI banners report active provider runtime",
  frameworkDisplay.includes("export function activeRuntimeLabel") &&
    frameworkDisplay.includes('return "Codex"') &&
    frameworkDisplay.includes('return "OpenCode"') &&
    frameworkDisplay.includes("readCodexModel") &&
    frameworkDisplay.includes('join(root, "config.toml")') &&
    frameworkDisplay.includes("PAI_CODEX_MODEL") &&
    frameworkDisplay.includes("PAI_OPENCODE_MODEL") &&
    (bannerSources.match(/activeRuntimeLabel/g)?.length ?? 0) >= 5 &&
    !bannerSources.includes('model: "Opus'),
  "PAI/TOOLS/lib/framework-display.ts and Banner*.ts",
);

check(
  "PAI banners count provider-native hook registrations",
  bannerCounts.includes("export function countRegisteredHooks") &&
    bannerCounts.includes('join(frameworkDir, "hooks.json")') &&
    bannerCounts.includes('join(frameworkDir, "settings.json")') &&
    bannerProviderCountsSmoke.includes("Codex hooks.json wins over dormant hook files") &&
    bannerProviderCountsSmoke.includes("Claude settings.json remains native fallback") &&
    (bannerSources.match(/countRegisteredHooks/g)?.length ?? 0) >= 5 &&
    !bannerSources.includes("const CLAUDE_DIR") &&
    !bannerSources.includes("readdirSync(hooksDir"),
  "PAI/TOOLS/lib/banner-counts.ts, Banner*.ts, and BannerProviderCountsSmokeTest.ts",
);

check(
  "PAI banners use central identity loader",
  bannerSources.includes('from "../../hooks/lib/identity"') &&
    bannerSources.includes("getStartupCatchphrase") &&
    (bannerSources.match(/getIdentity/g)?.length ?? 0) >= 5 &&
    !bannerSources.includes("settings.daidentity?.displayName") &&
    !bannerSources.includes("settings.daidentity?.name"),
  "PAI/TOOLS/Banner*.ts and hooks/lib/identity.ts",
);

check(
  "RTK hook rejects Windows-unsafe rewrites without fast bypass",
  rtkHook.includes("isWindowsUnsafeRtkRewrite") &&
    rtkHook.includes("windows_unsafe_rtk_rewrite") &&
    rtkHook.includes("isWindowsUnresolvableRtkRewrite") &&
    rtkHook.includes("windows_unresolvable_rtk_rewrite") &&
    rtkHook.includes("function homeDir()") &&
    rtkHook.includes("return process.env.PAI_DATA_DIR || join(homeDir(), \".pai\")") &&
    !rtkHook.includes("fast_bypass"),
  "hooks/RtkPreToolUse.hook.js",
);

check(
  "Security pattern inspector uses shared home helper",
  patternInspector.includes("homeDir, paiPath, userPath") &&
    patternInspector.includes("const home = homeDir()") &&
    !patternInspector.includes("homedir()"),
  "hooks/security/inspectors/PatternInspector.ts",
);

check(
  "Containment zones cover provider-native config files",
  containmentZones.includes('"config.toml"') &&
    containmentZones.includes('"hooks.json"') &&
    containmentZones.includes('"opencode.json"') &&
    containmentZones.includes('"auth.json"') &&
    containmentZones.includes("relativeToFrameworkRoot") &&
    containmentZones.includes("isContainedInFrameworkRoot") &&
    containmentZones.includes("isUnderFrameworkRoot") &&
    containmentZones.includes('path.replace(/\\\\/g, "/")') &&
    containmentGuard.includes("FRAMEWORK_ROOT = getFrameworkDir()") &&
    containmentGuard.includes("isContainedInFrameworkRoot") &&
    containmentZonesSmoke.includes("Windows backslash config path is contained") &&
    containmentZonesSmoke.includes("ordinary public files stay outside containment"),
  "hooks/lib/containment-zones.ts, hooks/ContainmentGuard.hook.ts, and ContainmentZonesSmokeTest.ts",
);

check(
  "Telos summary hook avoids shell exec on regeneration",
  telosSummaryHook.includes("spawnSync(process.execPath, [GENERATOR]") &&
    telosSummaryHook.includes("windowsHide: true") &&
    !telosSummaryHook.includes("execSync"),
  "hooks/TelosSummarySync.hook.ts",
);

check(
  "Tab setter avoids shell exec for terminal metadata",
  tabSetter.includes("spawnSync(resolved, args") &&
    tabSetter.includes("findExecutable(command)") &&
    tabSetter.includes("windowsHide: true") &&
    tabSetter.includes("JSON.parse(liveOutput)") &&
    !tabSetter.includes("execSync") &&
    !tabSetter.includes("| jq"),
  "hooks/lib/tab-setter.ts",
);

check(
  "ISA utils reads subagent tail without shell exec",
  isaUtils.includes("function readTailLines") &&
    isaUtils.includes("readSync(fd, buffer") &&
    isaUtils.includes("readTailLines(eventsPath, 200)") &&
    !isaUtils.includes("execSync") &&
    !isaUtils.includes("tail -200") &&
    !isaUtils.includes("require('child_process')"),
  "hooks/lib/isa-utils.ts",
);

check(
  "RestoreContext locates recent ISA without shell exec",
  restoreContext.includes("function findRecentArtifact") &&
    restoreContext.includes("readdirSync(dir, { withFileTypes: true })") &&
    restoreContext.includes("findRecentArtifact(workDir, 'ISA.md'") &&
    !restoreContext.includes("execSync") &&
    !restoreContext.includes("fd -t f") &&
    !restoreContext.includes("head -1"),
  "hooks/RestoreContext.hook.ts",
);

check(
  "Codex hook proof utilities keep child windows hidden",
  codexHookContractSmoke.includes('import { homeDir } from "./lib/paths"') &&
    codexHookContractSmoke.includes("const home = homeDir()") &&
    !codexHookContractSmoke.includes("process.env.HOME || homedir()") &&
    codexHookTriggerSmoke.includes('import { homeDir } from "./lib/paths"') &&
    codexHookTriggerSmoke.includes("const home = homeDir()") &&
    !codexHookTriggerSmoke.includes("homedir()") &&
    codexHookTriggerSmoke.includes("windowsHide: true") &&
    codexRealSessionHookProof.includes('import { homeDir } from "./lib/paths"') &&
    codexRealSessionHookProof.includes("const home = homeDir()") &&
    !codexRealSessionHookProof.includes("homedir()") &&
    codexRealSessionHookProof.includes("windowsHide: true") &&
    repeatDetectionSmoke.includes('import { homeDir } from "./lib/paths"') &&
    repeatDetectionSmoke.includes("const home = homeDir()") &&
    repeatDetectionSmoke.includes("windowsHide: true") &&
    !repeatDetectionSmoke.includes('join(process.env.HOME || "", ".codex")') &&
    startupSelfCheckSmoke.includes('import { homeDir } from "./lib/paths"') &&
    startupSelfCheckSmoke.includes("const home = homeDir()") &&
    startupSelfCheckSmoke.includes("windowsHide: true") &&
    !startupSelfCheckSmoke.includes('join(process.env.HOME || "", ".codex")'),
  "CodexHookContractSmokeTest, CodexHookTriggerSmokeTest, CodexRealSessionHookProof, RepeatDetectionSmokeTest, StartupSelfCheckSmokeTest",
);

check(
  "Pulse Windows launcher avoids visible shim windows",
  pulseManage.includes("npm\\node_modules\\bun") &&
    pulseManage.includes("bin\\bun.exe") &&
    pulseManage.includes("Test-Path -LiteralPath $candidate") &&
    pulseManage.includes("-WindowStyle Hidden") &&
    pulseManage.includes("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass"),
  "PAI/PULSE/manage.ps1",
);

check(
  "Stop transcript parser understands Codex response_item events",
  transcriptParser.includes("entry?.type === 'response_item'") &&
    transcriptParser.includes("entry.payload?.type === 'message'") &&
    transcriptParser.includes("entry.payload?.type === 'function_call'") &&
    transcriptParser.includes("requestuserinput"),
  "PAI/TOOLS/TranscriptParser.ts",
);

check(
  "Shared transcript roots discover provider-native session trees",
  transcriptRoots.includes("getClaudeProjectDirs") &&
    transcriptRoots.includes('return getClaudeProjectDirs(root)') &&
    transcriptRoots.includes('join(root, "sessions")') &&
    transcriptRoots.includes('join(getPaiDataDir(), "TRANSCRIPTS", "opencode")'),
  "PAI/TOOLS/lib/transcripts.ts",
);

check(
  "Integrity maintenance reads provider-native transcript context",
  integrityMaintenance.includes("parseTranscriptEntries(transcriptPath, framework)") &&
    integrityMaintenance.includes("export function readTranscriptContext") &&
    integrityMaintenance.includes("if (import.meta.main)") &&
    !integrityMaintenance.includes("entry.type === 'user' && entry.message?.content") &&
    integrityMaintenanceTranscriptSmoke.includes("Codex response_item context is parsed") &&
    integrityMaintenanceTranscriptSmoke.includes("Claude transcript context still parses") &&
    integrityMaintenanceTranscriptSmoke.includes("OpenCode transcript context parses"),
  "PAI/TOOLS/IntegrityMaintenance.ts and IntegrityMaintenanceTranscriptSmokeTest.ts",
);

check(
  "Relationship memory reads provider-native transcript context",
  relationshipMemory.includes("parseTranscriptEntries(path, framework)") &&
    relationshipMemory.includes("export function readTranscriptEntries") &&
    relationshipMemory.includes("export function analyzeForRelationship") &&
    relationshipMemory.includes("if (import.meta.main)") &&
    relationshipMemory.includes("Preference signal:") &&
    !relationshipMemory.includes("const parsed = parseTranscript(path)") &&
    relationshipMemoryTranscriptSmoke.includes("Codex user preference becomes relationship opinion note") &&
    relationshipMemoryTranscriptSmoke.includes("Claude relationship transcript still parses"),
  "hooks/RelationshipMemory.hook.ts and PAI/TOOLS/RelationshipMemoryTranscriptSmokeTest.ts",
);

check(
  "Prompt, satisfaction, and failure consumers read provider-native transcripts",
  transcriptRoots.includes("export function parseTranscriptEntriesFromText") &&
    promptProcessing.includes("parseTranscriptEntriesFromText(content, { sourcePath: transcriptPath })") &&
    promptProcessing.includes("export function getRecentContext") &&
    promptProcessing.includes("if (import.meta.main)") &&
    satisfactionCapture.includes("parseTranscriptEntries(transcriptPath)") &&
    satisfactionCapture.includes("export function getRecentContext") &&
    satisfactionCapture.includes("if (import.meta.main)") &&
    failureCapture.includes("parseTranscriptEntries(transcriptPath, framework)") &&
    failureCapture.includes("export function parseTranscript") &&
    failureCapture.includes("function_call") &&
    providerTranscriptConsumersSmoke.includes("Satisfaction context parses Codex response_item messages") &&
    providerTranscriptConsumersSmoke.includes("Failure capture tool calls parse Codex function_call") &&
    !promptProcessing.includes("entry.type === 'user' && entry.message?.content") &&
    !satisfactionCapture.includes("entry.type === 'user' && entry.message?.content"),
  "hooks/PromptProcessing.hook.ts, hooks/SatisfactionCapture.hook.ts, PAI/TOOLS/FailureCapture.ts, and ProviderTranscriptConsumersSmokeTest.ts",
);

check(
  "Identity loader falls back to shared USER docs",
  identityLoader.includes("getSettingsPath, userPath") &&
    identityLoader.includes("function loadUserIdentityDocuments") &&
    identityLoader.includes("userPath('DA_IDENTITY.md')") &&
    identityLoader.includes("userPath('PRINCIPAL_IDENTITY.md')") &&
    identityLoader.includes("parseAlgorithmVoice") &&
    identityLoader.includes("cachedUserIdentity = null") &&
    identityProviderFallbackSmoke.includes("settings.json only contains framework metadata") &&
    identityProviderFallbackSmoke.includes("Codex identity falls back to shared USER markdown") &&
    identityProviderFallbackSmoke.includes("Explicit settings identity overrides shared markdown"),
  "hooks/lib/identity.ts and IdentityProviderFallbackSmokeTest.ts",
);

check(
  "Pulse cost aggregator parses Codex token_count events",
  costAggregator.includes("getFrameworkSessionRoots") &&
    costAggregator.includes("payload?.type !== \"token_count\"") &&
    costAggregator.includes("total_token_usage") &&
    costAggregator.includes("codex-subscription") &&
    costAggregator.includes('billingSource = "subscription"') &&
    !costAggregator.includes('join(FRAMEWORK_DIR, "projects")'),
  "PAI/PULSE/Performance/cost-aggregator.ts",
);

check(
  "Integrity change detection understands Codex writes and patches",
  changeDetection.includes("entry.type === 'response_item'") &&
    changeDetection.includes("entry.payload?.type === 'function_call'") &&
    changeDetection.includes("parseModifiedFilePaths") &&
    changeDetection.includes("*** Begin Patch") &&
    changeDetection.includes("function isNativeHookRegistryPath") &&
    changeDetection.includes("function isNativeFrameworkConfigPath") &&
    changeDetection.includes("hooks\\.json") &&
    changeDetection.includes("config\\.toml"),
  "hooks/lib/change-detection.ts",
);

check(
  "Config audit resolves provider-native config files",
  configAudit.includes("function defaultConfigPath") &&
    configAudit.includes("config.toml") &&
    configAudit.includes("'permissions', 'hooks', 'env'") &&
    configAudit.includes("SNAPSHOT_DIR = memoryPath('STATE', 'config-audit')") &&
    configAudit.includes("function resolveConfigPath") &&
    configAudit.includes("function parseTomlLike") &&
    !configAudit.includes("'/tmp/pai-settings-snapshot.json'"),
  "hooks/ConfigAudit.hook.ts",
);

check(
  "Doc integrity uses shared provider-aware modified-file parser",
  docCrossRefIntegrity.includes("parseModifiedFilePaths") &&
    !docCrossRefIntegrity.includes("entry.type === 'assistant' && entry.message?.content"),
  "hooks/handlers/DocCrossRefIntegrity.ts",
);

check(
  "Doc integrity keeps provider inference opt-in",
  docCrossRefIntegrity.includes("function docInferenceEnabled") &&
    docCrossRefIntegrity.includes("PAI_DOC_INFERENCE") &&
    docCrossRefIntegrity.includes("PAI_DOC_INTEGRITY_INFERENCE") &&
    docCrossRefIntegrity.includes("level: 'fast'") &&
    docCrossRefIntegrity.includes("timeout: 5000") &&
    docCrossRefIntegrity.includes("Skipped; set PAI_DOC_INFERENCE=1"),
  "hooks/handlers/DocCrossRefIntegrity.ts",
);

check(
  "Doc integrity counts provider-native hook registration",
  docCrossRefIntegrity.includes("function countActiveHookCommands") &&
    docCrossRefIntegrity.includes("join(FRAMEWORK_DIR, 'hooks.json')") &&
    docCrossRefIntegrity.includes("countHookCommands(hooksJson.hooks ?? {})") &&
    docCrossRefIntegrity.includes("getSettingsPath()") &&
    docCrossRefIntegrity.includes("const activeHookCount = countActiveHookCommands()") &&
    docCrossRefIntegrity.includes("frameworkRel === 'hooks.json'") &&
    docCrossRefIntegrity.includes("f.endsWith('AGENTS.md')") &&
    docCrossRefIntegrity.includes("function listFilesRecursive") &&
    docCrossRefIntegrity.includes("return listFilesRecursive(DOCS_DIR, '.md')") &&
    docCrossRefIntegrity.includes("const docPath = join(DOCS_DIR, docFile)") &&
    !docCrossRefIntegrity.includes("checkHookCounts(docsToCheck, hooksOnDisk.size)") &&
    !docCrossRefIntegrity.includes("updateHookCount(hooksOnDisk.size)") &&
    !docCrossRefIntegrity.includes("getClaudeDir"),
  "hooks/handlers/DocCrossRefIntegrity.ts",
);

check(
  "Arch summary rebuild watches active framework config and instruction files",
  rebuildArchSummary.includes('"DOCUMENTATION", "ARCHITECTURE_SUMMARY.md"') &&
    rebuildArchSummary.includes('"TOOLS", "ArchitectureSummaryGenerator.ts"') &&
    rebuildArchSummary.includes("getFrameworkDir") &&
    !rebuildArchSummary.includes("getClaudeDir") &&
    rebuildArchSummary.includes('"config.toml"') &&
    rebuildArchSummary.includes('"hooks.json"') &&
    rebuildArchSummary.includes('"opencode.json"') &&
    rebuildArchSummary.includes('"AGENTS.md"') &&
    rebuildArchSummary.includes('"RTK.md"') &&
    rebuildArchSummary.includes("process.execPath") &&
    rebuildArchSummarySmoke.includes("config.toml") &&
    rebuildArchSummarySmoke.includes("hooks.json") &&
    rebuildArchSummarySmoke.includes("opencode.json") &&
    rebuildArchSummarySmoke.includes("generator-marker.txt") &&
    rebuildArchSummarySmoke.includes("pathToFileURL") &&
    !rebuildArchSummary.includes('spawn("bun"') &&
    !rebuildArchSummary.includes('"PAI_ARCHITECTURE_SUMMARY.md"') &&
    !rebuildArchSummary.includes('"Tools/ArchitectureSummaryGenerator.ts"'),
  "hooks/handlers/RebuildArchSummary.ts and RebuildArchSummarySmokeTest.ts",
);

check(
  "Integrity maintenance stays hidden on Windows",
  systemIntegrity.includes("process.execPath") &&
    systemIntegrity.includes("windowsHide: true") &&
    !systemIntegrity.includes("spawn('bun'") &&
    !systemIntegrity.includes('spawn("bun"'),
  "hooks/handlers/SystemIntegrity.ts",
);

check(
  "UpdateCounts avoids shell credential lookup",
  updateCounts.includes("spawnSync('security', [") &&
    updateCounts.includes("windowsHide: true") &&
    updateCounts.includes("join(getClaudeDir(), '.credentials.json')") &&
    !updateCounts.includes("execSync") &&
    !updateCounts.includes("process.env.HOME || ''"),
  "hooks/handlers/UpdateCounts.ts",
);

check(
  "Counts read provider-native hook registration",
  updateCounts.includes("join(frameworkDir, 'hooks.json')") &&
    updateCounts.includes("countHookCommands(codexHooks.hooks ?? {})") &&
    updateCounts.includes("countHookCommands(settings.hooks ?? {})") &&
    updateCounts.includes("join(getFrameworkDir(), 'skills')") &&
    getCountsTool.includes('join(FRAMEWORK_DIR, "hooks.json")') &&
    getCountsTool.includes("countHookCommands(parsed.hooks ?? {})") &&
    getCountsTool.includes("countHookCommands(settings.hooks ?? {})"),
  "hooks/handlers/UpdateCounts.ts and PAI/TOOLS/GetCounts.ts",
);

check(
  "Branch validation avoids visible Windows cmd shims",
  branchValidation.includes('command === "bun" ? process.execPath') &&
    branchValidation.includes("windowsHide: true") &&
    !branchValidation.includes("const resolvedCommand = Bun.which(command) || command;"),
  "PAI/TOOLS/CodexBranchValidation.ts",
);

check(
  "Installed updater keeps NoPull offline without SourceDir",
  updateInstalledPs1.includes("function Get-ScriptRoot") &&
    updateInstalledPs1.includes("Using bundled source because -NoPull was passed without -SourceDir") &&
    updateInstalledPs1.includes("Write-PaiFrameworkState $target.Root $target.Framework") &&
    updateInstalledPs1.includes("Repair-PowerShellProfiles $target.Root $target.Framework $backupRoot") &&
    updateInstalledPs1.indexOf("if ($NoPull)") < updateInstalledPs1.indexOf("git clone --depth 1") &&
    updateInstalledSh.includes("SCRIPT_DIR=") &&
    updateInstalledSh.includes("Using bundled source because --no-pull was passed without --source-dir") &&
    updateInstalledSh.includes("write_pai_framework_state") &&
    updateInstalledSh.includes("repair_shell_profiles") &&
    updateInstalledSh.includes("initialize_pai_environment") &&
    updateInstalledSh.indexOf('if [ "$NO_PULL" -eq 1 ]') < updateInstalledSh.indexOf("git clone --depth 1") &&
    hotfixUpdateRollbackSmoke.includes("NoPull without SourceDir does not invoke git") &&
    hotfixUpdateRollbackSmoke.includes("fakeGitInvoked"),
  "update-installed.ps1, update-installed.sh, and HotfixUpdateRollbackSmokeTest.ts",
);

check(
  "Installer and web guidance are provider-native",
  installActions.includes('const BACKUP_PREFIXES = [".claude", ".codex", ".config-opencode"]') &&
    installActions.includes("provider backup dirs (`~/.claude*`, `~/.codex*`, `~/.config-opencode*`)") &&
    installActions.includes("provider backup dirs such as ~/.claude.bak, ~/.codex-bak, or ~/.config-opencode.previous") &&
    paiSystemPrompt.includes("Codex-native browser tooling is the active harness capability") &&
    releaseClaudeMd.includes("Codex-native browser tooling is the active harness capability") &&
    !paiSystemPrompt.includes("Interceptor is the ONLY sanctioned") &&
    !paiSystemPrompt.includes("No exceptions.") &&
    !releaseClaudeMd.includes("Interceptor for ALL web verification"),
  "PAI-Install actions, PAI_SYSTEM_PROMPT.md, and CLAUDE.md",
);

check(
  "Safe validation smokes hide Windows child processes",
  frameworkCommandResolutionSmoke.includes("windowsHide: true") &&
    codexFrameworkExecutionSmoke.includes("windowsHide: true") &&
    openCodeFrameworkExecutionSmoke.includes("windowsHide: true") &&
    sessionEndLifecycleSmoke.match(/windowsHide:\s*true/g)?.length >= 3 &&
    installerCodexSmoke.includes("windowsHide: true") &&
    frameworkLaunchCwdSmoke.match(/windowsHide:\s*true/g)?.length >= 2 &&
    hotfixUpdateRollbackSmoke.match(/windowsHide:\s*true/g)?.length >= 2 &&
    junctionSafeUpdateSmoke.includes("windowsHide: true") &&
    memoryDeleteSmoke.match(/windowsHide:\s*true/g)?.length >= 2 &&
    paiSecurityAuditSmoke.includes("windowsHide: true"),
  "FrameworkCommandResolution, framework execution, session lifecycle, installer, launch cwd, HotfixUpdateRollback, JunctionSafeUpdate, MemoryDelete, PaiSecurityAudit",
);

check(
  "Branch validation keeps deep probes opt-in locally",
  branchValidation.includes('type ValidationMode = "safe" | "deep"') &&
    branchValidation.includes('process.env.GITHUB_ACTIONS === "true"') &&
    branchValidation.includes("safe local mode; pass --deep") &&
    branchValidation.includes('if (validationMode === "deep")') &&
    branchValidation.includes("Deep validation probes skipped"),
  "PAI/TOOLS/CodexBranchValidation.ts",
);

check(
  "Branch validation uses Codex-targeted framework smoke",
  branchValidation.includes('"PAI/TOOLS/FrameworkSmokeTest.ts", "--framework", "codex"') &&
    !branchValidation.includes('"PAI/TOOLS/FrameworkSmokeTest.ts"], { timeout: 240_000 }'),
  "PAI/TOOLS/CodexBranchValidation.ts",
);

check(
  "Framework smoke keeps OpenCode CLI parsing opt-in",
  frameworkSmoke.includes('const dynamic = process.argv.includes("--dynamic")') &&
    frameworkSmoke.includes("PAI_FRAMEWORK_SMOKE_DYNAMIC") &&
    frameworkSmoke.includes("skipped in AV-safe static mode") &&
    frameworkSmoke.includes("checkOpenCodeConfigParses(root, dynamic)") &&
    (frameworkSmoke.match(/windowsHide:\s*true/g)?.length ?? 0) >= 15,
  "PAI/TOOLS/FrameworkSmokeTest.ts",
);

check(
  "OpenCode plugin bounds hook adapter dispatch",
  opencodePlugin.includes("DEFAULT_HOOK_TIMEOUT_MS") &&
    opencodePlugin.includes('import { expandPath, homeDir } from "../hooks/lib/paths"') &&
    opencodePlugin.includes("const HOME = homeDir()") &&
    !opencodePlugin.includes('from "os"') &&
    !opencodePlugin.includes("process.env.HOME || process.env.USERPROFILE || homedir()") &&
    opencodePlugin.includes("PAI_OPENCODE_HOOK_TIMEOUT_MS") &&
    opencodePlugin.includes("--timeout-ms") &&
    opencodePlugin.includes("timeout: timeout + 5_000") &&
    opencodePlugin.includes("windowsHide: true"),
  "plugins/pai-opencode.ts",
);

check(
  "OpenCode prompt hooks receive transcript context",
  opencodePlugin.includes("function workingDirectory(input: JsonObject)") &&
    opencodePlugin.includes("transcript_path: transcriptPath(input)") &&
    opencodePlugin.includes("const promptPayload = {") &&
    opencodePlugin.includes('runHook("PromptProcessing.hook.ts", promptPayload)') &&
    opencodePlugin.includes('observe("SatisfactionCapture.hook.ts", promptPayload)') &&
    opencodePlugin.includes("transcript_path: transcriptPath(event)"),
  "plugins/pai-opencode.ts",
);

check(
  "Pulse config teaches ai job type",
  pulseToml.includes('type = "ai"') &&
    !pulseToml.includes('type = "claude"') &&
    setup.includes('type = "ai"') &&
    !setup.includes('type = "claude"'),
  "legacy type remains accepted by loader",
);

check(
  "Pulse static export pins tracing root",
  nextConfig.includes("outputFileTracingRoot") &&
    nextConfig.includes("pai-pulse-static") &&
    !nextConfig.includes("Date.now()"),
  "PAI/PULSE/Observability/next.config.ts",
);

const outFiles = walkTextFiles(join(paiRoot, "PULSE", "Observability", "out"));
const staleOut = outFiles.filter((path) => read(path).includes("~/.claude/PAI/USER"));
check(
  "Pulse static export has no stale Claude USER path",
  staleOut.length === 0,
  staleOut.length ? staleOut.slice(0, 8).join("\n") : `${outFiles.length} exported text files scanned`,
);

check(
  "Pulse static export includes referenced logo",
  existsSync(join(paiRoot, "PULSE", "Observability", "public", "pai-logo.png")) &&
    existsSync(join(paiRoot, "PULSE", "Observability", "out", "pai-logo.png")),
  "public/pai-logo.png and out/pai-logo.png",
);

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nCodex native runtime smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log("\nAll Codex native runtime checks passed.");
