#!/usr/bin/env bun
/**
 * Services — the one-shot control surface for every LifeOS background service.
 *
 * Single source of truth (SERVICES below) + live discovery/parse of the actual
 * launchd plists, so `status` reports reality, not a hand-maintained guess.
 *
 *   bun Services.ts status              # what's running vs installed vs available
 *   bun Services.ts install [--all|--only a,b] [--yes]
 *   bun Services.ts uninstall --only a,b
 *   bun Services.ts doc                 # emit the canonical markdown table (for the doc)
 *
 * launchctl install/uninstall are the privileged steps; `status`/`doc` are read-only.
 *
 * Linux: `status`/`doc` branch on `process.platform` to read systemd --user
 * units instead of launchd plists (same pattern as InstallWorkSweep.ts and
 * the sibling Install*.ts scripts, which each materialize a systemd unit
 * pair on Linux). Installation runs each service's own platform-aware command;
 * uninstallation removes the native launchd, systemd, or scheduled-task unit.
 * Unsupported services remain visible in status output but are labelled
 * "unsupported" instead of being misreported as missing.
 *
 * ported from public PR #1705, @takanorinishida
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { platformFacts, type RuntimeOs } from "../UNIVERSAL/platform";
import { planService, type ServiceBackend, type ServicePlan } from "../UNIVERSAL/services";

export interface ServiceRoots {
  home: string;
  configRoot: string;
  lifeosDir: string;
  launchAgentsDir: string;
  systemdUserDir: string;
}

export function resolveServiceRoots(
  env: Pick<NodeJS.ProcessEnv, "HOME" | "USERPROFILE" | "UAI_CONFIG_DIR" | "PAI_CONFIG_DIR" | "CLAUDE_CONFIG_DIR" | "LIFEOS_DIR"> = process.env,
  fallbackHome = homedir(),
  configRootOverride?: string,
): ServiceRoots {
  const home = normalize(env.HOME?.trim() || env.USERPROFILE?.trim() || fallbackHome);
  const configRoot = normalize(configRootOverride || env.UAI_CONFIG_DIR?.trim() || env.PAI_CONFIG_DIR?.trim() || env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"));
  const lifeosDir = normalize(env.LIFEOS_DIR?.trim() || join(configRoot, "LIFEOS"));
  return {
    home,
    configRoot,
    lifeosDir,
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
    systemdUserDir: join(home, ".config", "systemd", "user"),
  };
}

export interface ServicePlatformSupport {
  supported: boolean;
  backend: ServiceBackend;
  reason?: string;
  plan: ServicePlan;
}

export function servicePlatformSupport(platform: NodeJS.Platform = process.platform): ServicePlatformSupport {
  const os: RuntimeOs = platform === "win32" || platform === "darwin" || platform === "linux" ? platform : "unknown";
  const managers = os === "darwin" ? ["launchd"] : os === "linux" ? ["systemd-user"] : os === "win32" ? ["scheduled-task"] : [];
  const facts = platformFacts({ platform: os });
  const plan = planService({ os, headless: facts.headless, managers });
  const supported = plan.backend !== "foreground" && plan.backend !== "unsupported";
  return { supported, backend: plan.backend, plan, reason: supported ? undefined : plan.losses.join("; ") };
}

const configRootIndex = process.argv.indexOf("--config-root");
const ROOTS = resolveServiceRoots(process.env, homedir(), configRootIndex >= 0 ? process.argv[configRootIndex + 1] : undefined);
const IS_LINUX = process.platform === "linux";
const IS_WINDOWS = process.platform === "win32";
const HOME = ROOTS.home;
const LIFEOS = ROOTS.lifeosDir;
const TOOLS = join(LIFEOS, "TOOLS");
const PULSE = join(LIFEOS, "PULSE");
const LAUNCH_AGENTS = ROOTS.launchAgentsDir;
const SYSTEMD_USER = ROOTS.systemdUserDir;
const HERMES = join(LIFEOS, "HERMES");

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function commandQuote(value: string): string {
  return IS_WINDOWS ? `"${value.replaceAll('"', '\"')}"` : shellQuote(value);
}

export type Cat = "pulse" | "sidecar" | "capture" | "sync" | "sweep" | "maintenance";
export interface Svc {
  /** `com.lifeos.<x>` for services LifeOS installs; a vendor label for a mounted sidecar. */
  label: string;
  title: string;
  purpose: string;
  category: Cat;
  optIn: boolean;           // opt-in at install (vs default-on core)
  install: string;          // shell command that installs+loads it ("#"-prefixed = note, not runnable
  uninstall?: string;
  /** True for entries loaded from the USER-tree config — per-instance private
   *  machinery. `doc` renders these with a containment marker instead of the
   *  raw install command, so the shipped generated table never carries a
   *  private path even when regenerated (Max audit, 7.31.3: the hand-edited
   *  table row was reverted by its own generator — third occurrence of the
   *  self-referential-redaction blind spot). */
  perInstance?: boolean;
  /** Platforms on which this service has an install implementation. */
  platforms?: Array<"darwin" | "linux" | "win32">;
}

