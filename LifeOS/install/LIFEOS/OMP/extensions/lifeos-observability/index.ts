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

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

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
	sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined };
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

const HOME = homedir();
const CONFIG_ROOT = process.env.LIFEOS_CONFIG_ROOT || process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const LIFEOS_DIR = process.env.LIFEOS_DIR ?? join(CONFIG_ROOT, "LIFEOS");
const OBS_DIR = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY");
const ACTIVITY_FILE = join(OBS_DIR, "tool-activity.jsonl");
const FAILURES_FILE = join(OBS_DIR, "tool-failures.jsonl");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".omp", "agent");
const STATUSLINE_SCRIPT = join(LIFEOS_DIR, "LIFEOS_StatusLine.sh");
// Full statusline panel opt-out marker (panel defaults ON when the script exists).
const STATUSLINE_OFF_MARKER = join(AGENT_DIR, "lifeos-statusline.off");
// setWidget string-array content is capped at 10 lines by OMP's TUI.
const WIDGET_MAX_LINES = 10;
const WORK_JSON = join(LIFEOS_DIR, "MEMORY", "STATE", "work.json");
const DIRECT_DEPTH_TAG = " · DIRECT";
const STATUSLINE_TIMEOUT_MS = 10_000;
const BASH = typeof Bun !== "undefined" ? Bun.which("bash") : null;
const FALLBACK_SESSION_ID = `omp-${randomUUID()}`;

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

function sessionId(ctx: ExtensionCtx): string {
	const explicit = ctx.sessionManager?.getSessionId?.();
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	const file = ctx.sessionManager?.getSessionFile?.();
	if (typeof file === "string" && file.length > 0) return basename(file).replace(/\.[^.]+$/, "");
	return FALLBACK_SESSION_ID;
}

function readField(value: unknown, key: string): unknown {
	if (value !== null && typeof value === "object" && key in value) {
		const record = value as Record<string, unknown>;
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
		return JSON.stringify(input).slice(0, 200);
	} catch {
		return "";
	}
}

