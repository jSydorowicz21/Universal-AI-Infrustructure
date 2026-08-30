import { ADAPTER_CONTRACT, type AdapterDescriptor, type AdapterId } from "./contract";
import type { CanonicalDecision, CanonicalEvent } from "./canonical";

export type FirstPartyAdapterId = "claude" | "omp" | "codex" | "opencode";
export interface NativeDecision { exitCode: number; output?: Record<string, unknown> }
export interface Adapter {
  descriptor: AdapterDescriptor;
  normalize(payload: unknown): CanonicalEvent;
  lower(decision: CanonicalDecision): NativeDecision;
}

export interface HookRequirement {
  id: string;
  event: "tool.before" | "tool.after" | "prompt.submit" | "session.start" | "session.stop";
  matcher?: string;
  mode: "blocking" | "advisory";
  timeoutMs: number;
  pulseGate: boolean;
  nativePortPreferred: boolean;
  failMode: "fail-closed" | "fail-visible-open" | "advisory";
}

export const CANONICAL_HOOK_MANIFEST: readonly HookRequirement[] = [
  { id: "pre-tool-security", event: "tool.before", matcher: "*", mode: "blocking", timeoutMs: 15_000, pulseGate: false, nativePortPreferred: true, failMode: "fail-closed" },
  { id: "post-tool-observer", event: "tool.after", matcher: "*", mode: "advisory", timeoutMs: 15_000, pulseGate: false, nativePortPreferred: false, failMode: "fail-visible-open" },
  { id: "prompt-policy", event: "prompt.submit", mode: "advisory", timeoutMs: 15_000, pulseGate: false, nativePortPreferred: false, failMode: "advisory" },
  { id: "session-start", event: "session.start", mode: "advisory", timeoutMs: 20_000, pulseGate: true, nativePortPreferred: false, failMode: "fail-visible-open" },
  { id: "session-stop", event: "session.stop", mode: "advisory", timeoutMs: 30_000, pulseGate: true, nativePortPreferred: false, failMode: "fail-visible-open" },
] as const;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toolFrom(payload: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  const tool = object(payload.tool);
  const name = string(payload.tool_name) ?? string(payload.toolName) ?? string(payload.tool) ?? string(tool.name) ?? "Unknown";
  const input = object(payload.tool_input ?? payload.toolInput ?? payload.arguments ?? payload.input ?? tool.input);
  return { name, input };
}

function eventType(adapterId: FirstPartyAdapterId, payload: Record<string, unknown>): CanonicalEvent["type"] {
  const native = string(payload.hook_event_name) ?? string(payload.event) ?? string(payload.event_name) ?? "unknown";
  const mapping: Record<string, CanonicalEvent["type"]> = {
    PreToolUse: "tool.before", pre_tool: "tool.before", "tool.execute.before": "tool.before",
    PostToolUse: "tool.after", post_tool: "tool.after", "tool.execute.after": "tool.after",
    UserPromptSubmit: "prompt.submit", prompt: "prompt.submit", "chat.message": "prompt.submit",
    SessionStart: "session.start", session_start: "session.start", "session.created": "session.start",
    Stop: "session.stop", SessionEnd: "session.stop", session_stop: "session.stop", "session.idle": "session.stop",
  };
  const result = mapping[native];
  if (result) return result;
  if (adapterId === "omp" && native.includes("tool")) return native.endsWith("after") ? "tool.after" : "tool.before";
  throw new Error(`Unsupported ${adapterId} event: ${native}`);
}

export function normalizeNativeEvent(adapterId: FirstPartyAdapterId, value: unknown): CanonicalEvent {
  const payload = object(value);
  const session = object(payload.session);
  const type = eventType(adapterId, payload);
  const nativeSessionId = string(payload.session_id) ?? string(payload.sessionId) ?? string(payload.sessionID) ?? string(payload.conversation_id) ?? string(session.id);
  const event: CanonicalEvent = { type, adapterId, nativeSessionId };
  if (type === "tool.before" || type === "tool.after") event.tool = toolFrom(payload);
  if (type === "prompt.submit") event.prompt = string(payload.prompt) ?? string(payload.message) ?? "";
  if (type === "tool.after") {
    const output = payload.tool_response ?? payload.tool_result ?? payload.toolResult ?? payload.result ?? payload.output;
    event.result = { output, provenance: object(payload.provenance) as never };
  }
  return event;
}

