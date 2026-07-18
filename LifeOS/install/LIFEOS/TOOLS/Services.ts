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
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { platformFacts, type RuntimeOs } from "../UNIVERSAL/platform";
import { planService, type ServiceBackend, type ServicePlan } from "../UNIVERSAL/services";

export interface ServiceRoots {
  home: string;
  configRoot: string;
  lifeosDir: string;
  launchAgentsDir: string;
}

export interface ServicePlatformSupport {
  supported: boolean;
  backend: ServiceBackend;
  reason?: string;
  plan: ServicePlan;
}

export function resolveServiceRoots(
  env: Pick<NodeJS.ProcessEnv, "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR" | "LIFEOS_DIR"> = process.env,
  fallbackHome = homedir(),
  configRootOverride?: string,
): ServiceRoots {
  const home = normalize(env.HOME?.trim() || env.USERPROFILE?.trim() || fallbackHome);
  const configRoot = normalize(configRootOverride || env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
  const lifeosDir = normalize(env.LIFEOS_DIR || join(configRoot, "LIFEOS"));
  return { home, configRoot, lifeosDir, launchAgentsDir: join(home, "Library", "LaunchAgents") };
}

export function servicePlatformSupport(platform: NodeJS.Platform = process.platform): ServicePlatformSupport {
  const os: RuntimeOs = platform === "win32" || platform === "darwin" || platform === "linux" ? platform : "unknown";
  const facts = platformFacts({ platform: os });
  const plan = planService({
    os: facts.os,
    headless: facts.headless,
    managers: os === "darwin" ? ["launchd"] : [],
  });
  const supported = plan.backend === "launchd";
  return {
    supported,
    backend: plan.backend,
    plan,
    reason: supported ? undefined : plan.losses.join("; ") || "No supported background service mechanics",
  };
}

const configRootIndex = process.argv.indexOf("--config-root");
const configRootOverride = configRootIndex >= 0 ? process.argv[configRootIndex + 1] : undefined;
const ROOTS = resolveServiceRoots(process.env, homedir(), configRootOverride);
const HOME = ROOTS.home;
const LIFEOS = ROOTS.lifeosDir;
const TOOLS = join(LIFEOS, "TOOLS");
const PULSE = join(LIFEOS, "PULSE");
const LAUNCH_AGENTS = ROOTS.launchAgentsDir;
const AMBER = join(LIFEOS, "USER/CUSTOMIZATIONS/ARBOL/Workers/_A_AMBER_LEDGER");

type Cat = "pulse" | "capture" | "sync" | "sweep" | "maintenance";
interface Svc {
  label: string;            // com.lifeos.<x>
  title: string;
  purpose: string;
  category: Cat;
  optIn: boolean;           // opt-in at install (vs default-on core)
  install: string;          // shell command that installs+loads it ("#"-prefixed = note, not runnable
  uninstall?: string;
}

// Canonical registry: the human-meaningful metadata. Mechanical facts (cadence,
// runner) are read live from the plists in status()/doc().
const SERVICES: Svc[] = [
  { label: "com.lifeos.pulse", title: "Pulse (dashboard server)", category: "pulse", optIn: false,
    purpose: "The Life Dashboard HTTP server on :31337 — Pulse, the visible surface onto LifeOS.",
    install: `bash ${shellQuote(join(PULSE, "manage.sh"))} install` },
  { label: "com.lifeos.pulse-menubar", title: "Pulse menu-bar app", category: "pulse", optIn: false,
    purpose: "macOS menu-bar app for Pulse — quick status + open the dashboard.",
    install: `bash ${shellQuote(join(PULSE, "MenuBar/install.sh"))}` },
  { label: "com.lifeos.deriver", title: "Pulse deriver", category: "pulse", optIn: false,
    purpose: "Regenerates Pulse's derived Data-Plane pages on a cadence.",
    install: `bash ${shellQuote(join(PULSE, "manage-deriver.sh"))} install` },
  { label: "com.lifeos.conduit", title: "Conduit (sensory capture)", category: "capture", optIn: false,
    purpose: "Local current-state capture — feeds memory + TELOS current state.",
    install: `bun ${shellQuote(join(PULSE, "Conduit/InstallConduit.ts"))}` },
  { label: "com.lifeos.conduit.insight", title: "Conduit insight builder", category: "capture", optIn: false,
    purpose: "Builds insights from Conduit's captured signal.",
    install: `bun ${shellQuote(join(PULSE, "Conduit/InstallConduitInsight.ts"))}` },
  { label: "com.lifeos.synthesis", title: "Synthesis", category: "maintenance", optIn: true,
    purpose: "Periodic synthesis pass over recent state/memory (weekly-style rollup).",
    install: `# installed with the Pulse/Conduit stack — see PULSE/` },
  { label: "com.lifeos.conveyor-watcher", title: "Conveyor inbox watcher", category: "capture", optIn: true,
    purpose: "Watches ~/Recordings/Inbox and registers dropped recordings in the content-pipeline ledger (Conveyor P1).",
    install: `bun ${shellQuote(join(TOOLS, "InstallConveyorWatcher.ts"))}` },
  { label: "com.lifeos.conveyor-runner", title: "Conveyor stage engine", category: "capture", optIn: true,
    purpose: "Advances claimable INBOX items to PREP via transcription, lease-guarded, one item per tick (Conveyor P2 stage 1).",
    install: `bun ${shellQuote(join(TOOLS, "InstallConveyorRunner.ts"))}` },
  { label: "com.lifeos.worksweep", title: "Work sweep", category: "sweep", optIn: true,
    purpose: "Hourly UL work capture — untracked sessions, stale items, project checks, TELOS-goal derivation.",
    install: `bun ${shellQuote(join(TOOLS, "InstallWorkSweep.ts"))}` },
  { label: "com.lifeos.derivedsync", title: "Derived-file sync", category: "sync", optIn: true,
    purpose: "Watches 31 USER source files; regenerates PRINCIPAL_TELOS, LIFEOS_STATE, Data-Plane on hand-edits.",
    install: `bun ${shellQuote(join(TOOLS, "InstallDerivedSync.ts"))}` },
  { label: "com.lifeos.healthsync", title: "Health sync", category: "sync", optIn: true,
    purpose: "Syncs health data into CURRENT_STATE.",
    install: `bun ${shellQuote(join(TOOLS, "InstallHealthSync.ts"))}` },
  { label: "com.lifeos.codexupdate", title: "Codex update", category: "maintenance", optIn: true,
    purpose: "Keeps the Codex mirror / update state current.",
    install: `bun ${shellQuote(join(TOOLS, "InstallCodexUpdate.ts"))}` },
  { label: "com.lifeos.commitmentsweep", title: "Commitment sweep", category: "sweep", optIn: true,
    purpose: "Sweeps commitments/reminders on a cadence.",
    install: `bun ${shellQuote(join(TOOLS, "InstallCommitmentSweep.ts"))}` },
  { label: "com.lifeos.blogdiscovery", title: "Blog discovery", category: "sweep", optIn: true,
    purpose: "Discovers blog-worthy signal on a cadence.",
    install: `bun ${shellQuote(join(TOOLS, "InstallBlogDiscovery.ts"))}` },
  { label: "com.lifeos.usage-aggregator", title: "Usage aggregator", category: "maintenance", optIn: true,
    purpose: "Aggregates usage/cost telemetry for Pulse.",
    install: `bun ${shellQuote(join(TOOLS, "InstallUsageAggregator.ts"))}` },
  { label: "com.lifeos.bookmark-watchdog", title: "Bookmark pipeline watchdog", category: "capture", optIn: true,
    purpose: "Watches the X bookmark → summarize/idea pipeline for stalls.",
    install: `# ARBOL/BookmarkPipelineWatchdog.ts — see Arbol` },
  { label: "com.lifeos.backups", title: "Backups", category: "maintenance", optIn: true,
    purpose: "Daily 03:00 PT repo backup (Git LFS).",
    install: `# Backups project — installed from its own repo (backup.sh)` },
  { label: "com.lifeos.amberroute", title: "Amber router", category: "capture", optIn: true,
    purpose: "Every 30 min: TELOS-grade unrouted Amber captures → KNOWLEDGE notes / UL issues.",
    install: `bun ${shellQuote(join(AMBER, "Tools/InstallAmberRoute.ts"))}`,
    uninstall: `bun ${shellQuote(join(AMBER, "Tools/InstallAmberRoute.ts"))} --uninstall` },
];

export interface ServiceCommandResult {
  code: number;
  out: string;
  timedOut: boolean;
}
export function serviceCommandExitCode(results: readonly ServiceCommandResult[]): number {
  return results.some((result) => result.code !== 0 || result.timedOut) ? 1 : 0;
}

export function runBoundedServiceCommand(argv: string[], timeoutMs = 30_000): ServiceCommandResult {
  const process = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const timedOut = process.signalCode !== null && process.exitCode === null;
  return {
    code: process.exitCode ?? (timedOut ? 124 : 1),
    out: (process.stdout.toString() + process.stderr.toString()).trim(),
    timedOut,
  };
}

function sh(command: string): ServiceCommandResult {
  return runBoundedServiceCommand(["bash", "-c", command]);
}
export interface UninstallableService {
  label: string;
  uninstall?: string;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function runServiceUninstallCommands(
  services: readonly UninstallableService[],
  runner: (command: string) => ServiceCommandResult = sh,
): ServiceCommandResult[] {
  return services.map((service) => runner(
    service.uninstall || `launchctl bootout gui/$(id -u)/${service.label} && rm -f ${shellQuote(join(LAUNCH_AGENTS, `${service.label}.plist`))}`,
  ));
}


function loadedLabels(): Set<string> {
  if (process.platform !== "darwin") return new Set();
  try {
    const result = Bun.spawnSync(["launchctl", "list"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return new Set();
    return new Set(
      result.stdout.toString()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).at(-1) ?? "")
        .filter((label) => label.toLowerCase().includes("lifeos")),
    );
  } catch {
    return new Set();
  }
}

/** Find the plist for a label: installed one wins, else a template in TOOLS/PULSE. */
function findPlist(label: string): { path: string; installed: boolean } | null {
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

function cadenceOf(plistPath: string): string {
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

function runCli(): number {
  const cmd = process.argv[2] || "status";
  const onlyIndex = process.argv.indexOf("--only");
  const onlyArg = onlyIndex >= 0 && process.argv[onlyIndex + 1] ? process.argv[onlyIndex + 1].split(",") : null;
  const all = process.argv.includes("--all");
  const yes = process.argv.includes("--yes");
  const pick = (service: Svc): boolean => onlyArg
    ? onlyArg.includes(service.label) || onlyArg.includes(service.label.replace(/^com\.lifeos\./, ""))
    : true;
  const support = servicePlatformSupport();

  if (!support.supported && cmd !== "doc") {
    console.log(JSON.stringify({
      ok: cmd === "status" || cmd === "list",
      supported: false,
      backend: support.backend,
      platform: process.platform,
      configRoot: ROOTS.configRoot,
      lifeosDir: ROOTS.lifeosDir,
      reason: support.reason,
    }, null, 2));
    return cmd === "status" || cmd === "list" ? 0 : 2;
  }

  if (cmd === "status" || cmd === "list") {
    const loaded = loadedLabels();
    console.log(`LifeOS background services (${SERVICES.length})\n`);
    console.log("  " + "STATE".padEnd(13) + "CADENCE".padEnd(16) + "SERVICE");
    for (const cat of ["pulse", "capture", "sync", "sweep", "maintenance"] as Cat[]) {
      const rows = SERVICES.filter((service) => service.category === cat);
      if (!rows.length) continue;
      console.log(`\n  ── ${cat} ──`);
      for (const service of rows) {
        const plist = findPlist(service.label);
        const state = loaded.has(service.label) ? "● running" : plist?.installed ? "○ installed" : plist ? "· available" : "✗ missing";
        const cadence = plist ? cadenceOf(plist.path) : "—";
        console.log("  " + state.padEnd(13) + cadence.padEnd(16) + `${service.title}  (${service.label})`);
      }
    }
    const missingCore = SERVICES.filter((service) => !service.optIn && !loaded.has(service.label));
    if (missingCore.length) console.log(`\n  ⚠️ core not running: ${missingCore.map((service) => service.label).join(", ")}`);
    return 0;
  }
  if (cmd === "doc") {
    console.log("| Service | Category | Cadence | Opt-in | Purpose | Install |");
    console.log("|---------|----------|---------|--------|---------|---------|");
    for (const service of SERVICES) {
      const plist = findPlist(service.label);
      const cadence = plist ? cadenceOf(plist.path) : "—";
      const install = service.install.startsWith("#") ? service.install.slice(1).trim() : `\`${service.install.replace(HOME, "~")}\``;
      console.log(`| **${service.title}** \`${service.label}\` | ${service.category} | ${cadence} | ${service.optIn ? "yes" : "core"} | ${service.purpose} | ${install} |`);
    }
    return 0;
  }
  if (cmd === "install") {
    const targets = SERVICES.filter(pick).filter((service) => (all || onlyArg ? true : !service.optIn) && !service.install.startsWith("#"));
    console.log(`Installing ${targets.length} service(s):`);
    if (!yes) {
      console.log("  (dry preview — re-run with --yes to execute)");
      for (const service of targets) console.log(`  ${service.label}: ${service.install.replace(HOME, "~")}`);
      return 0;
    }
    const results: ServiceCommandResult[] = [];
    const failures: string[] = [];
    for (const service of targets) {
      process.stdout.write(`  ${service.label} … `);
      const result = sh(service.install);
      results.push(result);
      if (result.code === 0) {
        console.log("✅");
      } else {
        failures.push(service.label);
        const detail = result.timedOut ? "timed out" : result.out.split("\n").pop() || `exit ${result.code}`;
        console.log(`⚠️ (${detail})`);
      }
    }
    const exitCode = serviceCommandExitCode(results);
    if (exitCode !== 0) {
      console.error(`\nFailed service installers: ${failures.join(", ")}`);
      return exitCode;
    }
    console.log("\nRun `bun Services.ts status` to confirm.");
    return 0;
  }
  if (cmd === "uninstall") {
    if (!onlyArg) {
      console.error("uninstall requires --only <labels> (refusing to remove everything at once)");
      return 1;
    }
    const selected = SERVICES.filter(pick);
    const results = runServiceUninstallCommands(selected);
    for (const [index, service] of selected.entries()) {
      const result = results[index];
      process.stdout.write(`  ${service.label} … `);
      console.log(result.code === 0 && !result.timedOut ? "🧹" : `⚠️ (${result.timedOut ? "timed out" : result.out.split("\n").pop() || `exit ${result.code}`})`);
    }
    return serviceCommandExitCode(results);
  }
  console.log("usage: bun Services.ts <status|install|uninstall|doc> [--config-root dir] [--all] [--only a,b] [--yes]");
  return 1;
}

if (import.meta.main) process.exit(runCli());
