#!/usr/bin/env bun
/**
 * InstallSettings — Setup step 4's settings placement, as a deterministic tool.
 * Places the payload's `install/settings.system.json` into the harness
 * `settings.json` with the one transform the copy-by-hand step kept getting
 * wrong: **`env` values are expanded at write time** (`$HOME`/`${HOME}`/`~` →
 * the real home). The harness injects env values verbatim with NO shell
 * expansion (LifeOS#1404/#1451) — a literal `"$HOME/..."` value creates a real
 * `$HOME/` directory on disk that silently captures runtime state. Command
 * strings (hooks, statusLine) are shell-evaluated and ship untouched.
 *
 * Semantics match the sibling installers (DeployCore/InstallHooks):
 *   - settings.json absent → write the expanded template whole.
 *   - settings.json present → additive merge: only ABSENT top-level keys and
 *     ABSENT env keys are added (expanded); existing values are never touched.
 *   - Dry-run by default; `--apply` mutates; backup before every write.
 *   - REFUSES the author's live source tree (`--allow-dev` to override).
 *
 * Usage:
 *   bun InstallSettings.ts [--config-root <dir>] [--skill-root <dir>] [--apply] [--allow-dev]
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { detectDevTree, resolveHomeDir, resolveInstallRoots } from "./InstallEngine";

interface Args { configRoot: string; skillRoot: string; apply: boolean; allowDev: boolean; }

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
  };
  const roots = resolveInstallRoots();
  return {
    configRoot: get("--config-root") || roots.configRoot,
    skillRoot: get("--skill-root") || join(import.meta.dir, ".."),
    apply: a.includes("--apply"),
    allowDev: a.includes("--allow-dev"),
  };
}

/** Expand a LEADING $HOME / ${HOME} / ~ path segment. Mid-string refs are left alone. */
export function expandLeadingHome(value: string, home: string): string {
  if (!home) return value;
  if (value === "$HOME" || value === "${HOME}" || value === "~") return home;
  if (value.startsWith("$HOME/")) return home + value.slice("$HOME".length);
  if (value.startsWith("${HOME}/")) return home + value.slice("${HOME}".length);
  if (value.startsWith("~/")) return home + value.slice(1);
  return value;
}

function expandEnvBlock(settings: Record<string, unknown>, home: string, configRoot: string): number {
  const env = settings.env;
  if (!env || typeof env !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const expanded = k === "LIFEOS_CONFIG_DIR"
      ? configRoot
      : k === "LIFEOS_DIR"
        ? join(configRoot, "LIFEOS")
        : expandLeadingHome(v, home);
    if (expanded !== v) { (env as Record<string, unknown>)[k] = expanded; n++; }
  }
  return n;
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

function parseObjectJson(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`JSON root must be an object: ${path}`);
  return parsed as Record<string, unknown>;
}

function assertPhysicalPayloadFile(path: string, skillRoot: string): void {
  const root = resolve(skillRoot);
  const candidate = resolve(path);
  const delta = relative(root, candidate);
  if (delta === ".." || delta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(delta)) {
    throw new Error(`payload settings.system.json escapes the selected skill root: ${path}`);
  }
  const canonicalRoot = realpathSync(root);
  const segments = delta.split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error(`payload settings.system.json crosses a linked ancestor: ${current}`);
    const physical = realpathSync(current);
    const physicalDelta = relative(canonicalRoot, physical);
    if (physicalDelta === ".." || physicalDelta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(physicalDelta)) {
      throw new Error(`payload settings.system.json escapes the selected skill root: ${path}`);
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) throw new Error(`payload settings.system.json has a non-directory ancestor: ${current}`);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile()) throw new Error(`payload settings.system.json must be a physical regular file: ${path}`);
}

