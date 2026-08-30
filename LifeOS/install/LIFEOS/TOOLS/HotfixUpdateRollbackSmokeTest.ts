#!/usr/bin/env bun
/**
 * HotfixUpdateRollbackSmokeTest
 *
 * Proves the installed hotfix updater can patch an old Codex install, create
 * backups under ~/.pai/BACKUPS, leave protected state alone, and roll back by
 * overlaying the backup contents onto the install root.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

function print(checks: Check[]) {
  for (const item of checks) {
    console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name} - ${item.detail}`);
  }
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function normalizePathText(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function decodePowerShellEncodedCommands(value: string): string[] {
  const decoded: string[] = [];
  for (const match of value.matchAll(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/gi)) {
    try {
      decoded.push(Buffer.from(match[1], "base64").toString("utf16le"));
    } catch {
      // Ignore malformed encoded command fragments.
    }
  }
  return decoded;
}

function hookCommandTexts(hooksJson: string): string[] {
  const values: string[] = [];
  function visit(value: unknown): void {
    if (typeof value === "string") {
      values.push(value, ...decodePowerShellEncodedCommands(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  }
  try {
    visit(JSON.parse(hooksJson));
  } catch {}
  return values;
}

function codexHookDataDirs(hooksJson: string): string[] {
  const values: string[] = [];
  for (const text of hookCommandTexts(hooksJson)) {
    for (const match of text.matchAll(/(?:^|\s)PAI_DATA_DIR='([^']*)'/g)) {
      values.push(match[1]);
    }
    for (const match of text.matchAll(/\$env:PAI_DATA_DIR='([^']*)'/g)) {
      values.push(match[1]);
    }
  }
  return [...new Set(values.filter(Boolean))];
}

function promptProcessingTimeoutHasHeadroom(hooksJson: string): boolean {
  let hasOuterTimeout = false;
  try {
    const parsed = JSON.parse(hooksJson);
    for (const group of Array.isArray(parsed.hooks?.UserPromptSubmit) ? parsed.hooks.UserPromptSubmit : []) {
      for (const hook of Array.isArray(group.hooks) ? group.hooks : []) {
        const text = `${hook.command || ""}\n${hook.commandWindows || ""}`;
        if (text.includes("PromptProcessing.hook.ts") && hook.timeout === 40) {
          hasOuterTimeout = true;
        }
      }
    }
  } catch {}

  const hasChildTimeout = hookCommandTexts(hooksJson).some((text) =>
    text.includes("PromptProcessing.hook.ts") &&
    text.includes("35000") &&
    text.includes("--timeout-ms"),
  );

  return hasOuterTimeout && hasChildTimeout;
}

function latestBackupRoot(home: string): string {
  const backups = join(home, ".pai", "BACKUPS");
  if (!existsSync(backups)) return "";
  const entries = readdirSync(backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("hotfix-"))
    .map((entry) => join(backups, entry.name))
    .sort();
  return entries.at(-1) || "";
}

function copyDirectoryContents(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, entry.name);
    const dst = join(destination, entry.name);
    cpSync(src, dst, { recursive: true, force: true });
  }
}

function copyInstalledSourceFixture(source: string, destination: string): void {
  const skipSegments = new Set([".git", ".tmp", "node_modules", "MEMORY", "USER"]);
  cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: (path) => !path.split(/[\\/]+/).some((segment) => skipSegments.has(segment)),
  });
}

function manifestSources(): Set<string> {
  const manifestPath = join(releaseRoot, "hotfix-manifest.json");
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return new Set((Array.isArray(parsed.entries) ? parsed.entries : [])
      .map((entry: Record<string, unknown>) => String(entry.source || ""))
      .filter(Boolean));
  } catch {
    return new Set();
  }
}

const keep = process.argv.includes("--keep");
const remote = process.argv.includes("--remote");
const releaseRoot = resolve(import.meta.dir, "..", "..");
const repoRoot = resolve(releaseRoot, "..", "..", "..");
const root = join(tmpdir(), `pai-hotfix-rollback-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const home = join(root, "home");
const oneDriveRoot = join(home, "OneDrive");
const installRoot = join(root, "old-codex");
const installedSourceRoot = join(root, "installed-source");
const dataDir = join(home, ".pai");
const configDir = join(home, ".config", "PAI");
const staleEnvDataDir = join(root, "stale-env", ".pai");

const sentinels = {
  agents: "OLD_AGENTS_SENTINEL",
  paiTool: "OLD_PAI_TOOL_SENTINEL",
  repeatHook: "OLD_REPEAT_HOOK_SENTINEL",
  promptGuardHook: "OLD_PROMPT_GUARD_HOOK_SENTINEL",
  opencodePlugin: "OLD_OPENCODE_PLUGIN_SENTINEL",
  config: "PROTECTED_CONFIG_SENTINEL",
  auth: "PROTECTED_AUTH_SENTINEL",
  user: "PROTECTED_USER_SENTINEL",
  memory: "PROTECTED_MEMORY_SENTINEL",
};

mkdirSync(installRoot, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(staleEnvDataDir, { recursive: true });
copyInstalledSourceFixture(releaseRoot, installedSourceRoot);
write(join(installedSourceRoot, "CLAUDE.md"), "**MANDATORY FIRST ACTION:** Read `PAI/ALGORITHM/LATEST` from the current directory.");
write(join(installedSourceRoot, "AGENTS.md"), "**MANDATORY FIRST ACTION:** Read `$PAI_DIR/ALGORITHM/LATEST` from the active PAI subsystem directory.");
write(join(dataDir, "framework.json"), JSON.stringify({ active: "codex", root: installRoot, dataDir }, null, 2));
write(join(staleEnvDataDir, "framework.json"), JSON.stringify({
  active: "codex",
  root: join(root, "deleted-codex"),
  dataDir: staleEnvDataDir,
}, null, 2));
write(join(installRoot, "AGENTS.md"), sentinels.agents);
write(join(installRoot, "PAI", "TOOLS", "pai.ts"), sentinels.paiTool);
write(join(installRoot, "PAI", "TOOLS", "ExtraTool.ts"), "UNMANAGED_EXTRA_TOOL_SENTINEL");
write(join(installRoot, "hooks", "RepeatDetection.hook.ts"), sentinels.repeatHook);
write(join(installRoot, "hooks", "PromptGuard.hook.ts"), sentinels.promptGuardHook);
write(join(installRoot, "plugins", "pai-opencode.ts"), sentinels.opencodePlugin);
write(join(installRoot, "PAI", "ALGORITHM", "LATEST"), "6.3.0");
write(join(installRoot, "PAI", "ALGORITHM", "v6.3.0.md"), "# old algorithm placeholder");
write(join(installRoot, "config.toml"), sentinels.config);
write(join(installRoot, "auth.json"), sentinels.auth);
write(join(installRoot, "PAI", "USER", "profile.md"), sentinels.user);
write(join(installRoot, "MEMORY", "STATE", "state.json"), sentinels.memory);

const updateCommand = process.platform === "win32" ? "powershell" : "bash";
const updateArgs = process.platform === "win32"
  ? [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(releaseRoot, "update-installed.ps1"),
      "-Framework",
      "codex",
      "-InstallRoot",
      installRoot,
      "-NoPull",
    ]
  : [
      join(releaseRoot, "update-installed.sh"),
      "--framework",
      "codex",
      "--install-root",
      installRoot,
      "--no-pull",
    ];
if (!remote) {
  if (process.platform === "win32") updateArgs.push("-SourceDir", installedSourceRoot);
  else updateArgs.push("--source-dir", installedSourceRoot);
}

const update = spawnSync(updateCommand, updateArgs, {
  cwd: repoRoot,
  encoding: "utf-8",
  timeout: 180_000,
  maxBuffer: 20 * 1024 * 1024,
  windowsHide: true,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OneDrive: oneDriveRoot,
    CODEX_HOME: installRoot,
    PAI_DATA_DIR: staleEnvDataDir,
    PAI_CONFIG_DIR: configDir,
    PAI_FRAMEWORK_DIR: join(root, "deleted-codex"),
    PAI_FRAMEWORK: "codex",
    PAI_USER_ENV_TARGET: "Process",
  },
});

const offlineHome = join(root, "offline-home");
const offlineInstallRoot = join(root, "offline-codex");
const offlineDataDir = join(offlineHome, ".pai");
const offlineConfigDir = join(offlineHome, ".config", "PAI");
const fakeBin = join(root, "fake-bin");
const fakeGitInvoked = join(fakeBin, "git-invoked.txt");
mkdirSync(offlineInstallRoot, { recursive: true });
mkdirSync(offlineDataDir, { recursive: true });
mkdirSync(fakeBin, { recursive: true });
write(join(offlineDataDir, "framework.json"), JSON.stringify({ active: "codex", root: offlineInstallRoot, dataDir: offlineDataDir }, null, 2));
write(join(offlineInstallRoot, "AGENTS.md"), "OFFLINE_OLD_AGENTS_SENTINEL");
write(join(offlineInstallRoot, "PAI", "TOOLS", "pai.ts"), "OFFLINE_OLD_PAI_TOOL_SENTINEL");
if (process.platform === "win32") {
  write(join(fakeBin, "git.cmd"), `@echo off\r\necho invoked>${fakeGitInvoked}\r\nexit /b 86\r\n`);
} else {
  write(join(fakeBin, "git"), `#!/usr/bin/env sh\nprintf invoked > '${fakeGitInvoked}'\nexit 86\n`);
  chmodSync(join(fakeBin, "git"), 0o755);
}

const offlineUpdateArgs = process.platform === "win32"
  ? [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(installedSourceRoot, "update-installed.ps1"),
      "-Framework",
      "codex",
      "-InstallRoot",
      offlineInstallRoot,
      "-NoPull",
    ]
  : [
      join(installedSourceRoot, "update-installed.sh"),
      "--framework",
      "codex",
      "--install-root",
      offlineInstallRoot,
      "--no-pull",
    ];
const offlineUpdate = spawnSync(updateCommand, offlineUpdateArgs, {
  cwd: repoRoot,
  encoding: "utf-8",
  timeout: 180_000,
  maxBuffer: 20 * 1024 * 1024,
  windowsHide: true,
  env: {
    ...process.env,
    HOME: offlineHome,
    USERPROFILE: offlineHome,
    OneDrive: join(offlineHome, "OneDrive"),
    CODEX_HOME: offlineInstallRoot,
    PAI_DATA_DIR: offlineDataDir,
    PAI_CONFIG_DIR: offlineConfigDir,
    PAI_FRAMEWORK_DIR: offlineInstallRoot,
    PAI_FRAMEWORK: "codex",
    PAI_USER_ENV_TARGET: "Process",
    PATH: `${fakeBin}${delimiter}${process.env.PATH || ""}`,
  },
});

const backupRoot = latestBackupRoot(home);
const offlineUpdatedPaiTool = read(join(offlineInstallRoot, "PAI", "TOOLS", "pai.ts"));
const updatedPaiTool = read(join(installRoot, "PAI", "TOOLS", "pai.ts"));
const updatedCheckpointTool = read(join(installRoot, "PAI", "TOOLS", "Checkpoint.ts"));
const updatedMemoryRetriever = read(join(installRoot, "PAI", "TOOLS", "MemoryRetriever.ts"));
const updatedArchitectureSummaryGenerator = read(join(installRoot, "PAI", "TOOLS", "ArchitectureSummaryGenerator.ts"));
const updatedCostTracker = read(join(installRoot, "PAI", "TOOLS", "CostTracker.ts"));
const updatedRemoveBg = read(join(installRoot, "PAI", "TOOLS", "RemoveBg.ts"));
const updatedRepeatHook = read(join(installRoot, "hooks", "RepeatDetection.hook.ts"));
const updatedPromptGuardHook = read(join(installRoot, "hooks", "PromptGuard.hook.ts"));
const updatedRtkHook = read(join(installRoot, "hooks", "RtkPreToolUse.hook.js"));
const updatedSmartApproverHook = read(join(installRoot, "hooks", "SmartApprover.hook.ts"));
const updatedCheckpointHook = read(join(installRoot, "hooks", "CheckpointPerISC.hook.ts"));
const updatedToolActivityTrackerHook = read(join(installRoot, "hooks", "ToolActivityTracker.hook.ts"));
const updatedHookPaths = read(join(installRoot, "hooks", "lib", "paths.ts"));
const updatedOpenCodePlugin = read(join(installRoot, "plugins", "pai-opencode.ts"));
const updatedHooksJson = read(join(installRoot, "hooks.json"));
const hookDataDirs = codexHookDataDirs(updatedHooksJson).map(normalizePathText);
const expectedHookDataSuffix = normalizePathText(join("home", ".pai"));
const staleHookDataSegment = normalizePathText(join("stale-env", ".pai"));
const powerShellAllHostsProfile = join(home, "Documents", "PowerShell", "profile.ps1");
const powerShellProfile = join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
const windowsPowerShellAllHostsProfile = join(home, "Documents", "WindowsPowerShell", "profile.ps1");
const windowsPowerShellProfile = join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
const oneDrivePowerShellAllHostsProfile = join(oneDriveRoot, "Documents", "PowerShell", "profile.ps1");
const oneDrivePowerShellProfile = join(oneDriveRoot, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
const oneDriveWindowsPowerShellAllHostsProfile = join(oneDriveRoot, "Documents", "WindowsPowerShell", "profile.ps1");
const oneDriveWindowsPowerShellProfile = join(oneDriveRoot, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
const powerShellAllHostsProfileText = read(powerShellAllHostsProfile);
const powerShellProfileText = read(powerShellProfile);
const windowsPowerShellAllHostsProfileText = read(windowsPowerShellAllHostsProfile);
const windowsPowerShellProfileText = read(windowsPowerShellProfile);
const oneDrivePowerShellAllHostsProfileText = read(oneDrivePowerShellAllHostsProfile);
const oneDrivePowerShellProfileText = read(oneDrivePowerShellProfile);
const oneDriveWindowsPowerShellAllHostsProfileText = read(oneDriveWindowsPowerShellAllHostsProfile);
const oneDriveWindowsPowerShellProfileText = read(oneDriveWindowsPowerShellProfile);
const profileTexts = [
  powerShellAllHostsProfileText,
  powerShellProfileText,
  windowsPowerShellAllHostsProfileText,
  windowsPowerShellProfileText,
  oneDrivePowerShellAllHostsProfileText,
  oneDrivePowerShellProfileText,
  oneDriveWindowsPowerShellAllHostsProfileText,
  oneDriveWindowsPowerShellProfileText,
];
const sources = manifestSources();
const requiredManifestSources = [
  "PAI/TOOLS/InstallerCodexSmokeTest.ts",
  "PAI/TOOLS/Checkpoint.ts",
  "PAI/TOOLS/MemoryRetriever.ts",
  "PAI/TOOLS/MemoryRetrieverSmokeTest.ts",
  "PAI/TOOLS/ArchitectureSummaryGenerator.ts",
  "PAI/TOOLS/CostTracker.ts",
  "PAI/TOOLS/RemoveBg.ts",
  "PAI/TOOLS/SecretScan.ts",
  "PAI/TOOLS/SplitAndTranscribe.ts",
  "PAI/TOOLS/CompactSkillDescriptions.ts",
  "hooks/CheckpointPerISC.hook.ts",
  "hooks/RtkPreToolUse.hook.js",
  "hooks/SmartApprover.hook.ts",
  "hooks/ToolActivityTracker.hook.ts",
  "hooks/lib",
  "plugins/pai-opencode.ts",
];

const beforeRollbackChecks: Check[] = [
  check("hotfix manifest covers current parity files", requiredManifestSources.every((source) => sources.has(source)), JSON.stringify(requiredManifestSources.filter((source) => !sources.has(source)))),
  check("hotfix update exits cleanly", update.status === 0, `status=${update.status ?? "null"} ${update.stderr.split(/\r?\n/).slice(-4).join(" | ")}`),
  check("NoPull without SourceDir exits cleanly", offlineUpdate.status === 0, `status=${offlineUpdate.status ?? "null"} ${offlineUpdate.stderr.split(/\r?\n/).slice(-6).join(" | ")}`),
  check("NoPull without SourceDir uses bundled source", offlineUpdatedPaiTool.includes("k doctor                 Run AV-safe PAI diagnostics") && `${offlineUpdate.stdout}\n${offlineUpdate.stderr}`.includes("Using bundled source"), join(offlineInstallRoot, "PAI", "TOOLS", "pai.ts")),
  check("NoPull without SourceDir does not invoke git", !existsSync(fakeGitInvoked), fakeGitInvoked),
  check("backup root created", backupRoot.length > 0, backupRoot || "missing"),
  check("AGENTS.md backup captured old content", read(join(backupRoot, "AGENTS.md")) === sentinels.agents, join(backupRoot, "AGENTS.md")),
  check("pai.ts backup captured old content", read(join(backupRoot, "PAI", "TOOLS", "pai.ts")) === sentinels.paiTool, join(backupRoot, "PAI", "TOOLS", "pai.ts")),
  check("RepeatDetection backup captured old content", read(join(backupRoot, "hooks", "RepeatDetection.hook.ts")) === sentinels.repeatHook, join(backupRoot, "hooks", "RepeatDetection.hook.ts")),
  check("PromptGuard backup captured old content", read(join(backupRoot, "hooks", "PromptGuard.hook.ts")) === sentinels.promptGuardHook, join(backupRoot, "hooks", "PromptGuard.hook.ts")),
  check("OpenCode plugin backup captured old content", read(join(backupRoot, "plugins", "pai-opencode.ts")) === sentinels.opencodePlugin, join(backupRoot, "plugins", "pai-opencode.ts")),
  check("pai.ts updated from release", updatedPaiTool.includes("k doctor                 Run AV-safe PAI diagnostics"), join(installRoot, "PAI", "TOOLS", "pai.ts")),
  check("Checkpoint tool updated from release", updatedCheckpointTool.includes("const HOME = homeDir()") && updatedCheckpointTool.includes("windowsHide: true"), join(installRoot, "PAI", "TOOLS", "Checkpoint.ts")),
  check("MemoryRetriever updated from release", updatedMemoryRetriever.includes('paiPath("TOOLS", "Inference.ts")'), join(installRoot, "PAI", "TOOLS", "MemoryRetriever.ts")),
  check("MemoryRetriever smoke installed", existsSync(join(installRoot, "PAI", "TOOLS", "MemoryRetrieverSmokeTest.ts")), join(installRoot, "PAI", "TOOLS", "MemoryRetrieverSmokeTest.ts")),
  check("ArchitectureSummaryGenerator updated from release", updatedArchitectureSummaryGenerator.includes("const HOME = homeDir()"), join(installRoot, "PAI", "TOOLS", "ArchitectureSummaryGenerator.ts")),
  check("CostTracker updated from release", updatedCostTracker.includes("const HOME = homeDir()"), join(installRoot, "PAI", "TOOLS", "CostTracker.ts")),
  check("RemoveBg updated from release", updatedRemoveBg.includes("resolve(homeDir(), \".local/bin/rembg\")") && updatedRemoveBg.includes("windowsHide: true"), join(installRoot, "PAI", "TOOLS", "RemoveBg.ts")),
  check("hotfix preserves unmanaged PAI/TOOLS file", read(join(installRoot, "PAI", "TOOLS", "ExtraTool.ts")) === "UNMANAGED_EXTRA_TOOL_SENTINEL", join(installRoot, "PAI", "TOOLS", "ExtraTool.ts")),
  check("RepeatDetection updated from release", updatedRepeatHook.includes("Continue by addressing the newest request directly"), join(installRoot, "hooks", "RepeatDetection.hook.ts")),
  check("PromptGuard updated from release", updatedPromptGuardHook.includes("process.exitCode = 2"), join(installRoot, "hooks", "PromptGuard.hook.ts")),
  check("RtkPreToolUse updated from release", updatedRtkHook.includes("function homeDir()") && updatedRtkHook.includes('join(homeDir(), ".pai")'), join(installRoot, "hooks", "RtkPreToolUse.hook.js")),
  check("SmartApprover updated from release", updatedSmartApproverHook.includes("const HOME = homeDir()") && updatedSmartApproverHook.includes("getFrameworkDir, homeDir, userPath"), join(installRoot, "hooks", "SmartApprover.hook.ts")),
  check("Checkpoint hook updated from release", updatedCheckpointHook.includes("const HOME = homeDir()") && updatedCheckpointHook.includes("windowsHide: true"), join(installRoot, "hooks", "CheckpointPerISC.hook.ts")),
  check("ToolActivityTracker updated from release", updatedToolActivityTrackerHook.includes("CAPTURE_GIT_SNAPSHOT") && updatedToolActivityTrackerHook.includes("windowsHide: true"), join(installRoot, "hooks", "ToolActivityTracker.hook.ts")),
  check("hook path helper exports homeDir", updatedHookPaths.includes("export function homeDir()"), join(installRoot, "hooks", "lib", "paths.ts")),
  check("OpenCode plugin updated from release", updatedOpenCodePlugin.includes("PAI_OPENCODE_HOOK_TIMEOUT_MS"), join(installRoot, "plugins", "pai-opencode.ts")),
  check("MemoryDelete smoke installed", existsSync(join(installRoot, "PAI", "TOOLS", "MemoryDeleteSmokeTest.ts")), join(installRoot, "PAI", "TOOLS", "MemoryDeleteSmokeTest.ts")),
  check("Framework command smoke installed", existsSync(join(installRoot, "PAI", "TOOLS", "FrameworkCommandResolutionSmokeTest.ts")), join(installRoot, "PAI", "TOOLS", "FrameworkCommandResolutionSmokeTest.ts")),
  check("Framework launch smoke installed", existsSync(join(installRoot, "PAI", "TOOLS", "FrameworkLaunchCwdSmokeTest.ts")), join(installRoot, "PAI", "TOOLS", "FrameworkLaunchCwdSmokeTest.ts")),
  check("hooks.json regenerated with PromptProcessing", updatedHooksJson.includes("PromptProcessing.hook.ts"), join(installRoot, "hooks.json")),
  check("PromptProcessing timeout leaves adapter headroom", promptProcessingTimeoutHasHeadroom(updatedHooksJson), join(installRoot, "hooks.json")),
  check("hooks.json regenerated with ISA sync hooks", updatedHooksJson.includes("ISASync.hook.ts") && updatedHooksJson.includes("CheckpointPerISC.hook.ts"), join(installRoot, "hooks.json")),
  check("hooks.json Windows commands avoid encoded PowerShell", process.platform !== "win32" || (!updatedHooksJson.includes("-EncodedCommand") && !updatedHooksJson.includes("powershell.exe") && updatedHooksJson.includes("bun.exe")), join(installRoot, "hooks.json")),
  check("hooks.json ignores stale env PAI_DATA_DIR", hookDataDirs.length > 0 && hookDataDirs.every((value) => value.endsWith(expectedHookDataSuffix) && !value.includes(staleHookDataSegment)), JSON.stringify(hookDataDirs)),
  check("updater refreshes PAI environment variables", process.platform !== "win32" || update.stdout.includes("Updated PAI environment variables at Process scope"), "process-scope user env test"),
  check("hotfix repairs PowerShell all-host profile", process.platform !== "win32" || (powerShellAllHostsProfileText.includes("Initialize-PAIEnvironment") && powerShellAllHostsProfileText.includes("PAI_DIR")), powerShellAllHostsProfile),
  check("hotfix repairs PowerShell profile PAI_DIR", process.platform !== "win32" || (powerShellProfileText.includes("Initialize-PAIEnvironment") && powerShellProfileText.includes("PAI_DIR")), powerShellProfile),
  check("hotfix repairs WindowsPowerShell all-host profile", process.platform !== "win32" || (windowsPowerShellAllHostsProfileText.includes("Initialize-PAIEnvironment") && windowsPowerShellAllHostsProfileText.includes("PAI_DIR")), windowsPowerShellAllHostsProfile),
  check("hotfix repairs WindowsPowerShell profile PAI_DIR", process.platform !== "win32" || (windowsPowerShellProfileText.includes("Initialize-PAIEnvironment") && windowsPowerShellProfileText.includes("PAI_DIR")), windowsPowerShellProfile),
  check("hotfix repairs OneDrive PowerShell profiles", process.platform !== "win32" || profileTexts.slice(4).every((text) => text.includes("Initialize-PAIEnvironment") && text.includes("PAI_DIR")), oneDriveRoot),
  check("PowerShell profiles avoid stale smoke roots", process.platform !== "win32" || profileTexts.every((text) => !text.includes(staleEnvDataDir) && !text.includes(join(root, "deleted-codex"))), "profile bootstrap paths"),
  check("PowerShell bootstrap repairs stale PAI_DIR", process.platform !== "win32" || powerShellAllHostsProfileText.includes("-not (Test-Path -LiteralPath $env:PAI_DIR)"), powerShellAllHostsProfile),
  check("config.toml protected", read(join(installRoot, "config.toml")) === sentinels.config, join(installRoot, "config.toml")),
  check("auth.json protected", read(join(installRoot, "auth.json")) === sentinels.auth, join(installRoot, "auth.json")),
  check("USER protected", read(join(installRoot, "PAI", "USER", "profile.md")) === sentinels.user, join(installRoot, "PAI", "USER", "profile.md")),
  check("MEMORY protected", read(join(installRoot, "MEMORY", "STATE", "state.json")) === sentinels.memory, join(installRoot, "MEMORY", "STATE", "state.json")),
];

if (backupRoot) copyDirectoryContents(backupRoot, installRoot);

const rollbackChecks: Check[] = [
  check("rollback restores AGENTS.md", read(join(installRoot, "AGENTS.md")) === sentinels.agents, join(installRoot, "AGENTS.md")),
  check("rollback restores pai.ts", read(join(installRoot, "PAI", "TOOLS", "pai.ts")) === sentinels.paiTool, join(installRoot, "PAI", "TOOLS", "pai.ts")),
  check("rollback restores RepeatDetection", read(join(installRoot, "hooks", "RepeatDetection.hook.ts")) === sentinels.repeatHook, join(installRoot, "hooks", "RepeatDetection.hook.ts")),
  check("rollback restores PromptGuard", read(join(installRoot, "hooks", "PromptGuard.hook.ts")) === sentinels.promptGuardHook, join(installRoot, "hooks", "PromptGuard.hook.ts")),
  check("rollback restores OpenCode plugin", read(join(installRoot, "plugins", "pai-opencode.ts")) === sentinels.opencodePlugin, join(installRoot, "plugins", "pai-opencode.ts")),
];

// ---------------------------------------------------------------------------
// OpenCode hotfix update scenario
//
// Proves the same updater can patch an existing OpenCode install: it overlays
// the managed plugin from the release, then regenerates native OpenCode
// artifacts (schema-clean opencode.json, mode:subagent agents, Skill-free
// commands) via the installed PAI CLI while preserving protected state.
// ---------------------------------------------------------------------------

function jsonParseOrNull(text: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const ocHome = join(root, "oc-home");
const ocDataDir = join(ocHome, ".pai");
const ocConfigDir = join(ocHome, ".config", "PAI");
const ocInstallRoot = join(root, "old-opencode");

const ocSentinels = {
  plugin: "OLD_OC_PLUGIN_SENTINEL",
  config: "PROTECTED_OC_CONFIG_SENTINEL",
  auth: "PROTECTED_OC_AUTH_SENTINEL",
  user: "PROTECTED_OC_USER_SENTINEL",
  memory: "PROTECTED_OC_MEMORY_SENTINEL",
};

// Reuse the already-built release fixture as a complete OpenCode install tree so
// the installed PAI CLI has everything it needs to regenerate native artifacts.
mkdirSync(ocHome, { recursive: true });
mkdirSync(ocDataDir, { recursive: true });
cpSync(installedSourceRoot, ocInstallRoot, { recursive: true, force: true });
// A real OpenCode install carries an AGENTS.md plus a CLAUDE.md source that the
// CLI transforms; make sure both point at the algorithm entrypoint.
write(join(ocInstallRoot, "CLAUDE.md"), "**MANDATORY FIRST ACTION:** Read `$PAI_DIR/ALGORITHM/LATEST` from the active PAI subsystem directory.");
write(join(ocInstallRoot, "AGENTS.md"), "**MANDATORY FIRST ACTION:** Read `$PAI_DIR/ALGORITHM/LATEST` from the active PAI subsystem directory.");
write(join(ocInstallRoot, "PAI", "ALGORITHM", "LATEST"), "6.3.0");
write(join(ocInstallRoot, "PAI", "ALGORITHM", "v6.3.0.md"), "# algorithm placeholder");
// Stale plugin proves the manifest overlay refreshes it from the release.
write(join(ocInstallRoot, "plugins", "pai-opencode.ts"), ocSentinels.plugin);
// A pre-existing opencode.json carrying unsupported keys proves regeneration
// strips env/pai and forces instructions back to AGENTS.md.
write(join(ocInstallRoot, "opencode.json"), JSON.stringify({
  "$schema": "https://opencode.ai/config.json",
  instructions: ["CLAUDE.md"],
  env: { PAI_LEGACY: "1" },
  pai: { framework: "opencode" },
  mcp: { legacy: { type: "local", command: ["echo", "ok"], enabled: true } },
}, null, 2));
// Protected state that must survive the update untouched.
write(join(ocInstallRoot, "config.toml"), ocSentinels.config);
write(join(ocInstallRoot, "auth.json"), ocSentinels.auth);
write(join(ocInstallRoot, "PAI", "USER", "profile.md"), ocSentinels.user);
write(join(ocInstallRoot, "MEMORY", "STATE", "state.json"), ocSentinels.memory);
write(join(ocDataDir, "framework.json"), JSON.stringify({
  active: "opencode",
  frameworkName: "OpenCode",
  root: ocInstallRoot,
  dataDir: ocDataDir,
}, null, 2));

const ocUpdateArgs = process.platform === "win32"
  ? [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(releaseRoot, "update-installed.ps1"),
      "-Framework",
      "opencode",
      "-InstallRoot",
      ocInstallRoot,
      "-NoPull",
      "-SourceDir",
      installedSourceRoot,
    ]
  : [
      join(releaseRoot, "update-installed.sh"),
      "--framework",
      "opencode",
      "--install-root",
      ocInstallRoot,
      "--no-pull",
      "--source-dir",
      installedSourceRoot,
    ];

const ocUpdate = spawnSync(updateCommand, ocUpdateArgs, {
  cwd: repoRoot,
  encoding: "utf-8",
  timeout: 180_000,
  maxBuffer: 20 * 1024 * 1024,
  windowsHide: true,
  env: {
    ...process.env,
    HOME: ocHome,
    USERPROFILE: ocHome,
    OneDrive: join(ocHome, "OneDrive"),
    OPENCODE_CONFIG_DIR: ocInstallRoot,
    PAI_DATA_DIR: ocDataDir,
    PAI_CONFIG_DIR: ocConfigDir,
    PAI_FRAMEWORK_DIR: ocInstallRoot,
    PAI_FRAMEWORK: "opencode",
    PAI_SKIP_USER_ENV_UPDATE: "1",
    PAI_USER_ENV_TARGET: "Process",
  },
});

const ocOpenCodeConfig = jsonParseOrNull(read(join(ocInstallRoot, "opencode.json")));
const ocPlugin = read(join(ocInstallRoot, "plugins", "pai-opencode.ts"));
const ocAgentArchitect = read(join(ocInstallRoot, "agents", "Architect.md"));
const ocAgentEngineer = read(join(ocInstallRoot, "agents", "Engineer.md"));
const ocCommand = read(join(ocInstallRoot, "commands", "cs.md"));
const ocFrameworkState = jsonParseOrNull(read(join(ocDataDir, "framework.json")));

function agentIsNativeOpenCode(text: string): boolean {
  return text.length > 0
    && /(^|\n)mode:\s*subagent\b/.test(text)
    && text.includes("rendered from the provider-neutral")
    && !text.includes("Claude Code")
    && !text.includes("CLAUDE.md");
}

const ocAgentName = agentIsNativeOpenCode(ocAgentArchitect)
  ? "Architect.md"
  : agentIsNativeOpenCode(ocAgentEngineer)
    ? "Engineer.md"
    : "";
const ocNativeAgent = ocAgentName === "Engineer.md" ? ocAgentEngineer : ocAgentArchitect;

function commandFrontmatter(text: string): string {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : "";
}
const ocCommandFront = commandFrontmatter(ocCommand);

const opencodeChecks: Check[] = [
  check("opencode hotfix update exits cleanly", ocUpdate.status === 0, `status=${ocUpdate.status ?? "null"} ${ocUpdate.stderr.split(/\r?\n/).slice(-4).join(" | ")}`),
  check("opencode.json is valid JSON", ocOpenCodeConfig !== null, join(ocInstallRoot, "opencode.json")),
  check("opencode.json instructions point at AGENTS.md", JSON.stringify(ocOpenCodeConfig?.instructions) === JSON.stringify(["AGENTS.md"]), JSON.stringify(ocOpenCodeConfig?.instructions)),
  check("opencode.json keeps the OpenCode schema", ocOpenCodeConfig?.["$schema"] === "https://opencode.ai/config.json", String(ocOpenCodeConfig?.["$schema"])),
  check("opencode.json strips unsupported env/pai keys", Boolean(ocOpenCodeConfig) && !("env" in (ocOpenCodeConfig as object)) && !("pai" in (ocOpenCodeConfig as object)), JSON.stringify(Object.keys(ocOpenCodeConfig || {}))),
  check(
    "plugins/pai-opencode.ts updated from release",
    ocPlugin !== ocSentinels.plugin &&
      ocPlugin.includes("PAI_OPENCODE_HOOK_TIMEOUT_MS") &&
      ocPlugin.includes('import { expandPath, homeDir } from "../hooks/lib/paths"') &&
      ocPlugin.includes("const HOME = homeDir()") &&
      !ocPlugin.includes('from "os"') &&
      !ocPlugin.includes("process.env.HOME || process.env.USERPROFILE || homedir()"),
    join(ocInstallRoot, "plugins", "pai-opencode.ts"),
  ),
  check("OpenCode native agent generated with mode: subagent", ocAgentName !== "", join(ocInstallRoot, "agents", ocAgentName || "Architect.md")),
  check("OpenCode native agent is provider-neutral", agentIsNativeOpenCode(ocNativeAgent), join(ocInstallRoot, "agents", ocAgentName || "Architect.md")),
  check("OpenCode command generated without Skill() calls", ocCommand.length > 0 && !ocCommand.includes('Skill("'), join(ocInstallRoot, "commands", "cs.md")),
  check("OpenCode command drops Claude-only frontmatter", ocCommandFront.length > 0 && !/(^|\n)argument-hint:/.test(ocCommandFront) && !/(^|\n)name:/.test(ocCommandFront), ocCommandFront),
  check("framework.json marks opencode active root/dataDir", ocFrameworkState?.active === "opencode" && ocFrameworkState?.root === ocInstallRoot && ocFrameworkState?.dataDir === ocDataDir, JSON.stringify(ocFrameworkState)),
  check("opencode update preserves config.toml", read(join(ocInstallRoot, "config.toml")) === ocSentinels.config, join(ocInstallRoot, "config.toml")),
  check("opencode update preserves auth.json", read(join(ocInstallRoot, "auth.json")) === ocSentinels.auth, join(ocInstallRoot, "auth.json")),
  check("opencode update preserves USER", read(join(ocInstallRoot, "PAI", "USER", "profile.md")) === ocSentinels.user, join(ocInstallRoot, "PAI", "USER", "profile.md")),
  check("opencode update preserves MEMORY", read(join(ocInstallRoot, "MEMORY", "STATE", "state.json")) === ocSentinels.memory, join(ocInstallRoot, "MEMORY", "STATE", "state.json")),
];

const checks = [...beforeRollbackChecks, ...rollbackChecks, ...opencodeChecks];
print(checks);

if (keep) {
  console.log(`\nKept smoke root: ${root}`);
} else {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} hotfix update/rollback smoke check(s) failed.`);
  process.exit(1);
}

console.log(`\nAll hotfix update/rollback smoke checks passed.${remote ? " (remote branch source)" : ""}`);
