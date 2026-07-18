#!/usr/bin/env bun
/**
 * MemoryReviewer — single-pass autonomic reviewer for the typed-item memory system.
 *
 * LifeOS autonomic memory subsystem, F5.
 *
 * Reads the most recent harness session transcript, extracts the last N
 * user/assistant exchanges, calls Inference.ts (Sonnet, env-scrubbed,
 * subscription-billed) with a single reviewer prompt, parses the JSON output
 * as a flat list of typed items, and routes each item through
 * MemorySystem.add(). The MutationTier classifier inside add() enforces the
 * four-tier mutation boundary at write time.
 *
 * Invoked from hooks/MemoryReviewFire.hook.ts at Stop, when the trigger hook
 * has set pending_review=true (turn count ≥ 8 AND idle ≥ 2 min AND minutes
 * since last review ≥ 30).
 *
 * Single-pass design (revision 2): instead of separate deductive/inductive
 * phases, the model emits a flat list of typed items. The `type` field on each
 * item carries the structural distinction the old two-phase split previously
 * enforced. The reviewer prompt instructs the model to assign types correctly;
 * MemorySystem.add validates types against the registry; MutationTier ensures
 * the write lands at the right tier.
 *
 * CLI:
 *   bun MemoryReviewer.ts review --turns N           (default invocation)
 *   bun MemoryReviewer.ts review --input <path>      (review a specific transcript)
 *   bun MemoryReviewer.ts review --dry-run           (extract + prompt, no inference)
 *   bun MemoryReviewer.ts test                       (synthetic smoke test)
 *   bun MemoryReviewer.ts test --live                (real inference smoke — costs subscription)
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join as pathJoin, relative, resolve as pathResolve } from "node:path";

import { add as memoryAdd, type AddResult } from "./MemorySystem";
import { read as memoryWriterRead } from "./MemoryWriter";
import {
  isKnownType,
  PROPOSAL_KIND_TO_FILES,
  USER_ROOT as CANONICAL_USER_ROOT,
  type ProposalTargetKind,
  type TypedItem,
} from "./MemoryTypes";
import { inference } from "./Inference";
import { getPrincipalName, getDAName } from "../../hooks/lib/identity";
import {
  applyProposalEdit,
  markProposal,
  logProposalEvent,
} from "../PULSE/lib/telegram-proposals";
import { parseTranscriptLines, type Provenance } from "../UNIVERSAL/canonical";
import { resolveConfigRoot, resolveHome, resolveLifeosRoot } from "../UNIVERSAL/platform";

// ── Constants ──

const HOME = resolveHome();
const CLAUDE_ROOT = pathResolve(resolveConfigRoot(process.env, "claude"));
const LIFEOS_DIR = pathResolve(resolveLifeosRoot(process.env, "claude"));
const USER_ROOT = pathResolve(CANONICAL_USER_ROOT);
const HARNESS_PROJECTS_DIR = pathResolve(process.env.CLAUDE_PROJECTS_DIR ?? pathResolve(CLAUDE_ROOT, "projects"));
const OMP_SESSIONS_DIR = pathResolve(resolveConfigRoot(process.env, "omp"), "sessions");
const RUNS_LOG_PATH = pathResolve(LIFEOS_DIR, "MEMORY/OBSERVABILITY/reviewer-runs.jsonl");
const RUNS_DEBUG_DIR = pathResolve(LIFEOS_DIR, "MEMORY/OBSERVABILITY/reviewer-runs");
const REVIEW_CONFIG_PATH = pathResolve(USER_ROOT, "CONFIG/memory-review.json");

const DEFAULT_TURNS = 20;
// Curation is heavier than the old additive capture — the reviewer now reads
// the full current memory state plus recent conversation and returns a
// consolidated desired set. Give it a consolidation-tier time budget (120s)
// rather than the old capture-tier 60s. This is the two-tier latency split
// (Honcho: "waking capture" is cheap, "dreaming consolidation" is slow) made
// concrete without a second subprocess.
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.70;

function loadConfidenceThreshold(): number {
  // ISC-68 / ISC-157: high-confidence proposals auto-apply alongside enqueue.
  // Threshold lives in USER/CONFIG/memory-review.json. Falls back to 0.70.
  try {
    if (!existsSync(REVIEW_CONFIG_PATH)) return DEFAULT_CONFIDENCE_THRESHOLD;
    const raw = JSON.parse(readFileSync(REVIEW_CONFIG_PATH, "utf8")) as { confidence_threshold?: number };
    return typeof raw.confidence_threshold === "number" ? raw.confidence_threshold : DEFAULT_CONFIDENCE_THRESHOLD;
  } catch {
    return DEFAULT_CONFIDENCE_THRESHOLD;
  }
}

// ── Conversation extraction ──

export interface Exchange {
  user: string;
  assistant: string;
  ts: string;
  userProvenance: Provenance;
  assistantProvenance: Provenance;
  tainted: boolean;
}

export interface ExtractedExchanges extends Array<Exchange> {
  transcriptUri: string;
  malformedCount: number;
  warnings: string[];
  tainted: boolean;
}

/**
 * Find the most recently-modified session .jsonl across BOTH the Claude Code
 * harness project store (~/.claude/projects) and the OMP session store
 * (~/.omp/agent/sessions), so the reviewer works under either harness. Both use
 * the same 2-level <root>/<sessionDir>/*.jsonl layout and the same
 * message:{role,content} line shape. Returns null if no transcripts exist.
 */
