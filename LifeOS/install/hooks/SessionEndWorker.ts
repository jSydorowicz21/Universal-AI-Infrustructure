#!/usr/bin/env bun
/**
 * SessionEndWorker.ts - Bounded SessionEnd lifecycle runner (detached worker)
 *
 * PURPOSE:
 * Runs the real SessionEnd lifecycle hooks that used to be registered directly
 * under SessionEnd. SessionEndDispatcher.hook.ts spawns this worker detached and
 * exits immediately, so this process is fully decoupled from host teardown and
 * can take as long as it needs without producing "Hook cancelled" errors.
 *
 * This is intentionally NOT a `.hook.ts` file: it is never registered as a hook
 * and must not be discovered by hook-contract scanners. It is only ever started
 * by the dispatcher.
 *
 * CONTRACT:
 * - Runs each lifecycle hook sequentially, in the required order, preserving
 *   WorkCompletionLearning BEFORE SessionCleanup (capture-before-clear).
 * - Each hook is bounded by a per-hook timeout; a slow/hung hook is killed and
 *   the remaining hooks still run.
 * - Every hook receives the original SessionEnd payload on stdin.
 * - Writes one JSONL log line per hook (and a summary line) so background
 *   lifecycle behavior is observable after the fact.
 * - Always exits 0. No lifecycle failure is allowed to escape.
 *
 * ENV OVERRIDES (used by SessionEndLifecycleSmokeTest):
 * - PAI_SESSION_END_HOOKS_DIR: directory to resolve hook files from (default: this dir)
 * - PAI_SESSION_END_HOOKS: comma-separated ordered hook filenames (default: the six)
 * - PAI_SESSION_END_HOOK_TIMEOUT_MS: per-hook timeout in ms (default: 30000)
 * - PAI_SESSION_END_LOG: explicit JSONL log path (default: MEMORY/OBSERVABILITY/...)
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// Canonical SessionEnd order. WorkCompletionLearning MUST precede SessionCleanup
// (it reads work state before SessionCleanup clears it).
const DEFAULT_HOOKS = [
  'WorkCompletionLearning.hook.ts',
  'SessionCleanup.hook.ts',
  'RelationshipMemory.hook.ts',
  'UpdateCounts.hook.ts',
  'IntegrityCheck.hook.ts',
  'KVSync.hook.ts',
];

const DEFAULT_TIMEOUT_MS = 30_000;

function hooksDir(): string {
  const override = process.env.PAI_SESSION_END_HOOKS_DIR;
  return override && override.trim() ? override : import.meta.dir;
}

function orderedHooks(): string[] {
  const override = process.env.PAI_SESSION_END_HOOKS;
  if (override && override.trim()) {
    return override.split(',').map((name) => name.trim()).filter(Boolean);
  }
  return DEFAULT_HOOKS;
}

function perHookTimeoutMs(): number {
  const raw = Number(process.env.PAI_SESSION_END_HOOK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function resolveLogPath(): string {
  const explicit = process.env.PAI_SESSION_END_LOG;
  if (explicit && explicit.trim()) return explicit;
  try {
    // Lazy import so a path-resolution failure can never abort the worker.
    const localRequire = createRequire(import.meta.url);
    const { memoryPath } = localRequire('./lib/paths');
    return memoryPath('OBSERVABILITY', 'session-end-lifecycle.jsonl');
  } catch {
    return join(import.meta.dir, '..', 'session-end-lifecycle.jsonl');
  }
}

function log(logPath: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging is best-effort; never let it break the lifecycle.
  }
}

function readPayload(): string {
  const payloadFile = process.argv[2];
  if (!payloadFile) return '{}';
  try {
    return existsSync(payloadFile) ? readFileSync(payloadFile, 'utf-8') || '{}' : '{}';
  } catch {
    return '{}';
  }
}

function runHook(hookPath: string, payload: string, timeoutMs: number) {
  return spawnSync(process.execPath, [hookPath], {
    input: payload,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
    windowsHide: true,
  });
}

function main(): void {
  const logPath = resolveLogPath();
  const dir = hooksDir();
  const hooks = orderedHooks();
  const timeoutMs = perHookTimeoutMs();
  const payload = readPayload();
  const runId = `${new Date().toISOString()}-${process.pid}`;

  log(logPath, { ts: new Date().toISOString(), event: 'session-end-start', runId, hooks, timeoutMs });

  let ran = 0;
  for (let index = 0; index < hooks.length; index += 1) {
    const name = hooks[index];
    const hookPath = join(dir, name);
    const started = Date.now();

    if (!existsSync(hookPath)) {
      log(logPath, { ts: new Date().toISOString(), runId, index, hook: name, status: 'missing' });
      continue;
    }

    let status = 'ok';
    let exitCode: number | null = null;
    let signal: string | null = null;
    try {
      const result = runHook(hookPath, payload, timeoutMs);
      exitCode = result.status;
      signal = (result.signal as string | null) ?? null;
      const timedOut = Boolean(result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') || signal === 'SIGTERM';
      if (timedOut) status = 'timeout';
      else if (result.error) status = 'error';
      else if (result.status !== 0) status = 'nonzero';
    } catch (error) {
      status = 'error';
      log(logPath, { ts: new Date().toISOString(), runId, index, hook: name, status, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    ran += 1;
    log(logPath, {
      ts: new Date().toISOString(),
      runId,
      index,
      hook: name,
      status,
      exitCode,
      signal,
      durationMs: Date.now() - started,
    });
  }

  log(logPath, { ts: new Date().toISOString(), event: 'session-end-complete', runId, ran, total: hooks.length });

  // Best-effort cleanup of the dispatcher's temp payload file + its dir.
  const payloadFile = process.argv[2];
  if (payloadFile) {
    try { rmSync(dirname(payloadFile), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  process.exit(0);
}

main();
