import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type CanonicalEventType = "prompt.submit" | "tool.before" | "tool.after" | "session.start" | "session.stop" | "transcript.entry";
export interface CanonicalToolCall { id?: string; name: string; input: Record<string, unknown>; source?: { uri: string; tainted: boolean } }
export interface CanonicalToolResult { toolCallId?: string; output: unknown; error?: string; provenance?: Provenance }
export interface CanonicalDecision { action: "allow" | "block" | "advisory" | "update"; reason?: string; updatedInput?: Record<string, unknown>; additionalContext?: string[] }
export interface CanonicalEvent { type: CanonicalEventType; adapterId: string; nativeSessionId?: string; uaiSessionId?: string; tool?: CanonicalToolCall; prompt?: string; result?: CanonicalToolResult; occurredAt?: string }
export interface SessionIdentity { uaiSessionId: string; nativeSessionId?: string; adapterId: string; profileRoot: string }
export interface Provenance { transcriptUri: string; parserVersion: string; sourceLine: number; sourceEventId?: string; sourceUri?: string; tainted?: boolean; fallbackReason?: string }
export interface TranscriptEntry { role: "system" | "user" | "assistant" | "tool" | "unknown"; content: unknown; provenance: Provenance }
export interface TranscriptParseResult { entries: TranscriptEntry[]; malformedCount: number; warnings: string[] }
export interface AuditRow { schema: "uai.audit.v1"; eventId: string; occurredAt: string; decision: string; adapterId: string; uaiSessionId?: string; evidenceUri?: string; details: Record<string, string | number | boolean | null> }

export const CANONICAL_SCHEMAS = {
  event: { $id: "uai.event.v1", type: "object", required: ["type", "adapterId"], properties: { type: { enum: ["prompt.submit", "tool.before", "tool.after", "session.start", "session.stop", "transcript.entry"] }, adapterId: { type: "string" } } },
  tool: { $id: "uai.tool.v1", type: "object", required: ["name", "input"], properties: { name: { type: "string" }, input: { type: "object" } } },
  result: { $id: "uai.result.v1", type: "object", required: ["output"], properties: { output: {}, error: { type: "string" } } },
  session: { $id: "uai.session.v1", type: "object", required: ["uaiSessionId", "adapterId", "profileRoot"] },
  transcript: { $id: "uai.transcript.v1", type: "object", required: ["role", "content", "provenance"] },
  audit: { $id: "uai.audit.v1", type: "object", required: ["schema", "eventId", "occurredAt", "decision", "adapterId", "details"] },
} as const;