function appendJsonl(file: string, record: Record<string, unknown>): void {
	try {
		if (!existsSync(OBS_DIR)) mkdirSync(OBS_DIR, { recursive: true });
		appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
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
async function runStatusLine(
	ctx: ExtensionCtx,
	usage: ContextUsage | undefined,
	bash: string | null = BASH,
): Promise<string[]> {
	if (!bash) return [];
	const version = await ompVersionPromise;
	const { promise, resolve } = Promise.withResolvers<string[]>();
	const stdin = JSON.stringify({
		session_id: sessionId(ctx),
		workspace: { current_dir: ctx.cwd ?? process.cwd() },
		model: { display_name: ctx.model?.name ?? ctx.model?.id ?? "unknown" },
		harness: { name: "OMP", version },
		context_window: {
			context_window_size: usage?.contextWindow ?? 200000,
			used_percentage: usage?.percent ?? 0,
			total_input_tokens: usage?.tokens ?? 0,
		},
	});
	const proc = spawn(bash, [STATUSLINE_SCRIPT], {
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
	return rawPath.replace(/\\/g, "/").match(/MEMORY\/WORK\/([A-Za-z0-9._-]+)\//)?.[1] ?? "";
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

export default function lifeosObservability(
	pi: ExtensionApi,
	options: { bash?: string | null } = {},
): void {
	pi.setLabel?.("LifeOS Observability");

	const bash = options.bash === undefined ? BASH : options.bash;
	const sessionStates = new Map<string, {
		toolCount: number;
		failCount: number;
		sessionSlug: string;
		paintingPanel: boolean;
	}>();

	function stateFor(ctx: ExtensionCtx) {
		const id = sessionId(ctx);
		let state = sessionStates.get(id);
		if (!state) {
			state = { toolCount: 0, failCount: 0, sessionSlug: "", paintingPanel: false };
			sessionStates.set(id, state);
		}
		return state;
	}

	function noteSlugFromEvent(event: unknown, ctx: ExtensionCtx): void {
		const state = stateFor(ctx);
		state.sessionSlug = workSlugFromToolEvent(event) || state.sessionSlug;
	}

	function depthTag(ctx: ExtensionCtx): string {
		return depthTagForSession(stateFor(ctx).sessionSlug);
	}

	function paintStatus(ctx: ExtensionCtx): void {
		if (!ctx.hasUI) return;
		const state = stateFor(ctx);
		const fails = state.failCount > 0 ? ` ✗${state.failCount}` : "";
		ctx.ui?.setStatus?.("lifeos", `LifeOS · 🔧${state.toolCount}${fails}${depthTag(ctx)}`);
	}

	async function paintPanel(ctx: ExtensionCtx): Promise<void> {
		if (!ctx.hasUI || !ctx.ui?.setWidget) return;
		if (!bash || !existsSync(STATUSLINE_SCRIPT) || existsSync(STATUSLINE_OFF_MARKER)) {
			ctx.ui.setWidget("lifeos-statusline", undefined);
			return;
		}
		const state = stateFor(ctx);
		if (state.paintingPanel) return;
		state.paintingPanel = true;
		try {
			let usage: ContextUsage | undefined;
			try { usage = await ctx.getContextUsage?.(); } catch { usage = undefined; }
			const lines = await runStatusLine(ctx, usage, bash);
			if (lines.length > 0) {
				ctx.ui.setWidget("lifeos-statusline", distillPanel(lines), { placement: "belowEditor" });
			}
		} catch {
			/* statusline must never break a turn */
		} finally {
			state.paintingPanel = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		stateFor(ctx);
		paintStatus(ctx);
		void paintPanel(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		sessionStates.delete(sessionId(ctx));
	});
	pi.on("turn_end", (_event, ctx) => {
		void paintPanel(ctx);
	});

	pi.registerCommand?.("statusline", {
		description: "LifeOS statusline panel: /statusline on|off|refresh",
		handler: (args, ctx) => {
			const want = (typeof args === "string" ? args : "").trim().toLowerCase();
			if (!bash) {
				ctx.ui?.setWidget?.("lifeos-statusline", undefined);
				ctx.ui?.notify?.("LifeOS statusline unavailable: bash is not installed", "warning");
				return;
			}
			if (want === "off") {
				mkdirSync(AGENT_DIR, { recursive: true });
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

	pi.on("tool_execution_end", (event, ctx) => {
		const state = stateFor(ctx);
		state.toolCount++;
		noteSlugFromEvent(readField(event, "data") ?? event, ctx);
		appendJsonl(ACTIVITY_FILE, {
			timestamp: new Date().toISOString(),
			type: "tool_use",
			session_id: sessionId(ctx),
			tool_name: ccToolName(readField(event, "data") ?? event),
			tool_input_preview: inputPreview(readField(event, "data") ?? event),
			harness: "omp",
		});
		paintStatus(ctx);
	});

	pi.on("tool_result", (event, ctx) => {
		if (readField(event, "isError") !== true) return undefined;
		const state = stateFor(ctx);
		state.failCount++;
		const content = readField(event, "content");
		let error = "unknown error";
		if (Array.isArray(content)) {
			const text = content
				.map((chunk) => (typeof readField(chunk, "text") === "string" ? String(readField(chunk, "text")) : ""))
				.join(" ")
				.trim();
			if (text.length > 0) error = text;
		}
		appendJsonl(FAILURES_FILE, {
			timestamp: new Date().toISOString(),
			event: "tool_failure",
			session_id: sessionId(ctx),
			tool_name: ccToolName(event),
			error: error.slice(0, 1000),
			tool_input_preview: inputPreview(event),
			harness: "omp",
		});
		paintStatus(ctx);
		return undefined;
	});
}
