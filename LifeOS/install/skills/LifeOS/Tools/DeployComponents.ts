#!/usr/bin/env bun
/**
 * DeployComponents — Setup step 7.5 (opt-in). Deploys the AI-wide runtime
 * components that the bare skill SHIPS but does not auto-activate: the Pulse
 * dashboard service, the statusline, and the optional launchd jobs
 * (worksweep, derivedsync). Each component is OPT-IN — the Setup workflow asks
 * which the user wants, then calls this with `--components <csv>` (or `--all`).
 *
 * Thin orchestrator: it does not reimplement plist substitution / launchctl for
 * the jobs that already own a standalone installer — it delegates to them
 * (InstallWorkSweep.ts, InstallDerivedSync.ts). Only Pulse's plist install is
 * inlined, because Pulse's own installer (LIFEOS/PULSE/setup.ts) is a bundled
 * interactive flow, not a callable "just install the service" entry point.
 *
 * Self-staging: every component reads from the live runtime tree
 * `<configRoot>/LIFEOS`, falling back to the shipped payload `install/LifeOS/`
 * when the runtime tree isn't laid down yet — uniform across all four (the
 * cross-vendor audit flagged the prior pulse/statusline-only staging as an
 * inconsistent contract).
 *
 * Safety: dry-run by default (`--apply` to mutate); REFUSES on the author's live
 * source tree (`--allow-dev` to override); idempotent per component (a loaded,
 * unchanged service is left running — no restart, no backup churn); never
 * overwrites a populated file without a timestamped backup; a component whose
 * prerequisites are absent reports a LOUD blocker and fails the run (no silent
 * no-op success).
 *
 * Usage:
 *   bun DeployComponents.ts [--components pulse,statusline,worksweep,derivedsync | --all]
 *                           [--config-root <dir>] [--skill-root <dir>]
 *                           [--apply] [--allow-dev]
 *   (dry-run by default — reports the plan per component without writing)
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { detectDevTree, resolveInstallRoots } from "./InstallEngine";
import { pathToFileURL } from "node:url";

// Enhancement components are the à-la-carte half of setup. The "LifeOS Core"
// (skills + system prompt + base settings + CLAUDE.md) is installed by Setup's
// core steps; these are the opt-in extras the user (or their AI) picks some/all/none of.
//
// Two kinds:
// - Non-launchd: statusline, tooltips, spinnerverbs, agents, commands — settings.json merges + file copies
// - Launchd services: delegated to Services.ts (single source of truth for all 16 background services)
//
// Component names for launchd services are their short labels (pulse, worksweep, amberroute, etc.)
// or the full label (com.lifeos.pulse). Services.ts handles the mapping.
const NON_LAUNCHD_COMPONENTS = ["statusline", "tooltips", "spinnerverbs", "agents", "commands"] as const;
type NonLaunchdComponent = (typeof NON_LAUNCHD_COMPONENTS)[number];

// Launchd components — kept in sync with Services.ts. The install for these is delegated to Services.ts.
// Short labels (without com.lifeos. prefix) for convenience; Services.ts accepts both forms.
const LAUNCHD_COMPONENTS = [
  "pulse", "pulse-menubar", "deriver", "conduit", "conduit.insight", "synthesis",
  "worksweep", "derivedsync", "healthsync", "codexupdate", "commitmentsweep",
  "blogdiscovery", "usage-aggregator", "bookmark-watchdog", "backups", "amberroute"
] as const;
type LaunchdComponent = (typeof LAUNCHD_COMPONENTS)[number];

const KNOWN_COMPONENTS = [...NON_LAUNCHD_COMPONENTS, ...LAUNCHD_COMPONENTS] as const;
type Component = (typeof KNOWN_COMPONENTS)[number];

interface Ctx {
  configRoot: string;
  lifeosDir: string; // <configRoot>/LIFEOS — the live runtime root
  payloadRoot: string; // <skillRoot>/install/LIFEOS — the shipped runtime tree
  installRoot: string; // <skillRoot>/install — settings.enhancements.json + agents/ live here
  home: string;
  bun: string; // resolved bun binary path — substituted for __BUN_PATH__ in launchd plists
  launchAgents: string;
  apply: boolean;
}

interface ComponentResult {
  component: Component;
  ready: boolean; // can be deployed (present in live tree OR payload)
  actions: string[]; // what apply will / did do
  blockers: string[]; // why it can't run — a non-empty list FAILS the run
  applied?: boolean;
  probe?: { name: string; passed: boolean; detail: string };
  error?: string;
}

// ── helpers ──────────────────────────────────────────────────────────

function arg(a: string[], flag: string): string | undefined {
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
}

/**
 * Resolve the live runtime dir robustly. The runtime references all-caps
 * `LIFEOS` (statusline, plists), but the sibling install tools use mixed-case
 * `LifeOS` (works on macOS's case-insensitive FS, latent on Linux). Pick
 * whichever actually exists; default to the all-caps runtime name.
 */
