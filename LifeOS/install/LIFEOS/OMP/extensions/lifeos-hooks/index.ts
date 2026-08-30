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

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { boundedAuditRow } from "../../../UNIVERSAL/canonical";
import { spawn, type ChildProcess } from "node:child_process";
import { getOmpSessionIdentity } from "../../session";

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
	failMode: "fail-closed" | "fail-visible-open" | "advisory";
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
	sessionManager?: { getBranch?: () => unknown[]; getSessionFile?: () => string | undefined };
	ui?: { notify?: (message: string, level?: string) => void; setWorkingMessage?: (message?: string) => void };
}

interface ExtensionApi {
	on: (event: string, handler: (event: unknown, ctx: ExtensionCtx) => unknown) => void;
	setLabel?: (label: string) => void;
}

const HOME = normalize(process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir());
const CLAUDE_ROOT = normalize(process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"));
const HOOKS_DIR = normalize(process.env.LIFEOS_HOOKS_DIR ?? join(CLAUDE_ROOT, "hooks"));
const LIFEOS_DIR = normalize(process.env.LIFEOS_DIR ?? join(CLAUDE_ROOT, "LIFEOS"));
const PROFILE_ROOT = normalize(process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".omp", "agent"));
const BUN = process.env.LIFEOS_HOOK_EXECUTABLE?.trim() || process.execPath;

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
	{ file: "LoadContext.hook.ts", ompEvent: "before_agent_start", ccEvent: "SessionStart", once: true, timeoutMs: 8000, failMode: "fail-visible-open" },
	{ file: "MemoryDeltaSurface.hook.ts", ompEvent: "before_agent_start", ccEvent: "UserPromptSubmit", timeoutMs: 8000, failMode: "fail-visible-open" },
	// MemoryReviewTrigger retired: MemoryReviewFire (session_stop, below) owns the whole cadence.
	{ file: "SatisfactionCapture.hook.ts", ompEvent: "before_agent_start", ccEvent: "UserPromptSubmit", fireAndForget: true, timeoutMs: 20000, failMode: "advisory" },
	{ file: "ReminderRouter.hook.ts", ompEvent: "before_agent_start", ccEvent: "UserPromptSubmit", fireAndForget: true, timeoutMs: 5000, failMode: "advisory" },
	// tool_result (CC PostToolUse) — write/edit only; each self-gates on file path
	{ file: "ISASync.hook.ts", ompEvent: "tool_result", ccEvent: "PostToolUse", matcher: /^(write|edit|multiedit)$/i, timeoutMs: 8000, failMode: "advisory" },
	// TelosSummarySync retired upstream (no successor in this tree).
	{ file: "CheckpointPerISC.hook.ts", ompEvent: "tool_result", ccEvent: "PostToolUse", matcher: /^(write|edit|multiedit)$/i, timeoutMs: 30000, failMode: "advisory" },
	// tool_call (CC PreToolUse) — guards that block via exit code 2 + stderr
	{ file: "SystemFileGuard.hook.ts", ompEvent: "tool_call", ccEvent: "PreToolUse", matcher: /^(write|edit|multiedit)$/i, timeoutMs: 5000, failMode: "fail-closed" },
	// ArtWorkflowGuard retired upstream (no successor in this tree).
	// CC parity: Pulse HTTP-route guard (settings.json type:"http" on the Agent matcher).
	// OMP has no Skill tool (skills load via read); agent spawns go through task.
	{ url: "http://localhost:31337/hooks/agent-guard", ompEvent: "tool_call", ccEvent: "PreToolUse", matcher: /^task$/i, gate: "pulse", timeoutMs: 4000, failMode: "fail-visible-open" },
	// session_stop (CC Stop)
	{ file: "MemoryReviewFire.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", fireAndForget: true, timeoutMs: 140000, failMode: "advisory" },
	{ file: "MemoryHealthGate.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", timeoutMs: 8000, failMode: "fail-visible-open" },
	{ file: "DocIntegrity.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", timeoutMs: 15000, failMode: "advisory" },
	{ file: "ISARenderOnStop.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", timeoutMs: 8000, failMode: "advisory" },
	{ file: "VoiceCompletion.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", gate: "pulse", timeoutMs: 6000, failMode: "advisory" },
	// StopGates = FormatGate (banner telemetry) + VerificationGate (claim-vs-evidence teeth,
	// successor of SuccessClaimGate) + WritingGate — upstream's ONE Stop-gate hook, ungated
	// (FormatGate is telemetry-only — it records format compliance, never blocks).
	{ file: "StopGates.hook.ts", ompEvent: "session_stop", ccEvent: "Stop", timeoutMs: 15000, failMode: "fail-visible-open" },
	// session_shutdown (CC SessionEnd)
	{ file: "UpdateCounts.hook.ts", ompEvent: "session_shutdown", ccEvent: "SessionEnd", timeoutMs: 15000, failMode: "advisory" },
	{ file: "WorkCompletionLearning.hook.ts", ompEvent: "session_shutdown", ccEvent: "SessionEnd", timeoutMs: 20000, failMode: "advisory" },
	{ file: "SessionCleanup.hook.ts", ompEvent: "session_shutdown", ccEvent: "SessionEnd", timeoutMs: 8000, failMode: "advisory" },
	// RelationshipMemory retired upstream (no successor in this tree).
	{ file: "IntegrityCheck.hook.ts", ompEvent: "session_shutdown", ccEvent: "SessionEnd", timeoutMs: 10000, failMode: "fail-visible-open" },
	// Format regime: ONE unified format per the constitution (upstream 7.0.0 retired the mode
	// system entirely). StopGates' FormatGate (above) provides banner/format telemetry.
];