export function createSessionIdentity(input: { adapterId: string; profileRoot: string; nativeSessionId?: string; entropy?: string }): SessionIdentity {
  const entropy = input.entropy ?? input.nativeSessionId ?? randomUUID();
  const seed = `${input.adapterId}\0${input.profileRoot}\0${input.nativeSessionId ?? ""}\0${entropy}`;
  return { uaiSessionId: `uai_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`, nativeSessionId: input.nativeSessionId, adapterId: input.adapterId, profileRoot: input.profileRoot };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function transcriptRole(value: unknown): TranscriptEntry["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool" ? value : "unknown";
}

function nativeTranscriptFields(adapterId: string, raw: Record<string, unknown>): { role: TranscriptEntry["role"]; content: unknown; eventId?: string; sourceUri?: string; tainted?: boolean } | undefined {
  if (adapterId === "claude") {
    const message = asObject(raw.message);
    const content = raw.content ?? message.content;
    return content === undefined ? undefined : { role: transcriptRole(raw.role ?? message.role), content, eventId: String(raw.uuid ?? raw.id ?? "") || undefined, sourceUri: typeof raw.source_uri === "string" ? raw.source_uri : undefined, tainted: raw.tainted === true };
  }
  if (adapterId === "codex") {
    if (raw.type !== "response_item") return undefined;
    const content = raw.content ?? raw.payload;
    return content === undefined ? undefined : { role: transcriptRole(raw.role), content, eventId: String(raw.id ?? "") || undefined, sourceUri: typeof raw.source_uri === "string" ? raw.source_uri : undefined, tainted: raw.tainted === true };
  }
  if (adapterId === "opencode") {
    const message = asObject(raw.message);
    const content = raw.content ?? message.content ?? raw.parts;
    return content === undefined ? undefined : { role: transcriptRole(raw.role ?? message.role), content, eventId: String(raw.id ?? message.id ?? "") || undefined, sourceUri: typeof raw.source_uri === "string" ? raw.source_uri : undefined, tainted: raw.tainted === true };
  }
  if (adapterId === "omp") {
    const message = asObject(raw.message);
    const nested = asObject(message.message);
    const content = raw.content ?? message.content ?? nested.content;
    return content === undefined ? undefined : { role: transcriptRole(raw.role ?? message.role ?? nested.role), content, eventId: String(raw.id ?? message.id ?? nested.id ?? "") || undefined, sourceUri: typeof raw.source_uri === "string" ? raw.source_uri : undefined, tainted: raw.tainted === true };
  }
  const content = raw.content;
  return content === undefined ? undefined : { role: transcriptRole(raw.role), content, eventId: String(raw.id ?? "") || undefined, sourceUri: typeof raw.source_uri === "string" ? raw.source_uri : undefined, tainted: raw.tainted === true };
}

export function parseTranscriptLines(adapterId: string, lines: readonly string[], transcriptUri: string, parserVersion: string): TranscriptParseResult {
  const entries: TranscriptEntry[] = [];
  const warnings: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as unknown;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("record is not an object");
      const fields = nativeTranscriptFields(adapterId, raw as Record<string, unknown>);
      if (!fields) throw new Error("unrecognized transcript record");
      entries.push({ role: fields.role, content: fields.content, provenance: { transcriptUri, parserVersion, sourceLine: index + 1, sourceEventId: fields.eventId, sourceUri: fields.sourceUri, tainted: fields.tainted || undefined } });
    } catch (error) {
      warnings.push(`Malformed transcript line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return { entries, malformedCount: warnings.length, warnings };
}

function redactAuditValue(value: unknown, key: string, depth: number, seen: WeakSet<object>): unknown {
  if (/secret|token|password|authorization|cookie|api[-_]?key|credential|private[-_]?key|content|body|bytes|patch|old[-_]?string|new[-_]?string/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (/bearer\s+\S+|(?:api[-_]?key|token|password|authorization)\s*[:=]\s*\S+/i.test(value)) return "[REDACTED]";
    return value.slice(0, 512);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return null;
  if (depth >= 5) return "[TRUNCATED]";
  if (typeof value !== "object") return String(value).slice(0, 512);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => redactAuditValue(entry, "", depth + 1, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 32).map(([nestedKey, nestedValue]) => [
    nestedKey,
    redactAuditValue(nestedValue, nestedKey, depth + 1, seen),
  ]));
}
export function redactSensitiveValue(value: unknown): unknown {
  return redactAuditValue(value, "", 0, new WeakSet());
}


export function boundedAuditRow(input: Omit<AuditRow, "schema" | "details"> & { details?: Record<string, unknown> }): AuditRow {
  const details: AuditRow["details"] = {};
  for (const [key, value] of Object.entries(input.details ?? {}).slice(0, 32)) {
    const redacted = redactAuditValue(value, key, 0, new WeakSet());
    if (typeof redacted === "string") details[key] = redacted.slice(0, 512);
    else if (typeof redacted === "number" || typeof redacted === "boolean" || redacted === null) details[key] = redacted;
    else details[key] = JSON.stringify(redacted).slice(0, 512);
  }
  return { schema: "uai.audit.v1", eventId: input.eventId, occurredAt: input.occurredAt, decision: input.decision, adapterId: input.adapterId, uaiSessionId: input.uaiSessionId, evidenceUri: input.evidenceUri, details };
}

export async function atomicWriteJson(path: string, value: unknown, options: { injectFailureBeforeRename?: boolean } = {}): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  JSON.parse(bytes.toString("utf8"));
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.uai-json`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    if (options.injectFailureBeforeRename) throw new Error("Injected atomic write interruption");
    await rename(temporary, path);
    JSON.parse(await readFile(path, "utf8"));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
