#!/usr/bin/env bun
/**
 * manage.ts — install / uninstall / status / inference for the LifeOS↔OMP integration.
 *
 *   bun manage.ts install     wire the extensions into ~/.omp/agent/config.yml
 *                             and symlink APPEND_SYSTEM.md (idempotent)
 *   bun manage.ts uninstall   remove those wirings (leaves the OMP tree + tool patches)
 *   bun manage.ts status      report what is / isn't wired
 *
 * The extension SOURCE + adapted constitutions live in this directory (LIFEOS/OMP/),
 * version-controlled with LifeOS. This script only touches the machine-specific
 * wiring under the OMP agent dir, so it is safe to re-run on a fresh machine.
 * config.yml is parsed/merged as YAML (never blind-appended) and backed up first.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

const HOME = homedir();
const SELF_DIR = import.meta.dir; // …/.claude/LIFEOS/OMP
const LIFEOS_DIR = process.env.LIFEOS_DIR ?? dirname(SELF_DIR); // deployed runtime, overridable for isolated tests
const CONFIG_ROOT = process.env.LIFEOS_CONFIG_ROOT ?? process.env.CLAUDE_CONFIG_DIR ?? dirname(LIFEOS_DIR);
const HOOKS_DIR = join(CONFIG_ROOT, "hooks");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".omp", "agent");
const CONFIG_PATH = join(AGENT_DIR, "config.yml");
const APPEND_LINK = join(AGENT_DIR, "APPEND_SYSTEM.md");
const APPEND_SRC = join(SELF_DIR, "APPEND_SYSTEM.md");
const APPEND_BAK = `${APPEND_LINK}.pre-lifeos.bak`;
const APPEND_COPY_MARKER = `${APPEND_LINK}.lifeos-copy`;
// Legacy (pre-7.x mode system) marker — cleared if found; nothing writes it anymore.
const LEGACY_MODES_MARKER = join(AGENT_DIR, "lifeos-modes.on");
const INFERENCE_BACKEND_FILE = join(LIFEOS_DIR, "USER", "CONFIG", "inference-backend");

const EXTENSION_NAMES = ["lifeos-memory", "lifeos-commands", "lifeos-safety", "lifeos-hooks", "lifeos-observability"];

// Emit a home-relative (~/…) path when possible so config stays portable.
function tildify(abs: string): string {
	return abs.startsWith(`${HOME}/`) ? `~${abs.slice(HOME.length)}` : abs;
}

const EXTENSION_PATHS = EXTENSION_NAMES.map((name) => tildify(join(SELF_DIR, "extensions", name)));

function readConfig(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) return {};
	let parsed: unknown;
	try {
		parsed = parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch (error) {
		throw new Error(`invalid OMP config at ${CONFIG_PATH}; refusing mutation: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`invalid OMP config at ${CONFIG_PATH}; expected a YAML mapping`);
	}
	return parsed as Record<string, unknown>;
}

function writeConfig(config: Record<string, unknown>): void {
	mkdirSync(AGENT_DIR, { recursive: true });
	if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.lifeos-bak`);
	const temp = `${CONFIG_PATH}.lifeos-tmp-${process.pid}`;
	writeFileSync(temp, stringify(config), "utf8");
	renameSync(temp, CONFIG_PATH);
}

function currentExtensions(config: Record<string, unknown>): string[] {
	const raw = config.extensions;
	return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
}

function isOurLink(): boolean {
	try {
		const st = lstatSync(APPEND_LINK);
		if (!st.isSymbolicLink()) return false;
		return readlinkSync(APPEND_LINK) === APPEND_SRC;
	} catch {
		return false;
	}
}
function isOurCopy(): boolean {
	try {
		return pathExists(APPEND_LINK)
			&& readFileSync(APPEND_COPY_MARKER, "utf8") === APPEND_SRC;
	} catch {
		return false;
	}
}

function constitutionState(): "linked" | "copied" | "absent" {
	if (isOurLink()) return "linked";
	if (isOurCopy()) return "copied";
	return "absent";
}

function installConstitution(): void {
	const state = constitutionState();
	if (state === "linked") {
		console.log("• APPEND_SYSTEM.md already linked");
		return;
	}
	if (state === "copied") {
		copyFileSync(APPEND_SRC, APPEND_LINK);
		console.log("• APPEND_SYSTEM.md managed copy refreshed");
		return;
	}
	if (pathExists(APPEND_LINK)) renameSync(APPEND_LINK, APPEND_BAK);
	try {
		symlinkSync(APPEND_SRC, APPEND_LINK);
		if (pathExists(APPEND_COPY_MARKER)) unlinkSync(APPEND_COPY_MARKER);
		console.log(`• linked APPEND_SYSTEM.md -> ${tildify(APPEND_SRC)}`);
	} catch {
		copyFileSync(APPEND_SRC, APPEND_LINK);
		writeFileSync(APPEND_COPY_MARKER, APPEND_SRC, "utf8");
		console.log("• copied APPEND_SYSTEM.md (symlink unavailable)");
	}
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

async function verifySource(): Promise<string[]> {
	const problems: string[] = [];
	if (!existsSync(APPEND_SRC)) problems.push(`missing constitution: ${APPEND_SRC}`);
	for (const name of EXTENSION_NAMES) {
		const entry = join(SELF_DIR, "extensions", name, "index.ts");
		if (!existsSync(entry)) {
			problems.push(`missing extension: ${name}/index.ts`);
			continue;
		}
		try {
			const extension = await import(pathToFileURL(entry).href);
			if (name === "lifeos-hooks") {
				const required = extension.REQUIRED_HOOK_FILES;
				if (!Array.isArray(required)) {
					problems.push("lifeos-hooks does not expose its required hook manifest");
				} else {
					for (const file of required) {
						if (typeof file !== "string" || !existsSync(join(HOOKS_DIR, file))) {
							problems.push(`missing bridged hook: ${String(file)}`);
						}
					}
				}
			}
		} catch (error) {
			problems.push(`extension failed to load: ${name} (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	const reviewer = join(LIFEOS_DIR, "TOOLS", "MemoryReviewer.ts");
	if (!existsSync(reviewer)) {
		problems.push(`missing tool patch: ${reviewer}`);
	} else if (!readFileSync(reviewer, "utf8").includes("OMP_SESSIONS_DIR")) {
		problems.push("MemoryReviewer.ts lacks the OMP session-store patch (autonomic loop will read CC transcripts only)");
	}
	const parser = join(LIFEOS_DIR, "TOOLS", "TranscriptParser.ts");
	if (!existsSync(parser)) {
		problems.push(`missing tool patch: ${parser}`);
	} else if (!/message\?\.role|normalizeEntry/.test(readFileSync(parser, "utf8"))) {
		problems.push("TranscriptParser.ts lacks the OMP-format patch (Stop hooks will no-op on OMP transcripts)");
	}
	return problems;
}

async function install(): Promise<void> {
	const problems = await verifySource();
	if (problems.length > 0) {
		console.error("✗ Source not ready — the LifeOS/OMP tree is incomplete on this machine:");
		for (const p of problems) console.error(`  - ${p}`);
		process.exit(1);
	}
	const config = readConfig();

	// A fresh OMP profile may not have created its agent directory yet.
	mkdirSync(AGENT_DIR, { recursive: true });

	// 1) Install the constitution, backing up a pre-existing non-LifeOS file.
	// Windows profiles without symlink privileges receive a managed copy.
	installConstitution();

	// 2) Merge the extensions into config.extensions (dedup, preserve everything else).
	// Existing config was parsed before any symlink or file mutation.
	const existing = currentExtensions(config);
	const merged = [...existing];
	let added = 0;
	for (const path of EXTENSION_PATHS) {
		if (!merged.includes(path)) {
			merged.push(path);
			added++;
		}
	}
	config.extensions = merged;
	writeConfig(config);
	console.log(`• config.yml extensions: ${added} added, ${merged.length} total`);
	console.log(`\n✓ Installed. Open a fresh 'omp' session to activate. Verify: bun ${tildify(join(SELF_DIR, "manage.ts"))} status`);
}

function uninstall(): void {
	// 1) Remove our extensions from config; drop the key if it becomes empty.
	if (existsSync(CONFIG_PATH)) {
		const config = readConfig();
		const kept = currentExtensions(config).filter((path) => !EXTENSION_PATHS.includes(path));
		if (kept.length > 0) config.extensions = kept;
		else delete config.extensions;
		writeConfig(config);
		console.log(`• config.yml extensions: LifeOS entries removed (${kept.length} non-LifeOS kept)`);
	}

	// 2) Remove our linked/copied constitution; restore any backed-up original.
	if (constitutionState() !== "absent") {
		unlinkSync(APPEND_LINK);
		if (pathExists(APPEND_COPY_MARKER)) unlinkSync(APPEND_COPY_MARKER);
		if (pathExists(APPEND_BAK)) {
			renameSync(APPEND_BAK, APPEND_LINK);
			console.log("• restored pre-LifeOS APPEND_SYSTEM.md from backup");
		} else {
			console.log("• removed APPEND_SYSTEM.md");
		}
	} else {
		console.log("• APPEND_SYSTEM.md not managed by LifeOS — left untouched");
	}

	// 3) Clear the legacy mode-system marker if a pre-7.x install left one behind.
	if (pathExists(LEGACY_MODES_MARKER)) {
		unlinkSync(LEGACY_MODES_MARKER);
		console.log("• cleared legacy mode-system marker");
	}
	console.log("\n✓ Uninstalled the wiring. The LIFEOS/OMP tree + additive tool patches remain (harmless).");
}

async function status(): Promise<void> {
	const config = readConfig();
	const wired = new Set(currentExtensions(config));
	console.log(`agent dir: ${AGENT_DIR}`);
	console.log(`constitution: ${constitutionState() === "absent" ? "✗ not installed" : `✓ ${constitutionState()}`}`);
	console.log("extensions:");
	for (const path of EXTENSION_PATHS) console.log(`  ${wired.has(path) ? "✓" : "✗"} ${path}`);
	const problems = await verifySource();
	if (problems.length > 0) {
		console.log("source warnings:");
		for (const p of problems) console.log(`  ! ${p}`);
	} else {
		console.log("source: ✓ constitution + extensions + both tool patches present");
	}
	const configuredBackend = existsSync(INFERENCE_BACKEND_FILE)
		? readFileSync(INFERENCE_BACKEND_FILE, "utf8").trim()
		: null;
	const backend = configuredBackend ?? "omp (automatic OMP default)";
	const claudeFree = configuredBackend === null || configuredBackend === "omp";
	console.log(`inference backend: ${backend}${claudeFree ? " — intelligence layer runs Claude-free" : ""}`);
}

/**
 * inference default|claude|omp|auto|status — pick the backend for the LifeOS
 * intelligence layer (MemoryReviewer, SatisfactionCapture — everything through
 * TOOLS/Inference.ts). With no explicit override, OMP hook subprocesses use bare
 * omp sessions on OMP's own model/auth; no Claude CLI or subscription is needed.
 * 'default' clears an override, 'claude' opts in to Claude, and 'auto' tries
 * Claude first with one OMP retry. LIFEOS_INFERENCE_BACKEND overrides per call.
 */
