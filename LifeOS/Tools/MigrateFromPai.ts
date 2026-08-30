#!/usr/bin/env bun
/**
 * MigrateFromPai — one-shot migration of an existing OLD PAI install into the
 * LifeOS USER layout this checkout installs.
 *
 * What it does, in order:
 *   (a) source-repo refusal (detectDevTree);
 *   (b) detect the old install — if there is no `<paiDir>` AND no old-data USER,
 *       exit 0 with `nothing-to-migrate`;
 *   (c) verify the physical source and destination trees (no symlinks/junctions
 *       in either) via the shared `physicalTreeFailure`, refusing before any
 *       mutation otherwise — destination checks run UNCONDITIONALLY (not gated
 *       on existsSync) so a dangling junction at the destination root is
 *       refused, not treated as absent;
 *   (d) build a complete migration plan: every source file with its destination,
 *       classified `mapped` | `unmapped-carried` | `identical-skip` |
 *       `conflict-preserve` (destination differs — the displaced file is kept
 *       as `<file>.replaced-<stamp>`; LIVE/new-side wins semantics match the
 *       shared `mergeFile`/`mergeTree` primitive);
 *   (e) preview prints the full plan and mutates nothing;
 *   (f) `--apply` executes via the shared `mergeFile` primitive (the same one
 *       `mergeTree` calls), then verifies every planned destination exists and
 *       is byte-equal to its source;
 *   (g) never touches CLAUDE.md / settings.json automatically — instead emits an
 *       ADVISORY section listing detected `@PAI/...` imports in CLAUDE.md and
 *       PAI-path hook commands in settings.json, each with its exact suggested
 *       replacement, so the human/AI applies them via InstallSettings /
 *       ActivateImports;
 *   (h) exit codes: 0 ok / nothing-to-migrate, 1 failure, 2 refused.
 *
 * The OLD PAI source tree is READ-ONLY: this tool never renames, moves, or
 * deletes anything inside it. It only reads and copies. What can be manually
 * removed afterward is reported in the `removableOldSources` advisory.
 *
 * Usage:
 *   bun MigrateFromPai.ts [flags]
 *     --config-root <path>    old+new harness config root (default: DetectEnv selection)
 *     --pai-dir <path>        old PAI dir (default: <configRoot>/PAI)
 *     --old-data-dir <path>   old data root (default: PAI_DATA_DIR env else ~/.pai)
 *     --data-dir <path>       new LifeOS data root (default: ~/.pai)
 *     --apply                 mutate (default: preview)
 *     --json                  machine-readable report
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, relative } from "node:path";
import {
  detectDevTree,
  filesDiffer,
  mergeFile,
  physicalTreeFailure,
  resolveInstallRoots,
} from "./InstallEngine";

// ── Mapping table (source of truth = LifeOS/install/USER scaffold) ──
//
// Old PAI placed identity/TELOS at <configRoot>/PAI/USER/ using flat filenames
// that the LifeOS scaffold reorganized into PascalCase subdirectories. These
// renames are the only structural transformation; everything else carries at
// the same relative path under the new USER tree.
const USER_PATH_RENAMES: Array<{ match: RegExp; dest: string }> = [
  // <paiUser>/PRINCIPAL_IDENTITY.md -> USER/PRINCIPAL/PRINCIPAL_IDENTITY.md
  { match: /^PRINCIPAL_IDENTITY\.md$/i, dest: "PRINCIPAL/PRINCIPAL_IDENTITY.md" },
  // <paiUser>/DA_IDENTITY.md -> USER/DIGITAL_ASSISTANT/DA_IDENTITY.md
  { match: /^DA_IDENTITY\.md$/i, dest: "DIGITAL_ASSISTANT/DA_IDENTITY.md" },
  // <paiUser>/PROJECTS/PROJECTS.md -> USER/PROJECTS.md  (dir flattened to file)
  { match: /^PROJECTS[\\/]+PROJECTS\.md$/i, dest: "PROJECTS.md" },
];

/**
 * Known import targets the LifeOS ActivateImports flow expects (mirrors
 * InstallEngine.DORMANT_USER_IMPORTS). A source file whose destination lands
 * on one of these is classified `mapped` (an explicit, known target) even when
 * its relative path is unchanged — e.g. TELOS/PRINCIPAL_TELOS.md has no rename
 * but is still a first-class mapped target, not an unmapped carry.
 */
