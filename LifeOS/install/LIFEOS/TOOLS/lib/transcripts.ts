import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expandHome, getFrameworkDir, getPaiDataDir, homeDir } from "./paths";

export type FrameworkId = "claude" | "codex" | "opencode";

export interface SessionFile {
  path: string;
  framework: FrameworkId;
  mtime: number;
}

export interface TranscriptEntry {
  sessionId: string;
  timestamp: string;
  role: "user" | "assistant";
  text: string;
  sourceLine: number;
  sourcePath: string;
}

export interface FileOperation {
  filePath: string;
  action: "created" | "modified";
  sessionId: string;
  sourceLine: number;
  sourcePath: string;
}

export interface SessionFileOptions {
  recent?: number;
  all?: boolean;
  sessionId?: string;
  modifiedAfterMs?: number;
  framework?: FrameworkId;
}

function readFrameworkState(): Record<string, any> | null {
  try {
    const statePath = join(getPaiDataDir(), "framework.json");
    if (!existsSync(statePath)) return null;
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return null;
  }
}

export function normalizeFramework(value: string | undefined): FrameworkId | null {
  const v = (value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (v === "claude" || v === "claudecode") return "claude";
  if (v === "codex" || v === "openai" || v === "openaicodex") return "codex";
  if (v === "opencode" || v === "open") return "opencode";
  return null;
}

export function getActiveFramework(): FrameworkId {
  const envFramework = normalizeFramework(process.env.PAI_FRAMEWORK);
  if (envFramework) return envFramework;

  const state = readFrameworkState();
  if (state) return normalizeFramework(state.active) || normalizeFramework(state.framework) || "claude";

  const rootName = basename(getFrameworkDir()).toLowerCase();
  if (rootName === ".codex") return "codex";
  if (rootName === "opencode") return "opencode";
  return "claude";
}

export function getActiveFrameworkRoot(framework = getActiveFramework()): string {
  const state = readFrameworkState();
  const stateFramework = normalizeFramework(state?.active) || normalizeFramework(state?.framework);
  if (state?.root && (!stateFramework || stateFramework === framework)) {
    const stateRoot = expandHome(state.root);
    if (existsSync(stateRoot)) return stateRoot;
  }

  if (process.env.PAI_FRAMEWORK_DIR) {
    const envRoot = expandHome(process.env.PAI_FRAMEWORK_DIR);
    if (existsSync(envRoot)) return envRoot;
  }

  return getFrameworkDir();
}

export function getClaudeProjectDir(root = getActiveFrameworkRoot("claude")): string {
  const slug = root.replace(/[\\/.:]/g, "-");
  return join(root, "projects", slug);
}

export function getClaudeProjectDirs(root = getActiveFrameworkRoot("claude")): string[] {
  const projectsRoot = join(root, "projects");
  if (!existsSync(projectsRoot)) return [getClaudeProjectDir(root)];

  const dirs = readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectsRoot, entry.name));

  return dirs.length > 0 ? dirs : [getClaudeProjectDir(root)];
}

// Resolve a framework's transcript home. The ACTIVE framework honors
// framework.json / PAI_FRAMEWORK_DIR (via getActiveFrameworkRoot). NON-active
// frameworks resolve to their own conventional home so cross-framework scans
// (e.g. Pulse cost aggregation, which iterates claude/codex/opencode) never
// borrow the active framework's directory and mis-tag its sessions.
function frameworkRootFor(framework: FrameworkId): string {
  if (framework === getActiveFramework()) return getActiveFrameworkRoot(framework);
  if (framework === "codex") {
    const env = process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : "";
    return env || join(homeDir(), ".codex");
  }
  if (framework === "claude") {
    const env = process.env.CLAUDE_HOME
      ? expandHome(process.env.CLAUDE_HOME)
      : process.env.PAI_CLAUDE_HOME
        ? expandHome(process.env.PAI_CLAUDE_HOME)
        : "";
    return env || join(homeDir(), ".claude");
  }
  const env = process.env.OPENCODE_CONFIG_DIR ? expandHome(process.env.OPENCODE_CONFIG_DIR) : "";
  return env || join(homeDir(), ".config", "opencode");
}

export function getFrameworkSessionRoots(framework = getActiveFramework(), root = frameworkRootFor(framework)): string[] {
  if (framework === "claude") return getClaudeProjectDirs(root);
  if (framework === "codex") return [join(root, "sessions")];

  // PAI writes a normalized OpenCode transcript stream through its plugin.
  // The remaining roots are conservative best-effort locations for native
  // JSONL transcripts if OpenCode exposes them in a future/local build.
  return [
    join(getPaiDataDir(), "TRANSCRIPTS", "opencode"),
    join(root, "sessions"),
    join(root, "storage", "sessions"),
    join(homeDir(), ".local", "share", "opencode", "sessions"),
    join(homeDir(), "AppData", "Local", "opencode", "sessions"),
  ];
}