function inferenceBackend(state: string): void {
	if (state === "status" || state === "") {
		const configuredBackend = existsSync(INFERENCE_BACKEND_FILE)
			? readFileSync(INFERENCE_BACKEND_FILE, "utf8").trim()
			: null;
		if (configuredBackend) console.log(`inference backend: ${configuredBackend} (explicit override)`);
		else console.log("inference backend: omp (automatic OMP default; Claude-free)");
		return;
	}
	if (state !== "default" && state !== "claude" && state !== "omp" && state !== "auto") {
		console.error("Usage: bun manage.ts inference {default|claude|omp|auto|status}");
		process.exit(2);
	}
	if (state === "default") {
		if (existsSync(INFERENCE_BACKEND_FILE)) unlinkSync(INFERENCE_BACKEND_FILE);
		console.log("✓ inference backend → omp (automatic OMP default; config override removed)");
		return;
	}
	mkdirSync(dirname(INFERENCE_BACKEND_FILE), { recursive: true });
	writeFileSync(INFERENCE_BACKEND_FILE, `${state}\n`, "utf8");
	console.log(`✓ inference backend → ${state} (${tildify(INFERENCE_BACKEND_FILE)})`);
	if (state === "omp") {
		console.log("  MemoryReviewer / SatisfactionCapture / Inference.ts consumers now spawn bare omp sessions.");
		console.log("  Model: OMP's own default (model-agnostic), or pin via LIFEOS_OMP_INFERENCE_MODEL. Effective immediately.");
	} else if (state === "claude") {
		console.log("  Explicit Claude CLI backend selected; this requires working Claude authentication.");
	} else {
		console.log("  Claude first; ANY Claude failure (CLI gone, auth dead) retries once on a bare omp session.");
	}
}

const command = process.argv[2];
if (command === "install") await install();
else if (command === "uninstall") uninstall();
else if (command === "status") await status();
else if (command === "modes") {
	console.error("`modes` was removed — upstream 7.0.0 retired the mode system (one unified format). Nothing to toggle.");
	process.exit(2);
}
else if (command === "inference") inferenceBackend(process.argv[3] ?? "");
else {
	console.error("Usage: bun manage.ts {install|uninstall|status|inference default|claude|omp|auto|status}");
	process.exit(2);
}