function collectSessionJsonl(root: string, out: Array<{ path: string; mtime: number }>): void {
  if (!existsSync(root)) return;
  let sessionDirs: string[];
  try { sessionDirs = readdirSync(root); } catch { return; }
  for (const sub of sessionDirs) {
    const dir = pathJoin(root, sub);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = pathJoin(dir, file);
      try {
        out.push({ path: full, mtime: statSync(full).mtimeMs });
      } catch { /* skip unreadable */ }
    }
  }
}

function isPhysicalTranscriptUnder(transcriptPath: string, root: string): boolean {
  const absolutePath = pathResolve(transcriptPath);
  const absoluteRoot = pathResolve(root);
  const delta = relative(absoluteRoot, absolutePath);
  if (!delta || delta.startsWith("..") || isAbsolute(delta)) return false;
  try {
    const rootMetadata = lstatSync(absoluteRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return false;
    let cursor = absolutePath;
    while (cursor !== absoluteRoot) {
      const metadata = lstatSync(cursor);
      if (metadata.isSymbolicLink()) return false;
      cursor = dirname(cursor);
    }
    return lstatSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

export function transcriptProvenance(transcriptPath: string): "trusted" | "tainted" | "unknown" {
  if (!existsSync(transcriptPath)) return "unknown";
  return isPhysicalTranscriptUnder(transcriptPath, HARNESS_PROJECTS_DIR)
    || isPhysicalTranscriptUnder(transcriptPath, OMP_SESSIONS_DIR)
    ? "trusted"
    : "tainted";
}

function findMostRecentTranscript(): string | null {
  const candidates: Array<{ path: string; mtime: number }> = [];
  collectSessionJsonl(HARNESS_PROJECTS_DIR, candidates);
  collectSessionJsonl(OMP_SESSIONS_DIR, candidates);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path ?? null;
}

/**
 * Parse a harness session JSONL and return the last N user/assistant exchanges.
 * Each line in the transcript is one event; we collapse to user→assistant pairs.
 * Tool-use blocks and system messages are filtered out — the reviewer only
 * needs the conversational surface.
 */
export function extractRecentExchanges(transcriptPath: string, maxExchanges: number): ExtractedExchanges {
  const empty = Object.assign([] as Exchange[], {
    transcriptUri: transcriptPath,
    malformedCount: 0,
    warnings: [] as string[],
    tainted: false,
  }) as ExtractedExchanges;
  const pathProvenance = transcriptProvenance(transcriptPath);
  if (pathProvenance !== "trusted") {
    return Object.assign(empty, { tainted: pathProvenance === "tainted" }) as ExtractedExchanges;
  }
  const lines = readFileSync(transcriptPath, "utf8").split("\n");
  const adapterId = pathResolve(transcriptPath).startsWith(pathResolve(OMP_SESSIONS_DIR))
    ? "omp"
    : "claude";
  const parsed = parseTranscriptLines(adapterId, lines, transcriptPath, "memory-reviewer.v1");
  const textContent = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null && !Array.isArray(block))
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text))
      .join("\n")
      .trim();
  };
  const events = parsed.entries
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .map((entry) => ({
      role: entry.role,
      text: textContent(entry.content),
      provenance: entry.provenance,
    }))
    .filter((entry) => entry.text.length > 0);

  const MAX_MSG_CHARS = 2000;
  const cap = (value: string): string =>
    value.length > MAX_MSG_CHARS ? `${value.slice(0, MAX_MSG_CHARS)} …[truncated]` : value;
  const exchanges: Exchange[] = [];
  for (let i = 0; i < events.length; i++) {
    const current = events[i];
    const next = events[i + 1];
    if (current?.role === "user" && next?.role === "assistant") {
      const tainted = current.provenance.tainted === true || next.provenance.tainted === true;
      exchanges.push({
        user: cap(current.text),
        assistant: cap(next.text),
        ts: `${current.provenance.transcriptUri}#L${current.provenance.sourceLine}`,
        userProvenance: current.provenance,
        assistantProvenance: next.provenance,
        tainted,
      });
      i++;
    }
  }
  const result = exchanges.slice(-maxExchanges);
  return Object.assign(result, {
    transcriptUri: transcriptPath,
    malformedCount: parsed.malformedCount,
    warnings: parsed.warnings,
    tainted: parsed.malformedCount > 0 || result.some((exchange) => exchange.tainted),
  }) as ExtractedExchanges;
}