// Canonical registry: the human-meaningful metadata. Mechanical facts (cadence,
// runner) are read live from the plists in status()/doc().
export const SERVICES: Svc[] = [
  { label: "com.lifeos.pulse", title: "Pulse (dashboard server)", category: "pulse", optIn: false,
    purpose: "The Life Dashboard HTTP server on :31337 — Pulse, the visible surface onto LifeOS.",
    install: IS_WINDOWS ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${commandQuote(join(PULSE, "manage.ps1"))} install` : `bash ${commandQuote(join(PULSE, "manage.sh"))} install` },
  { label: "com.lifeos.pulse-menubar", title: "Pulse menu-bar app", category: "pulse", optIn: false, platforms: ["darwin"],
    purpose: "macOS menu-bar app for Pulse — quick status + open the dashboard.",
    install: `bash ${commandQuote(join(PULSE, "MenuBar/install.sh"))}` },
  { label: "com.lifeos.deriver", title: "Pulse deriver", category: "pulse", optIn: false, platforms: ["darwin"],
    purpose: "Regenerates Pulse's derived Data-Plane pages on a cadence.",
    install: `bash ${commandQuote(join(PULSE, "manage-deriver.sh"))} install` },
  // Separate but integrated: Hermes runs its own process tree under its own
  // vendor label, and LifeOS owns its health. Registered here so the sidecar
  // can't be up-or-down without the service surface knowing.
  { label: "ai.hermes.gateway", title: "Hermes sidecar (gateway)", category: "sidecar", optIn: true,
    purpose: "The second front door — Hermes gateway mounting this LifeOS install, serving its message channels. Health probe: `bun LIFEOS/HERMES/Health.ts`.",
    install: `bun ${commandQuote(join(HERMES, "Mount.ts"))}` },
  { label: "com.lifeos.conduit", title: "Conduit (sensory capture)", category: "capture", optIn: false,
    purpose: "Local current-state capture — feeds memory + TELOS current state.",
    install: `bun ${commandQuote(join(PULSE, "Conduit/InstallConduit.ts"))}` },
  { label: "com.lifeos.conduit.insight", title: "Conduit insight builder", category: "capture", optIn: false,
    purpose: "Builds insights from Conduit's captured signal.",
    install: `bun ${commandQuote(join(PULSE, "Conduit/InstallConduitInsight.ts"))}` },
  { label: "com.lifeos.synthesis", title: "Synthesis", category: "maintenance", optIn: true,
    purpose: "Periodic synthesis pass over recent state/memory (weekly-style rollup).",
    install: `# installed with the Pulse/Conduit stack — see PULSE/` },
  { label: "com.lifeos.distill", title: "Cortex distill (weekly digest)", category: "maintenance", optIn: true,
    purpose: "Weekly harvest of the Knowledge Archive into a routed digest — content ideas, upgrades, archive health.",
    install: `# plist written by the Cortex skill's distill workflow — bun ${join(TOOLS, "KnowledgeDistill.ts")} run --headless` },
  { label: "com.lifeos.conveyor-watcher", title: "Conveyor inbox watcher", category: "capture", optIn: true,
    purpose: "Watches ~/Recordings/Inbox and registers dropped recordings in the content-pipeline ledger (Conveyor P1).",
    install: `bun ${commandQuote(join(TOOLS, "InstallConveyorWatcher.ts"))}` },
  { label: "com.lifeos.conveyor-runner", title: "Conveyor stage engine", category: "capture", optIn: true,
    purpose: "Advances claimable INBOX items to PREP via transcription, lease-guarded, one item per tick (Conveyor P2 stage 1).",
    install: `bun ${commandQuote(join(TOOLS, "InstallConveyorRunner.ts"))}` },
  { label: "com.lifeos.worksweep", title: "Work sweep", category: "sweep", optIn: true,
    purpose: "Hourly UL work capture — untracked sessions, stale items, project checks, TELOS-goal derivation.",
    install: `bun ${commandQuote(join(TOOLS, "InstallWorkSweep.ts"))}` },
  { label: "com.lifeos.atlas", title: "Atlas asset-graph sync", category: "sync", optIn: true,
    purpose: "Reconciles the Atlas asset graph — 15-min tick (hourly full sync) + event-hint targeted syncs via WatchPaths.",
    install: "manual plist — ~/Library/LaunchAgents/com.lifeos.atlas.plist (see LIFEOS/DOCUMENTATION/Atlas/AtlasSystem.md)" },
  { label: "com.lifeos.derivedsync", title: "Derived-file sync", category: "sync", optIn: true,
    purpose: "Watches 31 USER source files; regenerates PRINCIPAL_TELOS, LIFEOS_STATE, Data-Plane on hand-edits.",
    install: `bun ${commandQuote(join(TOOLS, "InstallDerivedSync.ts"))}` },
  { label: "com.lifeos.healthsync", title: "Health sync", category: "sync", optIn: true,
    purpose: "Syncs health data into CURRENT_STATE.",
    install: `bun ${commandQuote(join(TOOLS, "InstallHealthSync.ts"))}` },
  { label: "com.lifeos.interviewdue", title: "Interview due-check", category: "maintenance", optIn: true,
    purpose: "Daily 07:10: rebuilds state-evidence, freshness, and interview-due caches feeding the statusline interview chip. Caches only — never claims files.",
    install: `bun ${commandQuote(join(TOOLS, "InstallInterviewDue.ts"))}`,
    uninstall: `bun ${commandQuote(join(TOOLS, "InstallInterviewDue.ts"))} --uninstall` },
  { label: "com.lifeos.codexupdate", title: "Codex update", category: "maintenance", optIn: true,
    purpose: "Keeps the Codex mirror / update state current.",
    install: `bun ${commandQuote(join(TOOLS, "InstallCodexUpdate.ts"))}` },
  { label: "com.lifeos.inboxsweep", title: "Inbox sweep", category: "sweep", optIn: true,
    purpose: "Every 5 min: deterministic Gmail triage — archives marketing/notification (podcast pitches, cold outreach) via _INBOX sender taxonomy; keep-classes hard-guarded.",
    install: `bun ${commandQuote(join(TOOLS, "InstallInboxSweep.ts"))}`,
    uninstall: `bun ${commandQuote(join(TOOLS, "InstallInboxSweep.ts"))} --uninstall` },
  { label: "com.lifeos.commitmentsweep", title: "Commitment sweep", category: "sweep", optIn: true,
    purpose: "Sweeps commitments/reminders on a cadence.",
    install: `bun ${commandQuote(join(TOOLS, "InstallCommitmentSweep.ts"))}` },
  { label: "com.lifeos.blogdiscovery", title: "Blog discovery", category: "sweep", optIn: true,
    purpose: "Discovers blog-worthy signal on a cadence.",
    install: `bun ${commandQuote(join(TOOLS, "InstallBlogDiscovery.ts"))}` },
  { label: "com.lifeos.usage-aggregator", title: "Usage aggregator", category: "maintenance", optIn: true,
    purpose: "Aggregates usage/cost telemetry for Pulse.",
    install: `bun ${commandQuote(join(TOOLS, "InstallUsageAggregator.ts"))}` },
  { label: "com.lifeos.pegwatch", title: "PegWatch (CPU/GPU peg detector)", category: "sweep", optIn: true,
    purpose: "Every 16 min: detects pegged CPU/GPU, attributes a likely cause from the process table, surfaces a recommendation via silent Pulse banner + pegwatch.jsonl.",
    install: `bun ${commandQuote(join(TOOLS, "InstallPegWatch.ts"))}`,
    uninstall: `bun ${commandQuote(join(TOOLS, "InstallPegWatch.ts"))} --uninstall` },
  { label: "com.lifeos.bunkermonitor", title: "Bunker app monitor", category: "sweep", optIn: true,
    purpose: "Every 5 min: re-runs every Bunker app's ISA Test Strategy probes; emails on green→red / red→green transitions.",
    install: `bun ${commandQuote(join(TOOLS, "InstallBunkerMonitor.ts"))}`,
    uninstall: `bun ${commandQuote(join(TOOLS, "InstallBunkerMonitor.ts"))} --uninstall` },
];

// Per-instance services live OUTSIDE this file, in the USER tree — an entry
// whose install command points into private infrastructure (a personal Arbol
// worker, a private repo) must never sit in shipped system code. This file
// ships; `LIFEOS/USER/CONFIG/services.json` does not. Absent or malformed
// config → empty list, silently: a fresh public install simply has no
// per-instance services yet.
const USER_SERVICES_PATH = join(LIFEOS, "USER/CONFIG/services.json");
export function loadUserServices(): Svc[] {
  try {
    const raw = JSON.parse(readFileSync(USER_SERVICES_PATH, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s) => s && typeof s.label === "string" && /^[A-Za-z0-9_.-]+$/.test(s.label) && typeof s.install === "string")
      .map((s) => ({ ...s, perInstance: true } as Svc));
  } catch { return []; }
}

/** The full registry: shipped system services + this install's per-instance ones. */
export function allServices(): Svc[] {
  return [...SERVICES, ...loadUserServices()];
}

export interface ServiceCommandResult {
  code: number;
  out: string;
  timedOut: boolean;
}

export function serviceCommandExitCode(results: readonly ServiceCommandResult[]): number {
  return results.some((result) => result.code !== 0 || result.timedOut) ? 1 : 0;
}

export function runBoundedServiceCommand(argv: string[], timeoutMs = 30_000): ServiceCommandResult {
  const child = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const timedOut = child.exitCode === null && child.signalCode !== null;
  return {
    code: child.exitCode ?? (timedOut ? 124 : 1),
    out: (child.stdout.toString() + child.stderr.toString()).trim(),
    timedOut,
  };
}

function sh(command: string): ServiceCommandResult {
  return runBoundedServiceCommand(IS_WINDOWS
    ? ["cmd.exe", "/d", "/s", "/c", command]
    : ["bash", "-c", command]);
}

export interface UninstallableService { label: string; uninstall?: string }

export function runServiceUninstallCommands(
  services: readonly UninstallableService[],
  runner: (command: string) => ServiceCommandResult = sh,
  platform: NodeJS.Platform = process.platform,
): ServiceCommandResult[] {
  return services.map((service) => {
    const command = service.uninstall || (platform === "linux"
      ? `systemctl --user disable --now ${service.label}.path ${service.label}.timer ${service.label}.service 2>/dev/null; rm -f ${shellQuote(join(SYSTEMD_USER, service.label + ".service"))} ${shellQuote(join(SYSTEMD_USER, service.label + ".timer"))} ${shellQuote(join(SYSTEMD_USER, service.label + ".path"))}; systemctl --user daemon-reload`
      : platform === "win32"
        ? `schtasks.exe /Delete /TN ${commandQuote(service.label)} /F`
        : `launchctl bootout gui/$(id -u)/${service.label}; rm -f ${shellQuote(join(LAUNCH_AGENTS, service.label + ".plist"))}`);
    return runner(command);
  });
}

/**
 * Every label launchd currently has loaded. Membership is tested by exact label,
 * so there is nothing to gain by pre-filtering the list — and a `lifeos` filter
 * silently reports any service under a vendor label (the Hermes sidecar) as
 * missing forever, which is the kind of bug that hides a dead service.
 */
function loadedLabelsDarwin(): Set<string> {
  const r = sh("launchctl list 2>/dev/null | awk '{print $3}'");
  return new Set(r.out.split("\n").map((s) => s.trim()).filter(Boolean));
}

/**
 * The systemd --user equivalent. Deliberately NOT filtered to `lifeos` either,
 * for the reason above: a vendor-labelled unit would otherwise read as missing
 * forever. The unit-type suffix is stripped so membership is tested against the
 * same bare label the registry stores.
 */
function loadedLabelsLinux(): Set<string> {
  const r = sh(
    "systemctl --user list-units --all --type=service,timer,path --plain --no-legend 2>/dev/null | awk '{print $1}'",
  );
  return new Set(
    r.out
      .split("\n")
      .map((s) => s.trim().replace(/\.(service|timer|path)$/, ""))
      .filter(Boolean),
  );
}

export function parseWindowsScheduledTaskLabels(output: string): Set<string> {
  const labels = output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^"([^"]+)"/);
    if (!match) return [];
    const taskPath = match[1].replace(/^[\\/]+/, "");
    return taskPath ? [taskPath] : [];
  });
  return new Set(labels);
}

