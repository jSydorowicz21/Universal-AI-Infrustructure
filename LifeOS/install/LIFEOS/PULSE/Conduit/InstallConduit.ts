#!/usr/bin/env bun
/**
 * Conduit service installer. Registers `com.lifeos.conduit` to run `conduit capture`
 * on a fixed interval — stateless one-shot polls restarted by the native scheduler,
 * with no long-lived daemon. Mirrors InstallWorkSweep / InstallDerivedSync.
 *
 *   bun InstallConduit.ts              install + enable
 *   bun InstallConduit.ts --uninstall  disable + remove
 *   bun InstallConduit.ts --status     show native scheduler state
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config.ts"
import { DATA_ROOT } from "./paths.ts"
import * as systemd from "../../TOOLS/lib/SystemdUser"
import { planWindowsScheduledTask } from "../../UNIVERSAL/services"
const LABEL = "com.lifeos.conduit"
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
const CONDUIT = join(import.meta.dir, "conduit.ts")
const LOG_DIR = join(DATA_ROOT, "logs")
const BUN = process.execPath // the bun binary currently running

/** Escape a string for safe interpolation into a plist XML <string> value. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function plistBody(intervalSec: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(BUN)}</string>
    <string>${escapeXml(CONDUIT)}</string>
    <string>capture</string>
  </array>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(join(LOG_DIR, "conduit.out.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(LOG_DIR, "conduit.err.log"))}</string>
</dict>
</plist>
`
}

function install(): void {
  mkdirSync(LOG_DIR, { recursive: true })
  const intervalSec = loadConfig().pollIntervalSec
  writeFileSync(PLIST, plistBody(intervalSec))
  try {
    execFileSync("launchctl", ["unload", PLIST], { stdio: "ignore" })
  } catch {
    /* not loaded yet */
  }
  execFileSync("launchctl", ["load", PLIST], { stdio: "inherit" })
  console.log(`Installed ${LABEL} → polls every ${intervalSec}s`)
  console.log(`  plist: ${PLIST}`)
  console.log(`  logs:  ${LOG_DIR}`)
}

function uninstall(): void {
  try {
    execFileSync("launchctl", ["unload", PLIST], { stdio: "ignore" })
  } catch {
    /* ignore */
  }
  if (existsSync(PLIST)) rmSync(PLIST)
  console.log(`Uninstalled ${LABEL}`)
}

function status(): void {
  try {
    const out = execFileSync("launchctl", ["list"], { encoding: "utf8" })
    const line = out.split("\n").find((l) => l.includes(LABEL))
    console.log(line ? `loaded: ${line.trim()}` : `${LABEL} not loaded`)
  } catch {
    console.log("launchctl unavailable")
  }
}

/* ── systemd --user backend (Linux only) ────────────────────────────────────
 * Strictly additive: every line above is the launchd path and is unchanged.
 * launchd keeps owning the job on darwin and systemd owns it on linux, so no
 * install ever has two schedulers for one job.
 * Translation rules live in ../../TOOLS/lib/SystemdUser.ts.
 * ported from public PR #1698, @elhoim
 * ------------------------------------------------------------------------- */

async function linuxSpec(): Promise<systemd.UnitSpec> {
  return {
    label: LABEL,
    description: "LifeOS Conduit capture",
    // BUN is process.execPath, already absolute — no `which` lookup needed.
    exec: [BUN, CONDUIT, "capture"],
    logPath: join(LOG_DIR, "conduit.out.log"),
    errLogPath: join(LOG_DIR, "conduit.err.log"),
    // Reads the same config key the plist does, so one setting drives both.
    schedule: { kind: "interval", seconds: loadConfig().pollIntervalSec },
  }
}

async function linuxMain(a: string | undefined): Promise<void> {
  const spec = await linuxSpec()
  const log = (m: string) => console.log(`[InstallConduit] ${m}`)
  if (a === "--uninstall") { await systemd.uninstall(spec, log); return }
  if (a === "--status") { if (!(await systemd.status(spec, log))) process.exit(1); return }
  if (!(await systemd.install(spec, log))) process.exit(1)
}

async function main(a: string | undefined): Promise<void> {
  if (systemd.isLinux()) { await linuxMain(a); return }
  if (process.platform === "win32") {
    const intervalSec = loadConfig().pollIntervalSec
    const plan = planWindowsScheduledTask({ taskName: LABEL, executable: BUN, args: [CONDUIT, "capture"], intervalSeconds: intervalSec })
    if (a === "--uninstall") {
      try { execFileSync(plan.executable, plan.deleteArgs, { stdio: "ignore", windowsHide: true }) } catch { /* already absent */ }
      console.log("Uninstalled " + LABEL)
      return
    }
    if (a === "--status") {
      try {
        execFileSync(plan.executable, plan.queryArgs, { stdio: "inherit", windowsHide: true })
      } catch {
        console.log(LABEL + " not installed")
        process.exitCode = 1
      }
      return
    }
    mkdirSync(LOG_DIR, { recursive: true })
    execFileSync(plan.executable, plan.createArgs, { stdio: "inherit", windowsHide: true })
    console.log("Installed " + LABEL + " → polls every " + intervalSec + "s")
    return
  }
  if (process.platform !== "darwin") throw new Error("Unsupported service platform: " + process.platform)
  if (a === "--uninstall") uninstall()
  else if (a === "--status") status()
  else install()
}

if (import.meta.main) await main(process.argv[2])
