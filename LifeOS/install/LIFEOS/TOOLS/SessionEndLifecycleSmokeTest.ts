#!/usr/bin/env bun
/**
 * SessionEndLifecycleSmokeTest
 *
 * Proves the fast-dispatcher / bounded-worker SessionEnd architecture:
 *  1. The dispatcher exits fast (status 0) and detaches a worker that runs to
 *     completion on its own.
 *  2. The worker runs hooks in the required order (mock hooks), preserving
 *     WorkCompletionLearning before SessionCleanup, and a hung hook is bounded
 *     by the per-hook timeout while later hooks still run.
 *  3. The six legacy SessionEnd hook files still exist (no functionality deleted).
 *  4. Claude settings.json no longer registers the six heavy hooks directly —
 *     only the dispatcher.
 *  5. The generated Codex hooks.json registers the dispatcher under SessionEnd
 *     and none of the six heavy hooks directly.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

type Check = { name: string; passed: boolean; detail: string };

const releaseRoot = resolve(import.meta.dir, '..', '..');
const hooksDir = join(releaseRoot, 'hooks');
const settingsPath = join(releaseRoot, 'settings.json');
const configGenPath = join(releaseRoot, 'PAI', 'PAI-Install', 'engine', 'config-gen.ts');
const keep = process.argv.includes('--keep');
const tempRoot = mkdtempSync(join(tmpdir(), 'pai-session-end-smoke-'));
const checks: Check[] = [];

const HEAVY_HOOKS = [
  'WorkCompletionLearning.hook.ts',
  'SessionCleanup.hook.ts',
  'RelationshipMemory.hook.ts',
  'UpdateCounts.hook.ts',
  'IntegrityCheck.hook.ts',
  'KVSync.hook.ts',
];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name} - ${detail}`);
}

function writeMockHook(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body);
}

function readLines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf-8').split(/\r?\n/).filter(Boolean) : [];
}

function logHookOrder(logPath: string): string[] {
  return readLines(logPath)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e && typeof e.index === 'number' && e.status)
    .map((e) => e.hook as string);
}

function decodeEncodedCommand(command: string): string {
  const match = command.match(/(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/=]+)/i);
  if (!match) return '';
  try {
    return Buffer.from(match[1], 'base64').toString('utf16le');
  } catch {
    return '';
  }
}

function commandStringsOf(sessionEnd: any): string[] {
  const out: string[] = [];
  if (!Array.isArray(sessionEnd)) return out;
  for (const group of sessionEnd) {
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      const command = `${hook?.command || ''} ${hook?.commandWindows || ''}`;
      if (command.trim()) {
        out.push(command);
        const decoded = decodeEncodedCommand(command);
        if (decoded) out.push(decoded);
      }
    }
  }
  return out;
}

try {
  // ---- Worker: ordered execution + per-hook timeout bounding -----------------
  const mockDir = join(tempRoot, 'mock-hooks');
  mkdirSync(mockDir, { recursive: true });
  const orderFile = join(tempRoot, 'exec-order.txt');
  const workerLog = join(tempRoot, 'worker-log.jsonl');

  // Two quick mocks that record execution, and a hung mock to exercise the timeout.
  for (const name of ['First.hook.ts', 'Second.hook.ts']) {
    writeMockHook(mockDir, name, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.ORDER_FILE, '${name}\\n');\nprocess.exit(0);\n`);
  }
  writeMockHook(mockDir, 'Hang.hook.ts', `setTimeout(() => {}, 60_000);\n`);

  const workerPath = join(hooksDir, 'SessionEndWorker.ts');
  check('SessionEndWorker.ts exists', existsSync(workerPath), workerPath);

  const workerRun = spawnSync(process.execPath, [workerPath], {
    encoding: 'utf-8',
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      ORDER_FILE: orderFile,
      PAI_SESSION_END_HOOKS_DIR: mockDir,
      PAI_SESSION_END_HOOKS: 'First.hook.ts,Hang.hook.ts,Second.hook.ts',
      PAI_SESSION_END_HOOK_TIMEOUT_MS: '1500',
      PAI_SESSION_END_LOG: workerLog,
    },
  });

  check('worker exits 0', workerRun.status === 0, `status=${workerRun.status ?? 'null'}`);

  const execOrder = readLines(orderFile);
  check(
    'worker runs hooks in order, later hook survives a timeout',
    JSON.stringify(execOrder) === JSON.stringify(['First.hook.ts', 'Second.hook.ts']),
    `exec order=${JSON.stringify(execOrder)}`,
  );

  const logOrder = logHookOrder(workerLog);
  check(
    'worker log preserves canonical order including the hung hook',
    JSON.stringify(logOrder) === JSON.stringify(['First.hook.ts', 'Hang.hook.ts', 'Second.hook.ts']),
    `log order=${JSON.stringify(logOrder)}`,
  );

  const logEntries = readLines(workerLog).map((l) => JSON.parse(l));
  const hangEntry = logEntries.find((e) => e.hook === 'Hang.hook.ts');
  check('hung hook is bounded (timeout status)', hangEntry?.status === 'timeout', `hang status=${hangEntry?.status}`);

  // ---- Worker: canonical order keeps WorkCompletion before SessionCleanup ----
  // (verified against the real default list, without executing the real hooks)
  const defaultOrderProbe = spawnSync(process.execPath, [
    '-e',
    `const fs=require('fs');const src=fs.readFileSync(${JSON.stringify(workerPath)},'utf-8');const m=src.match(/const DEFAULT_HOOKS = \\[([\\s\\S]*?)\\];/);process.stdout.write(m?m[1]:'');`,
  ], { encoding: 'utf-8', windowsHide: true });
  const defaultList = (defaultOrderProbe.stdout || '').match(/'([^']+)'/g)?.map((s) => s.replace(/'/g, '')) || [];
  check(
    'default order matches the six lifecycle hooks',
    JSON.stringify(defaultList) === JSON.stringify(HEAVY_HOOKS),
    `default=${JSON.stringify(defaultList)}`,
  );
  check(
    'WorkCompletionLearning precedes SessionCleanup in default order',
    defaultList.indexOf('WorkCompletionLearning.hook.ts') >= 0 &&
      defaultList.indexOf('WorkCompletionLearning.hook.ts') < defaultList.indexOf('SessionCleanup.hook.ts'),
    `wcl=${defaultList.indexOf('WorkCompletionLearning.hook.ts')} cleanup=${defaultList.indexOf('SessionCleanup.hook.ts')}`,
  );

  // ---- Dispatcher: fast exit + detached worker actually runs -----------------
  const dispatcherPath = join(hooksDir, 'SessionEndDispatcher.hook.ts');
  check('SessionEndDispatcher.hook.ts exists', existsSync(dispatcherPath), dispatcherPath);

  const dispatcherDataDir = join(tempRoot, 'pai-data');
  const dispatcherLog = join(tempRoot, 'dispatcher-worker-log.jsonl');
  const dispatcherMockDir = join(tempRoot, 'dispatcher-mock');
  mkdirSync(dispatcherMockDir, { recursive: true });
  writeMockHook(dispatcherMockDir, 'Quick.hook.ts', `process.exit(0);\n`);

  const started = Date.now();
  const dispatcherRun = spawnSync(process.execPath, [dispatcherPath], {
    input: JSON.stringify({ session_id: 'session-end-smoke', hook_event_name: 'SessionEnd', transcript_path: join(tempRoot, 't.jsonl') }),
    encoding: 'utf-8',
    timeout: 15_000,
    windowsHide: true,
    env: {
      ...process.env,
      PAI_DATA_DIR: dispatcherDataDir,
      PAI_SESSION_END_HOOKS_DIR: dispatcherMockDir,
      PAI_SESSION_END_HOOKS: 'Quick.hook.ts',
      PAI_SESSION_END_LOG: dispatcherLog,
    },
  });
  const elapsed = Date.now() - started;
  check('dispatcher exits 0', dispatcherRun.status === 0, `status=${dispatcherRun.status ?? 'null'}`);
  check('dispatcher exits fast (< 3000ms)', elapsed < 3000, `elapsed=${elapsed}ms`);

  // The worker is detached; poll its log for completion.
  let completed = false;
  for (let i = 0; i < 50 && !completed; i += 1) {
    if (readLines(dispatcherLog).some((l) => l.includes('session-end-complete'))) { completed = true; break; }
    Bun.sleepSync(200);
  }
  check('dispatcher detaches a worker that completes', completed, `log=${dispatcherLog} present=${existsSync(dispatcherLog)}`);

  // ---- Legacy hook files preserved ------------------------------------------
  const missing = HEAVY_HOOKS.filter((file) => !existsSync(join(hooksDir, file)));
  check('all six legacy SessionEnd hook files still present', missing.length === 0, missing.length ? `missing=${missing.join(', ')}` : 'all present');

  // ---- Claude settings.json no longer registers the heavy hooks --------------
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  const sessionEndCommands = commandStringsOf(settings?.hooks?.SessionEnd);
  const heavyInSettings = sessionEndCommands.filter((cmd) => HEAVY_HOOKS.some((file) => cmd.includes(file)));
  check('settings.json SessionEnd registers no heavy hooks', heavyInSettings.length === 0, heavyInSettings.length ? heavyInSettings.join(' | ') : 'none');
  check('settings.json SessionEnd registers the dispatcher', sessionEndCommands.some((cmd) => cmd.includes('SessionEndDispatcher.hook.ts')), sessionEndCommands.join(' | ') || 'empty');

  // ---- Generated Codex hooks.json parity ------------------------------------
  const { generateCodexHooksJson } = await import(pathToFileURL(configGenPath).href);
  const codex = generateCodexHooksJson({
    framework: 'codex', principalName: '', timezone: 'UTC', aiName: 'PAI', catchphrase: '',
    paiDir: join(releaseRoot, 'PAI'), configDir: join(tempRoot, 'config'), dataDir: join(tempRoot, 'pai-data'),
  });
  const codexSessionEnd = commandStringsOf(codex?.hooks?.SessionEnd);
  const heavyInCodex = codexSessionEnd.filter((cmd) => HEAVY_HOOKS.some((file) => cmd.includes(file)));
  check('Codex hooks.json SessionEnd exists', codexSessionEnd.length > 0, `${codexSessionEnd.length} command(s)`);
  check('Codex hooks.json SessionEnd registers no heavy hooks', heavyInCodex.length === 0, heavyInCodex.length ? heavyInCodex.join(' | ') : 'none');
  check('Codex hooks.json SessionEnd registers the dispatcher', codexSessionEnd.some((cmd) => cmd.includes('SessionEndDispatcher.hook.ts')), codexSessionEnd.join(' | ') || 'empty');

  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    console.error(`\n${failed.length} SessionEnd lifecycle check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${checks.length} SessionEnd lifecycle checks passed.`);
} finally {
  if (keep) console.log(`\nKept smoke root: ${tempRoot}`);
  else rmSync(tempRoot, { recursive: true, force: true });
}
