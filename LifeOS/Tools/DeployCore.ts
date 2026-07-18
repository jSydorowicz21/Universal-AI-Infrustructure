#!/usr/bin/env bun
/**
 * DeployCore — LifeOS Core deploy step (Setup step 4.5). Lays down the two
 * things the bare skill SHIPS in its install payload but no prior Setup step
 * installed: the functional skills library and the LIFEOS runtime tree
 * (Algorithm, documentation, tools, Pulse, statusline, version, user-templates).
 * Without it a fresh install has exactly one skill, no runtime, and the active
 * `@LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md` import in CLAUDE.md dangles.
 *
 * Every copy goes through InstallEngine.copyMissing — recursive, existsSync-
 * guarded, NEVER overwrites a populated target. So it is idempotent: a second
 * `--apply` copies 0. Dry-run by default (`--apply` to mutate); REFUSES the
 * author's live source tree (`--allow-dev` to override; exit 2). A required
 * payload source dir that is ABSENT is a LOUD blocker that fails the run
 * (exit 1) — never a silent ok (matches DeployComponents' failure contract).
 *
 * Targets the config-root runtime at the ALL-CAPS `<configRoot>/LIFEOS/` so it
 * matches the `@LIFEOS/...` imports in CLAUDE.md (NOT mixed-case `LifeOS`).
 *
 * Usage:
 *   bun DeployCore.ts [--config-root <dir>] [--skill-root <dir>] [--apply] [--allow-dev]
 *   (dry-run by default — reports the plan per target without writing)
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { defaultConfigRoot, detectDevTree } from "./InstallEngine";

// Runtime top-level entries this tool does NOT deploy:
//  - USER           shipped separately as a scaffold (ScaffoldUser) + symlinked (LinkUser)
//  - MEMORY         per-install state, never shipped — but scaffoldMemory() creates the
//                   empty tree at install so ISASync/hooks/memory writes have a home
//                   (this is where EmitSkill's "MEMORY scaffolded fresh at setup" becomes true)
//  - node_modules / .git  never deploy
// These are TOP-LEVEL entries of the runtime payload, so we filter them here explicitly.
const RUNTIME_SKIP = new Set(["USER", "MEMORY", "node_modules", ".git"]);

function arg(a: string[], flag: string): string | undefined {
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
}

interface DeployResult {
  what: "skills" | "runtime" | "hook-prerequisites" | "memory" | "dependencies";
  src: string;
  dst: string;
  present: boolean;
  copied: number;
  actions: string[];
  blockers: string[];
  failures: string[];
}

function countFiles(root: string): number {
  if (!existsSync(root)) return 0;
  if (statSync(root).isFile()) return 1;
  let count = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(root, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function overlay(src: string, dst: string, preserveExisting = false): { copied: number; failures: string[] } {
  const parent = dirname(dst);
  const nonce = `${process.pid}-${Date.now()}`;
  const stage = join(parent, `.${basename(dst)}.lifeos-stage-${nonce}`);
  const backup = join(parent, `.${basename(dst)}.lifeos-backup-${nonce}`);
  let movedExisting = false;
  try {
    mkdirSync(parent, { recursive: true });
    if (preserveExisting && existsSync(dst)) cpSync(dst, stage, { recursive: true, force: true });
    cpSync(src, stage, { recursive: true, force: true });
    if (existsSync(dst)) {
      renameSync(dst, backup);
      movedExisting = true;
    }
    renameSync(stage, dst);
    if (movedExisting) rmSync(backup, { recursive: true, force: true });
    return { copied: countFiles(src), failures: [] };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (movedExisting && !existsSync(dst) && existsSync(backup)) {
      try {
        renameSync(backup, dst);
      } catch {
        return { copied: 0, failures: [`${src} → ${dst}: replacement failed and backup restore failed`] };
      }
    }
    return { copied: 0, failures: [`${src} → ${dst}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** (a) skills library: install/skills/* → configRoot/skills/ (one copyMissing). */
