/**
 * telegram-proposals — pure helpers for the F7 proposal-surfacing pipeline.
 *
 * Extracted from LIFEOS/PULSE/modules/telegram.ts so the parser, formatter, queue
 * I/O, and tier-C edit application can be unit-tested without spinning up a
 * grammY bot. The Telegram module imports these and adds only the I/O glue
 * (bot.api.sendMessage, queue draining on the message handler).
 *
 * Spec: ISA MEMORY/WORK/20260522-223538_pai-hermes-parity-memory/ISA.md
 *       F7 (ISC-82..95). ISC-85/86 superseded by the 2026-05-23 decision to
 *       route all proposals through Telegram (no silent direct-apply yet).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  PENDING_PROPOSALS_PATH,
  USER_ROOT,
  inferProposalKind,
  type ProposalTargetKind,
} from "../../TOOLS/MemoryTypes";
import { validateProposalTargetBinding } from "../../TOOLS/MemorySystem";
import { resolveLifeosRoot } from "../../UNIVERSAL/platform";

const OBS_DIR = join(resolveLifeosRoot(process.env, "claude"), "MEMORY", "OBSERVABILITY");
const PROPOSAL_REPLIES_LOG_PATH = join(OBS_DIR, "proposal-replies.jsonl");
const IDENTITY_PROPOSALS_LOG_PATH = join(OBS_DIR, "identity-proposals.jsonl");

export interface ProposalRow {
  id: string;
  ts: string;
  /**
   * Lifecycle states:
   *   pending       — fresh from MemorySystem.add, awaiting surface or auto-apply
   *   sent          — surfaced to Telegram; awaiting reply
   *   accepted      — principal replied `yes`, edit applied
   *   rejected      — principal replied `no`
   *   edited        — principal replied `edit <text>`, alternate text applied
   *   auto-applied  — confidence ≥ threshold; reviewer applied without surfacing
   */
  status: "pending" | "sent" | "accepted" | "rejected" | "edited" | "auto-applied";
  target_file: string;
  /**
   * P1 2026-05-25: proposal subtype discriminator. Tells the surfacer which
   * label to render and the auditor which curated-context file class this
   * proposal touches. Backwards-compatible — absent rows infer kind from
   * target_file via inferProposalKind().
   */
  target_kind?: ProposalTargetKind;
  edit: string;
  confidence: number;
  rationale: string;
  observed_across_sessions?: number;
  source_session?: string | null;
  surfaced_at?: string;
  resolved_at?: string;
  applied_edit?: string;
}

export type ProposalReply =
  | { kind: "yes"; id: string }
  | { kind: "no"; id: string }
  | { kind: "edit"; id: string; editText: string }
  | { kind: "list" }
  | { kind: null };

export function loadProposalQueue(path: string = PENDING_PROPOSALS_PATH): ProposalRow[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const rows: ProposalRow[] = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as Partial<ProposalRow>;
        if (row.id && row.target_file && row.edit && row.status) {
          rows.push(row as ProposalRow);
        }
      } catch {
        // skip malformed row
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function atomicWrite(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.uai-tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, body, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best effort */ }
    try { unlinkSync(temporary); } catch { /* only our temporary */ }
    throw error;
  }
}

export function writeProposalQueue(rows: ProposalRow[], path: string = PENDING_PROPOSALS_PATH): void {
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
  atomicWrite(path, body);
}

export function markProposal(id: string, patch: Partial<ProposalRow>, path: string = PENDING_PROPOSALS_PATH): ProposalRow | null {
  const rows = loadProposalQueue(path);
  let matched: ProposalRow | null = null;
  for (const r of rows) {
    if (r.id === id) {
      Object.assign(r, patch);
      matched = r;
      break;
    }
  }
  if (matched) writeProposalQueue(rows, path);
  return matched;
}

export function logProposalEvent(event: Record<string, unknown>, path: string = IDENTITY_PROPOSALS_LOG_PATH): void {
  try {
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch {
    // best-effort observability
  }
}

export function logProposalReply(event: Record<string, unknown>, path: string = PROPOSAL_REPLIES_LOG_PATH): void {
  try {
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch {
    // best-effort observability
  }
}

export function formatProposalMessage(p: ProposalRow, userRoot: string = USER_ROOT): string {
  const relativeTarget = relative(userRoot, p.target_file);
  const fileLabel = relativeTarget && !relativeTarget.startsWith("..") && !isAbsolute(relativeTarget)
    ? relativeTarget.replaceAll("\\", "/")
    : "unrecognized proposal target";
  const conf = p.confidence.toFixed(2);
  const obs = p.observed_across_sessions ?? 1;
  // P1 2026-05-25: prepend subtype badge so the principal sees at a glance
  // which curated-context class is being touched. Falls back to inference
  // when the row predates target_kind.
  const kind: ProposalTargetKind | "unknown" = p.target_kind ?? inferProposalKind(p.target_file) ?? "unknown";
  return [
    `🆔 [${kind}] Propose adding to ${fileLabel}:`,
    `"${p.edit}"`,
    `— confidence ${conf}, observed across ${obs} session${obs === 1 ? "" : "s"}.`,
    `Reply: yes #${p.id} / no #${p.id} / edit #${p.id} <text>`,
  ].join("\n");
}

export function parseProposalReply(text: string): ProposalReply {
  const trimmed = text.trim();
  if (/^proposals?$/i.test(trimmed)) return { kind: "list" };
  const m = trimmed.match(/^(yes|no|edit)\s*#?([\w-]+)(?:\s+(.+))?$/i);
  if (!m) {
    const m2 = trimmed.match(/^#([\w-]+)\s+(yes|no|edit)(?:\s+(.+))?$/i);
    if (!m2) return { kind: null };
    const kind = m2[2]!.toLowerCase() as "yes" | "no" | "edit";
    const id = m2[1]!;
    if (kind === "edit") return { kind, id, editText: (m2[3] ?? "").trim() };
    return { kind, id };
  }
  const kind = m[1]!.toLowerCase() as "yes" | "no" | "edit";
  const id = m[2]!;
  if (kind === "edit") return { kind, id, editText: (m[3] ?? "").trim() };
  return { kind, id };
}

export function applyProposalEdit(targetFile: string, editText: string, targetKind?: ProposalTargetKind): { ok: true } | { ok: false; reason: string } {
  const kind = targetKind ?? inferProposalKind(targetFile);
  const validation = validateProposalTargetBinding(targetFile, kind);
  if (!validation.ok) return { ok: false, reason: validation.message };
  if (!existsSync(targetFile)) return { ok: false, reason: `target file missing: ${targetFile}` };
  try {
    const current = readFileSync(targetFile, "utf8");
    const sectionHeader = "## Memory-System Proposals";
    const ts = new Date().toISOString();
    const entry = `\n- ${editText} <!-- applied: ${ts} -->`;
    let next: string;
    if (current.includes(sectionHeader)) {
      next = current.replace(sectionHeader, `${sectionHeader}\n${entry.trim()}`);
    } else {
      next = current.trimEnd() + `\n\n${sectionHeader}\n\n${entry.trim()}\n`;
    }
    atomicWrite(targetFile, next);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? String(e) };
  }
}
