#!/usr/bin/env bun
/**
 * SessionEndLifecycleMigrate.ts - Migrate Claude settings.json to the fast
 * SessionEnd dispatcher architecture.
 *
 * WHY:
 * Older installs register six heavy hooks directly under SessionEnd
 * (WorkCompletionLearning, SessionCleanup, RelationshipMemory, UpdateCounts,
 * IntegrityCheck, KVSync). In `claude -p` runs those get cancelled during host
 * teardown ("Hook cancelled"). The robust design registers a single fast
 * dispatcher under SessionEnd that hands off to a detached worker.
 *
 * This tool rewrites an installed settings.json to the dispatcher form. It is:
 * - GUARDED: only the SessionEnd block is touched; every other key is preserved
 *   verbatim. Unknown custom SessionEnd hooks are left alone (reported, not clobbered).
 * - IDEMPOTENT: re-running on an already-migrated settings.json is a no-op.
 *
 * USAGE:
 *   bun SessionEndLifecycleMigrate.ts --settings <path/to/settings.json> [--dry-run] [--quiet]
 *   bun SessionEndLifecycleMigrate.ts <install-root>            # resolves <root>/settings.json
 *
 * EXIT CODES:
 *   0  migrated, already-migrated, or safely skipped
 *   1  hard error (unreadable / unparseable / unwritable settings)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DISPATCHER_FILE = 'SessionEndDispatcher.hook.ts';
const HEAVY_HOOKS = [
  'WorkCompletionLearning.hook.ts',
  'SessionCleanup.hook.ts',
  'RelationshipMemory.hook.ts',
  'UpdateCounts.hook.ts',
  'IntegrityCheck.hook.ts',
  'KVSync.hook.ts',
];
const DEFAULT_PREFIX = '$HOME/.claude/hooks/';

interface Args {
  settingsPath: string;
  dryRun: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  let settingsPath = '';
  let dryRun = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--settings') { settingsPath = argv[++i] || ''; }
    else if (arg === '--dry-run') { dryRun = true; }
    else if (arg === '--quiet') { quiet = true; }
    else if (!arg.startsWith('--') && !settingsPath) {
      // Positional: treat as install root if it is a dir-ish path, else as a settings file.
      settingsPath = arg.endsWith('.json') ? arg : join(arg, 'settings.json');
    }
  }
  return { settingsPath, dryRun, quiet };
}

function commandStringsOf(sessionEnd: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(sessionEnd)) return out;
  for (const group of sessionEnd) {
    const hooks = (group && typeof group === 'object' && Array.isArray((group as any).hooks)) ? (group as any).hooks : [];
    for (const hook of hooks) {
      const command = hook && typeof hook === 'object' ? (hook as any).command : undefined;
      if (typeof command === 'string') out.push(command);
    }
  }
  return out;
}

/** Derive the hooks-dir command prefix from an existing command, else the default. */
function derivePrefix(commands: string[]): string {
  for (const command of commands) {
    const match = command.match(/^(.*?\/hooks\/)[^/]+\.(?:ts|js|sh)\s*$/) || command.match(/^(.*?[/\\]hooks[/\\])[^/\\]+\.(?:ts|js|sh)\s*$/);
    if (match) return match[1];
  }
  return DEFAULT_PREFIX;
}

function dispatcherBlock(prefix: string): unknown {
  return [
    {
      hooks: [
        { type: 'command', command: `${prefix}${DISPATCHER_FILE}` },
      ],
    },
  ];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const note = (msg: string) => { if (!args.quiet) console.log(`[SessionEndLifecycleMigrate] ${msg}`); };

  if (!args.settingsPath) {
    console.error('[SessionEndLifecycleMigrate] No settings path. Pass --settings <path> or an install root.');
    process.exit(1);
  }
  if (!existsSync(args.settingsPath)) {
    console.error(`[SessionEndLifecycleMigrate] settings.json not found: ${args.settingsPath}`);
    process.exit(1);
  }

  let raw: string;
  let settings: any;
  try {
    raw = readFileSync(args.settingsPath, 'utf-8');
    settings = JSON.parse(raw);
  } catch (error) {
    console.error(`[SessionEndLifecycleMigrate] Could not parse settings.json: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : undefined;
  const sessionEnd = hooks ? hooks.SessionEnd : undefined;
  const commands = commandStringsOf(sessionEnd);

  const hasHeavy = commands.some((cmd) => HEAVY_HOOKS.some((file) => cmd.includes(file)));
  const hasDispatcher = commands.some((cmd) => cmd.includes(DISPATCHER_FILE));

  // Already migrated: dispatcher present and no heavy hooks → no-op.
  if (hasDispatcher && !hasHeavy) {
    note('Already migrated — SessionEnd registers the dispatcher only. No changes.');
    process.exit(0);
  }

  // Unknown custom SessionEnd (non-empty, no heavy hooks, no dispatcher) → leave alone.
  if (!hasHeavy && commands.length > 0) {
    note(`SessionEnd has ${commands.length} custom hook command(s) and no heavy lifecycle hooks; leaving unchanged (guarded).`);
    process.exit(0);
  }

  const prefix = derivePrefix(commands);
  const before = hasHeavy ? `${commands.length} heavy hook command(s)` : 'empty/absent SessionEnd';

  if (args.dryRun) {
    note(`DRY RUN: would replace ${before} with a single dispatcher (${prefix}${DISPATCHER_FILE}).`);
    process.exit(0);
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  settings.hooks.SessionEnd = dispatcherBlock(prefix);

  // Preserve trailing-newline style of the original file.
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  try {
    writeFileSync(args.settingsPath, `${JSON.stringify(settings, null, 2)}${trailingNewline}`);
  } catch (error) {
    console.error(`[SessionEndLifecycleMigrate] Failed to write settings.json: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  note(`Migrated SessionEnd: replaced ${before} with a single dispatcher (${prefix}${DISPATCHER_FILE}).`);
  process.exit(0);
}

main();
