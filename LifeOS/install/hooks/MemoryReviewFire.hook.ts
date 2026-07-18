#!/usr/bin/env bun
/**
 * @version 2.0.1
 * MemoryReviewFire — Stop hook that owns the WHOLE memory-review cadence.
 *
 * Consolidation (2026-07-11, thinking-system BPE strip): the old design split
 * the cadence across two hooks — MemoryReviewTrigger (per-prompt: tick counter,
 * idle detection, pending_review flag, debounce-cancel) and this one (consume
 * the flag at Stop). Firing at Stop is already the quiet moment the idle/
 * debounce machinery approximated, so the handshake was scaffolding. Now:
 *
 *   On every primary-session Stop:
 *     1. turn_count += 1, last_message_at = now
 *     2. If turn_count >= turn_threshold AND minutes since last_review >=
 *        min_minutes_between → spawn MemoryReviewer.ts detached, reset.
 *
 * State schema is unchanged (review-state.json) — the statusline 🧠 MEM line
 * reads it directly every second; pending_review stays false forever.
 * Cadence parameters: LIFEOS/USER/CONFIG/memory-review.json.
 *
 * Failure mode: any error logs to stderr and exits 0 (never block Stop).
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveDataRoot, resolveLifeosRoot } from "../LIFEOS/UNIVERSAL/platform";

const LIFEOS_DIR = resolveLifeosRoot(process.env, "claude");
const USER_ROOT = pathResolve(resolveDataRoot(process.env), "USER");
const STATE_PATH = pathResolve(LIFEOS_DIR, "MEMORY/OBSERVABILITY/review-state.json");
const CONFIG_PATH = pathResolve(USER_ROOT, "CONFIG/memory-review.json");
const FIRE_LOG_PATH = pathResolve(LIFEOS_DIR, "MEMORY/OBSERVABILITY/reviewer-fires.jsonl");
const REVIEWER_PATH = pathResolve(LIFEOS_DIR, "TOOLS/MemoryReviewer.ts");
const STATE_LOCK_PATH = `${STATE_PATH}.lock`;

interface ReviewAttempt {
  id: string;
  pid: number;
  started_at: string;
  turns_reviewed: number;
  transcript_path?: string;
}

interface ReviewState {
  turn_count_since_last_review: number;
  last_review_at: string | null;
  last_message_at: string | null;
  pending_review: boolean;
  schema_version: 1;
  review_attempt?: ReviewAttempt;
  sessions?: Record<string, Omit<ReviewState, "sessions">>;
}

const INITIAL_STATE: ReviewState = {
  turn_count_since_last_review: 0,
  last_review_at: null,
  last_message_at: null,
  pending_review: false,
  schema_version: 1,
};

interface HookInput {
  session_id?: string;
  uai_session_id?: string;
  native_session_id?: string;
  transcript_path?: string;
}

function readHookInput(): HookInput {
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (raw.length === 0) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed as HookInput : {};
  } catch {
    return {};
  }
}

function loadConfig(): { turn_threshold: number; min_minutes_between: number } {
  const fallback = { turn_threshold: 8, min_minutes_between: 30 };
  try {
    if (!existsSync(CONFIG_PATH)) return fallback;
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      turn_threshold: typeof raw.turn_threshold === "number" ? raw.turn_threshold : fallback.turn_threshold,
      min_minutes_between: typeof raw.min_minutes_between === "number" ? raw.min_minutes_between : fallback.min_minutes_between,
    };
  } catch {
    return fallback;
  }
}

function loadState(): ReviewState {
  try {
    if (!existsSync(STATE_PATH)) return { ...INITIAL_STATE };
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return {
      turn_count_since_last_review: typeof raw.turn_count_since_last_review === "number" ? raw.turn_count_since_last_review : 0,
      last_review_at: typeof raw.last_review_at === "string" ? raw.last_review_at : null,
      last_message_at: typeof raw.last_message_at === "string" ? raw.last_message_at : null,
      pending_review: raw.pending_review === true,
      schema_version: 1,
      sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
    };
  } catch {
    return { ...INITIAL_STATE };
  }
}

function saveState(state: ReviewState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const temporary = pathResolve(dirname(STATE_PATH), `.${randomUUID()}.uai-tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(state, null, 2) + "\n", "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, STATE_PATH);
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best effort */ }
    try { unlinkSync(temporary); } catch { /* only our temporary */ }
    throw error;
  }
}