function deploySkills(payloadInstall: string, configRoot: string, apply: boolean): DeployResult {
  const src = join(payloadInstall, "skills");
  const dst = join(configRoot, "skills");
  const r: DeployResult = { what: "skills", src, dst, present: existsSync(src), copied: 0, actions: [], blockers: [], failures: [] };
  if (!r.present) {
    r.blockers.push(`skills payload missing: ${src} — the bare-skill payload is unpopulated (run EmitSkill, or point --skill-root at a staged release)`);
    return r;
  }
  const skills = readdirSync(src, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of skills) {
    const skillSrc = join(src, name);
    const skillDst = join(dst, name);
    if (!apply) {
      r.actions.push(`overlay managed skill ${skillSrc} → ${skillDst}`);
      continue;
    }
    const result = overlay(skillSrc, skillDst);
    r.copied += result.copied;
    r.failures.push(...result.failures);
  }
  return r;
}

/** (b) runtime: install/LIFEOS/<entry> → configRoot/LIFEOS/<entry>, skipping RUNTIME_SKIP. */
function deployRuntime(payloadInstall: string, configRoot: string, apply: boolean): DeployResult {
  const src = existsSync(join(payloadInstall, "LIFEOS")) ? join(payloadInstall, "LIFEOS") : join(payloadInstall, "LifeOS");
  const dst = join(configRoot, "LIFEOS");
  const r: DeployResult = { what: "runtime", src, dst, present: existsSync(src), copied: 0, actions: [], blockers: [], failures: [] };
  if (!r.present) {
    r.blockers.push(`runtime payload missing: ${src} — the bare-skill payload is unpopulated (run EmitSkill, or point --skill-root at a staged release)`);
    return r;
  }
  const entries = readdirSync(src, { withFileTypes: true })
    .filter((entry) => !RUNTIME_SKIP.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) {
    r.blockers.push(`runtime payload at ${src} has nothing to deploy after skipping ${[...RUNTIME_SKIP].join(", ")}`);
    return r;
  }
  for (const name of entries) {
    const entrySrc = join(src, name);
    const entryDst = join(dst, name);
    if (!apply) {
      r.actions.push(`transactionally overlay managed runtime ${entrySrc} → ${entryDst}`);
      continue;
    }
    const result = overlay(entrySrc, entryDst);
    r.copied += result.copied;
    r.failures.push(...result.failures);
  }
  return r;
}

/** Core OMP and launcher imports require the hook libraries even when hook registration is declined. */
function deployHookPrerequisites(payloadInstall: string, configRoot: string, apply: boolean): DeployResult {
  const src = join(payloadInstall, "hooks");
  const dst = join(configRoot, "hooks");
  const r: DeployResult = { what: "hook-prerequisites", src, dst, present: existsSync(src), copied: 0, actions: [], blockers: [], failures: [] };
  if (!r.present) {
    r.blockers.push(`hook prerequisite payload missing: ${src}`);
    return r;
  }
  if (!apply) {
    r.actions.push(`transactionally overlay required hook libraries ${src} → ${dst} (registration remains opt-in)`);
    return r;
  }
  const result = overlay(src, dst, true);
  r.copied = result.copied;
  r.failures = result.failures;
  return r;
}

// MEMORY is per-install state rather than shipped payload, but every active
// top-level subsystem in MemorySystem.md's authoritative inventory must exist
// before hooks run. Reserved directories remain absent until they are needed.
const MEMORY_SUBDIRS = [
  "KNOWLEDGE",
  "WORK",
  "LEARNING",
  "WISDOM",
  "RESEARCH",
  "SECURITY",
  "STATE",
  "OBSERVABILITY",
  "VOICE",
  "RELATIONSHIP",
  "VERIFICATION",
  "TEAMS",
  "SKILLS",
  "SYSTEMUPDATES",
  "PLANS",
  "REFERENCE",
  "BOOKMARKS",
  "DATA",
  "SCRATCHPAD",
  "PROJECT",
  "ARCHIVE",
  "_AIRGRADIENT",
  "_HELIOS",
  "_NETWORK",
  "PULSE_DATA",
];