function collectJsonlFiles(dir: string, framework: FrameworkId, recursive: boolean): SessionFile[] {
  if (!existsSync(dir)) return [];

  const files: SessionFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      files.push(...collectJsonlFiles(entryPath, framework, recursive));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    files.push({
      path: entryPath,
      framework,
      mtime: statSync(entryPath).mtime.getTime(),
    });
  }

  return files;
}

export function getSessionFiles(options: SessionFileOptions = {}): SessionFile[] {
  const framework = options.framework || getActiveFramework();
  const recursive = framework === "codex" || framework === "opencode";
  const roots = getFrameworkSessionRoots(framework);
  const files = roots
    .flatMap((root) => collectJsonlFiles(root, framework, recursive))
    .sort((a, b) => b.mtime - a.mtime);

  let filtered = files;
  if (options.sessionId) {
    filtered = filtered.filter((file) => file.path.includes(options.sessionId!));
  }

  if (options.modifiedAfterMs !== undefined) {
    filtered = filtered.filter((file) => file.mtime > options.modifiedAfterMs!);
  } else if (options.all) {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    filtered = filtered.filter((file) => file.mtime > sevenDaysAgo);
  }

  if (options.sessionId || options.all || options.modifiedAfterMs !== undefined) {
    return filtered;
  }

  return filtered.slice(0, options.recent || 10);
}

function textFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((item) => typeof item?.text === "string")
    .filter((item) => !item.type || ["text", "input_text", "output_text"].includes(item.type))
    .map((item) => item.text)
    .join("\n");
}

function parseJsonMaybe(value: any): any {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function codexTextEntry(obj: any, sessionId: string, fallbackTimestamp: string): { role: "user" | "assistant"; text: string; timestamp: string } | null {
  if (obj?.type !== "response_item") return null;
  const payload = obj.payload;
  if (payload?.type !== "message") return null;
  if (payload.role !== "user" && payload.role !== "assistant") return null;

  const text = textFromContent(payload.content);
  if (!text) return null;

  return {
    role: payload.role,
    text,
    timestamp: obj.timestamp || fallbackTimestamp,
  };
}

function claudeTextEntry(obj: any, fallbackTimestamp: string): { role: "user" | "assistant"; text: string; timestamp: string } | null {
  if (obj?.type !== "user" && obj?.type !== "assistant") return null;
  const text = textFromContent(obj.message?.content);
  if (!text) return null;
  return {
    role: obj.type,
    text,
    timestamp: obj.timestamp || fallbackTimestamp,
  };
}

function opencodeTextEntry(obj: any, fallbackTimestamp: string): { role: "user" | "assistant"; text: string; timestamp: string } | null {
  if (obj?.type !== "message") return null;
  if (obj.role !== "user" && obj.role !== "assistant") return null;
  const text = textFromContent(obj.content) || (typeof obj.text === "string" ? obj.text : "");
  if (!text) return null;
  return {
    role: obj.role,
    text,
    timestamp: obj.timestamp || fallbackTimestamp,
  };
}

export function parseTranscriptEntriesFromText(
  transcriptContent: string,
  options: {
    framework?: FrameworkId;
    sourcePath?: string;
    sessionId?: string;
    fallbackTimestamp?: string;
  } = {},
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const framework = options.framework || getActiveFramework();
  const sourcePath = options.sourcePath || "";
  const fallbackTimestamp = options.fallbackTimestamp || new Date().toISOString();
  let sessionId = options.sessionId || (sourcePath ? basename(sourcePath, ".jsonl") : "");

  const lines = transcriptContent
    .split("\n")
    .map((line) => line.replace(/^\uFEFF/, ""))
    .filter((line) => line.trim());
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    try {
      const obj = JSON.parse(lines[lineIdx]);
      if (obj?.sessionId) sessionId = obj.sessionId;
      if (obj?.type === "session_meta" && obj.payload?.id) {
        sessionId = obj.payload.id;
        continue;
      }

      const parsed = framework === "codex"
        ? codexTextEntry(obj, sessionId, fallbackTimestamp)
        : framework === "opencode"
          ? opencodeTextEntry(obj, fallbackTimestamp)
          : claudeTextEntry(obj, fallbackTimestamp);
      if (!parsed) continue;

      entries.push({
        sessionId,
        timestamp: parsed.timestamp,
        role: parsed.role,
        text: parsed.text,
        sourceLine: lineIdx + 1,
        sourcePath,
      });
    } catch {
      // Skip malformed transcript lines.
    }
  }

  return entries;
}

export function parseTranscriptEntries(sessionPath: string, framework = getActiveFramework()): TranscriptEntry[] {
  return parseTranscriptEntriesFromText(readFileSync(sessionPath, "utf-8"), {
    framework,
    sourcePath: sessionPath,
  });
}

