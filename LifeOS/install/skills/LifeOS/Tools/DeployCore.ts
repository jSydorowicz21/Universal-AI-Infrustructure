#!/usr/bin/env bun
/**
 * DeployCore — LifeOS Core deploy step (Setup step 4.5). Lays down the two
 * things the bare skill SHIPS in its install payload but no prior Setup step
 * installed: the functional skills library and the LIFEOS runtime tree
 * (Algorithm, documentation, tools, Pulse, statusline, version, user-templates).
 * Without it a fresh install has exactly one skill, no runtime, and the active
 * `@LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md` import in CLAUDE.md dangles.
 *
 * Apply mode enumerates the complete missing payload, dependency manifest, and
 * MEMORY ownership sentinels into one `uai.install-plan.v1` transaction. The
 * lifecycle kernel validates structured files, snapshots type/bytes/mode/link
 * identity, journals before mutation, writes atomically, and rolls back or
 * reports drift. Dry-run remains non-mutating. A required payload source that
 * is absent is a loud blocker (exit 1), never a silent success.
 *
 * Targets the config-root runtime at the ALL-CAPS `<configRoot>/LIFEOS/` so it
 * matches the `@LIFEOS/...` imports in CLAUDE.md (NOT mixed-case `LifeOS`).
 *
 * Usage:
 *   bun DeployCore.ts [--config-root <dir>] [--skill-root <dir>] [--apply] [--allow-dev]
 *   (dry-run by default — reports the plan per target without writing)
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { copyMissing, detectDevTree, resolveInstallRoots } from "./InstallEngine";

// Runtime top-level entries this tool does NOT deploy:
//  - USER           shipped separately as a scaffold (ScaffoldUser) + symlinked (LinkUser)
//  - MEMORY         per-install state, never shipped — but scaffoldMemory() creates the
//                   empty tree at install so ISASync/hooks/memory writes have a home
//                   (this is where EmitSkill's "MEMORY scaffolded fresh at setup" becomes true)
//  - node_modules / .git  never deploy
// copyMissing's own SKIP_DIRS covers MEMORY when nested, but these
// are TOP-LEVEL entries of the runtime payload, so we filter them here explicitly.
const RUNTIME_SKIP = new Set(["USER", "MEMORY", "node_modules", ".git"]);

function arg(a: string[], flag: string): string | undefined {
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
}

export interface DeployResult {
  what: "skills" | "runtime" | "memory" | "dependencies";
  src: string;
  dst: string;
  present: boolean;
  copied: number;
  actions: string[];
  blockers: string[];
  failures: string[];
}

function assertPhysicalDescendant(path: string, root: string, label: string, directory = false): void {
  const logicalRoot = resolve(root);
  const logicalPath = resolve(path);
  const pathDelta = relative(logicalRoot, logicalPath);
  if (pathDelta === ".." || pathDelta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathDelta)) {
    throw new Error(`${label} escapes its selected root: ${path}`);
  }
  const canonicalRoot = realpathSync(logicalRoot);
  let current = logicalRoot;
  for (const [index, segment] of pathDelta.split(/[\\/]+/).filter(Boolean).entries()) {
    current = join(current, segment);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error(`${label} crosses a linked ancestor: ${current}`);
    const physical = realpathSync(current);
    const physicalDelta = relative(canonicalRoot, physical);
    if (physicalDelta === ".." || physicalDelta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(physicalDelta)) {
      throw new Error(`${label} escapes its selected root: ${path}`);
    }
    if (index < pathDelta.split(/[\\/]+/).filter(Boolean).length - 1 && !metadata.isDirectory()) {
      throw new Error(`${label} has a non-directory ancestor: ${current}`);
    }
    if (index === pathDelta.split(/[\\/]+/).filter(Boolean).length - 1 && directory && !metadata.isDirectory()) {
      throw new Error(`${label} must be a physical directory: ${path}`);
    }
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
  try {
    assertPhysicalDescendant(src, payloadInstall, "skills payload", true);
  } catch (error) {
    r.blockers.push(error instanceof Error ? error.message : String(error));
    return r;
  }
  if (!apply) {
    r.actions.push(`copyMissing ${src} → ${dst} (never overwrites existing skills)`);
    return r;
  }
  const { copied, failures } = copyMissing(src, dst);
  r.copied = copied;
  r.failures = failures;
  return r;
}

/** (b) runtime: install/LIFEOS/<entry> → configRoot/LIFEOS/<entry>, skipping RUNTIME_SKIP. */
function deployRuntime(payloadInstall: string, configRoot: string, apply: boolean): DeployResult {
  // Prefer canonical all-caps LIFEOS (matches @LIFEOS/... imports on case-sensitive FS);
  // fall back to the legacy mixed-case dir so pre-fix tarballs still install.
  const src = existsSync(join(payloadInstall, "LIFEOS")) ? join(payloadInstall, "LIFEOS") : join(payloadInstall, "LifeOS");
  const dst = join(configRoot, "LIFEOS");
  const r: DeployResult = { what: "runtime", src, dst, present: existsSync(src), copied: 0, actions: [], blockers: [], failures: [] };
  if (!r.present) {
    r.blockers.push(`runtime payload missing: ${src} — the bare-skill payload is unpopulated (run EmitSkill, or point --skill-root at a staged release)`);
    return r;
  }
  // Iterate top-level entries so USER (and the other skips) are excluded while the
  try {
    assertPhysicalDescendant(src, payloadInstall, "runtime payload", true);
  } catch (error) {
    r.blockers.push(error instanceof Error ? error.message : String(error));
    return r;
  }
  const entries = readdirSync(src, { withFileTypes: true })
    .filter((e) => !RUNTIME_SKIP.has(e.name))
    .map((e) => e.name)
    .sort();
  if (entries.length === 0) {
    r.blockers.push(`runtime payload at ${src} has nothing to deploy after skipping ${[...RUNTIME_SKIP].join(", ")}`);
    return r;
  }
  for (const name of entries) {
    const es = join(src, name);
    const ed = join(dst, name);
    if (!apply) {
      r.actions.push(`copyMissing ${es} → ${ed}`);
      continue;
    }
    const { copied, failures } = copyMissing(es, ed);
    r.copied += copied;
    r.failures.push(...failures);
  }
  return r;
}