// ── Reviewer prompt ──

export function reviewerProposalTargets(): Readonly<Record<ProposalTargetKind, readonly string[]>> {
  return PROPOSAL_KIND_TO_FILES;
}

function proposalTargetText(kind: ProposalTargetKind): string {
  return PROPOSAL_KIND_TO_FILES[kind].join(" OR ");
}

const REVIEWER_SYSTEM_PROMPT = `You are {{DA_NAME}}'s Memory Reviewer — a background process that reads recent conversation between {{PRINCIPAL_NAME}} and {{DA_NAME}}, and extracts durable signal as a flat list of typed items.

Your job is NOT to summarize the conversation. It is to extract items the system should remember going forward.

There are four item types. Output EXACTLY this JSON shape:

{
  "items": [
    {"type": "memory", "actor": "principal" | "assistant", "op": "set", "entries": ["PREFIX: durable fact ~provenance", "..."]},
    {"type": "idea", "title": "short title", "content": "the idea body", "confidence": 0.0-1.0, "related": [{"slug": "...", "type": "..."}]},
    {"type": "knowledge", "entity_type": "person" | "company" | "research", "name": "...", "content": "...", "confidence": 0.0-1.0, "related": [{"slug": "...", "type": "..."}]},
    {"type": "proposal", "target_kind": "identity" | "style" | "definition" | "canonical-content" | "resume" | "operational-rule" | "projects" | "contacts", "target_file": "absolute path", "edit": "the proposed addition", "confidence": 0.0-1.0, "rationale": "why this"}
  ]
}

TYPE GUIDANCE:

- memory — durable facts about {{PRINCIPAL_NAME}} ("principal") or about {{DA_NAME}} ("assistant"), stored in a small hot-layer file loaded into EVERY turn. This is CURATION, not appending. You are handed the file's CURRENT entries (see the user message). You return, via op:"set", the FULL desired list for that file — the next state you want. The system REPLACES the file with your list. Whatever you omit is forgotten. This is how memory stays alive: you add, you merge, you supersede, you drop.

  MEMORY CURATION RULES:
  - Emit ONE memory item per actor you want to change, with op:"set" and the complete entries array. Don't emit an item for an actor whose file needs no change.
  - Each entry keeps a prefix: NAME: / ROLE: / RELATION: / PREFERENCE: / RULE: — followed by the fact, then a provenance tag: ~explicit ({{PRINCIPAL_NAME}} stated it), ~deduced (logical inference from what he stated), or ~inferred (a pattern you noticed). Untagged is read as ~explicit. Example: "PREFERENCE: prefers terse direct responses ~explicit".
  - DECLARATIVE FACTS, NOT DIRECTIVES. Write "PREFERENCE: prefers terse responses ~explicit", NOT "RULE: Always be terse" — a directive gets re-read later as a command. State what is true, not what to do (RULE: is for genuine standing rules {{PRINCIPAL_NAME}} set, phrased as facts about his rules).
  - SUPERSEDE, don't stack. If a new fact contradicts an existing entry ("works at A" → "works at B"), DROP the old entry and write the new one. Never keep both.
  - MERGE duplicates. Three entries saying the same thing collapse to one.
  - CAP: 48 entries × 256 chars per file. When the current list is ≥39 entries (≥80% full), CONSOLIDATE FIRST — merge related entries and drop the least useful/most stale — BEFORE adding anything new. Your returned list MUST be ≤48 or the write is rejected.
  - Keep the entries that still reduce future steering; drop the ones that have gone stale.
- idea — a captured insight or thought. Has a short title and body. Lives in the knowledge graph as an idea note.
- knowledge — an entity note about a person, company, or research artifact mentioned in the conversation. Carries an entity_type and name. SHOULD include at least one related: link if you can name another entity it relates to. The 8 valid related types are: supports, contradicts, extends, part-of, instance-of, caused-by, preceded-by, related.
- proposal — a proposed edit to a curated context file. ALWAYS specify both target_kind AND target_file. See PROPOSAL SUBTYPES below. Only emit when you've seen strong evidence (across multiple turns or cross-session) of a durable signal. Low confidence triggers Telegram surfacing for principal approval; high confidence (≥0.70) triggers direct silent application.

PROPOSAL SUBTYPES (target_kind → target_file → what to emit):

- identity → ${proposalTargetText("identity")}
  Emit when: {{PRINCIPAL_NAME}} reveals a durable identity-level fact about himself or about how he wants {{DA_NAME}} to operate.
  Example: {"type":"proposal","target_kind":"identity","target_file":"<absolute path to PRINCIPAL_IDENTITY.md>","edit":"RULE: Always confirm before deploying to production","confidence":0.85,"rationale":"observed across N turns; principal explicitly asked for confirmation gate"}.

- style → ${proposalTargetText("style")}
  Emit when: {{PRINCIPAL_NAME}} corrects voice/tone/cadence/word choice in a way that generalizes beyond the moment. Banned vocabulary, preferred constructions, rhythmic preferences.
  Example: edit="BAN: 'underscores' — replace with 'shows' or 'proves'".

- definition → ${proposalTargetText("definition")}
  Emit when: {{PRINCIPAL_NAME}} defines a term (his coined concept, a principle's exact meaning, an acronym he uses) that future {{DA_NAME}} will need to interpret correctly.
  Example: edit="**Human 3.0** — humans transitioning from corporate (2.0) to creative self-expression (3.0) via AI-enabled augmentation".

- canonical-content → ${proposalTargetText("canonical-content")}
  Emit when: {{PRINCIPAL_NAME}} names a piece of content (post, talk, framework) as canonical / pillar / essential to his published body of work.
  Example: edit="- SPQA framework (2024 blog) — canonical reference for the four-stage AI architecture pattern".

- resume → ${proposalTargetText("resume")}
  Emit when: {{PRINCIPAL_NAME}} mentions a career fact (new role, certification, achievement, year of service) that should land in the resume.
  Example: edit="- Speaking: B-Sides SF 2026 keynote on Human 3.0".

- operational-rule → ${proposalTargetText("operational-rule")}
  Emit when: {{PRINCIPAL_NAME}} states an operating directive about HOW {{DA_NAME}}/PAI should handle a class of work — tooling preference, deployment ritual, repo convention, environment-specific behavior.
  Example: edit="**Ship-it directive** — when {{PRINCIPAL_NAME}} says 'ship it' on a Cloudflare repo, deploy AND push to main in one atomic operation".

- projects → ${proposalTargetText("projects")}
  Emit when: {{PRINCIPAL_NAME}} names a new project (repo, app, service, side build) that should be in the project routing table. Propose the row, not the body content.
  Example: edit="| **NewProject** | \`~/Projects/NewProject\` | newproject.com | bun run deploy | TS, CF Workers |".

- contacts → ${proposalTargetText("contacts")}
  Emit when: {{PRINCIPAL_NAME}} mentions a person 3+ times with enough context (role, relationship, why they matter) to add to the contacts file.

DO SAVE:
- Durable preferences ("{{PRINCIPAL_NAME}} prefers X")
- Durable rules ("Always confirm before deploying")
- Names + roles + relationships of important people the conversation mentioned
- Ideas {{PRINCIPAL_NAME}} articulated that have lasting value
- Knowledge about entities (people, companies, research) {{PRINCIPAL_NAME}} referenced
- Definitions, style corrections, operational rules, new projects, new contacts (use the matching proposal subtype)

DO NOT SAVE:
- Session-specific transients ("we just did X")
- Environment-dependent failures ("the test failed because of Y")
- One-off task narratives ("then we ran A and got B")
- Negative tool claims ("X tool isn't installed")
- Task progress, TODO state, completed-work logs
- Commit SHAs, PR/issue numbers, branch names
- Anything that will be stale in 7 days
- Anything you'd describe as "what happened in this conversation"

CONFIDENCE GUIDANCE (proposals):
- 0.90+ — {{PRINCIPAL_NAME}} explicitly stated the rule/definition/preference verbatim, with clear durability intent. Will auto-apply.
- 0.70-0.89 — Strong inference from multiple consistent signals. Will auto-apply.
- 0.40-0.69 — Plausible but worth confirming. Telegram surfacing.
- <0.40 — Speculation. Don't emit unless cross-session pattern is clear; if you do, expect surfacing.

OUTPUT RULES:
- Emit ONLY the JSON object above. No commentary, no markdown, no code fences.
- If nothing is worth saving, emit {"items": []}.
- Each item's content must be self-contained — readable by a future {{DA_NAME}} with no access to this conversation.
- Confidence reflects your certainty in the durability of the item, not the literalness of what was said.
- For proposals: ALWAYS include both target_kind and target_file. If you can't choose a subtype, the proposal probably shouldn't be emitted.

A confident "nothing to save" is correct.`;