function resolveLifeosDir(configRoot: string): string {
  for (const name of ["LIFEOS", "LifeOS"]) {
    if (existsSync(join(configRoot, name))) return join(configRoot, name);
  }
  return join(configRoot, "LIFEOS");
}


/** Where a component's path can be sourced from. */
function availability(rel: string, ctx: Ctx): { inLive: boolean; inPayload: boolean } {
  return { inLive: existsSync(join(ctx.lifeosDir, rel)), inPayload: existsSync(join(ctx.payloadRoot, rel)) };
}


const uid = (): string => execFileSync("id", ["-u"]).toString().trim();

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("launchctl", args, { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }).toString();
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
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

async function applyComponentMutations(ctx: Ctx, component: Component, mutations: Array<Record<string, unknown>>): Promise<void> {
  if (mutations.length === 0) return;
  const lifecycle = await import(pathToFileURL(lifecycleModulePath()).href);
  const journalDir = join(ctx.configRoot, ".uai-journal");
  if (existsSync(journalDir)) {
    const journalMetadata = lstatSync(journalDir);
    if (journalMetadata.isSymbolicLink() || !journalMetadata.isDirectory()) {
      throw new Error(`component journal directory must be a physical directory: ${journalDir}`);
    }
    const journals = readdirSync(journalDir).filter((name) => name.startsWith(`claude-component-${component}-`) && name.endsWith(".json")).sort();
    if (journals.length > 1) throw new Error(`component recovery is ambiguous across journals: ${journals.join(", ")}`);
    for (const file of journals) {
      const journal = join(journalDir, file);
      const metadata = lstatSync(journal);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`component journal must be a physical regular file: ${journal}`);
      const recovery = await lifecycle.recoverJournal(journal);
      if (recovery.status === "rollback-conflict") throw new Error(`component recovery conflict: ${recovery.conflicts.map((item) => item.path).join(", ")}`);
    }
  }
  const plan = await lifecycle.createInstallPlan({
    id: `claude-component-${component}`,
    root: ctx.configRoot,
    mutations: mutations as never,
  });
  await lifecycle.applyInstallPlan(plan, {
    injectFailureAfter: process.env.LIFEOS_TEST_FAIL_DEPLOY_COMPONENT === component ? plan.mutations.length : undefined,
  });
}