export function lowerDecision(adapterId: FirstPartyAdapterId, decision: CanonicalDecision): NativeDecision {
  if (decision.action === "block") {
    if (adapterId === "claude") return { exitCode: 2, output: undefined };
    if (adapterId === "omp") return { exitCode: 0, output: { block: true, reason: decision.reason ?? "Blocked by UAI" } };
    if (adapterId === "codex") return { exitCode: 0, output: { decision: "block", reason: decision.reason ?? "Blocked by UAI" } };
    return { exitCode: 0, output: { permission: "deny", message: decision.reason ?? "Blocked by UAI" } };
  }
  if (decision.action === "update") {
    if (adapterId === "codex") {
      const additionalContext = decision.additionalContext?.join("\n");
      return { exitCode: 0, output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: decision.updatedInput ?? {}, ...(additionalContext ? { additionalContext } : {}) } } };
    }
    const output = { updatedInput: decision.updatedInput ?? {}, additionalContext: decision.additionalContext ?? [] };
    return adapterId === "opencode" ? { exitCode: 0, output: { permission: "allow", ...output } } : { exitCode: 0, output };
  }
  if (decision.action === "advisory") {
    if (adapterId === "codex") return { exitCode: 0, output: { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: (decision.additionalContext ?? [decision.reason ?? ""]).join("\n") } } };
    return { exitCode: 0, output: { additionalContext: decision.additionalContext ?? [decision.reason ?? ""] } };
  }
  if (adapterId === "codex") return { exitCode: 0, output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } } };
  if (adapterId === "opencode") return { exitCode: 0, output: { permission: "allow" } };
  if (adapterId === "omp") return { exitCode: 0, output: { block: false } };
  return { exitCode: 0 };
}

function descriptor(id: FirstPartyAdapterId, adapterClass: AdapterDescriptor["adapter"]["class"], losses: string[], lifecycleState: "degraded" | "wired"): AdapterDescriptor {
  return {
    contract: ADAPTER_CONTRACT,
    adapter: { id, version: "1.0.0", class: adapterClass },
    discovery: { state: "detected", confidence: 1 },
    capabilities: {
      discovery: { state: "detected" },
      lifecycleBlocking: { critical: true, state: lifecycleState, failMode: id === "claude" || id === "omp" ? "fail-closed" : "fail-visible-open", losses },
      transcript: { state: "wired" },
      mcp: { state: "detected", losses: ["tool registration does not prove lifecycle parity"] },
    },
    certification: "C0",
    losses,
  };
}

export const FIRST_PARTY_ADAPTERS: Record<FirstPartyAdapterId, AdapterDescriptor> = {
  claude: descriptor("claude", "native", ["certification requires same-version negative probes"], "wired"),
  omp: descriptor("omp", "native", ["approval and egress surfaces require version-specific evidence"], "wired"),
  codex: descriptor("codex", "compatibility", ["native PreToolUse hooks block via trust-reviewed command handlers; managed hooks require policy trust", "system authority depends on managed configuration"], "degraded"),
  opencode: descriptor("opencode", "compatibility", ["blocking depends on plugin event semantics", "system prompt lowers to context authority"], "degraded"),
};

export const ADAPTERS: Record<FirstPartyAdapterId, Adapter> = {
  claude: { descriptor: FIRST_PARTY_ADAPTERS.claude, normalize: (value) => normalizeNativeEvent("claude", value), lower: (value) => lowerDecision("claude", value) },
  omp: { descriptor: FIRST_PARTY_ADAPTERS.omp, normalize: (value) => normalizeNativeEvent("omp", value), lower: (value) => lowerDecision("omp", value) },
  codex: { descriptor: FIRST_PARTY_ADAPTERS.codex, normalize: (value) => normalizeNativeEvent("codex", value), lower: (value) => lowerDecision("codex", value) },
  opencode: { descriptor: FIRST_PARTY_ADAPTERS.opencode, normalize: (value) => normalizeNativeEvent("opencode", value), lower: (value) => lowerDecision("opencode", value) },
};

export function unknownAdapter(id: AdapterId): AdapterDescriptor {
  return { contract: ADAPTER_CONTRACT, adapter: { id, version: "unknown", class: "discovery-only" }, discovery: { state: "detected", confidence: 0.25 }, certification: "C0", losses: ["discovery only; no mutation or runtime governance"] };
}
