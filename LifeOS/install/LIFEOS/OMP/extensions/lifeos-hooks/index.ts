/**
 * lifeos-hooks — CC-hook-protocol adapter for OMP.
 *
 * Runs the REAL LifeOS Claude Code hooks (bun scripts at ~/.claude/hooks/*.hook.ts)
 * against mapped OMP extension events, so the actual PAI logic executes here rather
 * than being re-implemented (and drifting). Each hook is invoked as a subprocess with
 * the Claude Code stdin/stdout contract:
 *   stdin : { hook_event_name, tool_name, tool_input, tool_response, prompt, cwd, ... }
 *   stdout: {hookSpecificOutput:{additionalContext}} | {decision:"block",reason}
 *           | {hookSpecificOutput:{decision:{behavior:"allow"|"deny"}}} | plain text
 *
 * CC->OMP event map:
 *   SessionStart->session_start  UserPromptSubmit->before_agent_start
 *   PreToolUse->tool_call        PostToolUse->tool_result
 *   Stop->session_stop           SessionEnd->session_shutdown
 *
 * EXECUTION IS FULLY ASYNC (2026-07-12). Extensions share OMP's process AND event loop
 * with the TUI; the original spawnSync core froze the terminal for the whole hook window
 * (no paint, no input echo — the "stall on Enter" bug). Hooks now run via awaited async
 * spawn: identical results and ordering, but the loop stays free so the UI paints (the
 * working-message indicator is visible, message echo is instant). OMP awaits async
 * handler return values on both the blocking (tool_call) and injecting
 * (before_agent_start) paths — probe-verified 2026-07-12.
 *
 * Fidelity guards (why this is an adapter, not a symlink):
 *   - CLAUDE_* env shim: PAI hooks read CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT /
 *     CLAUDE_EFFORT which are unset under OMP; synthesized per invocation.
 *   - OMP->CC tool-name normalization: OMP `bash`/`write`/`edit` -> CC `Bash`/`Write`/`Edit`.
 *   - once-guard: SessionStart-style hooks (LoadContext) fire once per session.
 *   - subagent guard: skip per-turn injection when running as a task subagent.
 *   - CC `async: true` parity: flagged hooks spawn detached fire-and-forget.
 *   - Pulse gate: hooks that need localhost:31337 are gate:"pulse", skipped when down.
 *   - Stop contract: ONLY an explicit decision:block affects the turn; Stop-hook stdout
 *     is informational (returning it as context looped turns — fixed 2026-07-11).
 *   - Fail-open: any error -> that hook contributes nothing.
 *
 * MANIFEST curated from the hook-inventory classification (see PARITY.md). Output regime is
 * the constitution's ONE unified format (upstream 7.0.0 retired the mode system).
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

type OmpEvent =
	| "session_start"
	| "before_agent_start"
	| "tool_call"
	| "tool_result"
	| "session_stop"
	| "session_shutdown";

interface HookSpec {
	file?: string;
	url?: string;
	ompEvent: OmpEvent;
	ccEvent: string;
	matcher?: RegExp;
	timeoutMs?: number;
	gate?: "pulse";
	once?: boolean;
	/** CC settings.json `async: true` parity — fire-and-forget, output ignored, never blocks the turn. */
	fireAndForget?: boolean;
}

interface HookOutcome {
	additionalContext?: string;
	block?: boolean;
	reason?: string;
}

interface ExtensionCtx {
	hasUI?: boolean;
	cwd?: string;
	sessionManager?: {
		getBranch?: () => unknown[];
		getSessionFile?: () => string | undefined;
		getSessionId?: () => string | undefined;
	};
	ui?: { notify?: (message: string, level?: string) => void; setWorkingMessage?: (message?: string) => void };
}

interface ExtensionApi {
	on: (event: string, handler: (event: unknown, ctx: ExtensionCtx) => unknown) => void;
	setLabel?: (label: string) => void;
}

const HOME = homedir();
const CONFIG_ROOT = process.env.LIFEOS_CONFIG_ROOT || process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const CLAUDE_ROOT = CONFIG_ROOT;
const HOOKS_DIR = join(CONFIG_ROOT, "hooks");
const LIFEOS_DIR = process.env.LIFEOS_DIR ?? join(CONFIG_ROOT, "LIFEOS");
const BUN = typeof Bun !== "undefined" ? Bun.which("bun") || process.execPath : "bun";

const TOOL_NAME_MAP: Record<string, string> = {
	bash: "Bash",
	write: "Write",
	edit: "Edit",
	multiedit: "MultiEdit",
	read: "Read",
	web_search: "WebSearch",
	web_fetch: "WebFetch",
};