// MEMORY is NOT shipped in the payload (per-install state), but the runtime writes
// to it immediately (ISASync → WORK + STATE, hooks → OBSERVABILITY, memory loop →
// KNOWLEDGE/LEARNING). Without the tree a fresh install throws on first write. This
// makes EmitSkill's "MEMORY scaffolded fresh at setup" claim actually true.
const MEMORY_SUBDIRS = ["WORK", "KNOWLEDGE", "LEARNING", "STATE", "OBSERVABILITY", "SKILLS"];

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
 * (d) shared runtime deps: merge install/package.json into configRoot/package.json.
 * Package-manager children can mutate lockfiles and node_modules outside a file
 * plan, so this tool never runs one in the live profile. Every required import
 * must already resolve exactly; otherwise deployment blocks before any target
 * mutation. The release packager or operator may provision dependencies first.
 */
function parseManifest(path: string, root: string): Record<string, unknown> {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`package manifest must be a physical regular file: ${path}`);
  }
  assertPhysicalDescendant(path, root, "package manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid package manifest at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`package manifest root must be an object: ${path}`);
  return parsed as Record<string, unknown>;
}

function lifecycleModulePath(): string {
  const candidates = [
    join(import.meta.dir, "..", "UNIVERSAL", "lifecycle.ts"),
    join(import.meta.dir, "..", "install", "LIFEOS", "UNIVERSAL", "lifecycle.ts"),
    join(import.meta.dir, "..", "..", "..", "LIFEOS", "UNIVERSAL", "lifecycle.ts"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`universal lifecycle module not found from ${import.meta.dir}`);
  return path;
}

async function loadLifecycle() {
  return import(pathToFileURL(lifecycleModulePath()).href);
}

interface LifecycleRecovery {
  recoverJournal(path: string): Promise<{ status: string; conflicts: Array<{ path: string }> }>;
}

async function recoverPlanJournals(
  lifecycle: LifecycleRecovery,
  root: string,
  planId: string,
  label: string,
): Promise<void> {
  const journalDirectory = join(root, ".uai-journal");
  if (!existsSync(journalDirectory)) return;
  const journalMetadata = lstatSync(journalDirectory);
  if (journalMetadata.isSymbolicLink() || !journalMetadata.isDirectory()) {
    throw new Error(`${label} journal directory must be a physical directory: ${journalDirectory}`);
  }
  const journals = readdirSync(journalDirectory).filter((candidate) => candidate.startsWith(`${planId}-`) && candidate.endsWith(".json")).sort();
  if (journals.length > 1) throw new Error(`${label} recovery is ambiguous across journals: ${journals.join(", ")}`);
  for (const name of journals) {
    const journal = join(journalDirectory, name);
    const metadata = lstatSync(journal);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} journal must be a physical regular file: ${journal}`);
    const recovery = await lifecycle.recoverJournal(journal);
    if (recovery.status === "rollback-conflict") throw new Error(`${label} recovery conflict: ${recovery.conflicts.map((item) => item.path).join(", ")}`);
  }
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function satisfiesVersion(version: string, range: string): boolean {
  const actual = parseVersion(version);
  if (!actual) return false;
  const normalized = range.trim();
  if (normalized === "*" || normalized === "latest") return true;
  const operator = normalized.match(/^(\^|~|>=|>|<=|<)?\s*(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  if (!operator) return false;
  const expected = parseVersion(operator[2]);
  if (!expected) return false;
  const compare = actual[0] !== expected[0] ? actual[0] - expected[0] : actual[1] !== expected[1] ? actual[1] - expected[1] : actual[2] - expected[2];
  switch (operator[1] ?? "") {
    case "^":
      if (compare < 0) return false;
      if (expected[0] > 0) return actual[0] === expected[0];
      if (expected[1] > 0) return actual[0] === 0 && actual[1] === expected[1];
      return actual[0] === 0 && actual[1] === 0 && actual[2] === expected[2];
    case "~": return actual[0] === expected[0] && actual[1] === expected[1] && compare >= 0;
    case ">=": return compare >= 0;
    case ">": return compare > 0;
    case "<=": return compare <= 0;
    case "<": return compare < 0;
    default: return compare === 0;
  }
}

function dependencyBlockers(required: Record<string, unknown>, configRoot: string): string[] {
  const blockers: string[] = [];
  for (const [name, range] of Object.entries(required)) {
    if (typeof range !== "string") {
      blockers.push(`dependency ${name} has a non-string required range`);
      continue;
    }
    const manifestPath = join(configRoot, "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(manifestPath)) {
      blockers.push(`dependency ${name} package manifest is missing`);
      continue;
    }
    try {
      const manifest = parseManifest(manifestPath, configRoot);
      if (manifest.name !== name || typeof manifest.version !== "string" || !satisfiesVersion(manifest.version, range)) {
        blockers.push(`dependency ${name} installed version ${String(manifest.version)} is incompatible with ${range}`);
      }
      if (manifest.exports === undefined) blockers.push(`dependency ${name} has no declared exports`);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  return blockers;
}

export async function deployDependencies(payloadInstall: string, configRoot: string, apply: boolean): Promise<DeployResult> {
  const src = join(payloadInstall, "package.json");
  const dst = join(configRoot, "package.json");
  const targetExisted = existsSync(dst);
  const result: DeployResult = { what: "dependencies", src, dst, present: existsSync(src), copied: 0, actions: [], blockers: [], failures: [] };
  if (!result.present) {
    result.blockers.push(`dependency manifest missing: ${src} — point --skill-root at a staged release`);
    return result;
  }
  let sourceManifest: Record<string, unknown>;
  let targetManifest: Record<string, unknown>;
  try {
    sourceManifest = parseManifest(src, payloadInstall);
    targetManifest = targetExisted ? parseManifest(dst, configRoot) : {};
  } catch (error) {
    result.blockers.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  const required = sourceManifest.dependencies;
  if (required === null || typeof required !== "object" || Array.isArray(required)) {
    result.blockers.push(`dependency manifest has no valid dependencies object: ${src}`);
    return result;
  }
  const current = targetManifest.dependencies === undefined ? {} : targetManifest.dependencies;
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    result.blockers.push(`target dependencies must be an object: ${dst}`);
    return result;
  }
  const mergedDependencies = { ...(current as Record<string, unknown>) };
  const added: string[] = [];
  for (const [name, version] of Object.entries(required as Record<string, unknown>)) {
    if (!(name in mergedDependencies)) {
      mergedDependencies[name] = version;
      added.push(name);
    }
  }
  const unresolved = Object.keys(required as Record<string, unknown>).filter((name) => {
    try {
      Bun.resolveSync(name, configRoot);
      return false;
    } catch {
      return true;
    }
  });
  if (unresolved.length > 0) {
    result.blockers.push(`required runtime imports are not already resolvable (${unresolved.join(", ")}); refusing non-transactional package-manager mutation`);
    return result;
  }
  const incompatible = dependencyBlockers(required as Record<string, unknown>, configRoot);
  if (incompatible.length > 0) {
    result.blockers.push(...incompatible);
    return result;
  }
  const nextManifest = { ...targetManifest, dependencies: mergedDependencies };
  if (!apply) {
    result.actions.push(`merge dependencies [${added.join(", ")}] into ${dst}`, "verify exact dependency imports (package-manager side effects are blocked)");
    return result;
  }
  if (added.length === 0 && targetExisted) {
    result.actions.push("manifest already complete", "verified exact imports");
    return result;
  }
  try {
    const lifecycle = await loadLifecycle();
    await recoverPlanJournals(lifecycle, configRoot, "claude-deploy-dependencies", "dependency deploy");
    const plan = await lifecycle.createInstallPlan({
      id: "claude-deploy-dependencies",
      root: configRoot,
      mutations: [{
        id: "package-manifest",
        kind: "write",
        path: dst,
        bytes: Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`),
        mode: targetExisted ? statSync(dst).mode & 0o777 : statSync(src).mode & 0o777,
        ownership: targetExisted ? "adopted" : "owned",
        structured: "json",
      }],
    });
    if (process.env.LIFEOS_TEST_DRIFT_DEPLOY_DEPENDENCIES === "1") writeFileSync(dst, `${JSON.stringify({ thirdState: true }, null, 2)}\n`);
    await lifecycle.applyInstallPlan(plan, {
      injectFailureAfter: process.env.LIFEOS_TEST_FAIL_DEPLOY_DEPENDENCIES === "after-manifest" ? 1 : undefined,
    });
    result.copied = targetExisted ? 0 : 1;
    result.actions.push(`merged ${added.length} dependencies`, "verified exact imports");
  } catch (error) {
    result.failures.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

function structuredFormat(path: string): "json" | "yaml" | "toml" | undefined {
  if (/(^|[/\\])tsconfig\.json$/.test(path)) return undefined; // TypeScript accepts JSONC comments.
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".toml")) return "toml";
  return undefined;
}