function resolveTranscriptPath(filePath: string, cwd: string | null): string {
  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("/") || filePath.startsWith("\\\\")) {
    return filePath;
  }
  return resolve(cwd || process.cwd(), filePath);
}

function operationsFromPatch(patch: string, cwd: string | null, sessionId: string, sourceLine: number, sourcePath: string): FileOperation[] {
  const operations: FileOperation[] = [];
  const seen = new Set<string>();
  const regex = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(patch)) !== null) {
    const marker = match[1];
    const rawPath = (match[2] || match[3] || "").trim();
    if (!rawPath || seen.has(rawPath)) continue;
    seen.add(rawPath);
    operations.push({
      filePath: resolveTranscriptPath(rawPath, cwd),
      action: marker === "Add" ? "created" : "modified",
      sessionId,
      sourceLine,
      sourcePath,
    });
  }

  return operations;
}

export function parseFileOperations(sessionPath: string, framework = getActiveFramework()): FileOperation[] {
  const operations: FileOperation[] = [];
  let sessionId = basename(sessionPath, ".jsonl");
  let cwd: string | null = null;

  const lines = readFileSync(sessionPath, "utf-8")
    .split("\n")
    .map((line) => line.replace(/^\uFEFF/, ""))
    .filter((line) => line.trim());
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    try {
      const obj = JSON.parse(lines[lineIdx]);
      if (obj?.sessionId) sessionId = obj.sessionId;
      if (obj?.type === "session_meta") {
        if (obj.payload?.id) sessionId = obj.payload.id;
        if (obj.payload?.cwd) cwd = obj.payload.cwd;
        continue;
      }
      if (typeof obj?.cwd === "string") cwd = obj.cwd;

      if (framework === "opencode") {
        if (obj?.type !== "tool_call") continue;
        const name = String(obj.name || obj.tool || "");
        const args = parseJsonMaybe(obj.arguments || obj.args || obj.tool_input);
        const rawPath = args.file_path || args.filePath || args.path;

        if (rawPath && /write/i.test(name)) {
          operations.push({
            filePath: resolveTranscriptPath(rawPath, cwd),
            action: "created",
            sessionId,
            sourceLine: lineIdx + 1,
            sourcePath: sessionPath,
          });
        } else if (rawPath && /edit|update/i.test(name)) {
          operations.push({
            filePath: resolveTranscriptPath(rawPath, cwd),
            action: "modified",
            sessionId,
            sourceLine: lineIdx + 1,
            sourcePath: sessionPath,
          });
        }

        const patch = args.patch || args.patchText || args.input || (/apply_patch/i.test(name) ? JSON.stringify(args) : "");
        if (typeof patch === "string" && patch.includes("*** Begin Patch")) {
          operations.push(...operationsFromPatch(patch, cwd, sessionId, lineIdx + 1, sessionPath));
        }
        continue;
      }

      if (framework !== "codex") {
        if (obj?.type !== "assistant" || !Array.isArray(obj.message?.content)) continue;
        for (const item of obj.message.content) {
          if (item?.type !== "tool_use") continue;
          const rawPath = item.input?.file_path;
          if (!rawPath) continue;
          if (item.name === "Write" || item.name === "Edit") {
            operations.push({
              filePath: resolveTranscriptPath(rawPath, cwd),
              action: item.name === "Write" ? "created" : "modified",
              sessionId,
              sourceLine: lineIdx + 1,
              sourcePath: sessionPath,
            });
          }
        }
        continue;
      }

      if (obj?.type !== "response_item" || obj.payload?.type !== "function_call") continue;
      const name = String(obj.payload.name || "");
      const args = parseJsonMaybe(obj.payload.arguments);
      const rawPath = args.file_path || args.filePath || args.path;

      if (rawPath && /write/i.test(name)) {
        operations.push({
          filePath: resolveTranscriptPath(rawPath, cwd),
          action: "created",
          sessionId,
          sourceLine: lineIdx + 1,
          sourcePath: sessionPath,
        });
      } else if (rawPath && /edit|update/i.test(name)) {
        operations.push({
          filePath: resolveTranscriptPath(rawPath, cwd),
          action: "modified",
          sessionId,
          sourceLine: lineIdx + 1,
          sourcePath: sessionPath,
        });
      }

      const patch = args.patch || args.patchText || args.input || (/apply_patch/i.test(name) ? obj.payload.arguments : "");
      if (typeof patch === "string" && patch.includes("*** Begin Patch")) {
        operations.push(...operationsFromPatch(patch, cwd, sessionId, lineIdx + 1, sessionPath));
      }
    } catch {
      // Skip malformed transcript lines.
    }
  }

  return operations;
}
