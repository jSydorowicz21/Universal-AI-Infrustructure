#!/usr/bin/env bun
/**
 * SessionEndDispatcher.hook.ts - Fast SessionEnd dispatcher (SessionEnd)
 *
 * PURPOSE:
 * SessionEnd hooks fire while the agent is tearing the session down. In
 * non-interactive runs (`claude -p`) the host process exits almost immediately
 * after the final turn, so any SessionEnd hook that does real work — reading the
 * transcript, writing learnings, syncing KV — gets cancelled mid-flight and the
 * user sees a wall of "Hook cancelled" lines. The historical fix of registering
 * six heavy hooks directly under SessionEnd is exactly what triggers that race.
 *
 * This dispatcher replaces that direct registration with a fast/slow split:
 *   - It is the ONLY hook registered under SessionEnd.
 *   - It captures stdin, hands the payload to a detached worker, and exits 0 in
 *     milliseconds so the host never has anything left to cancel.
 *   - SessionEndWorker.ts (spawned detached) runs the real lifecycle hooks in
 *     order, each bounded by its own timeout, fully decoupled from host teardown.
 *
 * TRIGGER: SessionEnd (Claude settings.json; Codex hooks.json via adapter)
 *
 * INPUT:
 * - stdin: SessionEnd payload JSON (session_id, transcript_path, ...)
 *
 * OUTPUT:
 * - exit(0): Always. Fail-open — a dispatcher failure must never block teardown
 *   and must never resurface as a cancelled-hook error.
 *
 * SIDE EFFECTS:
 * - Writes the captured payload to a temp file consumed (and deleted) by the worker.
 * - Spawns hooks/SessionEndWorker.ts detached so it outlives this process.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STDIN_TIMEOUT_MS = 2000;

async function readStdin(): Promise<string> {
  try {
    return await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), STDIN_TIMEOUT_MS)),
    ]);
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  try {
    const payload = await readStdin();

    // Persist the payload to a temp file so the detached worker can read it
    // without sharing this process's stdin (which closes when we exit).
    const dir = mkdtempSync(join(tmpdir(), 'pai-session-end-'));
    const payloadFile = join(dir, 'payload.json');
    writeFileSync(payloadFile, payload && payload.trim() ? payload : '{}');

    const workerPath = join(import.meta.dir, 'SessionEndWorker.ts');

    // Detached + ignored stdio + unref: the worker becomes its own process,
    // so the host can exit immediately and the worker keeps running the
    // lifecycle hooks to completion in the background.
    const child = spawn(process.execPath, [workerPath, payloadFile], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    // Fail-open: never block session teardown.
    console.error(`[SessionEndDispatcher] ${error instanceof Error ? error.message : String(error)}`);
  }

  // Exit fast and clean regardless of what happened above.
  process.exit(0);
}

main();