interface AppliedOwnership {
  path: string;
  ownership: "owned" | "adopted" | "foreign" | "user-data" | "unknown";
  applied: {
    existed: boolean;
    kind?: "file" | "directory" | "link";
    sha256?: string;
    mode?: number;
    linkTarget?: string;
  };
}

function fileDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function matchesAppliedOwnership(path: string, artifact: AppliedOwnership): boolean {
  if (!artifact.applied.existed) return !existsSync(path);
  try {
    const metadata = lstatSync(path);
    if (artifact.applied.kind === "file") {
      return metadata.isFile()
        && fileDigest(readFileSync(path)) === artifact.applied.sha256
        && (process.platform === "win32" || artifact.applied.mode === undefined || (metadata.mode & 0o777) === (artifact.applied.mode & 0o777));
    }
    if (artifact.applied.kind === "link") {
      return metadata.isSymbolicLink() && readlinkSync(path) === artifact.applied.linkTarget;
    }
    return artifact.applied.kind === "directory" && metadata.isDirectory();
  } catch {
    return false;
  }
}

function ownedArtifact(
  ownership: ReadonlyMap<string, AppliedOwnership>,
  target: string,
): AppliedOwnership | undefined {
  return ownership.get(resolve(target));
}

function assertOwnedTargetUnchanged(target: string, artifact: AppliedOwnership): void {
  if (!matchesAppliedOwnership(target, artifact)) {
    throw new Error(`owned payload target changed after install; refusing update: ${target}`);
  }
}