const KNOWN_MAPPED_USER_DESTS: Record<string, true> = {
  "TELOS/PRINCIPAL_TELOS.md": true,
  "PRINCIPAL/PRINCIPAL_IDENTITY.md": true,
  "DIGITAL_ASSISTANT/DA_IDENTITY.md": true,
  "PROJECTS.md": true,
};

// Known `@PAI/USER/...` imports that map to the LifeOS `@LIFEOS/USER/...`
// import targets the ActivateImports flow expects (DORMANT_USER_IMPORTS).
const CLAUDE_MD_IMPORT_REPLACEMENTS: Array<{ from: RegExp; to: string }> = [
  { from: /@PAI\/USER\/TELOS\/PRINCIPAL_TELOS\.md\b/g, to: "@LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md" },
  { from: /@PAI\/USER\/PRINCIPAL_IDENTITY\.md\b/g, to: "@LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md" },
  { from: /@PAI\/USER\/DA_IDENTITY\.md\b/g, to: "@LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY.md" },
  { from: /@PAI\/USER\/PROJECTS\/PROJECTS\.md\b/g, to: "@LIFEOS/USER/PROJECTS.md" },
];

export interface Args {
  configRoot: string;
  paiDir: string;
  oldDataDir: string;
  dataDir: string;
  apply: boolean;
  json: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (f: string): string | undefined => {
    const i = a.indexOf(f);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
  };
  const roots = resolveInstallRoots();
  const configRoot = get("--config-root") || roots.configRoot;
  const paiDir = get("--pai-dir") || join(configRoot, "PAI");
  const oldDataDir = get("--old-data-dir") || process.env.PAI_DATA_DIR?.trim() || join(homedir(), ".pai");
  const dataDir = get("--data-dir") || roots.dataRoot;
  const apply = a.includes("--apply");
  const json = a.includes("--json");
  return { configRoot, paiDir, oldDataDir, dataDir, apply, json };
}

// ── Plan types ──

type PlanClass = "mapped" | "unmapped-carried" | "identical-skip" | "conflict-preserve";

interface PlanEntry {
  /** Absolute source path (inside the OLD tree — read-only). */
  source: string;
  /** Absolute destination path (inside the new USER / MEMORY tree). */
  destination: string;
  /** Destination root the entry is relative to (USER or MEMORY). */
  destinationRoot: "USER" | "MEMORY";
  /** Relative path inside the source tree (for reporting). */
  sourceRel: string;
  /** Relative path inside the destination tree (post-rename). */
  destinationRel: string;
  classification: PlanClass;
}

interface AdvisoryItem {
  file: string;
  line: number;
  text: string;
  suggestion: string;
}

interface Advisory {
  claudeMdImports: AdvisoryItem[];
  settingsHooks: AdvisoryItem[];
  /** Old source paths the migration has finished copying and can be manually
   * removed by the human once they have verified the new tree. */
  removableOldSources: string[];
}

export interface MigrationReport {
  ok: boolean;
  status: "preview" | "applied" | "nothing-to-migrate" | "refused" | "failure";
  configRoot: string;
  paiDir: string;
  oldDataDir: string;
  dataDir: string;
  sources: Array<{ root: string; label: string; present: boolean }>;
  plan: PlanEntry[];
  summary: { mapped: number; "unmapped-carried": number; "identical-skip": number; "conflict-preserve": number; total: number };
  advisory: Advisory;
  verification?: { plannedDestinations: number; verified: number; failed: Array<{ destination: string; reason: string }> };
  error?: string;
  refused?: string;
}