export interface CurrentMemorySnapshot {
  principal: string[];
  assistant: string[];
}

const PRINCIPAL_MEMORY_PATH = pathResolve(USER_ROOT, "PRINCIPAL/PRINCIPAL_MEMORY.md");
const DA_MEMORY_PATH = pathResolve(USER_ROOT, "DIGITAL_ASSISTANT/DA_MEMORY.md");

/** Read both hot-layer files' current entries so the reviewer curates against reality. */
export function readCurrentMemorySnapshot(): CurrentMemorySnapshot {
  const readEntries = (path: string): string[] => {
    const r = memoryWriterRead(path);
    return "code" in r ? [] : r.entries;
  };
  return { principal: readEntries(PRINCIPAL_MEMORY_PATH), assistant: readEntries(DA_MEMORY_PATH) };
}

function renderCurrentMemory(snap: CurrentMemorySnapshot | undefined): string[] {
  if (!snap) return [];
  const fmt = (actor: string, entries: string[]) => {
    const head = `CURRENT ${actor} MEMORY [${entries.length}/48 entries${entries.length >= 39 ? " — ≥80% FULL, CONSOLIDATE BEFORE ADDING" : ""}]:`;
    if (entries.length === 0) return [head, "(empty)", ""];
    return [head, ...entries.map((e) => `  ${e}`), ""];
  };
  return [
    "── CURRENT MEMORY STATE (curate this — your op:\"set\" REPLACES it) ──",
    "",
    ...fmt("PRINCIPAL", snap.principal),
    ...fmt("ASSISTANT", snap.assistant),
  ];
}