function requirePhysicalRegularFile(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a physical regular file: ${path}`);
}

function requirePhysicalContainedFile(path: string, root: string, label: string): void {
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error(`${label} root must be a physical directory: ${root}`);
  requirePhysicalRegularFile(path, label);
  const canonicalRoot = realpathSync(root);
  const canonicalFile = realpathSync(path);
  const delta = relative(canonicalRoot, canonicalFile);
  if (delta === ".." || delta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`${label} escapes its selected runtime root: ${path}`);
  }
}

function missingTreeMutations(src: string, dst: string, prefix: string): Array<Record<string, unknown>> {
  const rootMetadata = lstatSync(src);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error(`component payload root must be a physical directory: ${src}`);
  const canonicalRoot = realpathSync(src);
  const mutations: Array<Record<string, unknown>> = [];
  const visit = (directory: string): void => {
    const canonicalDirectory = realpathSync(directory);
    if (canonicalDirectory !== canonicalRoot && !canonicalDirectory.startsWith(`${canonicalRoot}${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`component payload escapes its source root: ${directory}`);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const metadata = lstatSync(source);
      if (metadata.isSymbolicLink()) throw new Error(`component payload links are not allowed: ${source}`);
      if (metadata.isDirectory()) visit(source);
      else if (metadata.isFile()) {
        const canonicalFile = realpathSync(source);
        if (!canonicalFile.startsWith(`${canonicalRoot}${process.platform === "win32" ? "\\" : "/"}`)) {
          throw new Error(`component payload escapes its source root: ${source}`);
        }
        const target = join(dst, relative(src, source));
        if (!existsSync(target)) mutations.push({
          id: `${prefix}:${relative(src, source).replaceAll("\\", "/")}`,
          kind: "write",
          path: target,
          bytes: readFileSync(source),
          mode: metadata.mode & 0o777,
          ownership: "owned",
        });
      } else {
        throw new Error(`component payload contains an unsupported artifact: ${source}`);
      }
    }
  };
  visit(src);
  return mutations;
}

// ── component deployers ──────────────────────────────────────────────

/** Statusline: lifecycle-manage the script and settings binding where Bash is supported. */
async function deployStatusline(ctx: Ctx): Promise<ComponentResult> {
  const r: ComponentResult = { component: "statusline", ready: false, actions: [], blockers: [] };
  const av = availability("LIFEOS_StatusLine.sh", ctx);
  const scriptPath = join(ctx.lifeosDir, "LIFEOS_StatusLine.sh");
  const settingsPath = join(ctx.configRoot, "settings.json");
  const command = scriptPath.startsWith(`${ctx.home}/`)
    ? `$HOME/${scriptPath.slice(ctx.home.length + 1)}`
    : scriptPath;
  if (process.platform === "win32") {
    r.blockers.push("statusline panel is unsupported on native Windows because the shipped executable is Bash; no settings wiring was written");
    return r;
  }
  if (!av.inLive && !av.inPayload) {
    r.blockers.push(`LIFEOS_StatusLine.sh not in live tree (${scriptPath}) or payload`);
    return r;
  }
  let settings: Record<string, unknown> = {};
  try { requirePhysicalSettings(settingsPath); }
  catch (error) { r.blockers.push(error instanceof Error ? error.message : String(error)); return r; }
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      r.blockers.push("settings.json exists but is not valid JSON — refusing to rewrite");
      return r;
    }
  }
  const current = settings.statusLine as Record<string, unknown> | undefined;
  const alreadyWired = current?.command === command;
  r.ready = true;
  if (!ctx.apply) {
    if (!av.inLive) r.actions.push(`lifecycle copy LIFEOS_StatusLine.sh → ${scriptPath}`);
    r.actions.push(`lifecycle wire settings.json statusLine → ${command}`);
    return r;
  }
  try {
    const source = av.inLive ? scriptPath : join(ctx.payloadRoot, "LIFEOS_StatusLine.sh");
    requirePhysicalContainedFile(source, av.inLive ? ctx.lifeosDir : ctx.payloadRoot, "statusline source");
    const mutations: Array<Record<string, unknown>> = [{
      id: "statusline:script",
      kind: "write",
      path: scriptPath,
      bytes: readFileSync(source),
      mode: 0o755,
      ownership: av.inLive ? "adopted" : "owned",
    }];
    if (!alreadyWired) {
      settings.statusLine = { type: "command", command, refreshInterval: 1 };
      mutations.push({
        id: "statusline:settings",
        kind: "write",
        path: settingsPath,
        bytes: Buffer.from(`${JSON.stringify(settings, null, 2)}\n`),
        mode: existsSync(settingsPath) ? statSync(settingsPath).mode & 0o777 : 0o600,
        ownership: existsSync(settingsPath) ? "adopted" : "owned",
        structured: "json",
      });
    }
    await applyComponentMutations(ctx, "statusline", mutations);
    r.applied = true;
    const reread = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const wired = (reread.statusLine as Record<string, unknown> | undefined)?.command === command;
    let executable = false;
    try { execFileSync("test", ["-x", scriptPath]); executable = true; } catch { executable = false; }
    r.probe = { name: "statusline-wired", passed: wired && executable, detail: `wired=${wired} executable=${executable}` };
  } catch (error) {
    r.error = error instanceof Error ? error.message : String(error);
  }
  return r;
}