function collectMissingMutations(
  source: string,
  target: string,
  prefix: string,
  mutations: Array<Record<string, unknown>>,
  skip = RUNTIME_SKIP,
  ownership: ReadonlyMap<string, AppliedOwnership> = new Map(),
): void {
  const metadata = lstatSync(source);
  if (metadata.isSymbolicLink()) throw new Error(`core payload links are not allowed: ${source}`);
  if (existsSync(target) && !metadata.isDirectory() && !ownedArtifact(ownership, target)) return;
  if (metadata.isDirectory()) {
    if (existsSync(target) && !lstatSync(target).isDirectory()) throw new Error(`target blocks payload directory: ${target}`);
    for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.has(entry.name)) continue;
      collectMissingMutations(join(source, entry.name), join(target, entry.name), prefix, mutations, skip, ownership);
    }
    return;
  }
  if (!metadata.isFile()) return;
  const bytes = readFileSync(source);
  const prior = ownedArtifact(ownership, target);
  if (existsSync(target)) {
    if (!prior) return;
    assertOwnedTargetUnchanged(target, prior);
    if (fileDigest(bytes) === prior.applied.sha256
      && (process.platform === "win32" || prior.applied.mode === undefined || (metadata.mode & 0o777) === (prior.applied.mode & 0o777))) return;
  }
  mutations.push({
    id: `${prefix}:${mutations.length}`,
    kind: "write",
    path: target,
    bytes,
    mode: metadata.mode & 0o777,
    ownership: prior?.ownership ?? "owned",
    structured: structuredFormat(source),
  });
}