function loadedLabelsWindows(): Set<string> {
  const result = runBoundedServiceCommand(["schtasks.exe", "/Query", "/FO", "CSV", "/NH"]);
  return result.code === 0 ? parseWindowsScheduledTaskLabels(result.out) : new Set();
}

export function loadedLabels(): Set<string> {
  return IS_WINDOWS ? loadedLabelsWindows() : IS_LINUX ? loadedLabelsLinux() : loadedLabelsDarwin();
}

/** Find the plist for a label: installed one wins, else a template in TOOLS/PULSE. */
function findPlistDarwin(label: string): { path: string; installed: boolean } | null {
  const installed = join(LAUNCH_AGENTS, `${label}.plist`);
  if (existsSync(installed)) return { path: installed, installed: true };
  const short = label.replace(/^com\.lifeos\./, "");
  for (const base of [TOOLS, PULSE, join(PULSE, "MenuBar"), join(PULSE, "Conduit")]) {
    for (const cand of [`${label}.plist`, `${label}.plist.template`, `${short}.plist`]) {
      const p = join(base, cand);
      if (existsSync(p)) return { path: p, installed: false };
    }
  }
  return null;
}

/**
 * Find the most cadence-informative systemd unit for a label: a `.timer`
 * (OnCalendar/OnUnitActiveSec) or `.path` (PathModified — the file-watch
 * case, e.g. derivedsync) wins over the bare `.service`, since that's where
 * the scheduling lives. Falls back to the `.service` alone for persistent
 * daemons with no timer/path pairing (e.g. pulse — the systemd analog of a
 * RunAtLoad-only launchd job). Searches the same bases as findPlistDarwin,
 * so a unit shipped beside its installer is found wherever that installer lives.
 */