export async function runInstallSettings(args = parseArgs()): Promise<Record<string, unknown>> {
  const home = resolveHomeDir();
  const templatePath = join(args.skillRoot, "install", "settings.system.json");
  const targetPath = join(args.configRoot, "settings.json");
  if (detectDevTree(args.configRoot) && !args.allowDev) {
    return { ok: false, error: "dev tree detected — refusing to touch the author's live settings (--allow-dev to override)" };
  }
  if (!existsSync(templatePath)) return { ok: false, error: `payload settings.system.json not found at ${templatePath}` };
  try {
    assertPhysicalPayloadFile(templatePath, args.skillRoot);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    const template = parseObjectJson(templatePath);
    const expanded = expandEnvBlock(template, home, args.configRoot);
    const report: Record<string, unknown> = { ok: true, apply: args.apply, target: targetPath, envValuesExpanded: expanded };
    const targetExists = existsSync(targetPath);
    if (targetExists) {
      const targetMetadata = lstatSync(targetPath);
      if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()) throw new Error(`settings.json must be a physical regular file: ${targetPath}`);
    }
    let next = template;
    let writeNeeded = !targetExists;
    if (!targetExists) {
      report.mode = "create";
      report.topLevelKeys = Object.keys(template).length;
    } else {
      const current = parseObjectJson(targetPath);
      const addedKeys: string[] = [];
      for (const [key, value] of Object.entries(template)) {
        if (key !== "env" && !(key in current)) {
          current[key] = value;
          addedKeys.push(key);
        }
      }
      if (current.env !== undefined && (current.env === null || typeof current.env !== "object" || Array.isArray(current.env))) {
        throw new Error(`settings.env must be an object: ${targetPath}`);
      }
      const currentEnv = (current.env ??= {}) as Record<string, unknown>;
      const templateEnv = (template.env ?? {}) as Record<string, unknown>;
      const addedEnv: string[] = [];
      for (const [key, value] of Object.entries(templateEnv)) {
        if (!(key in currentEnv)) {
          currentEnv[key] = value;
          addedEnv.push(key);
        }
      }
      next = current;
      writeNeeded = addedKeys.length > 0 || addedEnv.length > 0;
      report.mode = "merge";
      report.addedKeys = addedKeys;
      report.addedEnv = addedEnv;
    }
    if (!args.apply || !writeNeeded) {
      if (args.apply && !writeNeeded) report.note = "nothing to add — no write, no backup";
      return report;
    }

    const lifecycle = await loadLifecycle();
    const journalDirectory = join(args.configRoot, ".uai-journal");
    if (existsSync(journalDirectory)) {
      const journalMetadata = lstatSync(journalDirectory);
      if (journalMetadata.isSymbolicLink() || !journalMetadata.isDirectory()) {
        throw new Error(`settings journal directory must be a physical directory: ${journalDirectory}`);
      }
      const journals = readdirSync(journalDirectory).filter((candidate) => candidate.startsWith("claude-install-settings-") && candidate.endsWith(".json")).sort();
      if (journals.length > 1) throw new Error(`settings recovery is ambiguous across journals: ${journals.join(", ")}`);
      for (const name of journals) {
        const journal = join(journalDirectory, name);
        const metadata = lstatSync(journal);
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`settings journal must be a physical regular file: ${journal}`);
        const recovery = await lifecycle.recoverJournal(journal);
        if (recovery.status === "rollback-conflict") throw new Error(`settings recovery conflict: ${recovery.conflicts.map((item) => item.path).join(", ")}`);
      }
    }
    const targetMode = targetExists ? statSync(targetPath).mode & 0o777 : statSync(templatePath).mode & 0o777;
    const backupMutation = targetExists ? [{
      id: "settings-backup",
      kind: "write" as const,
      path: `${targetPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      bytes: readFileSync(targetPath),
      mode: targetMode,
      ownership: "owned" as const,
      structured: "json" as const,
    }] : [];
    const plan = await lifecycle.createInstallPlan({
      id: "claude-install-settings",
      root: args.configRoot,
      mutations: [
        ...backupMutation,
        {
          id: "settings-write",
          kind: "write",
          path: targetPath,
          bytes: Buffer.from(`${JSON.stringify(next, null, 2)}\n`),
          mode: targetMode,
          ownership: "adopted",
          structured: "json",
        },
      ],
    });
    if (process.env.LIFEOS_TEST_DRIFT_INSTALL_SETTINGS === "1") writeFileSync(targetPath, `${JSON.stringify({ thirdState: true }, null, 2)}\n`);
    await lifecycle.applyInstallPlan(plan, {
      injectFailureAfter: process.env.LIFEOS_TEST_FAIL_INSTALL_SETTINGS === "after-backup"
        ? backupMutation.length
        : process.env.LIFEOS_TEST_FAIL_INSTALL_SETTINGS === "after-settings" ? plan.mutations.length : undefined,
    });
    return report;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), target: targetPath };
  }
}

if (import.meta.main) {
  const report = await runInstallSettings();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok === true ? 0 : 1);
}