/** (c) MEMORY scaffold: create the empty per-install state dirs (never overwrites). */
function scaffoldMemory(configRoot: string, apply: boolean): DeployResult {
  const dst = join(configRoot, "LIFEOS", "MEMORY");
  const r: DeployResult = { what: "memory", src: "(scaffold — not shipped)", dst, present: true, copied: 0, actions: [], blockers: [], failures: [] };
  for (const sub of MEMORY_SUBDIRS) {
    const d = join(dst, sub);
    if (existsSync(d)) continue;
    if (!apply) { r.actions.push(`mkdir -p ${d}`); continue; }
    try {
      mkdirSync(d, { recursive: true });
      r.copied++;
    } catch (err) {
      r.failures.push(`mkdir ${d}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return r;
}

/**
 * (d) shared runtime deps: install/package.json → configRoot/package.json, then
 * `bun install` in configRoot. Several deployed hooks/TOOLS scripts (e.g.
 * hooks/lib/identity.ts, LIFEOS/TOOLS/Banner.ts) import npm packages (yaml)
 * that resolve via node_modules walked up from configRoot — without this step
 * those scripts throw "Cannot find package" on first run after a fresh install.
 */
function deployDependencies(payloadInstall: string, configRoot: string, apply: boolean): DeployResult {
  const src = join(payloadInstall, "package.json");
  const dst = join(configRoot, "package.json");
  const lockPath = join(configRoot, "bun.lock");
  const modulesPath = join(configRoot, "node_modules");
  const r: DeployResult = { what: "dependencies", src, dst, present: existsSync(src), copied: 0, actions: [], blockers: [], failures: [] };
  if (!r.present) {
    r.blockers.push(`dependency manifest missing: ${src} — point --skill-root at a staged release`);
    return r;
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  let shipped: Record<string, unknown>;
  let current: Record<string, unknown> = {};
  const originalPackage = existsSync(dst) ? readFileSync(dst, "utf8") : null;
  try {
    const shippedValue: unknown = JSON.parse(readFileSync(src, "utf8"));
    const currentValue: unknown = originalPackage === null ? {} : JSON.parse(originalPackage);
    if (!isRecord(shippedValue)) throw new Error("shipped package.json must contain a JSON object");
    if (!isRecord(currentValue)) throw new Error("existing package.json must contain a JSON object");
    shipped = shippedValue;
    current = currentValue;
  } catch (error) {
    r.blockers.push(`dependency manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
    return r;
  }

  const requiredValue = shipped.dependencies;
  const existingValue = current.dependencies;
  if (requiredValue !== undefined && !isRecord(requiredValue)) {
    r.blockers.push("shipped package.json dependencies must be a JSON object");
    return r;
  }
  if (existingValue !== undefined && !isRecord(existingValue)) {
    r.blockers.push("existing package.json dependencies must be a JSON object");
    return r;
  }
  const required = requiredValue ?? {};
  const existing = existingValue ?? {};
  const added = Object.keys(required).filter((name) => !(name in existing));
  const merged = {
    ...current,
    ...(originalPackage === null ? shipped : {}),
    dependencies: { ...required, ...existing },
  };
  const needsWrite = originalPackage === null || added.length > 0;
  const needsInstall = needsWrite || !existsSync(modulesPath);

  if (!apply) {
    r.actions.push(`merge required dependencies into ${dst}: ${added.length > 0 ? added.join(", ") : "already present"}`);
    if (needsInstall) r.actions.push(`bun install --cwd ${configRoot}`);
    return r;
  }
  if (!needsInstall) {
    r.actions.push("dependencies already installed");
    return r;
  }

  const backupDir = join(configRoot, `.lifeos-deps-backup-${process.pid}-${Date.now()}`);
  const restore = (): void => {
    rmSync(dst, { force: true });
    rmSync(lockPath, { force: true });
    rmSync(modulesPath, { recursive: true, force: true });
    const packageBackup = join(backupDir, "package.json");
    const lockBackup = join(backupDir, "bun.lock");
    const modulesBackup = join(backupDir, "node_modules");
    if (existsSync(packageBackup)) copyFileSync(packageBackup, dst);
    if (existsSync(lockBackup)) copyFileSync(lockBackup, lockPath);
    if (existsSync(modulesBackup)) cpSync(modulesBackup, modulesPath, { recursive: true });
  };

  let snapshotReady = false;
  try {
    mkdirSync(configRoot, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    if (existsSync(dst)) copyFileSync(dst, join(backupDir, "package.json"));
    if (existsSync(lockPath)) copyFileSync(lockPath, join(backupDir, "bun.lock"));
    if (existsSync(modulesPath)) cpSync(modulesPath, join(backupDir, "node_modules"), { recursive: true });
    snapshotReady = true;
    if (needsWrite) {
      writeFileSync(dst, JSON.stringify(merged, null, 2) + "\n");
      r.copied = added.length || 1;
    }

    const bun = Bun.which("bun") || process.execPath;
    const proc = Bun.spawnSync([bun, "install"], { cwd: configRoot, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`bun install --cwd ${configRoot} exited ${proc.exitCode}`);
    r.actions.push(`bun install --cwd ${configRoot}`);
  } catch (error) {
    if (snapshotReady) {
      try {
        restore();
      } catch (rollbackError) {
        r.failures.push(`dependency rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    r.failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(backupDir, { recursive: true, force: true });
  }
  return r;
}


function main(): void {
  const a = process.argv.slice(2);
  const home = process.env.HOME || homedir();
  const configRoot = arg(a, "--config-root") || defaultConfigRoot(home);
  const skillRoot = arg(a, "--skill-root") || join(import.meta.dir, "..");
  const payloadInstall = join(skillRoot, "install");
  const apply = a.includes("--apply");
  const allowDev = a.includes("--allow-dev");

  if (detectDevTree(configRoot) && !allowDev) {
    console.log(JSON.stringify({
      ok: false,
      refused: "dev-tree",
      detail: `${configRoot} is a LifeOS source tree (skills/_LIFEOS present) — refusing to deploy core. Use --allow-dev only in a sandbox.`,
    }, null, 2));
    process.exit(2);
  }

  const results = [
    deploySkills(payloadInstall, configRoot, apply),
    deployRuntime(payloadInstall, configRoot, apply),
    deployHookPrerequisites(payloadInstall, configRoot, apply),
    scaffoldMemory(configRoot, apply),
    deployDependencies(payloadInstall, configRoot, apply),
  ];

  // A missing required payload source (blocker) or a copy failure is a hard
  // failure, not a silent success — `ok` requires both lists empty.
  const blockers = results.flatMap((r) => r.blockers);
  const failures = results.flatMap((r) => r.failures);
  const ok = blockers.length === 0 && failures.length === 0;
  const skillsCopied = results.find((r) => r.what === "skills")?.copied ?? 0;
  const runtimeCopied = results.find((r) => r.what === "runtime")?.copied ?? 0;

  console.log(JSON.stringify({
    ok,
    dryRun: !apply,
    configRoot,
    payloadInstall,
    skillsDst: join(configRoot, "skills"),
    runtimeDst: join(configRoot, "LIFEOS"),
    skillsCopied,
    runtimeCopied,
    blockers,
    failures,
    results,
    note: apply ? undefined : "dry-run — re-run with --apply to deploy (a blocked source fails the run in both modes)",
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