function findPlistLinux(label: string): { path: string; installed: boolean } | null {
  for (const ext of ["timer", "path", "service"]) {
    const installed = join(SYSTEMD_USER, `${label}.${ext}`);
    if (existsSync(installed)) return { path: installed, installed: true };
  }
  // Not-yet-installed source: most Install*.ts ship a `.template` (placeholders
  // substituted at install time); manage.sh instead keeps pulse's systemd unit
  // as a bare `.service` in PULSE/ (its own __HOME__/__BUN_PATH__ sed step) —
  // the same dual pattern findPlistDarwin already handles on the plist side.
  for (const ext of ["timer", "path", "service"]) {
    for (const base of [TOOLS, PULSE, join(PULSE, "MenuBar"), join(PULSE, "Conduit"), join(LIFEOS, "ATLAS")]) {
      for (const cand of [`${label}.${ext}.template`, `${label}.${ext}`]) {
        const p = join(base, cand);
        if (existsSync(p)) return { path: p, installed: false };
      }
    }
  }
  return null;
}

export function findPlist(label: string): { path: string; installed: boolean } | null {
  if (IS_WINDOWS) return null;
  return IS_LINUX ? findPlistLinux(label) : findPlistDarwin(label);
}

function cadenceOfDarwin(plistPath: string): string {
  try {
    const x = readFileSync(plistPath, "utf8");
    const si = x.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    if (si) { const s = +si[1]; return s % 3600 === 0 ? `every ${s / 3600}h` : `every ${Math.round(s / 60)}m`; }
    if (/<key>StartCalendarInterval<\/key>/.test(x)) return "daily/scheduled";
    if (/<key>WatchPaths<\/key>/.test(x)) return "on file-change";
    if (/<key>RunAtLoad<\/key>\s*<true/.test(x)) return "at load";
    return "—";
  } catch { return "?"; }
}

