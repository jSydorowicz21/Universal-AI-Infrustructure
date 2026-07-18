#!/usr/bin/env bun
/**
 * PaiSecurityAuditSmokeTest
 *
 * Release security regression check for the Codex flawless track. It keeps the
 * security audit mechanical: hook hard-block surfaces, MCP secret hygiene,
 * protected file tracking, hotfix overlay scope, and Interceptor risk docs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const releaseRoot = resolve(import.meta.dir, "..", "..");
const repoRoot = resolve(releaseRoot, "..", "..", "..");
const hooksDir = join(releaseRoot, "hooks");
const mcpDir = join(releaseRoot, "MCPs");
const interceptorDir = join(releaseRoot, "skills", "Interceptor");
const manifestPath = join(releaseRoot, "hotfix-manifest.json");
const checks: Check[] = [];

const ALLOWED_NONZERO_HOOKS = new Set([
  "hooks/PromptGuard.hook.ts",
  "hooks/SecurityPipeline.hook.ts",
  "hooks/ContainmentGuard.hook.ts",
  "hooks/TaskGovernance.hook.ts",
  "hooks/FrameworkHookAdapter.ts",
  // SkillGuard mirrors Claude's Pulse skill-guard for Codex/OpenCode command
  // hooks: it denies known false-positive skill invocations (e.g. keybindings-help).
  "hooks/SkillGuard.hook.ts",
]);

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-(?:ant|proj|live|test)-[A-Za-z0-9_-]{12,}\b/, "API key"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/, "GitHub token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/, "private key"],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}\b/i, "bearer token"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/, "JWT"],
];

const SAFE_ENV_PLACEHOLDERS = new Set([
  "API_TOKEN",
  "PRO_MODE",
  "APIFY_TOKEN",
]);

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function walk(dir: string, predicate: (path: string) => boolean, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, predicate, acc);
    else if (predicate(path)) acc.push(path);
  }
  return acc;
}

function slash(path: string): string {
  return path.replace(/\\/g, "/");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function collectStringValues(value: unknown, path = "$", out: Array<{ path: string; value: string }> = []): Array<{ path: string; value: string }> {
  if (typeof value === "string") {
    out.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringValues(item, `${path}[${index}]`, out));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) collectStringValues(child, `${path}.${key}`, out);
  }
  return out;
}

function securityRelevantHookAudit(): void {
  const hookFiles = walk(hooksDir, (path) => /\.(ts|js|sh)$/.test(path));
  const unexpected: string[] = [];
  const hardBlockSurfaces = new Set<string>();

  for (const path of hookFiles) {
    const rel = slash(relative(releaseRoot, path));
    const text = readFileSync(path, "utf-8");
    if (/process\.exit\(([1-9]\d*)\)|process\.exitCode\s*=\s*[1-9]/.test(text) || /permissionDecision:\s*["']deny["']/.test(text)) {
      hardBlockSurfaces.add(rel);
      if (!ALLOWED_NONZERO_HOOKS.has(rel) && basename(path) !== "RtkPreToolUse.hook.js") {
        unexpected.push(rel);
      }
    }
  }

  check("all hook source files reviewed", hookFiles.length >= 60, `${hookFiles.length} hook/support source file(s)`);
  check("hook hard-block surfaces allowlisted", unexpected.length === 0, unexpected.length ? unexpected.join(", ") : [...hardBlockSurfaces].sort().join(", "));
}

function mcpSecretAudit(): void {
  const files = walk(mcpDir, (path) => path.endsWith(".json") || path.endsWith(".mcp.json"));
  const findings: string[] = [];

  for (const file of files) {
    const rel = slash(relative(releaseRoot, file));
    const parsed = readJson(file);
    const values = collectStringValues(parsed);
    for (const { path, value } of values) {
      if (SAFE_ENV_PLACEHOLDERS.has(value)) continue;
      for (const [pattern, label] of SECRET_PATTERNS) {
        if (pattern.test(value)) findings.push(`${rel} ${path}: ${label}`);
      }
    }
  }

  check("MCP profiles parse and avoid literal secrets", findings.length === 0, findings.length ? findings.join("\n") : `${files.length} MCP profile(s)`);
}

function trackedSecretAudit(): void {
  if (!existsSync(join(repoRoot, ".git"))) {
    check("tracked secret files absent", true, "not a git checkout; branch CI performs git tracked-file audit");
    return;
  }

  const result = spawnSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 10_000,
    windowsHide: true,
  });
  const files = (result.stdout || "").split(/\r?\n/).filter(Boolean);
  const forbidden = files.filter((path) => {
    const name = basename(path);
    if (name === ".env.example" || path.endsWith("/.env.example")) return false;
    if (path.includes("/MCPs/") && /\.(json|mcp\.json)$/.test(path)) return false;
    if (path === "Releases/v5.0.0/.claude/.mcp.json") return false;
    return /(^|\/)(\.env|\.env\..+|auth\.json|credentials?\.json|credential-store\.json|token\.json|tokens\.json|secrets?\.json)$/i.test(path);
  });

  check("tracked secret files absent", forbidden.length === 0, forbidden.length ? forbidden.join(", ") : `${files.length} tracked file(s) audited`);
}

function hotfixManifestAudit(): void {
  const manifest = readJson(manifestPath);
  const forbidden: string[] = [];
  const missingSources: string[] = [];
  const sourceEntries = new Set<string>();

  function isManifestCovered(relPath: string): boolean {
    const normalized = slash(relPath);
    if (sourceEntries.has(normalized)) return true;
    for (const source of sourceEntries) {
      if (normalized.startsWith(`${source}/`)) return true;
    }
    return false;
  }

  for (const entry of manifest.entries || []) {
    const source = slash(String(entry.source || ""));
    if (source) {
      sourceEntries.add(source);
      if (!existsSync(join(releaseRoot, source))) missingSources.push(source);
    }
    const targets = entry.targets && typeof entry.targets === "object"
      ? Object.values(entry.targets)
      : [entry.target || entry.source];
    for (const target of targets) {
      const t = String(target || "");
      if (!t) continue;
      if (/^(PAI\/USER|USER|MEMORY|PAI\/MEMORY)(\/|$)/.test(t)) forbidden.push(t);
      if (/(^|\/)(config\.toml|auth\.json|settings\.json|\.env|\.env\..*)$/.test(t)) forbidden.push(t);
    }
  }

  check("hotfix manifest avoids protected state/config", forbidden.length === 0, forbidden.length ? forbidden.join(", ") : `${manifest.entries?.length || 0} manifest entries`);
  check("hotfix manifest sources exist", missingSources.length === 0, missingSources.length ? missingSources.join(", ") : `${sourceEntries.size} source entries`);

  const requiredManagedSources = [
    "PAI/TOOLS/CodexBranchValidation.ts",
    "PAI/TOOLS/FailureCapture.ts",
    "PAI/TOOLS/FrameworkSmokeTest.ts",
    "PAI/TOOLS/MemoryDelete.ts",
    "hooks/FrameworkHookAdapter.ts",
    "hooks/ContextReduction.hook.sh",
    "hooks/KVSync.hook.ts",
    "hooks/RtkPreToolUse.hook.js",
    "hooks/SatisfactionCapture.hook.ts",
    "hooks/ToolActivityTracker.hook.ts",
  ];
  const missingManagedSources = requiredManagedSources.filter((source) => !isManifestCovered(source));
  check("hotfix manifest includes parity runtime files", missingManagedSources.length === 0, missingManagedSources.length ? missingManagedSources.join(", ") : requiredManagedSources.join(", "));

  const configGenPath = join(releaseRoot, "PAI", "PAI-Install", "engine", "config-gen.ts");
  const configGenText = readFileSync(configGenPath, "utf-8");
  const generatedHookTargets = [...configGenText.matchAll(/commandHook\(config,\s+"([^"]+)"/g)]
    .map((match) => `hooks/${match[1]}`)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
  const missingGeneratedHooks = generatedHookTargets.filter((source) => !isManifestCovered(source));
  check("hotfix manifest covers generated Codex hook targets", missingGeneratedHooks.length === 0, missingGeneratedHooks.length ? missingGeneratedHooks.join(", ") : generatedHookTargets.join(", "));

  const unresolvedImports: string[] = [];
  for (const source of sourceEntries) {
    const fullPath = join(releaseRoot, source);
    if (!existsSync(fullPath) || extname(fullPath) !== ".ts") continue;
    const text = readFileSync(fullPath, "utf-8");
    const importPattern = /(?:from\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\))/g;
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] || match[2] || "";
      if (!specifier.startsWith(".")) continue;
      const base = slash(relative(releaseRoot, resolve(dirname(fullPath), specifier)));
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.js`,
        `${base}/index.ts`,
        `${base}/module.ts`,
      ];
      const existing = candidates.find((candidate) => existsSync(join(releaseRoot, candidate)));
      if (existing && !isManifestCovered(existing)) unresolvedImports.push(`${source} -> ${existing}`);
    }
  }
  check("hotfix manifest covers managed TS imports", unresolvedImports.length === 0, unresolvedImports.length ? unresolvedImports.join("\n") : "relative imports covered");
}

function interceptorRiskDocsAudit(): void {
  const files = [
    join(interceptorDir, "SKILL.md"),
    join(interceptorDir, "Workflows", "VerifyDeploy.md"),
    join(interceptorDir, "Workflows", "ReplayFlow.md"),
  ];
  const text = files.filter(existsSync).map((path) => readFileSync(path, "utf-8")).join("\n");
  const required = [
    "No authentication on the socket",
    "Local-only; no network listener",
    "real Chrome login sessions",
    "supply-chain",
    "password fields",
  ];
  const missing = required.filter((needle) => !text.includes(needle));
  check("Interceptor browser/session risks documented", missing.length === 0, missing.length ? missing.join(", ") : `${required.length} risk phrase(s) present`);
}

securityRelevantHookAudit();
mcpSecretAudit();
trackedSecretAudit();
hotfixManifestAudit();
interceptorRiskDocsAudit();

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} PAI security audit check(s) failed.`);
  process.exit(1);
}

console.log("\nAll PAI security audit checks passed.");