// ── Helpers ──

/** Resolve the relative destination of a USER entry, applying known renames. */
function resolveUserDestinationRel(rel: string): string {
  const norm = rel.replace(/\\/g, "/");
  for (const rule of USER_PATH_RENAMES) {
    if (rule.match.test(norm)) {
      return rule.dest;
    }
  }
  return rel;
}

/** Walk a physical directory tree, yielding every regular file (absolute path).
 * Symlinked entries are skipped (physicalTreeFailure already rejects them, but
 * walkFiles is also used in pure read-only scan paths — defensive). */
function* walkFiles(root: string): Generator<string> {
  let stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        yield full;
      }
    }
  }
}

function hasPaiUserTree(paiDir: string): boolean { return existsSync(join(paiDir, "USER")); }
function hasOldDataUserTree(oldDataDir: string): boolean { return existsSync(join(oldDataDir, "USER")); }
function hasPaiMemoryTree(paiDir: string): boolean { return existsSync(join(paiDir, "MEMORY")); }

// ── Plan construction ──

function buildPlan(args: Args): PlanEntry[] {
  const entries: PlanEntry[] = [];
  const newUserRoot = join(args.dataDir, "USER");
  const newMemoryRoot = join(args.dataDir, "MEMORY");

  const addEntry = (
    sourceAbs: string,
    destinationRoot: "USER" | "MEMORY",
    sourceRootAbs: string,
  ): void => {
    const sourceRel = relative(sourceRootAbs, sourceAbs).replace(/\\/g, "/");
    const destinationRootAbs = destinationRoot === "USER" ? newUserRoot : newMemoryRoot;
    const destinationRel = destinationRoot === "USER" ? resolveUserDestinationRel(sourceRel) : sourceRel;
    const destinationAbs = join(destinationRootAbs, destinationRel);
    let classification: PlanClass;
    if (!existsSync(destinationAbs)) {
      const destNorm = destinationRel.replace(/\\/g, "/");
      classification = KNOWN_MAPPED_USER_DESTS[destNorm] !== undefined || USER_PATH_RENAMES.some((r) => r.match.test(sourceRel.replace(/\\/g, "/")))
        ? "mapped"
        : "unmapped-carried";
    } else if (filesDiffer(sourceAbs, destinationAbs)) {
      classification = "conflict-preserve";
    } else {
      classification = "identical-skip";
    }
    entries.push({
      source: sourceAbs,
      destination: destinationAbs,
      destinationRoot,
      sourceRel,
      destinationRel,
      classification,
    });
  };

  // Source 1: <configRoot>/PAI/USER/**  (identity, TELOS, PROJECTS, ...)
  if (existsSync(join(args.paiDir, "USER"))) {
    const paiUserRoot = join(args.paiDir, "USER");
    for (const file of walkFiles(paiUserRoot)) addEntry(file, "USER", paiUserRoot);
  }

  // Source 2: <oldDataDir>/USER/**  (RESUME, CONTACTS, TELOS/*, MEMORY, BUSINESS, HEALTH, FINANCES, Config/PAI_CONFIG.yaml)
  if (existsSync(join(args.oldDataDir, "USER"))) {
    const oldDataUserRoot = join(args.oldDataDir, "USER");
    for (const file of walkFiles(oldDataUserRoot)) addEntry(file, "USER", oldDataUserRoot);
  }

  // Source 3: <configRoot>/PAI/MEMORY/**  (some installs keep MEMORY under the config PAI tree)
  if (hasPaiMemoryTree(args.paiDir)) {
    const paiMemoryRoot = join(args.paiDir, "MEMORY");
    for (const file of walkFiles(paiMemoryRoot)) addEntry(file, "MEMORY", paiMemoryRoot);
  }

  return entries;
}

// ── Advisory construction (CLAUDE.md imports + settings.json hooks) ──