export function buildReviewerUserPrompt(exchanges: Exchange[], currentMemory?: CurrentMemorySnapshot): string {
  const lines = [
    ...renderCurrentMemory(currentMemory),
    `Recent conversation between {{PRINCIPAL_NAME}} and {{DA_NAME}} (last ${exchanges.length} exchanges):`,
    "",
  ];
  for (let i = 0; i < exchanges.length; i++) {
    const ex = exchanges[i];
    lines.push(`--- Exchange ${i + 1} (${ex.ts})${ex.tainted ? " [TAINTED]" : ""} ---`);
    lines.push(`Provenance: user=${ex.userProvenance.transcriptUri}#L${ex.userProvenance.sourceLine}; assistant=${ex.assistantProvenance.transcriptUri}#L${ex.assistantProvenance.sourceLine}`);
    lines.push(`{{PRINCIPAL_NAME}}: ${ex.user}`);
    lines.push("");
    lines.push(`{{DA_NAME}}: ${ex.assistant}`);
    lines.push("");
  }
  lines.push("Curate memory (return the full desired list per file you change via op:\"set\") and extract any idea/knowledge/proposal items. Return JSON only.");
  return lines.join("\n");
}

/**
 * Resolve {{PRINCIPAL_NAME}} / {{DA_NAME}} placeholders to the installed identity.
 *
 * The release scrubber (ShadowRelease's identity map) rewrites the author's names
 * to these placeholders in every shipped file, so a fresh install's reviewer
 * prompts arrive full of literal `{{…}}` braces that nothing substituted — the
 * model was handed raw placeholders. Substitute them at prompt-build time from the
 * canonical loader (PRINCIPAL_IDENTITY.md core.name / settings.json daidentity.name),
 * guarding against empty or still-braced values with a neutral fallback so an
 * un-interviewed install never leaks a placeholder into the prompt. No-op in the
 * live tree, where the prompt carries real names and no placeholders.
 */
export function renderNames(text: string): string {
  const safe = (fn: () => string, fallback: string): string => {
    try {
      const n = (fn() || "").trim();
      return n.length > 0 && !n.includes("{{") && !n.includes("}}") ? n : fallback;
    } catch {
      return fallback;
    }
  };
  const principal = safe(getPrincipalName, "the principal");
  const assistant = safe(getDAName, "the assistant");
  return text
    .replace(/\{\{\s*PRINCIPAL_NAME\s*\}\}/g, principal)
    .replace(/\{\{\s*DA_NAME\s*\}\}/g, assistant);
}

// ── Output parsing ──

export interface ReviewerOutput {
  items: TypedItem[];
}

/**
 * Parse the inference output as a {items:[...]} JSON envelope. Tolerant of
 * leading/trailing whitespace and stray markdown code fences (some models
 * wrap JSON in ```json…``` despite explicit instructions). Returns parsed
 * items array; on unparseable input returns empty list (logged as malformed).
 */
export function parseReviewerOutput(text: string): { ok: true; output: ReviewerOutput } | { ok: false; error: string; raw: string } {
  const trimmed = text.trim();

  // Strip markdown code fence if present
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  const candidate = fenced ? fenced[1] : trimmed;

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch (e: any) {
    return { ok: false, error: `JSON parse failed: ${e?.message}`, raw: candidate.slice(0, 500) };
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
    return { ok: false, error: `Expected {items:[...]}, got: ${typeof parsed}`, raw: JSON.stringify(parsed).slice(0, 500) };
  }

  // Filter to items with a known type — silently drop unknown-type items
  // (they would be rejected by MemorySystem.add anyway, but doing it here
  // gives us cleaner logging)
  const validItems = parsed.items.filter((it: any) => it && typeof it === "object" && isKnownType(it?.type));

  return { ok: true, output: { items: validItems as TypedItem[] } };
}

// ── Dispatch ──

export interface DispatchSummary {
  total: number;
  by_type: Record<string, number>;
  succeeded: number;
  failed: number;
  failures: Array<{ index: number; type: string; error: string }>;
  proposals_auto_applied: number;
  proposals_auto_apply_failed: number;
}

export interface DispatchOptions {
  dryRun?: boolean;
  confidenceThreshold?: number;
  provenance?: "trusted" | "tainted" | "unknown";
}

