/**
 * lifeos-observability — native OMP port of the LifeOS observability hooks + statusline.
 *
 *   tool_execution_end -> MEMORY/OBSERVABILITY/tool-activity.jsonl   (ToolActivityTracker)
 *   tool_result(isError) -> MEMORY/OBSERVABILITY/tool-failures.jsonl (ToolFailureTracker)
 *   statusline -> ctx.ui.setStatus("lifeos", …) — mode state + session tool count
 *
 * Native (in-process) rather than adapter-bridged because these fire on EVERY tool call —
 * a subprocess per call would add latency the CC hooks never had (they ran async there).
 * Schemas match the CC hooks byte-for-byte so Pulse reads both harnesses' events from the
 * same files. Fail-open: observability must never break a tool call.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { getOmpSessionIdentity } from "../../session";
import { redactSensitiveValue } from "../../../UNIVERSAL/canonical";

interface ContextUsage {
	tokens?: number;
	contextWindow?: number;
	percent?: number;
}

interface ExtensionCtx {
	hasUI?: boolean;
	cwd?: string;
	model?: { id?: string; name?: string };
	getContextUsage?: () => ContextUsage | undefined | Promise<ContextUsage | undefined>;
	sessionManager?: { getSessionFile?: () => string | undefined };
	ui?: {
		setStatus?: (key: string, text: string) => void;
		notify?: (message: string, level?: string) => void;
		setWidget?: (key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
	};
}

interface ExtensionApi {
	on: (event: string, handler: (event: unknown, ctx: ExtensionCtx) => unknown) => void;
	setLabel?: (label: string) => void;
	registerCommand?: (
		name: string,
		spec: { description: string; handler: (args: string | undefined, ctx: ExtensionCtx) => unknown },
	) => void;
}

const HOME = normalize(process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir());
const LIFEOS_DIR = normalize(process.env.LIFEOS_DIR ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"), "LIFEOS"));
const OBS_DIR = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY");
const ACTIVITY_FILE = join(OBS_DIR, "tool-activity.jsonl");
const FAILURES_FILE = join(OBS_DIR, "tool-failures.jsonl");
const AGENT_DIR = normalize(process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".omp", "agent"));
const STATUSLINE_SCRIPT = join(LIFEOS_DIR, "LIFEOS_StatusLine.sh");
// Full statusline panel opt-out marker (panel defaults ON when the script exists).
const STATUSLINE_OFF_MARKER = join(AGENT_DIR, "lifeos-statusline.off");
// setWidget string-array content is capped at 10 lines by OMP's TUI.
const WIDGET_MAX_LINES = 10;
const WORK_JSON = join(LIFEOS_DIR, "MEMORY", "STATE", "work.json");
const DIRECT_DEPTH_TAG = " · DIRECT";
const STATUSLINE_TIMEOUT_MS = 10_000;

const TOOL_NAME_MAP: Record<string, string> = {
	bash: "Bash",
	write: "Write",
	edit: "Edit",
	multiedit: "MultiEdit",
	read: "Read",
	web_search: "WebSearch",
	web_fetch: "WebFetch",
	task: "Agent",
};

function readField(value: unknown, key: string): unknown {
	if (value !== null && typeof value === "object" && key in value) {
		const record: Record<string, unknown> = value;
		return record[key];
	}
	return undefined;
}

function ccToolName(event: unknown): string {
	const raw = readField(event, "toolName") ?? readField(event, "tool_name");
	const name = typeof raw === "string" ? raw : "unknown";
	return TOOL_NAME_MAP[name.toLowerCase()] ?? name;
}

function inputPreview(event: unknown): string {
	const input = readField(event, "input") ?? readField(event, "args");
	if (input === undefined) return "";
	try {
		return JSON.stringify(redactSensitiveValue(input)).slice(0, 200);
	} catch {
		return "";
	}
}

function appendJsonl(file: string, record: Record<string, unknown>): void {
	try {
		if (!existsSync(OBS_DIR)) mkdirSync(OBS_DIR, { recursive: true });
		appendFileSync(file, `${JSON.stringify(redactSensitiveValue(record))}\n`, "utf-8");
	} catch {
		/* observability never breaks a tool call */
	}
}