function buildAdvisory(args: Args): Advisory {
  const claudeMdImports: AdvisoryItem[] = [];
  const settingsHooks: AdvisoryItem[] = [];

  const claudeMdPath = join(args.configRoot, "CLAUDE.md");
  if (existsSync(claudeMdPath) && lstatSync(claudeMdPath).isFile()) {
    const lines = readFileSync(claudeMdPath, "utf-8").split("\n");
    lines.forEach((text, idx) => {
      for (const rule of CLAUDE_MD_IMPORT_REPLACEMENTS) {
        rule.from.lastIndex = 0;
        if (rule.from.test(text)) {
          claudeMdImports.push({
            file: claudeMdPath,
            line: idx + 1,
            text: text.trim(),
            suggestion: text.replace(rule.from, rule.to).trim(),
          });
        }
      }
    });
  }

  const settingsPath = join(args.configRoot, "settings.json");
  if (existsSync(settingsPath) && lstatSync(settingsPath).isFile()) {
    const lines = readFileSync(settingsPath, "utf-8").split("\n");
    const paiPathRe = /(?:~\/\.claude|\$HOME\/\.claude|\$\{HOME\}\/\.claude|~\/\.codex|\$HOME\/\.codex|\$\{?LIFEOS_DIR\}?|~\/\.omp\/agent|~\/\.config\/opencode)\/PAI\/[^\s"'\\]+/g;
    lines.forEach((text, idx) => {
      paiPathRe.lastIndex = 0;
      if (paiPathRe.test(text)) {
        const suggestion = text.replace(/\/PAI\//g, "/LIFEOS/").replace(/\\PAI\\/g, "\\LIFEOS\\");
        settingsHooks.push({
          file: settingsPath,
          line: idx + 1,
          text: text.trim(),
          suggestion: suggestion.trim(),
        });
      }
    });
  }

  const removableOldSources: string[] = [];
  if (existsSync(join(args.paiDir, "USER"))) removableOldSources.push(join(args.paiDir, "USER"));
  if (hasPaiMemoryTree(args.paiDir)) removableOldSources.push(join(args.paiDir, "MEMORY"));

  return { claudeMdImports, settingsHooks, removableOldSources };
}

// ── Execution (apply) — reuses the shared mergeFile primitive ──

function executePlan(
  entries: PlanEntry[],
  stamp: string,
): { copied: number; overwritten: number; preserved: number; skipped: number; failures: string[] } {
  let copied = 0;
  let overwritten = 0;
  let preserved = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const entry of entries) {
    // Self-copy guard: when old and new data roots are the same directory, a
    // carried old-data USER file resolves to itself. mergeFile would classify
    // it byte-identical (skip) anyway, but normalizing makes the intent explicit
    // and defends against any rename edge that maps a file onto itself.
    if (normalize(entry.source) === normalize(entry.destination)) {
      skipped++;
      continue;
    }
    const result = mergeFile(entry.source, entry.destination, stamp, { createMissingParent: true });
    if (result.action === "copied") copied++;
    else if (result.action === "overwritten") { overwritten++; preserved++; }
    else if (result.action === "skipped-identical") skipped++;
    if (result.failure) failures.push(result.failure);
  }
  return { copied, overwritten, preserved, skipped, failures };
}

// ── Verification ──

function verifyPlan(entries: PlanEntry[]): { plannedDestinations: number; verified: number; failed: Array<{ destination: string; reason: string }> } {
  const finalWriters = new Map<string, PlanEntry>();
  for (const entry of entries) finalWriters.set(normalize(entry.destination), entry);
  let verified = 0;
  const failed: Array<{ destination: string; reason: string }> = [];
  for (const entry of finalWriters.values()) {
    if (!existsSync(entry.destination)) {
      failed.push({ destination: entry.destination, reason: "destination missing after apply" });
      continue;
    }
    if (filesDiffer(entry.source, entry.destination)) {
      failed.push({ destination: entry.destination, reason: "destination differs from final source after apply" });
      continue;
    }
    verified++;
  }
  return { plannedDestinations: finalWriters.size, verified, failed };
}

// ── Output formatting ──

function summarize(entries: PlanEntry[]): MigrationReport["summary"] {
  const summary = { mapped: 0, "unmapped-carried": 0, "identical-skip": 0, "conflict-preserve": 0, total: entries.length };
  for (const e of entries) summary[e.classification]++;
  return summary;
}

function humanReport(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push("PAI → LifeOS migration");
  lines.push("=====================");
  lines.push(`configRoot : ${report.configRoot}`);
  lines.push(`paiDir     : ${report.paiDir}`);
  lines.push(`oldDataDir : ${report.oldDataDir}`);
  lines.push(`dataDir    : ${report.dataDir}`);
  lines.push(`mode       : ${report.status}`);
  lines.push("");
  lines.push(`sources:`);
  for (const s of report.sources) {
    lines.push(`  - ${s.label.padEnd(16)} ${s.root} ${s.present ? "(present)" : "(absent)"}`);
  }
  lines.push("");
  lines.push(`plan (${report.summary.total} entries):`);
  if (report.summary.total === 0) {
    lines.push("  (no files to migrate)");
  } else {
    for (const e of report.plan) {
      lines.push(`  [${e.classification.padEnd(18)}] ${e.sourceRel} → ${e.destinationRoot}/${e.destinationRel}`);
    }
  }
  lines.push("");
  lines.push(`summary: mapped=${report.summary.mapped} unmapped-carried=${report.summary["unmapped-carried"]} identical-skip=${report.summary["identical-skip"]} conflict-preserve=${report.summary["conflict-preserve"]}`);
  if (report.verification) {
    lines.push("");
    lines.push(`verification: ${report.verification.verified}/${report.verification.plannedDestinations} final destinations byte-equal to their authoritative source`);
    if (report.verification.failed.length > 0) {
      lines.push(`  failures:`);
      for (const f of report.verification.failed) lines.push(`    - ${f.destination}: ${f.reason}`);
    }
  }
  lines.push("");
  lines.push("ADVISORY — apply these manually (CLAUDE.md / settings.json are NOT auto-edited):");
  if (report.advisory.claudeMdImports.length === 0 && report.advisory.settingsHooks.length === 0) {
    lines.push("  (no @PAI/... imports or PAI-path hooks detected)");
  }
  for (const item of report.advisory.claudeMdImports) {
    lines.push(`  CLAUDE.md:${item.line}`);
    lines.push(`    found: ${item.text}`);
    lines.push(`    →     ${item.suggestion}`);
  }
  for (const item of report.advisory.settingsHooks) {
    lines.push(`  settings.json:${item.line}`);
    lines.push(`    found: ${item.text}`);
    lines.push(`    →     ${item.suggestion}`);
  }
  if (report.advisory.removableOldSources.length > 0) {
    lines.push("");
    lines.push("removable old sources (verify the new tree first, then delete manually):");
    for (const p of report.advisory.removableOldSources) lines.push(`  - ${p}`);
  }
  if (report.error) {
    lines.push("");
    lines.push(`ERROR: ${report.error}`);
  }
  if (report.refused) {
    lines.push("");
    lines.push(`REFUSED: ${report.refused}`);
  }
  return lines.join("\n");
}

// ── Main ──

export function run(args: Args): MigrationReport {
  // (a) source-repo refusal.
  if (detectDevTree(args.configRoot)) {
    return {
      ok: false,
      status: "refused",
      configRoot: args.configRoot,
      paiDir: args.paiDir,
      oldDataDir: args.oldDataDir,
      dataDir: args.dataDir,
      sources: [],
      plan: [],
      summary: { mapped: 0, "unmapped-carried": 0, "identical-skip": 0, "conflict-preserve": 0, total: 0 },
      advisory: { claudeMdImports: [], settingsHooks: [], removableOldSources: [] },
      refused: `${args.configRoot} is a source tree — refusing to migrate.`,
    };
  }

  const sources: MigrationReport["sources"] = [
    { root: join(args.paiDir, "USER"), label: "PAI/USER", present: hasPaiUserTree(args.paiDir) },
    { root: join(args.oldDataDir, "USER"), label: "old-data/USER", present: hasOldDataUserTree(args.oldDataDir) },
    { root: join(args.paiDir, "MEMORY"), label: "PAI/MEMORY", present: hasPaiMemoryTree(args.paiDir) },
  ];

  // (b) detect old install — nothing to migrate?
  const anySource = sources.some((s) => s.present);
  if (!anySource) {
    return {
      ok: true,
      status: "nothing-to-migrate",
      configRoot: args.configRoot,
      paiDir: args.paiDir,
      oldDataDir: args.oldDataDir,
      dataDir: args.dataDir,
      sources,
      plan: [],
      summary: { mapped: 0, "unmapped-carried": 0, "identical-skip": 0, "conflict-preserve": 0, total: 0 },
      advisory: { claudeMdImports: [], settingsHooks: [], removableOldSources: [] },
    };
  }

  // (c) verify physical trees (sources AND destination). Reuse physicalTreeFailure.
  // Destination checks run UNCONDITIONALLY (not gated on existsSync) so a
  // dangling junction/symlink at the destination root is refused rather than
  // treated as absent — physicalTreeFailure already returns undefined for a
  // truly-missing path via its lstat try/catch.
  const failures: string[] = [];
  for (const s of sources) {
    if (!s.present) continue;
    const f = physicalTreeFailure(s.root, s.label);
    if (f) failures.push(f);
  }
  const newUserRoot = join(args.dataDir, "USER");
  {
    const f = physicalTreeFailure(newUserRoot, "new-data/USER");
    if (f) failures.push(f);
  }
  if (hasPaiMemoryTree(args.paiDir)) {
    const newMemoryRoot = join(args.dataDir, "MEMORY");
    const f = physicalTreeFailure(newMemoryRoot, "new-data/MEMORY");
    if (f) failures.push(f);
  }
  if (failures.length > 0) {
    return {
      ok: false,
      status: "refused",
      configRoot: args.configRoot,
      paiDir: args.paiDir,
      oldDataDir: args.oldDataDir,
      dataDir: args.dataDir,
      sources,
      plan: [],
      summary: { mapped: 0, "unmapped-carried": 0, "identical-skip": 0, "conflict-preserve": 0, total: 0 },
      advisory: { claudeMdImports: [], settingsHooks: [], removableOldSources: [] },
      refused: `unsafe physical tree: ${failures.join("; ")}`,
    };
  }

  // (d) build the plan.
  const entries = buildPlan(args);
  const advisory = buildAdvisory(args);
  const summary = summarize(entries);
  const baseReport = {
    configRoot: args.configRoot,
    paiDir: args.paiDir,
    oldDataDir: args.oldDataDir,
    dataDir: args.dataDir,
    sources,
    plan: entries,
    summary,
    advisory,
  };

  // (e) preview — no mutation.
  if (!args.apply) {
    return { ok: true, status: "preview", ...baseReport, verification: undefined };
  }

  // (f) apply — execute via shared mergeFile, then verify.
  const stamp = String(Date.now());
  const result = executePlan(entries, stamp);
  if (result.failures.length > 0) {
    return {
      ok: false,
      status: "failure",
      ...baseReport,
      verification: undefined,
      error: `migration produced ${result.failures.length} failure(s): ${result.failures.join("; ")}`,
    };
  }
  const verification = verifyPlan(entries);
  const ok = verification.failed.length === 0;
  return {
    ok,
    status: ok ? "applied" : "failure",
    ...baseReport,
    verification,
    error: ok ? undefined : `${verification.failed.length} destination(s) failed verification`,
  };
}

function main(): void {
  const args = parseArgs();
  const report = run(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(humanReport(report));
  }
  if (report.status === "refused") process.exit(2);
  if (!report.ok) process.exit(1);
  process.exit(0);
}

if (import.meta.main) main();
