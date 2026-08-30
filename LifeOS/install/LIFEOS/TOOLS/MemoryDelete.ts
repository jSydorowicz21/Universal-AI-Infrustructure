#!/usr/bin/env bun
/**
 * MemoryDelete - remove a PAI memory artifact and redact its copies from caches/logs.
 *
 * PAI keeps observability and voice logs as append-only operational records, but
 * user-requested memory deletion must not leave the deleted fact retrievable in
 * ordinary memory searches. This tool deletes the canonical memory file and
 * rewrites local PAI cache/log files with exact literal redactions.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { memoryPath, getMemoryDir, expandHome } from "./lib/paths";

type Options = {
  path?: string;
  texts: string[];
  patternsFile?: string;
  dryRun: boolean;
};

type Change = {
  file: string;
  replacements: number;
  deleted?: boolean;
};

const REDACTION = "[PAI_MEMORY_DELETED]";

function usage(): never {
  console.error([
    "Usage:",
    "  bun MemoryDelete.ts --path MEMORY/RELATIONSHIP/file.md --text \"literal to redact\"",
    "  bun MemoryDelete.ts --path /absolute/memory/file --patterns-file /tmp/patterns.txt",
    "",
    "Options:",
    "  --path <path>           Memory file or directory to delete. Must be under MEMORY/.",
    "  --text <literal>        Exact literal to redact. May be repeated.",
    "  --patterns-file <file>  Newline-separated exact literals to redact.",
    "  --dry-run               Report changes without writing.",
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { texts: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--path") {
      opts.path = argv[++i];
    } else if (arg === "--text") {
      opts.texts.push(argv[++i] || "");
    } else if (arg === "--patterns-file") {
      opts.patternsFile = argv[++i];
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }
  return opts;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function resolveInsideMemory(inputPath: string): string {
  const memoryRoot = resolve(getMemoryDir());
  const expanded = expandHome(inputPath);
  const candidate = isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(memoryRoot, expanded.replace(/^MEMORY[\\/]/, ""));
  const rel = relative(memoryRoot, candidate);
  if (rel && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error(`Refusing to delete outside MEMORY/: ${inputPath}`);
  }
  return candidate;
}

function loadPatterns(opts: Options, deletePath?: string): string[] {
  const patterns = [...opts.texts];
  if (opts.patternsFile) {
    const file = expandHome(opts.patternsFile);
    if (!existsSync(file)) throw new Error(`Patterns file not found: ${file}`);
    patterns.push(...readFileSync(file, "utf-8").split(/\r?\n/));
  }
  if (deletePath && existsSync(deletePath) && lstatSync(deletePath).isFile()) {
    const content = readFileSync(deletePath, "utf-8");
    const trimmed = content.trim();
    if (trimmed && trimmed.length <= 20_000) patterns.push(trimmed);
  }
  return unique(patterns);
}

function redactContent(content: string, patterns: string[]): { content: string; replacements: number } {
  let next = content;
  let replacements = 0;
  for (const pattern of patterns) {
    let index = next.indexOf(pattern);
    while (index !== -1) {
      replacements += 1;
      next = `${next.slice(0, index)}${REDACTION}${next.slice(index + pattern.length)}`;
      index = next.indexOf(pattern, index + REDACTION.length);
    }
  }
  return { content: next, replacements };
}

function redactFile(file: string, patterns: string[], dryRun: boolean): Change | null {
  if (!existsSync(file)) return null;
  const original = readFileSync(file, "utf-8");
  const result = redactContent(original, patterns);
  if (result.replacements === 0) return null;
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, result.content, "utf-8");
  }
  return { file, replacements: result.replacements };
}

function redactTargets(patterns: string[], dryRun: boolean): Change[] {
  const targets = [
    memoryPath("STATE", "last-response.txt"),
    memoryPath("STATE", "last-prompt.json"),
    memoryPath("VOICE", "voice-events.jsonl"),
    memoryPath("OBSERVABILITY", "tool-activity.jsonl"),
  ];
  return targets
    .map((target) => redactFile(target, patterns, dryRun))
    .filter((change): change is Change => Boolean(change));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.path && opts.texts.length === 0 && !opts.patternsFile) usage();

  const deletePath = opts.path ? resolveInsideMemory(opts.path) : undefined;
  const patterns = loadPatterns(opts, deletePath);
  if (patterns.length === 0) {
    throw new Error("No redaction patterns provided or discovered.");
  }

  const changes: Change[] = [];
  if (deletePath && existsSync(deletePath)) {
    changes.push({ file: deletePath, replacements: 0, deleted: true });
    if (!opts.dryRun) rmSync(deletePath, { recursive: true, force: true });
  }

  changes.push(...redactTargets(patterns, opts.dryRun));

  console.log(JSON.stringify({
    ok: true,
    dryRun: opts.dryRun,
    redaction: REDACTION,
    patterns: patterns.length,
    changes,
  }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
