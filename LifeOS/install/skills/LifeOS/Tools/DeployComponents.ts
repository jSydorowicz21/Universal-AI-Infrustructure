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
import { accessSync, chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { copyMissing, defaultConfigRoot, detectDevTree, resolveInstallerHome } from "./InstallEngine";

// Enhancement components are the à-la-carte half of setup. The "LifeOS Core"
// (skills + system prompt + base settings + CLAUDE.md) is installed by Setup's
// core steps; these are the opt-in extras the user (or their AI) picks some/all/none of.
//
// Two kinds:
// - Direct components: statusline, tooltips, spinnerverbs, agents, commands
// - Background services: delegated to Services.ts on macOS; Pulse also uses its
//   native systemd (Linux) or Scheduled Task (Windows) manager.
//
// Component names for background services are their short labels or full label.
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
  bun: string;
  platform: string;
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

const stamp = (): string => String(Date.now());

/** Back up a file aside as <file>.lifeos-backup-<ts> (only if it exists). */
function backup(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const dst = `${path}.lifeos-backup-${stamp()}`;
  copyFileSync(path, dst);
  return dst;
}

/** Where a component's path can be sourced from. */
function availability(rel: string, ctx: Ctx): { inLive: boolean; inPayload: boolean } {
  return { inLive: existsSync(join(ctx.lifeosDir, rel)), inPayload: existsSync(join(ctx.payloadRoot, rel)) };
}

/**
 * Ensure a component path exists in the live tree, copying from the shipped
 * payload only when ABSENT (never overwrites a populated target — idempotent).
 * Returns whether the path is present after the call.
 */
function ensurePresent(rel: string, ctx: Ctx): boolean {
  const dst = join(ctx.lifeosDir, rel);
  if (existsSync(dst)) return true;
  const src = join(ctx.payloadRoot, rel);
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  return true;
}

const uid = (): string => execFileSync("id", ["-u"]).toString().trim();

function processExitSummary(error: unknown, action: string): string {
  const statusValue = error !== null && typeof error === "object" && "status" in error ? error.status : undefined;
  const status = statusValue === undefined || statusValue === null ? "unknown" : String(statusValue);
  return `${action} failed (exit ${status}); process output withheld to avoid leaking credentials`;
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("launchctl", args, { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }).toString();
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

function preparePulse(ctx: Ctx): { ok: true } | { ok: false; error: string } {
  const livePulse = join(ctx.lifeosDir, "PULSE");
  const payloadPulse = join(ctx.payloadRoot, "PULSE");
  let staged = false;

  if (!existsSync(livePulse)) {
    if (!existsSync(payloadPulse)) return { ok: false, error: `Pulse payload missing: ${payloadPulse}` };
    mkdirSync(dirname(livePulse), { recursive: true });
    cpSync(payloadPulse, livePulse, { recursive: true });
    staged = true;
  }

  const rootPackage = join(livePulse, "package.json");
  if (!existsSync(rootPackage)) {
    if (staged) rmSync(livePulse, { recursive: true, force: true });
    return { ok: false, error: `Pulse package.json missing: ${rootPackage}` };
  }

  const installs = [
    { cwd: livePulse, args: ["install", "--frozen-lockfile"], label: "Pulse runtime dependencies" },
  ];
  const dashboard = join(livePulse, "Observability");
  if (existsSync(join(dashboard, "package.json"))) {
    installs.push(
      { cwd: dashboard, args: ["install", "--frozen-lockfile"], label: "Pulse dashboard dependencies" },
      { cwd: dashboard, args: ["run", "build"], label: "Pulse dashboard build" },
    );
  }

  const createdNodeModules: string[] = [];
  try {
    for (const step of installs) {
      const nodeModules = join(step.cwd, "node_modules");
      if (!existsSync(nodeModules)) createdNodeModules.push(nodeModules);
      execFileSync(ctx.bun, step.args, {
        cwd: step.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180000,
        env: { ...process.env, LIFEOS_CONFIG_ROOT: ctx.configRoot, LIFEOS_DIR: ctx.lifeosDir },
      });
    }
    return { ok: true };
  } catch (err) {
    if (staged) {
      rmSync(livePulse, { recursive: true, force: true });
    } else {
      for (const nodeModules of createdNodeModules) rmSync(nodeModules, { recursive: true, force: true });
    }
    return { ok: false, error: processExitSummary(err, "Pulse dependency preparation") };
  }
}

function statusLineWired(value: unknown, command: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "command" in value && (value as Record<string, unknown>).command === command;
}

// ── component deployers ──────────────────────────────────────────────

/** Statusline: place the script, chmod +x, wire settings.json statusLine. */
function deployStatusline(ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component: "statusline", ready: false, actions: [], blockers: [] };
  if (ctx.platform === "win32") {
    r.blockers.push("statusline requires a POSIX shell and is not available on Windows; omit this enhancement");
    return r;
  }
  const av = availability("LIFEOS_StatusLine.sh", ctx);
  const scriptPath = join(ctx.lifeosDir, "LIFEOS_StatusLine.sh");
  const settingsPath = join(ctx.configRoot, "settings.json");
  const command = scriptPath.startsWith(`${ctx.home}/`)
    ? `$HOME/${scriptPath.slice(ctx.home.length + 1)}`
    : scriptPath;

  if (!av.inLive && !av.inPayload) {
    r.blockers.push(`LIFEOS_StatusLine.sh not in live tree (${scriptPath}) or payload`);
    return r;
  }
  r.ready = true;
  if (!ctx.apply) {
    if (!av.inLive) r.actions.push(`copy LIFEOS_StatusLine.sh from payload → ${scriptPath}`);
    r.actions.push(`chmod +x ${scriptPath}`, `wire settings.json statusLine → ${command}`);
    return r;
  }

  try {
    ensurePresent("LIFEOS_StatusLine.sh", ctx);
    chmodSync(scriptPath, 0o755);
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {
        r.blockers.push("settings.json exists but is not valid JSON — refusing to rewrite");
        return r;
      }
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
        r.blockers.push("settings.json must contain a JSON object — refusing to rewrite");
        return r;
      }
      settings = parsed as Record<string, unknown>;
    }
    const alreadyWired = statusLineWired(settings.statusLine, command);
    if (!alreadyWired) {
      backup(settingsPath);
      settings.statusLine = { type: "command", command, refreshInterval: 1 };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
    r.applied = !alreadyWired;
    const reread = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const wired = statusLineWired(reread.statusLine, command);
    let executable = false;
    try { accessSync(scriptPath, constants.X_OK); executable = true; } catch { executable = false; }
    r.probe = { name: "statusline-wired", passed: wired && executable, detail: `wired=${wired} executable=${executable}${alreadyWired ? " (idempotent)" : ""}` };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

/**
 * Merge a single Claude-Code enhancement key (spinnerTipsOverride / spinnerVerbs)
 * from the shipped `install/settings.enhancements.json` into the user's
 * settings.json — set-the-key semantics (these are whole-object settings, like
 * statusLine). Idempotent (deep-equal → skip), backup-before-write, parse-abort.
 */
function deploySettingsKey(component: Component, key: string, ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component, ready: false, actions: [], blockers: [] };
  const enhPath = join(ctx.installRoot, "settings.enhancements.json");
  if (!existsSync(enhPath)) {
    r.blockers.push(`settings.enhancements.json not in payload (${enhPath}) — runtime not staged`);
    return r;
  }
  let enh: Record<string, unknown>;
  try { enh = JSON.parse(readFileSync(enhPath, "utf-8")); } catch { r.blockers.push(`${enhPath} is not valid JSON`); return r; }
  if (!(key in enh)) {
    r.blockers.push(`${key} not present in settings.enhancements.json`);
    return r;
  }
  r.ready = true;
  const settingsPath = join(ctx.configRoot, "settings.json");
  if (!ctx.apply) {
    r.actions.push(`merge settings.${key} into ${settingsPath} (backup-first, idempotent)`);
    return r;
  }
  try {
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); }
      catch { r.blockers.push(`settings.json exists but is not valid JSON — refusing to rewrite (would drop your config).`); return r; }
    }
    const already = JSON.stringify(settings[key]) === JSON.stringify(enh[key]);
    if (!already) {
      backup(settingsPath);
      settings[key] = enh[key];
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
    r.applied = !already;
    const reread = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
    const passed = JSON.stringify(reread[key]) === JSON.stringify(enh[key]);
    r.probe = { name: `${component}-merged`, passed, detail: `settings.${key} set${already ? " (idempotent)" : ""}` };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

/** Agents: copyMissing the shipped agents tree into the harness agents dir (never overwrites). */
function deployAgents(ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component: "agents", ready: false, actions: [], blockers: [] };
  const src = join(ctx.installRoot, "agents");
  const dst = join(ctx.configRoot, "agents");
  if (!existsSync(src) && !existsSync(dst)) {
    r.blockers.push(`agents not in payload (${src}) and not already installed (${dst})`);
    return r;
  }
  r.ready = true;
  if (!ctx.apply) {
    r.actions.push(existsSync(src) ? `copyMissing agents → ${dst} (never overwrites existing)` : `agents already present at ${dst} — no-op`);
    return r;
  }
  try {
    if (!existsSync(src)) {
      r.applied = false;
      r.probe = { name: "agents-present", passed: true, detail: `already present at ${dst} (no payload to copy)` };
      return r;
    }
    const { copied, failures } = copyMissing(src, dst);
    r.applied = copied > 0;
    r.probe = { name: "agents-copied", passed: failures.length === 0 && existsSync(dst), detail: `${copied} agent file(s) copied${failures.length ? `, ${failures.length} failed` : ""}` };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

// commands mirrors agents exactly: copy the payload's install/commands/ into the
// user's ~/.claude/commands/, never overwriting. The payload is already filtered
// at emit time to public commands only (a command ships iff its target skill
// ships), so there is nothing private-pointing to guard against here.
function deployCommands(ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component: "commands", ready: false, actions: [], blockers: [] };
  const src = join(ctx.installRoot, "commands");
  const dst = join(ctx.configRoot, "commands");
  if (!existsSync(src) && !existsSync(dst)) {
    r.blockers.push(`commands not in payload (${src}) and not already installed (${dst})`);
    return r;
  }
  r.ready = true;
  if (!ctx.apply) {
    r.actions.push(existsSync(src) ? `copyMissing commands → ${dst} (never overwrites existing)` : `commands already present at ${dst} — no-op`);
    return r;
  }
  try {
    if (!existsSync(src)) {
      r.applied = false;
      r.probe = { name: "commands-present", passed: true, detail: `already present at ${dst} (no payload to copy)` };
      return r;
    }
    const { copied, failures } = copyMissing(src, dst);
    r.applied = copied > 0;
    r.probe = { name: "commands-copied", passed: failures.length === 0 && existsSync(dst), detail: `${copied} command file(s) copied${failures.length ? `, ${failures.length} failed` : ""}` };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

/**
 * Delegate launchd service install to Services.ts — single source of truth for all 16 services.
 * This keeps DeployComponents focused on non-launchd components (settings merges, file copies)
 * while Services.ts owns the full launchd machinery.
 */
function deployViaServices(component: LaunchdComponent, ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component, ready: false, actions: [], blockers: [] };

  if (ctx.platform !== "darwin") {
    if (component !== "pulse") {
      r.blockers.push(
        `${component} has no ${ctx.platform} service adapter; install it on macOS or run its tool manually`,
      );
      return r;
    }

    const av = availability("PULSE", ctx);
    if (!av.inLive && !av.inPayload) {
      r.blockers.push(`PULSE not in live tree (${join(ctx.lifeosDir, "PULSE")}) or payload`);
      return r;
    }
    const managerName = ctx.platform === "win32" ? "manage.ps1" : "manage.sh";
    const manager = join(ctx.lifeosDir, "PULSE", managerName);
    r.ready = true;
    if (!ctx.apply) {
      if (!av.inLive) r.actions.push(`stage PULSE from payload → ${join(ctx.lifeosDir, "PULSE")}`);
      r.actions.push(
        ctx.platform === "win32"
          ? `powershell -File ${manager.replace(ctx.home, "~")} install`
          : `bash ${manager.replace(ctx.home, "~")} install`,
      );
      return r;
    }

    try {
      ensurePresent("PULSE", ctx);
      if (!existsSync(manager)) {
        r.blockers.push(`${managerName} still missing after staging: ${manager}`);
        return r;
      }
      const env = { ...process.env, LIFEOS_CONFIG_ROOT: ctx.configRoot, LIFEOS_DIR: ctx.lifeosDir };
      const isWin = ctx.platform === "win32";
      const interpreter = isWin ? Bun.which("pwsh") || Bun.which("powershell") : Bun.which("bash");
      if (!interpreter) {
        r.blockers.push(isWin
          ? "PowerShell is required to install the Windows Pulse Scheduled Task"
          : "bash is required to install the Linux Pulse user service");
        return r;
      }
      const managerArgs = isWin
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", manager, "install"]
        : [manager, "install"];
      execFileSync(interpreter, managerArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000,
        cwd: dirname(manager),
        env,
      });
      r.applied = true;
      r.probe = { name: "pulse-service-ready", passed: true, detail: `Pulse installed through ${managerName}` };
    } catch (err) {
      r.error = processExitSummary(err, "pulse service installation");
    }
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
    if (!av.inLive) r.actions.push(`stage TOOLS from payload → ${join(ctx.lifeosDir, "TOOLS")}`);
    r.actions.push(`bun ${servicesTs.replace(ctx.home, "~")} install --only ${component} --yes`);
    return r;
  }

  try {
    ensurePresent("TOOLS", ctx);
    if (!existsSync(servicesTs)) {
      r.blockers.push(`Services.ts still missing after staging: ${servicesTs}`);
      return r;
    }
    execFileSync(ctx.bun, [servicesTs, "install", "--only", component, "--yes"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
      cwd: dirname(servicesTs),
      env: { ...process.env, LIFEOS_CONFIG_ROOT: ctx.configRoot, LIFEOS_DIR: ctx.lifeosDir },
    });
    r.applied = true;
    const loaded = launchctl(["print", `gui/${uid()}/${label}`]).ok;
    r.probe = { name: `${component}-loaded`, passed: loaded, detail: loaded ? `${label} loaded via Services.ts` : `${label} was not loaded after Services.ts returned success` };
  } catch (err) {
    r.error = processExitSummary(err, `${component} service installation`);
  }
  return r;
}

function isLaunchdComponent(c: Component): c is LaunchdComponent {
  return (LAUNCHD_COMPONENTS as readonly string[]).includes(c);
}

function deploy(component: Component, ctx: Ctx): ComponentResult {
  // Non-launchd components: handled directly
  switch (component) {
    case "statusline": return deployStatusline(ctx);
    case "tooltips": return deploySettingsKey("tooltips", "spinnerTipsOverride", ctx);
    case "spinnerverbs": return deploySettingsKey("spinnerverbs", "spinnerVerbs", ctx);
    case "agents": return deployAgents(ctx);
    case "commands": return deployCommands(ctx);
  }
  // Launchd components: delegate to Services.ts
  if (isLaunchdComponent(component)) {
    return deployViaServices(component, ctx);
  }
  // Fallback (shouldn't reach here with proper types, but TypeScript wants exhaustiveness)
  return { component, ready: false, actions: [], blockers: [`unknown component: ${component}`] };
}

// ── main ─────────────────────────────────────────────────────────────

function main(): void {
  const a = process.argv.slice(2);
  const home = resolveInstallerHome();
  const configRoot = arg(a, "--config-root") || defaultConfigRoot(home);
  const skillRoot = arg(a, "--skill-root") || join(import.meta.dir, "..");
  const platform = arg(a, "--platform") || process.platform;
  const apply = a.includes("--apply");
  const allowDev = a.includes("--allow-dev");
  if (!["darwin", "linux", "win32"].includes(platform)) {
    console.log(JSON.stringify({ ok: false, error: `unsupported operating system: ${platform}` }, null, 2));
    process.exit(1);
  }

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
    bun: Bun.which("bun") || process.execPath,
    launchAgents: join(home, "Library", "LaunchAgents"),
    apply,
    platform,
  };

  if (apply && selected.includes("pulse")) {
    const prepared = preparePulse(ctx);
    if (!prepared.ok) {
      console.log(JSON.stringify({ ok: false, error: prepared.error }, null, 2));
      process.exit(1);
    }
  }

  const results = selected.map((c) => deploy(c, ctx));
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

main();