export function reviewerProvenance(
  exchanges: Pick<ExtractedExchanges, "length" | "malformedCount" | "tainted">,
): "trusted" | "tainted" | "unknown" {
  if (exchanges.tainted || exchanges.malformedCount > 0) return "tainted";
  return exchanges.length > 0 ? "trusted" : "unknown";
}

export function dispatchItems(items: TypedItem[], opts: DispatchOptions = {}): { summary: DispatchSummary; results: AddResult[] } {
  const summary: DispatchSummary = {
    total: items.length,
    by_type: {},
    succeeded: 0,
    failed: 0,
    failures: [],
    proposals_auto_applied: 0,
    proposals_auto_apply_failed: 0,
  };
  const results: AddResult[] = [];
  const threshold = opts.confidenceThreshold ?? loadConfidenceThreshold();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    summary.by_type[item.type] = (summary.by_type[item.type] || 0) + 1;
    if (opts.dryRun) {
      results.push({ ok: true, type: item.type, path: "(dry-run)", detail: { dry: true } } as AddResult);
      summary.succeeded++;
      continue;
    }

    const result = memoryAdd(item);
    results.push(result);
    if (!result.ok) {
      summary.failed++;
      summary.failures.push({ index: i, type: item.type, error: `${result.code}: ${result.message}` });
      continue;
    }
    summary.succeeded++;

    if (item.type === "proposal" && opts.provenance === "trusted" && typeof item.confidence === "number" && item.confidence >= threshold) {
      const proposalId = (result.detail?.id as string | undefined) ?? null;
      const applied = applyProposalEdit(item.target_file, item.edit, item.target_kind);
      if (applied.ok && proposalId) {
        markProposal(proposalId, {
          status: "auto-applied",
          resolved_at: new Date().toISOString(),
          applied_edit: item.edit,
        });
        logProposalEvent({
          id: proposalId,
          file: item.target_file,
          edit: item.edit,
          confidence: item.confidence,
          status: "auto-applied",
          threshold,
        });
        summary.proposals_auto_applied++;
      } else {
        logProposalEvent({
          id: proposalId,
          file: item.target_file,
          edit: item.edit,
          confidence: item.confidence,
          status: "auto-apply-failed",
          reason: applied.ok ? "missing-id" : applied.reason,
          threshold,
        });
        summary.proposals_auto_apply_failed++;
      }
    }
  }

  return { summary, results };
}

// ── Observability ──

function tsSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function logRunSummary(row: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(RUNS_LOG_PATH), { recursive: true });
    appendFileSync(RUNS_LOG_PATH, JSON.stringify(row) + "\n", "utf8");
  } catch { /* best-effort */ }
}

function writeRunDebug(runId: string, files: Record<string, string>): void {
  try {
    const dir = pathJoin(RUNS_DEBUG_DIR, runId);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(pathJoin(dir, name), content, "utf8");
    }
  } catch { /* best-effort */ }
}

// ── Orchestrator ──

export interface ReviewOptions {
  turns?: number;
  input?: string;
  dryRun?: boolean;
  /** For testing: bypass real inference, return this canned response */
  mockInferenceResponse?: string;
  timeoutMs?: number;
}

export interface ReviewResult {
  ok: boolean;
  runId: string;
  malformed_transcript_rows?: number;
  transcript_warnings?: string[];
  transcript_tainted?: boolean;
  transcript: string | null;
  exchanges: number;
  inference_duration_ms: number;
  parse_ok: boolean;
  dispatch_summary?: DispatchSummary;
  error?: string;
}