const firedOnce = new Set<string>();

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

const PULSE_NEGATIVE_TTL_MS = 2_000;
let pulseState: { available: boolean; checkedAt: number } | undefined;
export async function pulseAvailable(now = Date.now()): Promise<boolean> {
	if (pulseState?.available) return true;
	if (pulseState && now - pulseState.checkedAt < PULSE_NEGATIVE_TTL_MS) return false;
	try {
		const res = await fetch("http://localhost:31337/", { signal: AbortSignal.timeout(1000) });
		pulseState = { available: res.status >= 200 && res.status < 400, checkedAt: now };
	} catch {
		pulseState = { available: false, checkedAt: now };
	}
	return pulseState.available;
}

export function resetPulseAvailabilityForTests(): void {
	pulseState = undefined;
}

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

function timeoutFor(spec: HookSpec): number {
	const override = Number(process.env.LIFEOS_HOOK_TIMEOUT_MS);
	return Number.isFinite(override) && override > 0 ? override : spec.timeoutMs ?? 5000;
}

function recordDegradedHook(reason: string, ctx: ExtensionCtx): void {
	try {
		const directory = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY");
		mkdirSync(directory, { recursive: true });
		const identity = getOmpSessionIdentity(ctx, PROFILE_ROOT);
		const row = boundedAuditRow({
			eventId: `omp-hook-degraded-${Date.now()}`,
			occurredAt: new Date().toISOString(),
			decision: "advisory",
			adapterId: "omp",
			uaiSessionId: identity.uaiSessionId,
			details: { reason, failVisible: true },
		});
		appendFileSync(join(directory, "hook-degraded.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
	} catch {
		// The native advisory remains visible even if durable evidence cannot be written.
	}
}

function hookFailure(spec: HookSpec, ctx: ExtensionCtx, detail: string): HookOutcome {
	const identity = spec.file ?? spec.url ?? spec.ccEvent;
	const reason = `LifeOS hook ${identity} failed: ${detail}`;
	if (spec.failMode === "fail-visible-open") recordDegradedHook(reason, ctx);
	if (spec.failMode === "fail-closed") return { block: true, reason };
	if (spec.failMode === "fail-visible-open") {
		ctx.ui?.notify?.(reason, "warning");
		return { additionalContext: reason };
	}
	return {};
}

async function runHttpHook(spec: HookSpec, ccStdin: Record<string, unknown>, ctx: ExtensionCtx): Promise<HookOutcome> {
	try {
		const res = await fetch(spec.url ?? "", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(ccStdin),
			signal: AbortSignal.timeout(timeoutFor(spec)),
		});
		if (!res.ok) return hookFailure(spec, ctx, `HTTP ${res.status}`);
		const out = (await res.text()).trim();
		if (out.length === 0) return {};
		return out.startsWith("{") ? parseHookJson(out) : { additionalContext: out };
	} catch (error) {
		return hookFailure(spec, ctx, error instanceof Error ? error.message : String(error));
	}
}

export function hookEnv(ctx: Pick<ExtensionCtx, "cwd">): Record<string, string | undefined> {
	return {
		...process.env,
		LIFEOS_DIR,
		LIFEOS_HARNESS: "omp",
		CLAUDE_PROJECT_DIR: ctx.cwd ?? process.cwd(),
		CLAUDE_PLUGIN_ROOT: CLAUDE_ROOT,
		CLAUDE_EFFORT: process.env.CLAUDE_EFFORT ?? "E3",
	};
}

export interface SpawnResult {
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface DetachedProcessControl {
	exited: Promise<SpawnResult>;
}

function terminateProcessTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		if (process.platform === "win32") {
			child.kill();
			const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.unref();
		} else if (child.spawnargs.length > 0) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		} else {
			child.kill("SIGKILL");
		}
	} catch {
		// The child already exited.
	}
}