function minutesSince(iso: string | null, nowMs: number): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - t) / 60_000);
}

function isSubagent(): boolean {
  return Boolean(
    process.env.CLAUDE_CODE_SUBAGENT_NAME ||
    process.env.CLAUDE_CODE_SUBAGENT_TYPE ||
    process.env.CLAUDE_AGENT_SDK === "1",
  );
}

function logFire(payload: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(FIRE_LOG_PATH), { recursive: true });
    appendFileSync(FIRE_LOG_PATH, JSON.stringify(payload) + "\n", "utf8");
  } catch { /* best-effort */ }
}

export function reviewerArgs(turnsReviewed: number, transcriptPath?: string): string[] {
  const args = [REVIEWER_PATH, "review", "--turns", String(turnsReviewed)];
  if (transcriptPath && transcriptPath.trim().length > 0) args.push("--input", transcriptPath);
  return args;
}

function runReviewer(turnsReviewed: number, transcriptPath?: string): { completed: boolean; reason: string } {
  if (!existsSync(REVIEWER_PATH)) {
    return { completed: false, reason: "reviewer-not-found" };
  }
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDECODE;
  const timeout = Number(process.env.LIFEOS_REVIEW_TIMEOUT_MS ?? 130_000);
  try {
    const result = spawnSync(process.execPath, reviewerArgs(turnsReviewed, transcriptPath), {
      env,
      stdio: "ignore",
      windowsHide: true,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 130_000,
    });
    if (result.error) return { completed: false, reason: `spawn-failed: ${result.error.message}` };
    if (result.status !== 0) return { completed: false, reason: `reviewer-exit-${result.status ?? "signal"}${result.signal ? `-${result.signal}` : ""}` };
    return { completed: true, reason: "completed" };
  } catch (error) {
    return { completed: false, reason: `spawn-failed: ${(error as Error)?.message || String(error)}` };
  }
}

const REVIEW_LEASE_MS = 5 * 60_000;

export function reviewLockIsStale(
  lock: { pid?: number; createdAt?: string },
  nowMs = Date.now(),
  mtimeMs = Number.NaN,
): boolean {
  const createdMs = typeof lock.createdAt === "string" ? Date.parse(lock.createdAt) : Number.NaN;
  const leaseStartedAt = Number.isFinite(createdMs) ? createdMs : mtimeMs;
  return Number.isFinite(leaseStartedAt) && nowMs - leaseStartedAt > REVIEW_LEASE_MS;
}