// Curated from the hook-inventory classification (PARITY.md), remapped 2026-07-15 to the
// post-restructure hook set this tree actually ships (upstream's 2026-07-11 hooks BPE pass
// consolidated/retired several): MemoryReviewTrigger → cadence folded into MemoryReviewFire;
// OutputFormatGate + SuccessClaimGate → StopGates (FormatGate + VerificationGate + WritingGate);
// TheRouter / TelosSummarySync / RelationshipMemory / ArtWorkflowGuard → retired upstream, no
// successor — upstream 7.0.0 retired the whole mode system).
const MANIFEST: HookSpec[] = [
	// before_agent_start (CC UserPromptSubmit / SessionStart-once)
	{ file: "LoadContext.hook.ts", ompEvent: "before_agent_start", ccEvent: "SessionStart", once: true, timeoutMs: 8000 },
	{ file: "MemoryDeltaSurface.hook.ts", ompEvent: "before_agent_start", ccEvent: "UserPromptSubmit", timeoutMs: 8000 },
	// MemoryReviewTrigger retired: MemoryReviewFire (session_stop, below) owns the whole cadence.
	{ file: "SatisfactionCapture.hook.ts", ompEvent: "before_agent_start", ccEvent: "UserPromptSubmit", fireAndForget: true, timeoutMs: 20000 },
	{ file: "ReminderRouter.hook.ts", ompEvent: "before_agent_start", ccEvent: "UserPromptSubmit", fireAndForget: true, timeoutMs: 5000 },
	// tool_result (CC PostToolUse) — write/edit only; each self-gates on file path
	{ file: "ISASync.hook.ts", ompEvent: "tool_result", ccEvent: "PostToolUse", matcher: /^(write|edit|multiedit)$/i, timeoutMs: 8000 },
	// TelosSummarySync retired upstream (no successor in this tree).
	{ file: "CheckpointPerISC.hook.ts", ompEvent: "tool_result", ccEvent: "PostToolUse", matcher: /^(write|edit|multiedit)$/i, timeoutMs: 30000 },
	// tool_call (CC PreToolUse) — guards that block via exit code 2 + stderr
	{ file: "SystemFileGuard.hook.ts", ompEvent: "tool_call", ccEvent: "PreToolUse", matcher: /^(write|edit|multiedit)$/i, timeoutMs: 5000 },
	// ArtWorkflowGuard retired upstream (no successor in this tree).
	// CC parity: Pulse HTTP-route guard (settings.json type:"http" on the Agent matcher).
	// OMP has no Skill tool (skills load via read); agent spawns go through task.
	{ url: "http://localhost:31337/hooks/agent-guard", ompEvent: "tool_call", ccEvent: "PreToolUse", matcher: /^task$/i, gate: "pulse", timeoutMs: 4000 },
	// session_stop (CC Stop)
	{ file: "MemoryReviewFire.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", timeoutMs: 10000 },
	{ file: "MemoryHealthGate.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", timeoutMs: 8000 },
	{ file: "DocIntegrity.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", timeoutMs: 15000 },
	{ file: "ISARenderOnStop.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", timeoutMs: 8000 },
	{ file: "VoiceCompletion.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", gate: "pulse", timeoutMs: 6000 },
	// StopGates = FormatGate (banner telemetry) + VerificationGate (claim-vs-evidence teeth,
	// successor of SuccessClaimGate) + WritingGate — upstream's ONE Stop-gate hook, ungated
	// (FormatGate is telemetry-only — it records format compliance, never blocks).
	{ file: "StopGates.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", timeoutMs: 15000 },
	// session_shutdown (CC SessionEnd)
	{ file: "UpdateCounts.hook.ts", ompEvent: "session_shutdown", ccEvent: "SessionEnd", timeoutMs: 15000 },
	{ file: "WorkCompletionLearning.hook.ts", ompEvent: "session_shutdown", ccEvent: "SessionEnd", timeoutMs: 20000 },
	{ file: "SessionCleanup.hook.ts", ompEvent: "session_shutdown", ccEvent: "SessionEnd", timeoutMs: 8000 },
	// RelationshipMemory retired upstream (no successor in this tree).
	{ file: "IntegrityCheck.hook.ts", ompEvent: "session_shutdown", ccEvent: "SessionEnd", timeoutMs: 10000 },
	// Format regime: ONE unified format per the constitution (upstream 7.0.0 retired the mode
	// system entirely). StopGates' FormatGate (above) provides banner/format telemetry.
];
export const REQUIRED_HOOK_FILES = MANIFEST.flatMap((spec) => spec.file ? [spec.file] : []);