/**
 * Merge a single Claude-Code enhancement key (spinnerTipsOverride / spinnerVerbs)
 * from the shipped `install/settings.enhancements.json` into the user's
 * settings.json — set-the-key semantics (these are whole-object settings, like
 * statusLine). Idempotent (deep-equal → skip), backup-before-write, parse-abort.
 */
async function deploySettingsKey(component: Component, key: string, ctx: Ctx): Promise<ComponentResult> {
  const r: ComponentResult = { component, ready: false, actions: [], blockers: [] };
  const enhPath = join(ctx.installRoot, "settings.enhancements.json");
  if (!existsSync(enhPath)) {
    r.blockers.push(`valid physical settings.enhancements.json not in payload (${enhPath})`);
    return r;
  }
  try { requirePhysicalContainedFile(enhPath, ctx.installRoot, "settings.enhancements.json"); }
  catch (error) { r.blockers.push(error instanceof Error ? error.message : String(error)); return r; }
  let enh: Record<string, unknown>;
  try { enh = JSON.parse(readFileSync(enhPath, "utf-8")); } catch { r.blockers.push(`${enhPath} is not valid JSON`); return r; }
  if (!(key in enh)) {
    r.blockers.push(`${key} not present in settings.enhancements.json`);
    return r;
  }
  const settingsPath = join(ctx.configRoot, "settings.json");
  try { requirePhysicalSettings(settingsPath); }
  catch (error) { r.blockers.push(error instanceof Error ? error.message : String(error)); return r; }
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); }
    catch { r.blockers.push("settings.json exists but is not valid JSON — refusing to rewrite"); return r; }
  }
  const already = JSON.stringify(settings[key]) === JSON.stringify(enh[key]);
  r.ready = true;
  if (!ctx.apply) {
    r.actions.push(`lifecycle merge settings.${key} into ${settingsPath}`);
    return r;
  }
  try {
    if (!already) {
      settings[key] = enh[key];
      await applyComponentMutations(ctx, component, [{
        id: `${component}:settings`,
        kind: "write",
        path: settingsPath,
        bytes: Buffer.from(`${JSON.stringify(settings, null, 2)}\n`),
        mode: existsSync(settingsPath) ? statSync(settingsPath).mode & 0o777 : 0o600,
        ownership: existsSync(settingsPath) ? "adopted" : "owned",
        structured: "json",
      }]);
    }
    r.applied = !already;
    const reread = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
    r.probe = { name: `${component}-merged`, passed: JSON.stringify(reread[key]) === JSON.stringify(enh[key]), detail: `settings.${key} set${already ? " (idempotent)" : ""}` };
  } catch (error) {
    r.error = error instanceof Error ? error.message : String(error);
  }
  return r;
}