export async function review(opts: ReviewOptions = {}): Promise<ReviewResult> {
  const runId = tsSlug();
  const turns = opts.turns ?? DEFAULT_TURNS;

  // 1. Locate transcript
  const transcript = opts.input ?? findMostRecentTranscript();
  if (!transcript) {
    const result: ReviewResult = { ok: false, runId, transcript: null, exchanges: 0, inference_duration_ms: 0, parse_ok: false, error: "no transcript available" };
    logRunSummary({ ts: new Date().toISOString(), ...result });
    return result;
  }

  // 2. Extract exchanges
  const exchanges = extractRecentExchanges(transcript, turns);
  if (exchanges.length === 0) {
    const result: ReviewResult = {
      ok: false,
      runId,
      transcript,
      exchanges: 0,
      malformed_transcript_rows: exchanges.malformedCount,
      transcript_warnings: exchanges.warnings,
      transcript_tainted: exchanges.tainted,
      inference_duration_ms: 0,
      parse_ok: false,
      error: "no exchanges extracted",
    };
    logRunSummary({ ts: new Date().toISOString(), ...result });
    return result;
  }

  const snapshot = readCurrentMemorySnapshot();
  const systemPrompt = renderNames(REVIEWER_SYSTEM_PROMPT);
  const userPrompt = renderNames(buildReviewerUserPrompt(exchanges, snapshot));
  writeRunDebug(runId, {
    "prompt.system.md": systemPrompt,
    "prompt.user.md": userPrompt,
    "transcript.txt": [
      `Source: ${exchanges.transcriptUri}`,
      `Exchanges: ${exchanges.length}`,
      `Malformed: ${exchanges.malformedCount}`,
      `Tainted: ${exchanges.tainted}`,
      ...exchanges.warnings,
      "",
    ].join("\n"),
  });

  let inferenceOutput: string;
  let inferenceDuration: number;
  if (opts.mockInferenceResponse !== undefined) {
    inferenceOutput = opts.mockInferenceResponse;
    inferenceDuration = 0;
  } else {
    const startedAt = Date.now();
    const inferenceResult = await inference({
      systemPrompt,
      userPrompt,
      level: "medium",
      expectJson: false,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    inferenceDuration = Date.now() - startedAt;
    if (!inferenceResult.success) {
      const failed: ReviewResult = {
        ok: false,
        runId,
        transcript,
        exchanges: exchanges.length,
        malformed_transcript_rows: exchanges.malformedCount,
        transcript_warnings: exchanges.warnings,
        transcript_tainted: exchanges.tainted,
        inference_duration_ms: inferenceDuration,
        parse_ok: false,
        error: `inference failed: ${inferenceResult.error}`,
      };
      logRunSummary({ ts: new Date().toISOString(), ...failed });
      return failed;
    }
    inferenceOutput = inferenceResult.output;
  }
  writeRunDebug(runId, { "response.raw.txt": inferenceOutput });

  const parsed = parseReviewerOutput(inferenceOutput);
  if (!parsed.ok) {
    writeRunDebug(runId, { "parse-error.txt": `${parsed.error}\n\nRaw:\n${parsed.raw}` });
    const failed: ReviewResult = {
      ok: false,
      runId,
      transcript,
      exchanges: exchanges.length,
      malformed_transcript_rows: exchanges.malformedCount,
      transcript_warnings: exchanges.warnings,
      transcript_tainted: exchanges.tainted,
      inference_duration_ms: inferenceDuration,
      parse_ok: false,
      error: `parse failed: ${parsed.error}`,
    };
    logRunSummary({ ts: new Date().toISOString(), ...failed });
    return failed;
  }
  writeRunDebug(runId, { "response.parsed.json": JSON.stringify(parsed.output, null, 2) });

  const { summary, results } = dispatchItems(parsed.output.items, {
    dryRun: opts.dryRun,
    provenance: reviewerProvenance(exchanges),
  });
  writeRunDebug(runId, {
    "dispatch.log": [
      `Items: ${summary.total} (succeeded=${summary.succeeded} failed=${summary.failed})`,
      `By type: ${JSON.stringify(summary.by_type)}`,
      ...summary.failures.map((failure) => `  FAIL [${failure.index}] ${failure.type}: ${failure.error}`),
      "",
      "Per-item results:",
      ...results.map((dispatchResult, index) => `[${index}] ${dispatchResult.ok ? `OK ${dispatchResult.type}` : `FAIL ${dispatchResult.code}`}: ${dispatchResult.ok ? dispatchResult.path?.replace(CLAUDE_ROOT, "~/.claude") : dispatchResult.message}`),
    ].join("\n"),
  });

  const result: ReviewResult = {
    ok: summary.failed === 0,
    runId,
    transcript,
    exchanges: exchanges.length,
    malformed_transcript_rows: exchanges.malformedCount,
    transcript_warnings: exchanges.warnings,
    transcript_tainted: exchanges.tainted,
    inference_duration_ms: inferenceDuration,
    parse_ok: true,
    dispatch_summary: summary,
    ...(summary.failed > 0 ? { error: `${summary.failed} item(s) failed dispatch` } : {}),
  };
  logRunSummary({ ts: new Date().toISOString(), ...result });
  return result;
}

// ── CLI ──

function parseArg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function smokeTest(): Promise<number> {
  console.log("MemoryReviewer smoke test starting…");
  let pass = 0, fail = 0;
  const check = (name: string, ok: boolean, detail?: string) => {
    if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
    else    { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
  };

  // 1. Output parsing — clean JSON
  const p1 = parseReviewerOutput('{"items":[{"type":"memory","actor":"principal","content":"PREFERENCE: terse"}]}');
  check("parse: clean JSON envelope", p1.ok && p1.output.items.length === 1);

  // 2. Output parsing — markdown-fenced JSON
  const p2 = parseReviewerOutput('```json\n{"items":[]}\n```');
  check("parse: markdown-fenced JSON", p2.ok && p2.output.items.length === 0);

  // 3. Output parsing — empty items list
  const p3 = parseReviewerOutput('{"items":[]}');
  check("parse: nothing-to-save", p3.ok && p3.output.items.length === 0);

  // 4. Output parsing — unknown types filtered
  const p4 = parseReviewerOutput('{"items":[{"type":"memory","actor":"principal","content":"X"},{"type":"nonsense","content":"Y"}]}');
  check("parse: unknown-type items dropped", p4.ok && p4.output.items.length === 1 && p4.output.items[0].type === "memory");

  // 5. Output parsing — malformed JSON
  const p5 = parseReviewerOutput('not json at all');
  check("parse: malformed JSON rejected", !p5.ok);

  // 6. Dispatch — dry-run
  const dryItems: TypedItem[] = [
    { type: "memory", actor: "principal", content: "PREFERENCE: smoke dry-run" },
    { type: "idea", title: "Smoke Dry Idea", content: "..." },
  ];
  const { summary: drySum } = dispatchItems(dryItems, { dryRun: true });
  check("dispatch: dry-run skips real writes", drySum.succeeded === 2 && drySum.failed === 0);
  check("dispatch: by-type tally correct", drySum.by_type.memory === 1 && drySum.by_type.idea === 1);

  // 7. End-to-end with mocked inference — full pipeline
  const mockResponse = JSON.stringify({
    items: [
      { type: "memory", actor: "principal", content: "PREFERENCE: smoke E2E mock" },
      { type: "proposal", target_kind: "identity", target_file: PROPOSAL_KIND_TO_FILES.identity[0], edit: "RULE: E2E mock", confidence: 0.5, rationale: "smoke" },
    ],
  });

  // Use a synthetic transcript so we don't depend on real harness state
  const synthDir = pathJoin(CLAUDE_ROOT, "LIFEOS/MEMORY/OBSERVABILITY/reviewer-test-synth");
  mkdirSync(synthDir, { recursive: true });
  const synthPath = pathJoin(synthDir, "synth.jsonl");
  writeFileSync(synthPath, [
    JSON.stringify({ timestamp: "2026-05-23T22:30:00Z", message: { role: "user", content: "Hey {{DA_NAME}}" } }),
    JSON.stringify({ timestamp: "2026-05-23T22:30:05Z", message: { role: "assistant", content: [{ type: "text", text: "Hey {{PRINCIPAL_NAME}}" }] } }),
  ].join("\n"), "utf8");

  const r = await review({
    input: synthPath,
    turns: 5,
    mockInferenceResponse: mockResponse,
  });
  check("E2E: review() returns ok", r.ok, `runId=${r.runId}, exchanges=${r.exchanges}`);
  check("E2E: dispatch ran", r.dispatch_summary !== undefined && r.dispatch_summary.total === 2);
  check("E2E: memory write succeeded", r.dispatch_summary?.by_type.memory === 1);
  check("E2E: proposal enqueue succeeded", r.dispatch_summary?.by_type.proposal === 1);
  check("E2E: zero dispatch failures", r.dispatch_summary?.failed === 0);

  // Cleanup synth transcript + reviewer-runs debug dir for this run
  try {
    const { rmSync } = await import("node:fs");
    rmSync(synthDir, { recursive: true, force: true });
    rmSync(pathJoin(RUNS_DEBUG_DIR, r.runId), { recursive: true, force: true });
  } catch { /* ignore */ }

  // Cleanup synthetic memory entry
  try {
    const { read: mwRead, setEntries: mwSet } = await import("./MemoryWriter");
    const principalMemoryPath = pathJoin(USER_ROOT, "PRINCIPAL", "PRINCIPAL_MEMORY.md");
    const cur = mwRead(principalMemoryPath);
    if (!("code" in cur)) {
      const cleaned = cur.entries.filter((e) => !e.includes("smoke E2E mock"));
      mwSet(principalMemoryPath, cleaned, { updatedBy: "smoke-test-cleanup" });
    }
  } catch { /* ignore */ }

  // 8. Real harness transcript — extract some exchanges (read-only probe)
  const realTranscript = findMostRecentTranscript();
  if (realTranscript) {
    const real = extractRecentExchanges(realTranscript, 3);
    check("extract: real harness transcript yields exchanges", real.length > 0, `last 3 of ${realTranscript.split("/").pop()}: ${real.length} exchanges`);
  } else {
    check("extract: harness directory accessible", false, "no transcript found (test environment)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("✓ MemoryReviewer smoke test PASSED");
    return 0;
  }
  console.error("✗ MemoryReviewer smoke test FAILED");
  return 1;
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === "test") {
    process.exit(await smokeTest());
  }

  if (cmd === "review") {
    const turnsArg = parseArg("--turns");
    const turns = turnsArg ? parseInt(turnsArg, 10) : DEFAULT_TURNS;
    const input = parseArg("--input");
    const dryRun = hasFlag("--dry-run");

    const result = await review({ turns, input, dryRun });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  console.error("Usage: bun MemoryReviewer.ts {test|review [--turns N] [--input <path>] [--dry-run]}");
  process.exit(2);
}

if (import.meta.main) {
  main();
}