const firedOnce = new Set<string>();
const fallbackSessionId = `omp-${randomUUID()}`;

function isLikelySubagent(): boolean {
	return Boolean(
		process.env.CLAUDE_CODE_SUBAGENT_NAME ||
			process.env.CLAUDE_CODE_SUBAGENT_TYPE ||
			process.env.CLAUDE_CODE_AGENT_TASK_ID ||
			process.env.CLAUDE_AGENT_SDK === "1" ||
			process.env.PI_SUBAGENT ||
			process.env.OMP_SUBAGENT ||
			process.env.PI_AGENT_TASK_ID,
	);
}

export function createPulseAvailabilityProbe(options: {
	probe?: () => Promise<boolean>;
	now?: () => number;
	retryAfterMs?: number;
} = {}): () => Promise<boolean> {
	const probe = options.probe ?? (async () => {
		const response = await fetch("http://localhost:31337/", { signal: AbortSignal.timeout(1000) });
		return response.status >= 200 && response.status < 400;
	});
	const now = options.now ?? Date.now;
	const retryAfterMs = options.retryAfterMs ?? 5000;
	let pulseUp: boolean | undefined;
	let pulseCheckedAt = 0;

	return async () => {
		if (pulseUp === true || (pulseUp === false && now() - pulseCheckedAt < retryAfterMs)) return pulseUp;
		try {
			pulseUp = await probe();
		} catch {
			pulseUp = false;
		}
		pulseCheckedAt = now();
		return pulseUp;
	};
}

const pulseAvailable = createPulseAvailabilityProbe();

function parseHookJson(out: string): HookOutcome {
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch {
		return {};
	}
	if (parsed === null || typeof parsed !== "object") return {};
	if ("decision" in parsed && parsed.decision === "block") {
		const reason = "reason" in parsed && typeof parsed.reason === "string" ? parsed.reason : "blocked by LifeOS hook";
		return { block: true, reason };
	}
	if ("hookSpecificOutput" in parsed) {
		const hso = parsed.hookSpecificOutput;
		if (hso !== null && typeof hso === "object") {
			if ("additionalContext" in hso && typeof hso.additionalContext === "string") {
				return { additionalContext: hso.additionalContext };
			}
			if ("decision" in hso && hso.decision !== null && typeof hso.decision === "object") {
				const d = hso.decision;
				if ("behavior" in d && d.behavior === "deny") return { block: true, reason: "denied by LifeOS Safety hook" };
			}
		}
	}
	return {};
}

async function runHttpHook(spec: HookSpec, ccStdin: Record<string, unknown>): Promise<HookOutcome> {
	try {
		const res = await fetch(spec.url ?? "", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(ccStdin),
			signal: AbortSignal.timeout(spec.timeoutMs ?? 4000),
		});
		if (!res.ok) return {};
		const out = (await res.text()).trim();
		if (out.length === 0) return {};
		return out.startsWith("{") ? parseHookJson(out) : { additionalContext: out };
	} catch {
		return {};
	}
}

export function hookEnv(ctx: Pick<ExtensionCtx, "cwd">): Record<string, string | undefined> {
	return {
		...process.env,
		LIFEOS_CONFIG_ROOT: CONFIG_ROOT,
		LIFEOS_DIR,
		LIFEOS_HARNESS: "omp",
		CLAUDE_PROJECT_DIR: ctx.cwd ?? process.cwd(),
		CLAUDE_PLUGIN_ROOT: CLAUDE_ROOT,
		CLAUDE_EFFORT: process.env.CLAUDE_EFFORT ?? "E3",
	};
}

interface SpawnResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export function launchFireAndForgetHook(
	path: string,
	input: string,
	timeoutMs: number,
	env: Record<string, string | undefined>,
): ChildProcess {
	const child = spawn(BUN, [path], { env, stdio: ["pipe", "ignore", "ignore"], detached: true });
	child.stdin?.write(input);
	child.stdin?.end();
	const timer = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already dead */
		}
	}, timeoutMs);
	timer.unref();
	child.once("close", () => clearTimeout(timer));
	child.once("error", () => clearTimeout(timer));
	child.unref();
	return child;
}

/**
 * Async subprocess runner — spawnSync replacement. spawnSync blocked OMP's shared
 * event loop for the full hook duration (TUI freeze); this awaits instead, with a
 * hard timeout that SIGKILLs the child.
 */