export async function deployCoreTransactional(payloadInstall: string, configRoot: string): Promise<DeployResult[]> {
  const skillsSrc = join(payloadInstall, "skills");
  const runtimeSrc = existsSync(join(payloadInstall, "LIFEOS")) ? join(payloadInstall, "LIFEOS") : join(payloadInstall, "LifeOS");
  const skills = deploySkills(payloadInstall, configRoot, false);
  const runtime = deployRuntime(payloadInstall, configRoot, false);
  const memory = scaffoldMemory(configRoot, false);
  const dependencies = await deployDependencies(payloadInstall, configRoot, false);
  const results = [skills, runtime, memory, dependencies];
  if (results.some((result) => result.blockers.length > 0 || result.failures.length > 0)) return results;

  try {
    const lifecycle = await loadLifecycle();
    await recoverPlanJournals(lifecycle, configRoot, "claude-deploy-core", "core deploy");
    const ownershipPath = join(configRoot, ".uai-ownership", "claude-deploy-core.json");
    const ownership = new Map<string, AppliedOwnership>();
    if (existsSync(ownershipPath)) {
      const ownershipDirectory = dirname(ownershipPath);
      const directoryMetadata = lstatSync(ownershipDirectory);
      const manifestMetadata = lstatSync(ownershipPath);
      if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory() || manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
        throw new Error(`core ownership manifest must be a physical regular file under the selected root: ${ownershipPath}`);
      }
      const manifest = await lifecycle.assertValidOwnershipManifest(JSON.parse(readFileSync(ownershipPath, "utf8")));
      if (resolve(manifest.root) !== resolve(configRoot) || manifest.planId !== "claude-deploy-core") {
        throw new Error("core deploy ownership manifest coordinates do not match the selected root");
      }
      for (const artifact of manifest.artifacts as AppliedOwnership[]) ownership.set(resolve(artifact.path), artifact);
    }
    const mutations: Array<Record<string, unknown>> = [];
    collectMissingMutations(skillsSrc, join(configRoot, "skills"), "skills", mutations, RUNTIME_SKIP, ownership);
    const runtimeEntries = readdirSync(runtimeSrc, { withFileTypes: true })
      .filter((entry) => !RUNTIME_SKIP.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of runtimeEntries) {
      collectMissingMutations(join(runtimeSrc, entry.name), join(configRoot, "LIFEOS", entry.name), "runtime", mutations, RUNTIME_SKIP, ownership);
    }
    const runtimeMutationCount = mutations.length;
    for (const subdir of MEMORY_SUBDIRS) {
      const directory = join(configRoot, "LIFEOS", "MEMORY", subdir);
      if (!existsSync(directory)) {
        mutations.push({
          id: `memory:${subdir}`,
          kind: "write",
          path: join(directory, ".uai-owned"),
          bytes: Buffer.from("uai.lifecycle.v1\n"),
          mode: 0o600,
          ownership: "owned",
        });
      }
    }
    const memoryMutationCount = mutations.length - runtimeMutationCount;
    const sourceManifest = parseManifest(join(payloadInstall, "package.json"), payloadInstall);
    const targetPath = join(configRoot, "package.json");
    const targetManifest = existsSync(targetPath) ? parseManifest(targetPath, configRoot) : {};
    const required = sourceManifest.dependencies as Record<string, unknown>;
    const current = targetManifest.dependencies === undefined ? {} : targetManifest.dependencies as Record<string, unknown>;
    const merged = { ...current };
    for (const [name, version] of Object.entries(required)) if (!(name in merged)) merged[name] = version;
    const nextManifest = { ...targetManifest, dependencies: merged };
    if (!existsSync(targetPath) || JSON.stringify(nextManifest) !== JSON.stringify(targetManifest)) {
      mutations.push({
        id: "package-manifest",
        kind: "write",
        path: targetPath,
        bytes: Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`),
        mode: existsSync(targetPath) ? statSync(targetPath).mode & 0o777 : statSync(join(payloadInstall, "package.json")).mode & 0o777,
        ownership: existsSync(targetPath) ? "adopted" : "owned",
        structured: "json",
      });
    }
    const plan = await lifecycle.createInstallPlan({
      id: "claude-deploy-core",
      root: configRoot,
      mutations: mutations as never,
    });
    if (process.env.LIFEOS_TEST_DRIFT_DEPLOY_CORE === "1" && plan.mutations[0]) {
      const first = plan.mutations[0];
      if (first.kind === "write") {
        mkdirSync(join(first.path, ".."), { recursive: true });
        writeFileSync(first.path, "third-state\n");
      }
    }
    const injectFailureAfter = process.env.LIFEOS_TEST_FAIL_DEPLOY_CORE === "after-runtime"
      ? runtimeMutationCount
      : process.env.LIFEOS_TEST_FAIL_DEPLOY_CORE === "after-manifest" ? plan.mutations.length : undefined;
    await lifecycle.applyInstallPlan(plan, { injectFailureAfter });
    skills.copied = plan.mutations.filter((mutation) => mutation.id.startsWith("skills:")).length;
    runtime.copied = plan.mutations.filter((mutation) => mutation.id.startsWith("runtime:")).length;
    memory.copied = memoryMutationCount;
    dependencies.copied = plan.mutations.some((mutation) => mutation.id === "package-manifest") ? 1 : 0;
    for (const result of results) result.actions = ["applied by uai.install-plan.v1"];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const result of results) result.failures.push(message);
  }
  return results;
}

async function main(): Promise<void> {
  const a = process.argv.slice(2);
  const roots = resolveInstallRoots();
  const configRoot = arg(a, "--config-root") || roots.configRoot;
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

  const results = apply
    ? await deployCoreTransactional(payloadInstall, configRoot)
    : [
      deploySkills(payloadInstall, configRoot, false),
      deployRuntime(payloadInstall, configRoot, false),
      scaffoldMemory(configRoot, false),
      await deployDependencies(payloadInstall, configRoot, false),
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

if (import.meta.main) await main();
