#!/usr/bin/env bun
/**
 * CodexBranchValidation
 *
 * CI entrypoint for the Codex PAI release branch. Keeps branch validation
 * reproducible locally and in GitHub Actions.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

type ValidationMode = "safe" | "deep";

const releaseRoot = resolve(import.meta.dir, "..", "..");
const repoRoot = resolve(releaseRoot, "..", "..", "..");
const tempRoot = mkdtempSync(join(tmpdir(), "pai-codex-branch-ci-"));
const validationMode = validationModeFromArgs(process.argv.slice(2));
const checks: Check[] = [];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function validationModeFromArgs(args: string[]): ValidationMode {
  if (
    args.includes("--deep") ||
    args.includes("--full") ||
    process.env.PAI_BRANCH_VALIDATION_DEEP === "1" ||
    process.env.GITHUB_ACTIONS === "true"
  ) {
    return "deep";
  }
  return "safe";
}

function run(name: string, command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): void {
  const resolvedCommand = command === "bun" ? process.execPath : (Bun.which(command) || command);
  const spawnCommand = process.platform === "win32" && resolvedCommand.toLowerCase().endsWith(".cmd")
    ? (process.env.ComSpec || "cmd.exe")
    : resolvedCommand;
  const spawnArgs = spawnCommand === resolvedCommand ? args : ["/d", "/c", resolvedCommand, ...args];
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: options.cwd || releaseRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf-8",
    timeout: options.timeout || 120_000,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const detail = result.status === 0
    ? output.split(/\r?\n/).slice(-1)[0] || `${command} ${args.join(" ")}`
    : `status=${result.status ?? "null"} signal=${result.signal ?? ""} error=${result.error?.message || ""}\n${output.split(/\r?\n/).slice(-80).join("\n")}`;
  check(name, result.status === 0, detail);
}

function walk(dir: string, predicate: (path: string) => boolean, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", ".next", "out", "dist", "coverage"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, predicate, acc);
    else if (predicate(path)) acc.push(path);
  }
  return acc;
}

function validateJson(): void {
  const jsonFiles = walk(repoRoot, (path) => path.endsWith(".json") || path.endsWith(".mcp.json"));
  const failures: string[] = [];
  for (const path of jsonFiles) {
    try {
      const raw = readFileSync(path, "utf-8");
      const text = /(^|[/\\])tsconfig[^/\\]*\.json$/.test(path) ? stripJsonComments(raw) : raw;
      JSON.parse(text);
    } catch (err) {
      failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  check("JSON validation", failures.length === 0, failures.length === 0 ? `${jsonFiles.length} JSON files parsed` : failures.slice(0, 12).join("\n"));
}

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function validateReadmeUrls(): void {
  const readmes = [
    join(repoRoot, "README.md"),
    join(repoRoot, "Releases", "v5.0.0", "README.md"),
    join(releaseRoot, "README.md"),
  ];
  const stalePatterns = [
    "pai-codex-windows-installer",
    "raw.githubusercontent.com/jSydorowicz21/Personal_AI_Infrastructure",
    "github.com/jSydorowicz21/Personal_AI_Infrastructure",
  ];
  const failures: string[] = [];
  for (const path of readmes) {
    const text = existsSync(path) ? readFileSync(path, "utf-8") : "";
    for (const pattern of stalePatterns) {
      if (text.includes(pattern)) failures.push(`${path}: ${pattern}`);
    }
  }
  check("README stale URL scan", failures.length === 0, failures.length === 0 ? "no known stale fork/branch URLs" : failures.join("\n"));
}

function validateDoctorDiscoverability(): void {
  const files = [
    join(repoRoot, "README.md"),
    join(releaseRoot, "README.md"),
    join(releaseRoot, "PAI", "PAI-Install", "README.md"),
    join(releaseRoot, "PAI", "TOOLS", "pai.ts"),
  ];
  const missing = files.filter((path) => !readFileSync(path, "utf-8").includes("k doctor"));
  run("k help documents doctor", "bun", ["PAI/TOOLS/pai.ts", "help"]);
  check("doctor docs discoverability", missing.length === 0, missing.length === 0 ? "k doctor appears in CLI help and docs" : missing.join("\n"));
}

function validateHotfixDryRun(): void {
  const installRoot = join(tempRoot, "install-root");
  const home = join(tempRoot, "home");
  const paiData = join(home, ".pai");
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(paiData, { recursive: true });
  const command = process.platform === "win32" ? "powershell" : "bash";
  const args = process.platform === "win32"
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
        "-SourceDir",
        repoRoot,
        "-NoPull",
        "-DryRun",
      ]
    : [
        join(releaseRoot, "update-installed.sh"),
        "--framework",
        "codex",
        "--install-root",
        installRoot,
        "--source-dir",
        repoRoot,
        "--no-pull",
        "--dry-run",
      ];
  run("hotfix dry-run", command, args, {
    cwd: repoRoot,
    env: {
      HOME: home,
      CODEX_HOME: installRoot,
      PAI_DATA_DIR: paiData,
    },
  });
}

function main(): void {
  try {
    run("Bun build critical TypeScript", "bun", [
      "build",
      "PAI/PAI-Install/main.ts",
      "PAI/TOOLS/pai.ts",
      "PAI/TOOLS/algorithm.ts",
      "PAI/TOOLS/Inference.ts",
      "PAI/TOOLS/FailureCapture.ts",
      "PAI/bin/llcli/llcli.ts",
      "PAI/TOOLS/PaiDoctor.ts",
      "PAI/TOOLS/PaiDoctorSmokeTest.ts",
      "PAI/TOOLS/CodexFreshInstallSmokeTest.ts",
      "PAI/TOOLS/InstallerCodexSmokeTest.ts",
      "PAI/TOOLS/InstallerProviderEnvSmokeTest.ts",
      "PAI/TOOLS/CodexPaiSecuritySmokeTest.ts",
      "PAI/TOOLS/HookSharedPathSmokeTest.ts",
      "PAI/TOOLS/StartupSelfCheckSmokeTest.ts",
      "PAI/TOOLS/RepeatDetectionSmokeTest.ts",
      "PAI/TOOLS/CodexHookContractSmokeTest.ts",
      "PAI/TOOLS/LoadContextSmokeTest.ts",
      "PAI/TOOLS/LimitlessCliConfigSmokeTest.ts",
      "PAI/TOOLS/PaiSecurityAuditSmokeTest.ts",
      "PAI/TOOLS/ContainmentZonesSmokeTest.ts",
      "PAI/TOOLS/HotfixUpdateRollbackSmokeTest.ts",
      "PAI/TOOLS/JunctionSafeUpdateSmokeTest.ts",
      "PAI/TOOLS/SessionEndLifecycleSmokeTest.ts",
      "PAI/TOOLS/CodexNativeRuntimeSmokeTest.ts",
      "PAI/TOOLS/PerformanceCostAggregatorSmokeTest.ts",
      "PAI/TOOLS/CodexFrameworkAgentExecutionSmokeTest.ts",
      "PAI/TOOLS/OpenCodeFrameworkAgentExecutionSmokeTest.ts",
      "PAI/TOOLS/TranscriptParserSmokeTest.ts",
      "PAI/TOOLS/IdentityProviderFallbackSmokeTest.ts",
      "PAI/TOOLS/ChangeDetectionSmokeTest.ts",
      "PAI/TOOLS/ConfigAuditSmokeTest.ts",
      "PAI/TOOLS/DocCheckSmokeTest.ts",
      "PAI/TOOLS/ReferenceCheckSmokeTest.ts",
      "PAI/TOOLS/RebuildArchSummarySmokeTest.ts",
      "PAI/TOOLS/FrameworkSmokeTest.ts",
      "PAI/TOOLS/FrameworkCommandResolutionSmokeTest.ts",
      "PAI/TOOLS/FrameworkLaunchCwdSmokeTest.ts",
      "PAI/TOOLS/MemoryDelete.ts",
      "PAI/TOOLS/MemoryDeleteSmokeTest.ts",
      "hooks/FrameworkHookAdapter.ts",
      "hooks/KVSync.hook.ts",
      "hooks/SatisfactionCapture.hook.ts",
      "hooks/ToolActivityTracker.hook.ts",
      "hooks/RtkPreToolUse.hook.js",
      "--target=bun",
      "--outdir",
      join(tempRoot, "build"),
    ]);

    validateJson();
    check(
      "Validation mode",
      true,
      validationMode === "deep"
        ? "deep probes enabled by --deep/CI"
        : "safe local mode; pass --deep for child/session/install probes",
    );

    run("Codex security smoke", "bun", ["PAI/TOOLS/CodexPaiSecuritySmokeTest.ts"]);
    run("Startup self-check smoke", "bun", ["PAI/TOOLS/StartupSelfCheckSmokeTest.ts"], {
      env: {
        PAI_BRANCH_CI: "1",
        PAI_FRAMEWORK_DIR: releaseRoot,
        PAI_DIR: join(releaseRoot, "PAI"),
        PAI_DATA_DIR: join(tempRoot, "pai-data"),
      },
    });
    run("Codex hook contract smoke", "bun", ["PAI/TOOLS/CodexHookContractSmokeTest.ts"], {
      env: {
        PAI_FRAMEWORK_DIR: releaseRoot,
        PAI_DIR: join(releaseRoot, "PAI"),
        PAI_DATA_DIR: join(tempRoot, "pai-data-hook-contract"),
      },
    });
    run("Installer provider env smoke", "bun", ["PAI/TOOLS/InstallerProviderEnvSmokeTest.ts"]);
    run("LoadContext smoke", "bun", ["PAI/TOOLS/LoadContextSmokeTest.ts"]);
    run("Limitless CLI config smoke", "bun", ["PAI/TOOLS/LimitlessCliConfigSmokeTest.ts"]);
    run("PAI security audit smoke", "bun", ["PAI/TOOLS/PaiSecurityAuditSmokeTest.ts"]);
    run("Containment zones smoke", "bun", ["PAI/TOOLS/ContainmentZonesSmokeTest.ts"]);
    run("Codex native runtime smoke", "bun", ["PAI/TOOLS/CodexNativeRuntimeSmokeTest.ts"]);
    run("Performance cost aggregator smoke", "bun", ["PAI/TOOLS/PerformanceCostAggregatorSmokeTest.ts"]);
    run("Transcript parser smoke", "bun", ["PAI/TOOLS/TranscriptParserSmokeTest.ts"]);
    run("Integrity transcript smoke", "bun", ["PAI/TOOLS/IntegrityMaintenanceTranscriptSmokeTest.ts"]);
    run("Relationship memory transcript smoke", "bun", ["PAI/TOOLS/RelationshipMemoryTranscriptSmokeTest.ts"]);
    run("Provider transcript consumers smoke", "bun", ["PAI/TOOLS/ProviderTranscriptConsumersSmokeTest.ts"]);
    run("Identity provider fallback smoke", "bun", ["PAI/TOOLS/IdentityProviderFallbackSmokeTest.ts"]);
    run("Change detection smoke", "bun", ["PAI/TOOLS/ChangeDetectionSmokeTest.ts"]);
    run("Config audit smoke", "bun", ["PAI/TOOLS/ConfigAuditSmokeTest.ts"]);
    run("DocCheck smoke", "bun", ["PAI/TOOLS/DocCheckSmokeTest.ts"]);
    run("ReferenceCheck smoke", "bun", ["PAI/TOOLS/ReferenceCheckSmokeTest.ts"]);
    run("Rebuild architecture summary smoke", "bun", ["PAI/TOOLS/RebuildArchSummarySmokeTest.ts"]);
    run("Banner provider counts smoke", "bun", ["PAI/TOOLS/BannerProviderCountsSmokeTest.ts"]);
    run("MemoryRetriever smoke", "bun", ["PAI/TOOLS/MemoryRetrieverSmokeTest.ts"]);
    run("Codex framework parity smoke", "bun", ["PAI/TOOLS/FrameworkSmokeTest.ts", "--framework", "codex"], { timeout: 120_000 });
    run("PAI doctor smoke", "bun", ["PAI/TOOLS/PaiDoctorSmokeTest.ts"]);
    validateReadmeUrls();
    validateDoctorDiscoverability();

    if (validationMode === "deep") {
      run("Hook shared-path smoke", "bun", ["PAI/TOOLS/HookSharedPathSmokeTest.ts"]);
      run("Repeat detection smoke", "bun", ["PAI/TOOLS/RepeatDetectionSmokeTest.ts"], {
        env: {
          PAI_FRAMEWORK_DIR: releaseRoot,
          PAI_DIR: join(releaseRoot, "PAI"),
          PAI_DATA_DIR: join(tempRoot, "pai-data-repeat"),
        },
      });
      run("Codex framework-agent execution smoke", "bun", ["PAI/TOOLS/CodexFrameworkAgentExecutionSmokeTest.ts"]);
      run("OpenCode framework-agent execution smoke", "bun", ["PAI/TOOLS/OpenCodeFrameworkAgentExecutionSmokeTest.ts"]);
      run("Codex framework parity smoke deep", "bun", ["PAI/TOOLS/FrameworkSmokeTest.ts", "--framework", "codex"], { timeout: 120_000 });
      run("Framework command resolution smoke", "bun", ["PAI/TOOLS/FrameworkCommandResolutionSmokeTest.ts"]);
      run("Framework launch cwd smoke", "bun", ["PAI/TOOLS/FrameworkLaunchCwdSmokeTest.ts"]);
      run("Memory delete smoke", "bun", ["PAI/TOOLS/MemoryDeleteSmokeTest.ts"]);
      run("Hotfix update/rollback smoke", "bun", ["PAI/TOOLS/HotfixUpdateRollbackSmokeTest.ts"]);
      run("Junction-safe update smoke", "bun", ["PAI/TOOLS/JunctionSafeUpdateSmokeTest.ts"]);
      run("SessionEnd lifecycle smoke", "bun", ["PAI/TOOLS/SessionEndLifecycleSmokeTest.ts"]);
      run("Codex fresh-install smoke", "bun", ["PAI/TOOLS/CodexFreshInstallSmokeTest.ts"]);
      run("Codex installer smoke", "bun", ["PAI/TOOLS/InstallerCodexSmokeTest.ts"]);
      validateHotfixDryRun();
    } else {
      check("Deep validation probes skipped", true, "local safe mode; pass --deep or run in GitHub Actions");
    }

    const failed = checks.filter((item) => !item.passed);
    if (failed.length > 0) {
      console.error(`\nPAI Codex branch validation failed: ${failed.length} check(s).`);
      process.exit(1);
    }
    console.log(`\nPAI Codex branch validation passed: ${checks.length} check(s).`);
  } finally {
    const resolved = resolve(tempRoot);
    if (dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-codex-branch-ci-")) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main();