function spawnHook(path: string, input: string, timeoutMs: number, env: Record<string, string | undefined>): Promise<SpawnResult> {
	const { promise, resolve } = Promise.withResolvers<SpawnResult>();
	let stdout = "";
	let stderr = "";
	let settled = false;
	try {
		const child = spawn(BUN, [path], { env, stdio: ["pipe", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				try {
					child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
				resolve({ status: null, stdout, stderr });
			}
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ status: code, stdout, stderr });
			}
		});
		child.on("error", () => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({ status: null, stdout, stderr });
			}
		});
		child.stdin?.write(input);
		child.stdin?.end();
	} catch {
		if (!settled) {
			settled = true;
			resolve({ status: null, stdout, stderr });
		}
	}
	return promise;
}

async function runHook(spec: HookSpec, ccStdin: Record<string, unknown>, ctx: ExtensionCtx): Promise<HookOutcome> {
	if (spec.gate === "pulse" && !(await pulseAvailable())) return {};
	if (spec.url) return runHttpHook(spec, ccStdin);
	if (!spec.file) return {};
	const path = join(HOOKS_DIR, spec.file);
	if (!existsSync(path)) return {};

	// CC `async: true` parity: detached fire-and-forget. Output ignored by contract —
	// these hooks write state files / observability, never additionalContext the model needs.
	if (spec.fireAndForget) {
		try {
			launchFireAndForgetHook(path, JSON.stringify(ccStdin), spec.timeoutMs ?? 5000, hookEnv(ctx));
		} catch {
			/* fail-open */
		}
		return {};
	}

	const res = await spawnHook(path, JSON.stringify(ccStdin), spec.timeoutMs ?? 5000, hookEnv(ctx));
	if (res.status === 2) return { block: true, reason: res.stderr.trim() || "blocked by LifeOS guard" };
	const out = res.stdout.trim();
	if (out.length === 0) return {};
	return out.startsWith("{") ? parseHookJson(out) : { additionalContext: out };
}

function sessionId(ctx: ExtensionCtx): string {
	const explicit = ctx.sessionManager?.getSessionId?.();
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	const file = ctx.sessionManager?.getSessionFile?.();
	if (typeof file === "string" && file.length > 0) return basename(file).replace(/\.[^.]+$/, "");
	return fallbackSessionId;
}

function buildStdin(spec: HookSpec, extra: Record<string, unknown>, ctx: ExtensionCtx): Record<string, unknown> {
	return { hook_event_name: spec.ccEvent, session_id: sessionId(ctx), cwd: ctx.cwd ?? process.cwd(), ...extra };
}

function readField(value: unknown, key: string): unknown {
	if (value !== null && typeof value === "object" && key in value) {
		const record = value as Record<string, unknown>;
		return record[key];
	}
	return undefined;
}

function readToolName(event: unknown): string {
	const name = readField(event, "toolName") ?? readField(event, "tool_name");
	return typeof name === "string" ? name : "";
}