async function deployMissingTree(component: "agents" | "commands", ctx: Ctx): Promise<ComponentResult> {
  const r: ComponentResult = { component, ready: false, actions: [], blockers: [] };
  const src = join(ctx.installRoot, component);
  const dst = join(ctx.configRoot, component);
  if (!existsSync(src) && !existsSync(dst)) {
    r.blockers.push(`${component} not in payload (${src}) and not already installed (${dst})`);
    return r;
  }
  r.ready = true;
  if (!ctx.apply) {
    r.actions.push(existsSync(src) ? `lifecycle copy missing ${component} → ${dst}` : `${component} already present at ${dst} — no-op`);
    return r;
  }
  try {
    if (!existsSync(src)) {
      r.probe = { name: `${component}-present`, passed: true, detail: `already present at ${dst}` };
      return r;
    }
    const mutations = missingTreeMutations(src, dst, component);
    await applyComponentMutations(ctx, component, mutations);
    r.applied = mutations.length > 0;
    r.probe = { name: `${component}-copied`, passed: existsSync(dst), detail: `${mutations.length} file(s) copied through lifecycle` };
  } catch (error) {
    r.error = error instanceof Error ? error.message : String(error);
  }
  return r;
}

function deployAgents(ctx: Ctx): Promise<ComponentResult> {
  return deployMissingTree("agents", ctx);
}

function deployCommands(ctx: Ctx): Promise<ComponentResult> {
  return deployMissingTree("commands", ctx);
}

/**
 * Delegate launchd service install to Services.ts — single source of truth for all 16 services.
 * This keeps DeployComponents focused on non-launchd components (settings merges, file copies)
 * while Services.ts owns the full launchd machinery.
 */
async function deployViaServices(component: LaunchdComponent, ctx: Ctx): Promise<ComponentResult> {
  const r: ComponentResult = { component, ready: false, actions: [], blockers: [] };
  if (process.platform !== "darwin") {
    r.blockers.push(`launchd services are unsupported on ${process.platform}; no runtime files or service mutations were staged`);
    return r;
  }
  const servicesTs = join(ctx.lifeosDir, "TOOLS", "Services.ts");
  const av = availability("TOOLS", ctx);
  if (!av.inLive && !av.inPayload) {
    r.blockers.push(`TOOLS not in live tree (${join(ctx.lifeosDir, "TOOLS")}) or payload`);
    return r;
  }
  r.ready = true;
  const label = component.startsWith("com.lifeos.") ? component : `com.lifeos.${component}`;
  if (!ctx.apply) {
    if (!av.inLive) r.actions.push(`lifecycle stage TOOLS → ${join(ctx.lifeosDir, "TOOLS")}`);
    r.actions.push(`bun ${servicesTs.replace(ctx.home, "~")} install --only ${component} --yes`);
    return r;
  }
  try {
    if (av.inPayload) {
      const mutations = missingTreeMutations(join(ctx.payloadRoot, "TOOLS"), join(ctx.lifeosDir, "TOOLS"), `tools:${component}`);
      await applyComponentMutations(ctx, component, mutations);
    }
    if (!existsSync(servicesTs)) {
      r.blockers.push(`Services.ts still missing after lifecycle staging: ${servicesTs}`);
      return r;
    }
    requirePhysicalContainedFile(servicesTs, join(ctx.lifeosDir, "TOOLS"), "Services.ts");
    const out = execFileSync("bun", [servicesTs, "install", "--only", component, "--yes"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
      cwd: dirname(servicesTs),
    }).toString();
    r.applied = true;
    const loaded = launchctl(["print", `gui/${uid()}/${label}`]).ok;
    r.probe = { name: `${component}-loaded`, passed: loaded, detail: loaded ? `${label} loaded via Services.ts` : `Services.ts exit 0 but ${label} not loaded: ${out.trim().split("\n").slice(-1)[0]}` };
  } catch (error) {
    r.error = error instanceof Error ? error.message : String(error);
  }
  return r;
}