function cadenceOfLinux(unitPath: string): string {
  try {
    const x = readFileSync(unitPath, "utf8");
    if (/^PathModified=/m.test(x)) return "on file-change";
    if (/^OnCalendar=/m.test(x)) return "daily/scheduled";
    // Our generated timers emit bare seconds (`900s` / `900`); accept the
    // min/h suffixes too, since a hand-written unit may use them.
    const oa = x.match(/^OnUnitActiveSec=(\d+)(s|min|h)?/m);
    if (oa) {
      const n = +oa[1];
      const s = oa[2] === "h" ? n * 3600 : oa[2] === "min" ? n * 60 : n;
      return s % 3600 === 0 ? `every ${s / 3600}h` : `every ${Math.round(s / 60)}m`;
    }
    if (/^\[Timer\]/m.test(x)) return "daily/scheduled"; // timer file with neither pattern matched above
    if (/^Type=simple/m.test(x)) return "at load"; // persistent daemon, no timer/path pairing (e.g. pulse)
    return "—";
  } catch { return "?"; }
}

export function cadenceOf(unitPath: string): string {
  if (IS_WINDOWS) return "scheduled";
  return IS_LINUX ? cadenceOfLinux(unitPath) : cadenceOfDarwin(unitPath);
}

// CLI dispatch runs only when invoked directly. Pulse's `scheduled` module
// imports SERVICES so the registry has exactly one home; without this guard an
// import would execute a command and, worse, could exit the server process.
if (import.meta.main) {

const cmd = process.argv[2] || "status";
const onlyArg = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? process.argv[i + 1].split(",") : null; })();
const all = process.argv.includes("--all");
const yes = process.argv.includes("--yes");
const supportsCurrentPlatform = (service: Svc): boolean => !service.platforms || service.platforms.includes(process.platform as "darwin" | "linux" | "win32");
const pick = (s: Svc) => supportsCurrentPlatform(s) && (onlyArg ? onlyArg.includes(s.label) || onlyArg.includes(s.label.replace(/^com\.lifeos\./, "")) : true);