function contentToText(event: unknown): string {
	const content = readField(event, "content");
	if (!Array.isArray(content)) return "";
	return content
		.map((chunk) => {
			const text = readField(chunk, "text");
			return typeof text === "string" ? text : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function latestUserText(ctx: ExtensionCtx): string {
	const branch = ctx.sessionManager?.getBranch?.();
	if (!Array.isArray(branch)) return "";
	for (let i = branch.length - 1; i >= 0; i--) {
		if (readField(branch[i], "role") === "user") {
			const text = contentToText(branch[i]).trim();
			if (text.length > 0) return text;
		}
	}
	return "";
}

function latestAssistantText(ctx: ExtensionCtx): string {
	const branch = ctx.sessionManager?.getBranch?.();
	if (!Array.isArray(branch)) return "";
	for (let i = branch.length - 1; i >= 0; i--) {
		if (readField(branch[i], "role") === "assistant") {
			const text = contentToText(branch[i]).trim();
			if (text.length > 0) return text;
		}
	}
	return "";
}

// Transcript surface for Stop / SessionEnd hooks (StopGates, VoiceCompletion,
// MemoryReviewFire). transcript_path lets them parse via the (OMP-aware)
// TranscriptParser; last_assistant_message is the robust fallback.
function stopExtra(ctx: ExtensionCtx): Record<string, unknown> {
	const extra: Record<string, unknown> = {};
	const file = ctx.sessionManager?.getSessionFile?.();
	if (typeof file === "string" && file.length > 0) extra.transcript_path = file;
	const last = latestAssistantText(ctx);
	if (last.length > 0) extra.last_assistant_message = last;
	return extra;
}

export default function lifeosHooks(pi: ExtensionApi): void {
	pi.setLabel?.("LifeOS Hooks");

	pi.on("before_agent_start", async (event, ctx) => {
		if (isLikelySubagent()) return undefined;
		// event.prompt is authoritative — at before_agent_start the user message is NOT yet
		// on the session branch (probe: last branch entry is thinking_level_change).
		const eventPrompt = readField(event, "prompt");
		const prompt = typeof eventPrompt === "string" && eventPrompt.length > 0 ? eventPrompt : latestUserText(ctx);
		// Surface the pre-turn hook window (CC masks the same span with its spinner). With the
		// async core the TUI actually paints this: the fast context pass (~150ms, barely a flicker).
		if (ctx.hasUI) ctx.ui?.setWorkingMessage?.("LifeOS: loading context…");
		try {
			const chunks: string[] = [];
			for (const spec of MANIFEST.filter((s) => s.ompEvent === "before_agent_start")) {
				if (spec.once && spec.file && firedOnce.has(spec.file)) continue;
				const outcome = await runHook(spec, buildStdin(spec, { prompt }, ctx), ctx);
				if (spec.once && spec.file) firedOnce.add(spec.file);
				if (outcome.additionalContext) chunks.push(outcome.additionalContext);
			}
			if (chunks.length === 0) return undefined;
			return { message: { customType: "lifeos-hooks", content: [{ type: "text", text: chunks.join("\n\n") }], display: false } };
		} finally {
			if (ctx.hasUI) ctx.ui?.setWorkingMessage?.();
		}
	});

	// OMP tool args use `path`; CC hooks read `tool_input.file_path` (SystemFileGuard,
	// ISASync, CheckpointPerISC all path-gate on it — missing field = silent allow/no-op,
	// which let a SYSTEM-file write through on 2026-07-12). Normalize before bridging.
	function toCcToolInput(input: unknown): Record<string, unknown> {
		const base = input !== null && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {};
		if (typeof base.path === "string" && base.file_path === undefined) base.file_path = base.path;
		return base;
	}

	pi.on("tool_call", async (event, ctx) => {
		const toolName = readToolName(event);
		if (toolName.length === 0) return undefined;
		const input = readField(event, "input") ?? readField(event, "tool_input");
		const toolInput = toCcToolInput(input);
		const ccName = TOOL_NAME_MAP[toolName.toLowerCase()] ?? toolName;
		for (const spec of MANIFEST.filter((s) => s.ompEvent === "tool_call" && (!s.matcher || s.matcher.test(toolName)))) {
			const outcome = await runHook(spec, buildStdin(spec, { tool_name: ccName, tool_input: toolInput }, ctx), ctx);
			if (outcome.block) return { block: true, reason: outcome.reason ?? "blocked by LifeOS hook" };
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const toolName = readToolName(event);
		if (toolName.length === 0) return undefined;
		const specs = MANIFEST.filter((s) => s.ompEvent === "tool_result" && (!s.matcher || s.matcher.test(toolName)));
		if (specs.length === 0) return undefined;
		const ccName = TOOL_NAME_MAP[toolName.toLowerCase()] ?? toolName;
		// CC PostToolUse stdin carries the ORIGINAL tool_input alongside tool_response;
		// ISASync/CheckpointPerISC path-gate on tool_input.file_path.
		// Omitting it made them silent no-ops (2026-07-12 finding).
		const toolInput = toCcToolInput(readField(event, "input") ?? readField(event, "tool_input"));
		const body = contentToText(event);
		const chunks: string[] = [];
		for (const spec of specs) {
			const outcome = await runHook(spec, buildStdin(spec, { tool_name: ccName, tool_input: toolInput, tool_response: body }, ctx), ctx);
			if (outcome.additionalContext) chunks.push(outcome.additionalContext);
		}
		if (chunks.length === 0) return undefined;
		return { content: [{ type: "text", text: chunks.join("\n\n") }] };
	});

	pi.on("session_stop", async (_event, ctx) => {
		// Contract: ONLY an explicit hook decision:block continues the turn. Plain stdout from
		// Stop hooks (render status, {"continue":true} acks, doc reports) is informational — in
		// CC it never re-prompts, and returning it as additionalContext here made OMP loop the
		// turn until the continuation cap and drop the visible response (found 2026-07-11:
		// ISARenderOnStop's {"continue":true} ack triggered exactly that).
		for (const spec of MANIFEST.filter((s) => s.ompEvent === "session_stop")) {
			const outcome = await runHook(spec, buildStdin(spec, stopExtra(ctx), ctx), ctx);
			if (outcome.block) return { decision: "block", reason: outcome.reason ?? "held by LifeOS gate" };
		}
		return undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const spec of MANIFEST.filter((s) => s.ompEvent === "session_shutdown")) {
			await runHook(spec, buildStdin(spec, stopExtra(ctx), ctx), ctx);
		}
	});
}