function acquireStateLock(timeoutMs = 5000): () => void {
  mkdirSync(dirname(STATE_LOCK_PATH), { recursive: true });
  const startedAt = Date.now();
  const owner = `${process.pid}:${randomUUID()}`;
  while (true) {
    try {
      const fd = openSync(STATE_LOCK_PATH, "wx");
      writeFileSync(fd, JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() }) + "\n", "utf8");
      return () => {
        closeSync(fd);
        if (!existsSync(STATE_LOCK_PATH)) throw new Error("memory review state lock disappeared before release");
        const current = JSON.parse(readFileSync(STATE_LOCK_PATH, "utf8")) as { owner?: string };
        if (current.owner !== owner) throw new Error("memory review state lock ownership changed");
        unlinkSync(STATE_LOCK_PATH);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const possibleWindowsContention = process.platform === "win32" && (code === "EPERM" || code === "EACCES");
      if (code !== "EEXIST" && !possibleWindowsContention) throw error;
      let rawLock: string;
      let lockMtimeMs: number;
      try {
        rawLock = readFileSync(STATE_LOCK_PATH, "utf8");
        lockMtimeMs = statSync(STATE_LOCK_PATH).mtimeMs;
      } catch (observationError) {
        if ((observationError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw observationError;
      }
      let lock: { pid?: number; createdAt?: string } = {};
      try {
        lock = JSON.parse(rawLock) as { pid?: number; createdAt?: string };
      } catch {
        // Malformed metadata is recoverable only after the file's lease demonstrably expires.
      }
      if (reviewLockIsStale(lock, Date.now(), lockMtimeMs)) {
        try {
          unlinkSync(STATE_LOCK_PATH);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error("memory review state lock timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

function reviewAttemptIsActive(attempt: ReviewAttempt | undefined): boolean {
  if (!attempt) return false;
  const startedAt = Date.parse(attempt.started_at);
  return Number.isFinite(startedAt) && Date.now() - startedAt <= REVIEW_LEASE_MS;
}

function mirrorSessionState(state: ReviewState, scoped: Omit<ReviewState, "sessions">): void {
  state.turn_count_since_last_review = scoped.turn_count_since_last_review;
  state.last_message_at = scoped.last_message_at;
  state.last_review_at = scoped.last_review_at;
  state.pending_review = scoped.pending_review;
}

function main(): number {
  let releaseStateLock: (() => void) | undefined;
  try {
    if (isSubagent()) return 0;
    const input = readHookInput();
    const sessionId = input.uai_session_id || input.session_id || "unknown-session";
    releaseStateLock = acquireStateLock();

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const config = loadConfig();
    const state = loadState();
    const scoped = state.sessions?.[sessionId] ?? { ...INITIAL_STATE };
    scoped.turn_count_since_last_review += 1;
    scoped.last_message_at = now;

    if (scoped.review_attempt && !reviewAttemptIsActive(scoped.review_attempt)) {
      scoped.review_attempt = undefined;
      scoped.pending_review = true;
    }
    const due =
      !scoped.review_attempt &&
      (
        scoped.pending_review ||
        (
          scoped.turn_count_since_last_review >= config.turn_threshold &&
          minutesSince(scoped.last_review_at, nowMs) >= config.min_minutes_between
        )
      );
    const attempt: ReviewAttempt | undefined = due
      ? {
          id: randomUUID(),
          pid: process.pid,
          started_at: now,
          turns_reviewed: scoped.turn_count_since_last_review,
          ...(input.transcript_path ? { transcript_path: input.transcript_path } : {}),
        }
      : undefined;
    if (attempt) {
      scoped.pending_review = true;
      scoped.review_attempt = attempt;
    }

    state.sessions ??= {};
    state.sessions[sessionId] = scoped;
    mirrorSessionState(state, scoped);
    saveState(state);
    releaseStateLock();
    releaseStateLock = undefined;
    if (!attempt) return 0;

    const { completed, reason } = runReviewer(attempt.turns_reviewed, attempt.transcript_path);
    const completedAt = new Date().toISOString();
    logFire({
      ts: completedAt,
      session_id: sessionId,
      native_session_id: input.native_session_id,
      transcript_path: attempt.transcript_path,
      turns_since_last_review: attempt.turns_reviewed,
      completed,
      reason,
      attempt_id: attempt.id,
    });

    releaseStateLock = acquireStateLock();
    const latest = loadState();
    const latestScoped = latest.sessions?.[sessionId] ?? { ...INITIAL_STATE };
    if (latestScoped.review_attempt?.id === attempt.id) {
      latestScoped.review_attempt = undefined;
      if (completed) {
        latestScoped.turn_count_since_last_review = Math.max(
          0,
          latestScoped.turn_count_since_last_review - attempt.turns_reviewed,
        );
        latestScoped.last_review_at = completedAt;
        latestScoped.pending_review = latestScoped.turn_count_since_last_review >= config.turn_threshold;
      } else {
        latestScoped.pending_review = true;
      }
      latest.sessions ??= {};
      latest.sessions[sessionId] = latestScoped;
      mirrorSessionState(latest, latestScoped);
      saveState(latest);
    }
    return completed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`MemoryReviewFire error: ${(error as Error)?.message || String(error)}\n`);
    return 1;
  } finally {
    releaseStateLock?.();
  }
}

if (import.meta.main) process.exit(main());