function collectChild(
	child: ChildProcess,
	input: string,
	timeoutMs: number,
): Promise<SpawnResult> {
	const { promise, resolve } = Promise.withResolvers<SpawnResult>();
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let settled = false;
	const timer = setTimeout(() => {
		timedOut = true;
		terminateProcessTree(child);
	}, timeoutMs);
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const finish = (status: number | null): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve({ status, stdout, stderr, timedOut });
	};
	child.on("close", finish);
	child.on("error", () => finish(null));
	child.stdin?.end(input);
	return promise;
}

export function runProcessWithTimeout(
	command: string,
	args: string[],
	input: string,
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
	try {
		const child = spawn(command, args, {
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		return collectChild(child, input, timeoutMs);
	} catch {
		return Promise.resolve({ status: null, stdout: "", stderr: "", timedOut: false });
	}
}

export function startDetachedProcess(
	command: string,
	args: string[],
	input: string,
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
): DetachedProcessControl {
	try {
		const child = spawn(command, args, {
			env,
			stdio: ["pipe", "ignore", "ignore"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		const exited = collectChild(child, input, timeoutMs);
		return { exited };
	} catch {
		return { exited: Promise.resolve({ status: null, stdout: "", stderr: "", timedOut: false }) };
	}
}

async function runHook(spec: HookSpec, ccStdin: Record<string, unknown>, ctx: ExtensionCtx): Promise<HookOutcome> {
	if (spec.gate === "pulse" && !(await pulseAvailable())) return hookFailure(spec, ctx, "Pulse is unavailable");
	if (spec.url) return runHttpHook(spec, ccStdin, ctx);
	if (!spec.file) return hookFailure(spec, ctx, "hook implementation is not configured");
	const path = join(HOOKS_DIR, spec.file);
	if (!existsSync(path)) return hookFailure(spec, ctx, `missing hook file ${path}`);

	// Detached hooks cannot block their originating event, but fail-visible-open hooks
	// still report process failures to the active OMP UI.
	if (spec.fireAndForget) {
		const control = startDetachedProcess(BUN, [path], JSON.stringify(ccStdin), timeoutFor(spec), hookEnv(ctx));
		void control.exited.then((result) => {
			if (result.timedOut) hookFailure(spec, ctx, `timed out after ${timeoutFor(spec)}ms`);
			else if (result.status === null) hookFailure(spec, ctx, "hook process could not be spawned");
			else if (result.status !== 0) hookFailure(spec, ctx, `hook process exited ${result.status}`);
		});
		return {};
	}

	const res = await runProcessWithTimeout(BUN, [path], JSON.stringify(ccStdin), timeoutFor(spec), hookEnv(ctx));
	if (res.timedOut) return hookFailure(spec, ctx, `timed out after ${timeoutFor(spec)}ms`);
	if (res.status === null) return hookFailure(spec, ctx, "hook process could not be spawned");
	if (res.status === 2) return { block: true, reason: res.stderr.trim() || "blocked by LifeOS guard" };
	if (res.status !== 0) return hookFailure(spec, ctx, `hook process exited ${res.status}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}`);
	const out = res.stdout.trim();
	if (out.length === 0) return {};
	return out.startsWith("{") ? parseHookJson(out) : { additionalContext: out };
}

function buildStdin(spec: HookSpec, extra: Record<string, unknown>, ctx: ExtensionCtx): Record<string, unknown> {
	const identity = getOmpSessionIdentity(ctx, PROFILE_ROOT);
	return {
		hook_event_name: spec.ccEvent,
		session_id: identity.uaiSessionId,
		uai_session_id: identity.uaiSessionId,
		native_session_id: identity.nativeSessionId,
		uai_profile_root: identity.profileRoot,
		cwd: ctx.cwd ?? process.cwd(),
		...extra,
	};
}

function readField(value: unknown, key: string): unknown {
	if (value !== null && typeof value === "object" && key in value) {
		const record: Record<string, unknown> = value;
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
				const identity = getOmpSessionIdentity(ctx, PROFILE_ROOT);
				const onceKey = spec.file ? `${identity.uaiSessionId}:${spec.file}` : "";
				if (spec.once && onceKey !== "" && firedOnce.has(onceKey)) continue;
				const outcome = await runHook(spec, buildStdin(spec, { prompt }, ctx), ctx);
				if (spec.once && onceKey !== "") firedOnce.add(onceKey);
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