const REGISTRY = allServices();

if (cmd === "status" || cmd === "list") {
  const loaded = loadedLabels();
  console.log(`LifeOS background services (${REGISTRY.length})\n`);
  console.log("  " + "STATE".padEnd(13) + "CADENCE".padEnd(16) + "SERVICE");
  for (const cat of ["pulse", "sidecar", "capture", "sync", "sweep", "maintenance"] as Cat[]) {
    const rows = REGISTRY.filter((s) => s.category === cat);
    if (!rows.length) continue;
    console.log(`\n  ── ${cat} ──`);
    for (const s of rows) {
      const supported = supportsCurrentPlatform(s);
      const pl = supported ? findPlist(s.label) : null;
      const state = !supported ? "unsupported" : loaded.has(s.label) ? (IS_WINDOWS ? "○ scheduled" : "● running") : pl?.installed ? "○ installed" : pl ? "· available" : "✗ missing";
      const cad = pl ? cadenceOf(pl.path) : "—";
      console.log("  " + state.padEnd(13) + cad.padEnd(16) + s.title + "  (" + s.label + ")");
    }
  }
  const missingCore = REGISTRY.filter((s) => supportsCurrentPlatform(s) && !s.optIn && !loaded.has(s.label));
  if (missingCore.length) console.log(`\n  ⚠️ core not running: ${missingCore.map((s) => s.label).join(", ")}`);
} else if (cmd === "doc") {
  console.log("| Service | Category | Cadence | Opt-in | Purpose | Install |");
  console.log("|---------|----------|---------|--------|---------|---------|");
  for (const s of REGISTRY) {
    const pl = findPlist(s.label);
    const cad = pl ? cadenceOf(pl.path) : "—";
    // Per-instance entries render a containment marker, never their install
    // command: this table lands in shipped DOCUMENTATION, and a private path
    // that survives regeneration is exactly the leak the 7.31.3 audit caught.
    const inst = s.perInstance
      ? "per-install private infrastructure — defined in `LIFEOS/USER/CONFIG/services.json`, NOT in the public release payload"
      : s.install.startsWith("#") ? s.install.slice(1).trim() : `\`${s.install.replace(HOME, "~")}\``;
    console.log(`| **${s.title}** \`${s.label}\` | ${s.category} | ${cad} | ${s.optIn ? "yes" : "core"} | ${s.purpose} | ${inst} |`);
  }
} else if (cmd === "install") {
  const targets = REGISTRY.filter(pick).filter((s) => (all || onlyArg ? true : !s.optIn) && !s.install.startsWith("#"));
  console.log(`Installing ${targets.length} service(s):`);
  if (!yes) { console.log("  (dry preview — re-run with --yes to execute)"); for (const s of targets) console.log(`  ${s.label}: ${s.install.replace(HOME, "~")}`); process.exit(0); }
  // Some services install from a script that lives in a private, release-stripped
  // skill, so on a public install the script simply is not there. Skipping those
  // explicitly beats running them: the bare failure was an opaque exit 1 that read
  // like a broken release rather than "this service belongs to a component you did
  // not install". Caught by the 2026-07-27 cross-vendor audit, which found the inbox
  // sweep always exiting 1 and an Amber installer advertised but never shipped.
  const scriptOf = (cmd: string): string | null => {
    const m = cmd.match(/(\S+\.(?:ts|sh))/);
    return m ? m[1] : null;
  };
  let failed = 0, skipped = 0;
  for (const s of targets) {
    const script = scriptOf(s.install);
    if (script && isAbsolute(script) && !existsSync(script)) {
      console.log(`  ${s.label} … ⏭  skipped (installer not present in this install: ${script.replace(HOME, "~")})`);
      skipped++;
      continue;
    }
    process.stdout.write(`  ${s.label} … `);
    const r = sh(s.install);
    if (r.code === 0 && !r.timedOut) console.log("✅");
    else { console.log(`⚠️ (${r.timedOut ? "timed out" : r.out.split("\n").pop() || `exit ${r.code}`})`); failed++; }
  }
  console.log(`\nRun \`bun Services.ts status\` to confirm.${skipped ? ` ${skipped} skipped.` : ""}`);
  // Exit non-zero when something actually failed. The old loop printed a warning
  // glyph and still exited 0, so any caller or install script treating the exit
  // code as truth recorded a false success.
  if (failed > 0) { console.error(`${failed} service install(s) FAILED.`); process.exit(1); }
} else if (cmd === "uninstall") {
  if (!onlyArg) { console.error("uninstall requires --only <labels> (refusing to remove everything at once)"); process.exit(1); }
  const selected = REGISTRY.filter(pick);
  const results = runServiceUninstallCommands(selected);
  for (const [index, service] of selected.entries()) {
    const result = results[index];
    process.stdout.write(`  ${service.label} … `);
    console.log(result.code === 0 && !result.timedOut ? "🧹" : `⚠️ (${result.timedOut ? "timed out" : result.out.split("\n").pop() || `exit ${result.code}`})`);
  }
  if (serviceCommandExitCode(results) !== 0) process.exit(1);
} else {
  console.log("usage: bun Services.ts <status|install|uninstall|doc> [--config-root dir] [--all] [--only a,b] [--yes]");
  process.exit(1);
}

} // end import.meta.main