// omp's own version for the HARN line — resolved once per process (async spawn,
// never blocks the TUI event loop); runStatusLine awaits it so even the first
// paint carries it. Fail-open: empty string → the script prints just "OMP".
const ompVersionPromise: Promise<string> = (() => {
	const fromEnv = process.env.OMP_VERSION ?? "";
	if (fromEnv !== "") return Promise.resolve(fromEnv);
	const { promise, resolve } = Promise.withResolvers<string>();
	try {
		const vproc = spawn("omp", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		let vout = "";
		const timer = setTimeout(() => { vproc.kill("SIGTERM"); resolve(""); }, 3000);
		vproc.stdout.on("data", (d) => { vout += d.toString(); });
		vproc.on("close", () => { clearTimeout(timer); resolve(vout.match(/\d+\.\d+[.\d]*/)?.[0] ?? ""); });
		vproc.on("error", () => { clearTimeout(timer); resolve(""); });
	} catch { resolve(""); }
	return promise;
})();

/**
 * Run the REAL LIFEOS_StatusLine.sh (the same script Claude Code's statusLine
 * setting runs) and return its rendered lines. We synthesize the stdin JSON
 * Claude Code would send — model + context-window fields from OMP's live ctx —
 * and the script computes everything else itself (location/weather caches,
 * TELOS state, memory freshness, mode/effort ladders, usage). Single-sourced:
 * the panel can never drift from the CC statusline because it IS the CC
 * statusline.
 */
async function runStatusLine(ctx: ExtensionCtx, usage: ContextUsage | undefined): Promise<string[]> {
	if (process.platform === "win32") return [];
	const version = await ompVersionPromise;
	const { promise, resolve } = Promise.withResolvers<string[]>();
	const identity = getOmpSessionIdentity(ctx, AGENT_DIR);
	const stdin = JSON.stringify({
		session_id: identity.uaiSessionId,
		native_session_id: identity.nativeSessionId,
		workspace: { current_dir: ctx.cwd ?? process.cwd() },
		model: { display_name: ctx.model?.name ?? ctx.model?.id ?? "unknown" },
		harness: { name: "OMP", version },
		context_window: {
			context_window_size: usage?.contextWindow ?? 200000,
			used_percentage: usage?.percent ?? 0,
			total_input_tokens: usage?.tokens ?? 0,
		},
	});
	const proc = spawn("bash", [STATUSLINE_SCRIPT], {
		env: { ...process.env, LIFEOS_HARNESS: "omp" },
		stdio: ["pipe", "pipe", "ignore"],
	});
	let out = "";
	const timer = setTimeout(() => {
		proc.kill("SIGTERM");
		resolve([]);
	}, STATUSLINE_TIMEOUT_MS);
	proc.stdout.on("data", (d) => { out += d.toString(); });
	proc.on("close", () => {
		clearTimeout(timer);
		resolve(out.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0));
	});
	proc.on("error", () => {
		clearTimeout(timer);
		resolve([]);
	});
	proc.stdin.write(stdin);
	proc.stdin.end();
	return promise;
}

/**
 * Distill the panel to the widget's 10-line cap: drop pure separator/filler
 * rows (─ ┄ · ═ lines) first — they carry no information in a TUI widget that
 * already has borders — then hard-cap. Content rows keep their ANSI styling.
 */