function isLaunchdComponent(c: Component): c is LaunchdComponent {
  return (LAUNCHD_COMPONENTS as readonly string[]).includes(c);
}

async function deploy(component: Component, ctx: Ctx): Promise<ComponentResult> {
  switch (component) {
    case "statusline": return deployStatusline(ctx);
    case "tooltips": return deploySettingsKey("tooltips", "spinnerTipsOverride", ctx);
    case "spinnerverbs": return deploySettingsKey("spinnerverbs", "spinnerVerbs", ctx);
    case "agents": return deployAgents(ctx);
    case "commands": return deployCommands(ctx);
  }
  if (isLaunchdComponent(component)) return deployViaServices(component, ctx);
  return { component, ready: false, actions: [], blockers: [`unknown component: ${component}`] };
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const a = process.argv.slice(2);
  const roots = resolveInstallRoots();
  const home = roots.home;
  const configRoot = arg(a, "--config-root") || roots.configRoot;
  const skillRoot = arg(a, "--skill-root") || join(import.meta.dir, "..");
  const apply = a.includes("--apply");
  const allowDev = a.includes("--allow-dev");

  if (detectDevTree(configRoot) && !allowDev) {
    console.log(JSON.stringify({ ok: false, refused: "dev-tree", detail: `${configRoot} is a LifeOS source tree (skills/_LIFEOS present) — refusing to deploy components. Use --allow-dev only in a sandbox.` }, null, 2));
    process.exit(2);
  }

  // Selection: --all, or --components csv. Dry-run with no selection plans all.
  const csv = arg(a, "--components");
  const selectAll = a.includes("--all");
  let selected: Component[];
  if (selectAll) {
    selected = [...KNOWN_COMPONENTS];
  } else if (csv) {
    const requested = csv.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = requested.filter((c) => !KNOWN_COMPONENTS.includes(c as Component));
    if (unknown.length) {
      console.log(JSON.stringify({ ok: false, error: `unknown component(s): ${unknown.join(", ")}`, known: KNOWN_COMPONENTS }, null, 2));
      process.exit(1);
    }
    selected = requested as Component[];
  } else if (apply) {
    console.log(JSON.stringify({ ok: false, error: "--apply needs --components <csv> or --all (opt-in: nothing deploys implicitly)", known: KNOWN_COMPONENTS }, null, 2));
    process.exit(1);
  } else {
    selected = [...KNOWN_COMPONENTS]; // dry-run planning view
  }

  const ctx: Ctx = {
    configRoot,
    lifeosDir: resolveLifeosDir(configRoot),
    payloadRoot: existsSync(join(skillRoot, "install", "LIFEOS"))
      ? join(skillRoot, "install", "LIFEOS")
      : join(skillRoot, "install", "LifeOS"),
    installRoot: join(skillRoot, "install"),
    home,
    // launchd runs the plist with a minimal PATH, so ProgramArguments[0] must be an
    // absolute bun path. Prefer the interpreter running this installer; fall back to
    // the standard bun install location.
    bun: /\/bun$/.test(process.execPath) ? process.execPath : join(home, ".bun", "bin", "bun"),
    launchAgents: join(home, "Library", "LaunchAgents"),
    apply,
  };

  const results: ComponentResult[] = [];
  for (const component of selected) results.push(await deploy(component, ctx));
  // A blocked component (prereq absent, nothing written) is a FAILURE, not a
  // silent success — `ok` factors in blockers, error, AND probe in both modes.
  const ok = results.every((r) => r.blockers.length === 0 && !r.error && (!r.probe || r.probe.passed));

  console.log(JSON.stringify({
    ok,
    dryRun: !apply,
    configRoot,
    lifeosDir: ctx.lifeosDir,
    payloadRoot: ctx.payloadRoot,
    selected,
    results,
    note: apply ? undefined : "dry-run — re-run with --apply --components <csv> after the user opts in",
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

void main();
