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

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfigRoot, detectDevTree } from "./InstallEngine";

interface Args { configRoot: string; skillRoot: string; apply: boolean; allowDev: boolean; }

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
  };
  const home = homedir();
  return {
    configRoot: get("--config-root") || defaultConfigRoot(home),
    skillRoot: get("--skill-root") || join(import.meta.dir, ".."),
    apply: a.includes("--apply"),
    allowDev: a.includes("--allow-dev"),
  };
}

function readSettings(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${path} must contain a JSON object`);
  }
  const settings = parsed as Record<string, unknown>;
  if ("env" in settings && (settings.env === null || Array.isArray(settings.env) || typeof settings.env !== "object")) {
    throw new Error(`${path} env must be a JSON object`);
  }
  return settings;
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

function relocateLifeosEnv(settings: Record<string, unknown>, configRoot: string): number {
  const env = settings.env;
  if (!env || typeof env !== "object") return 0;
  const values = env as Record<string, unknown>;
  const lifeosDir = join(configRoot, "LIFEOS");
  let changed = 0;
  for (const key of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR"]) {
    if (values[key] !== lifeosDir) {
      values[key] = lifeosDir;
      changed++;
    }
  }
  if (values.LIFEOS_CONFIG_ROOT !== configRoot) {
    values.LIFEOS_CONFIG_ROOT = configRoot;
    changed++;
  }
  return changed;
}

function expandEnvBlock(settings: Record<string, unknown>, home: string): number {
  const env = settings.env;
  if (!env || typeof env !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v === "string") {
      const expanded = expandLeadingHome(v, home);
      if (expanded !== v) { (env as Record<string, unknown>)[k] = expanded; n++; }
    }
  }
  return n;
}

const args = parseArgs();
const home = homedir();
const templatePath = join(args.skillRoot, "install", "settings.system.json");
const targetPath = join(args.configRoot, "settings.json");

if (detectDevTree(args.configRoot) && !args.allowDev) {
  console.log(JSON.stringify({ ok: false, error: "dev tree detected — refusing to touch the author's live settings (--allow-dev to override)" }, null, 2));
  process.exit(2);
}
if (!existsSync(templatePath)) {
  console.log(JSON.stringify({ ok: false, error: `payload settings.system.json not found at ${templatePath}` }, null, 2));
  process.exit(1);
}

const template = readSettings(templatePath);
const relocatedCount = relocateLifeosEnv(template, args.configRoot);
const expandedCount = expandEnvBlock(template, home);

const report: Record<string, unknown> = {
  ok: true,
  apply: args.apply,
  target: targetPath,
  envValuesExpanded: expandedCount,
  configRootValuesApplied: relocatedCount,
};

if (!existsSync(targetPath)) {
  report.mode = "create";
  report.topLevelKeys = Object.keys(template).length;
  if (args.apply) {
    mkdirSync(args.configRoot, { recursive: true });
    writeFileSync(targetPath, JSON.stringify(template, null, 2) + "\n");
  }
} else {
  const current = readSettings(targetPath);
  const addedKeys: string[] = [];
  for (const [k, v] of Object.entries(template)) {
    if (k === "env") continue;               // handled per-key below
    if (!(k in current)) { current[k] = v; addedKeys.push(k); }
  }
  const curEnv = (current.env && typeof current.env === "object" ? current.env : (current.env = {})) as Record<string, unknown>;
  const tplEnv = (template.env || {}) as Record<string, unknown>;
  const addedEnv: string[] = [];
  for (const [k, v] of Object.entries(tplEnv)) {
    if (!(k in curEnv)) { curEnv[k] = v; addedEnv.push(k); }
  }
  report.mode = "merge";
  report.addedKeys = addedKeys;
  report.addedEnv = addedEnv;
  if (args.apply && (addedKeys.length || addedEnv.length)) {
    copyFileSync(targetPath, targetPath + ".backup-" + new Date().toISOString().replace(/[:.]/g, "-"));
    writeFileSync(targetPath, JSON.stringify(current, null, 2) + "\n");
  } else if (args.apply) {
    report.note = "nothing to add — no write, no backup";
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(0);