function distillPanel(lines: string[]): string[] {
	const isSeparator = (l: string): boolean => /^[\s─┄·═┈-]+$/.test(l.replace(/\u001b\[[0-9;]*m/g, ""));
	const content = lines.filter((l) => !isSeparator(l));
	return (content.length > 0 ? content : lines).slice(0, WIDGET_MAX_LINES);
}

export function workSlugFromToolEvent(event: unknown): string {
	const input = readField(event, "input") ?? readField(event, "args");
	const rawPath = readField(input, "path")
		?? readField(input, "file_path")
		?? readField(input, "filePath");
	if (typeof rawPath !== "string") return "";
	return rawPath.match(/MEMORY\/WORK\/([A-Za-z0-9._-]+)\//)?.[1] ?? "";
}

export function depthTagForSession(
	sessionSlug: string,
	workJson = WORK_JSON,
): string {
	if (sessionSlug === "") return DIRECT_DEPTH_TAG;
	try {
		const raw = JSON.parse(readFileSync(workJson, "utf-8")) as { sessions?: Record<string, unknown> };
		const value = (raw.sessions ?? {})[sessionSlug];
		if (value === null || typeof value !== "object") return DIRECT_DEPTH_TAG;
		const s = value as { phase?: string; effort?: string };
		if (typeof s.phase !== "string" || s.phase === "complete") return DIRECT_DEPTH_TAG;
		return ` · ALGO ${s.phase}${s.effort ? ` ${s.effort}` : ""}`;
	} catch {
		return DIRECT_DEPTH_TAG;
	}
}

export default function lifeosObservability(pi: ExtensionApi): void {
	pi.setLabel?.("LifeOS Observability");

	let toolCount = 0;
	let failCount = 0;
	// Slug of the ISA THIS session last touched (from tool paths under MEMORY/WORK/<slug>/).
	// Keys the depth indicator to our own session — work.json is shared across every
	// harness session, so "most recent row" would show another tab's Algorithm phase.
	let sessionSlug = "";

	function noteSlugFromEvent(event: unknown): void {
		sessionSlug = workSlugFromToolEvent(event) || sessionSlug;
	}

	/**
	 * Depth indicator — the 7.x-native answer to "which mode was picked": the
	 * Algorithm writes phase/effort to MEMORY/STATE/work.json as it runs (ISASync).
	 * Show `ALGO <phase> <effort>` for THIS session's live ISA; otherwise show
	 * `DIRECT`. Deterministic (file state, not model claims).
	 */
	function depthTag(): string {
		return depthTagForSession(sessionSlug);
	}

	function paintStatus(ctx: ExtensionCtx): void {
		if (!ctx.hasUI) return;
		const fails = failCount > 0 ? ` ✗${failCount}` : "";
		ctx.ui?.setStatus?.("lifeos", `LifeOS · 🔧${toolCount}${fails}${depthTag()}`);
	}

	// ── Full statusline panel (the CC statusline, rendered as an OMP widget) ──
	// Default ON when the script exists; `/statusline off` writes the opt-out marker.
	let paintingPanel = false;
	let statuslineAdvisoryRecorded = false;
	function recordStatuslineAdvisory(ctx: ExtensionCtx, reason: string): void {
		if (statuslineAdvisoryRecorded) return;
		statuslineAdvisoryRecorded = true;
		appendJsonl(join(OBS_DIR, "statusline-degraded.jsonl"), {
			timestamp: new Date().toISOString(),
			adapter_id: "omp",
			status: "degraded",
			reason,
		});
		const message = `LifeOS statusline degraded: ${reason}`;
		if (ctx.ui?.notify) ctx.ui.notify(message, "warning");
		else process.stderr.write(`${message}\n`);
	}
	async function paintPanel(ctx: ExtensionCtx): Promise<void> {
		if (!ctx.hasUI || !ctx.ui?.setWidget) {
			recordStatuslineAdvisory(ctx, "headless OMP has no widget surface");
			return;
		}
		if (process.platform === "win32") {
			recordStatuslineAdvisory(ctx, "the Bash statusline panel is unavailable on native Windows; compact OMP status remains available");
			ctx.ui.setWidget("lifeos-statusline", undefined);
			return;
		}
		if (!existsSync(STATUSLINE_SCRIPT) || existsSync(STATUSLINE_OFF_MARKER)) {
			ctx.ui.setWidget("lifeos-statusline", undefined);
			return;
		}
		if (paintingPanel) return; // one render in flight; turn_end will re-fire
		paintingPanel = true;
		try {
			// getContextUsage is sync in interactive mode, async in print mode —
			// await normalizes both; NEVER chain .catch on its return.
			let usage: ContextUsage | undefined;
			try { usage = await ctx.getContextUsage?.(); } catch { usage = undefined; }
			const lines = await runStatusLine(ctx, usage);
			if (lines.length > 0) ctx.ui.setWidget("lifeos-statusline", distillPanel(lines), { placement: "belowEditor" });
		} catch {
			/* statusline must never break a turn */
		} finally {
			paintingPanel = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		paintStatus(ctx);
		void paintPanel(ctx);
	});
	pi.on("turn_end", (_event, ctx) => {
		void paintPanel(ctx);
	});

	pi.registerCommand?.("statusline", {
		description: "LifeOS statusline panel: /statusline on|off|refresh",
		handler: (args, ctx) => {
			const want = (typeof args === "string" ? args : "").trim().toLowerCase();
			if (want === "off") {
				writeFileSync(STATUSLINE_OFF_MARKER, `disabled ${new Date().toISOString()}\n`, "utf-8");
				ctx.ui?.setWidget?.("lifeos-statusline", undefined);
				ctx.ui?.notify?.("LifeOS statusline off (marker written)", "info");
				return;
			}
			if (want === "on") {
				if (existsSync(STATUSLINE_OFF_MARKER)) unlinkSync(STATUSLINE_OFF_MARKER);
				ctx.ui?.notify?.("LifeOS statusline on", "info");
			}
			void paintPanel(ctx);
		},
	});

	// ToolActivityTracker parity — one event per completed tool execution.
	pi.on("tool_execution_end", (event, ctx) => {
		toolCount++;
		noteSlugFromEvent(readField(event, "data") ?? event);
		const identity = getOmpSessionIdentity(ctx, AGENT_DIR);
		appendJsonl(ACTIVITY_FILE, {
			timestamp: new Date().toISOString(),
			type: "tool_use",
			session_id: identity.uaiSessionId,
			native_session_id: identity.nativeSessionId,
			profile_root: identity.profileRoot,
			transcript_path: identity.transcriptPath,
			tool_name: ccToolName(readField(event, "data") ?? event),
			tool_input_preview: inputPreview(readField(event, "data") ?? event),
			harness: "omp",
		});
		paintStatus(ctx);
	});

	// ToolFailureTracker parity — errored tool results.
	pi.on("tool_result", (event, ctx) => {
		if (readField(event, "isError") !== true) return undefined;
		failCount++;
		const content = readField(event, "content");
		let error = "unknown error";
		if (Array.isArray(content)) {
			const text = content
				.map((chunk) => (typeof readField(chunk, "text") === "string" ? String(readField(chunk, "text")) : ""))
				.join(" ")
				.trim();
			if (text.length > 0) error = text;
		}
		const identity = getOmpSessionIdentity(ctx, AGENT_DIR);
		appendJsonl(FAILURES_FILE, {
			timestamp: new Date().toISOString(),
			event: "tool_failure",
			session_id: identity.uaiSessionId,
			native_session_id: identity.nativeSessionId,
			profile_root: identity.profileRoot,
			transcript_path: identity.transcriptPath,
			tool_name: ccToolName(event),
			error: error.slice(0, 1000),
			tool_input_preview: inputPreview(event),
			harness: "omp",
		});
		paintStatus(ctx);
		return undefined;
	});
}
