#!/usr/bin/env bun
/**
 * FrameworkHookAdapter.ts
 *
 * Normalizes non-Claude hook payloads into the Claude-shaped fields used by
 * PAI's existing hook implementations, then delegates to the target hook.
 */

import { spawnSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { basename, dirname, extname, join, resolve } from "path";
import { blockEmissionForFramework, shouldExitCleanlyOnBlock } from "./lib/framework-hook-contract";
import { homeDir } from "./lib/paths";
import { isSubagentSession } from "./lib/session";

type JsonObject = Record<string, any>;
type CapturedOutput = {
  json: JsonObject[];
  text: string[];
};
type HookRunLogEntry = {
  type: "hook-run-start" | "hook-run-end";
  runId: string;
  adapterPid: number;
  framework: string;
  event: string;
  timestamp: string;
  hookEventName: string;
  sessionId: string;
  target: string;
  timeoutMs: number;
  startEpochMs: number;
  endEpochMs?: number;
  durationMs?: number;
  status?: number;
  signal?: string;
  error?: string;
  stdoutLength?: number;
  stderrLength?: number;
  stderrPreview?: string;
  statusReason?: string;
  payload: JsonObject;
  skipReason?: string;
};
type MergedHookOutput = {
  decision?: JsonObject;
  permission?: JsonObject;
  updatedInput?: unknown;
  additionalContext: string[];
  hookEventName?: string;
  continueValue?: boolean;
};

function childBlockReason(targetPath: string, stderr: string): string {
  const cleaned = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return cleaned || `[PAI SECURITY] ${basename(targetPath)} blocked this tool call.`;
}

function shouldLogHookRuns(): boolean {
  return process.env.PAI_HOOK_DEBUG === "1" || process.env.PAI_HOOK_RUN_LOG === "1";
}

function hookLogFile(dataDir: string): string {
  return join(dataDir, "MEMORY", "OBSERVABILITY", "hook-runs.jsonl");
}

function preview(value: unknown, max = 300): string {
  if (!value) return "";
  if (typeof value === "string") return value.length <= max ? value : `${value.slice(0, max)}...`;
  try {
    const json = JSON.stringify(value);
    return json.length <= max ? json : `${json.slice(0, max)}...`;
  } catch {
    return "";
  }
}

function payloadSummary(input: JsonObject): JsonObject {
  const rawToolInput = input.tool_input || input.toolInput || input.tool?.input;
  const rawToolResult = input.tool_result || input.toolResult || input.tool_response || input.result;
  return {
    framework: input.framework,
    session_id: input.session_id || "pai-framework-session",
    hook_event_name: input.hook_event_name || input.event_name || input.event || "unknown",
    cwd: input.cwd || input.workingDirectory,
    tool_name: input.tool_name || input.toolName || input.tool?.name || "Unknown",
    tool_input_preview: preview(rawToolInput, 400),
    tool_result_preview: preview(rawToolResult, 400),
    prompt_preview: preview(input.prompt, 240),
  };
}

function writeHookRunLog(entry: HookRunLogEntry, dataDir: string): void {
  if (!shouldLogHookRuns()) return;
  try {
    const path = hookLogFile(dataDir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Hook logging must never affect hook execution.
  }
}

function runLogForTargetStart(runId: string, framework: string, input: JsonObject, target: string, timeout: number, index: number, total: number, dataDir: string, eventName: string): void {
  writeHookRunLog({
    type: "hook-run-start",
    runId,
    adapterPid: process.pid,
    framework,
    event: "start",
    timestamp: new Date().toISOString(),
    hookEventName: eventName,
    sessionId: input.session_id || input.sessionId || input.session?.id || "pai-framework-session",
    target: `${index + 1}/${total}:${basename(target)}`,
    timeoutMs: timeout,
    startEpochMs: Date.now(),
    payload: payloadSummary(input),
  }, dataDir);
}

function runLogForTargetEnd(runId: string, framework: string, input: JsonObject, target: string, result: {
  status: number | null;
  signal: NodeJS.Signals | undefined;
  error?: Error;
  stdout?: string;
  stderr?: string;
  startEpochMs: number;
  timeoutMs: number;
}, statusReason: string | undefined, index: number, total: number, dataDir: string, eventName: string): void {
  const endEpoch = Date.now();
  const stderrText = result.stderr || "";
  writeHookRunLog({
    type: "hook-run-end",
    runId,
    adapterPid: process.pid,
    framework,
    event: statusReason || "completed",
    timestamp: new Date(endEpoch).toISOString(),
    hookEventName: eventName,
    sessionId: input.session_id || input.sessionId || input.session?.id || "pai-framework-session",
    target: `${index + 1}/${total}:${basename(target)}`,
    timeoutMs: result.timeoutMs,
    startEpochMs: result.startEpochMs,
    endEpochMs: endEpoch,
    durationMs: endEpoch - result.startEpochMs,
    status: result.status ?? -1,
    signal: result.signal,
    error: result.error ? result.error.message : undefined,
    stdoutLength: result.stdout?.length || 0,
    stderrLength: stderrText.length,
    stderrPreview: preview(stderrText, 300),
    statusReason,
    payload: payloadSummary(input),
  }, dataDir);
}

function runLogForTargetSkip(runId: string, framework: string, input: JsonObject, target: string, reason: string, index: number, total: number, dataDir: string, eventName: string): void {
  writeHookRunLog({
    type: "hook-run-end",
    runId,
    adapterPid: process.pid,
    framework,
    event: "skip",
    timestamp: new Date().toISOString(),
    hookEventName: eventName,
    sessionId: input.session_id || input.sessionId || input.session?.id || "pai-framework-session",
    target: `${index + 1}/${total}:${basename(target)}`,
    timeoutMs: timeoutMs(),
    startEpochMs: Date.now(),
    status: 0,
    skipReason: reason,
    payload: payloadSummary(input),
  }, dataDir);
}

function exitAfterChildBlock(framework: string, targetPath: string, stderr: string, merged: MergedHookOutput, fallbackEventName: string): never {
  if (shouldExitCleanlyOnBlock(framework)) {
    if (!merged.decision && !merged.permission) {
      const emission = blockEmissionForFramework(framework, childBlockReason(targetPath, stderr));
      if (emission.output) console.log(JSON.stringify(emission.output));
      process.exit(emission.exitCode);
    }
    emitMergedOutput(merged, fallbackEventName);
    process.exit(0);
  }

  emitMergedOutput(merged, fallbackEventName);
  process.exit(2);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function targetArgs(): string[] {
  const raw = argValue("--target") || argValue("--targets") || "";
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function timeoutMs(): number {
  const raw = Number(argValue("--timeout-ms") || process.env.PAI_HOOK_CHILD_TIMEOUT_MS || "");
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function existingEnvPath(name: string): string {
  const value = process.env[name] || "";
  return value && existsSync(value) ? value : "";
}

function fallbackDataDir(): string {
  return existingEnvPath("PAI_DATA_DIR") || join(homeDir(), ".pai");
}

function fallbackConfigDir(): string {
  return existingEnvPath("PAI_CONFIG_DIR") || join(homeDir(), ".config", "PAI");
}

const RECURSION_GUARDED_HOOKS = new Set([
  "PromptGuard.hook.ts",
  "RepeatDetection.hook.ts",
  "PromptProcessing.hook.ts",
  "SatisfactionCapture.hook.ts",
]);

function shouldSkipForNestedInference(target: string): boolean {
  if (process.env.PAI_INFERENCE_CHILD !== "1" && process.env.PAI_DISABLE_RECURSIVE_HOOKS !== "1") {
    return false;
  }
  return RECURSION_GUARDED_HOOKS.has(basename(target));
}

function eventName(input: JsonObject): string {
  return (
    input.hook_event_name ||
    input.hookEventName ||
    input.event_name ||
    input.eventName ||
    input.event ||
    "unknown"
  );
}

function toolName(input: JsonObject): string {
  return (
    input.tool_name ||
    input.toolName ||
    input.tool?.name ||
    input.name ||
    input.tool ||
    "Unknown"
  );
}

function patchPath(patchText: string): string {
  const match = patchText.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)
    || patchText.match(/^\*\*\* Move to: (.+)$/m);
  return match?.[1]?.trim() || "";
}

function normalizeToolInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? {};

  const out: JsonObject = { ...(input as JsonObject) };
  const filePath =
    out.file_path ||
    out.filePath ||
    out.path ||
    out.absolutePath ||
    (typeof out.patchText === "string" ? patchPath(out.patchText) : "");

  if (filePath && !out.file_path) out.file_path = filePath;
  if (out.oldString && !out.old_string) out.old_string = out.oldString;
  if (out.newString && !out.new_string) out.new_string = out.newString;
  if (out.patchText && !out.patch_text) out.patch_text = out.patchText;

  return out;
}

function toolInput(input: JsonObject): unknown {
  return normalizeToolInput(
    input.tool_input ??
    input.toolInput ??
    input.tool?.input ??
    input.arguments ??
    input.args ??
    input.input ??
    {}
  );
}

function toolResult(input: JsonObject): unknown {
  return (
    input.tool_result ??
    input.toolResult ??
    input.tool_response ??
    input.toolResponse ??
    input.result ??
    input.output
  );
}

function promptText(input: JsonObject): string {
  if (typeof input.prompt === "string") return input.prompt;
  if (typeof input.user_prompt === "string") return input.user_prompt;
  if (typeof input.userPrompt === "string") return input.userPrompt;
  if (typeof input.message === "string") return input.message;
  if (Array.isArray(input.messages)) {
    const last = [...input.messages].reverse().find((m) => typeof m?.content === "string");
    if (last) return last.content;
  }
  return "";
}

function cwd(input: JsonObject): string {
  return (
    input.cwd ||
    input.workingDirectory ||
    input.working_directory ||
    input.session?.cwd ||
    input.session?.workingDirectory ||
    process.cwd()
  );
}

function transcriptPath(input: JsonObject): string | undefined {
  return (
    input.transcript_path ||
    input.transcriptPath ||
    input.session?.transcript_path ||
    input.session?.transcriptPath ||
    input.session?.logPath ||
    input.logPath
  );
}

function lastAssistantMessage(input: JsonObject): string {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  if (typeof input.lastAssistantMessage === "string") return input.lastAssistantMessage;
  if (!Array.isArray(input.messages)) return "";
  const last = [...input.messages].reverse().find((m) => {
    const role = String(m?.role || m?.type || "").toLowerCase();
    return role === "assistant" && typeof m?.content === "string";
  });
  return last?.content || "";
}

function normalize(input: JsonObject, framework: string): JsonObject {
  const normalizedCwd = cwd(input);
  const normalizedToolResult = toolResult(input);
  return {
    ...input,
    framework,
    session_id:
      input.session_id ||
      input.sessionId ||
      input.session?.id ||
      process.env.CODEX_SESSION_ID ||
      process.env.OPENCODE_SESSION_ID ||
      "pai-framework-session",
    cwd: normalizedCwd,
    transcript_path: transcriptPath(input),
    last_assistant_message: lastAssistantMessage(input),
    hook_event_name: eventName(input),
    tool_name: toolName(input),
    tool_input: toolInput(input),
    tool_result: normalizedToolResult,
    tool_response: normalizedToolResult,
    prompt: promptText(input),
  };
}

function captureStdout(stdout: string): CapturedOutput {
  const captured: CapturedOutput = { json: [], text: [] };
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        captured.json.push(parsed as JsonObject);
        continue;
      }
    } catch {}
    captured.text.push(line);
  }
  return captured;
}

function systemReminderContexts(lines: string[]): string[] {
  const text = lines.join("\n");
  const contexts: string[] = [];
  for (const match of text.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)) {
    const context = match[1]?.trim();
    if (context) contexts.push(context);
  }
  return contexts;
}

function mergeCapturedJson(merged: MergedHookOutput, entries: JsonObject[]): "continue" | "stop" {
  for (const entry of entries) {
    if (typeof entry.decision === "string") {
      merged.decision = entry;
      return "stop";
    }

    if (typeof entry.continue === "boolean") {
      merged.continueValue = merged.continueValue ?? entry.continue;
    }

    const hookOutput = entry.hookSpecificOutput;
    if (!hookOutput || typeof hookOutput !== "object") continue;

    if (typeof hookOutput.hookEventName === "string") {
      merged.hookEventName = merged.hookEventName || hookOutput.hookEventName;
    }

    const permissionDecision = String(hookOutput.permissionDecision || "");
    if (permissionDecision && permissionDecision !== "allow") {
      merged.permission = hookOutput;
      return "stop";
    }

    if ("updatedInput" in hookOutput) {
      merged.updatedInput = hookOutput.updatedInput;
      merged.hookEventName = merged.hookEventName || hookOutput.hookEventName;
    }

    if (typeof hookOutput.additionalContext === "string" && hookOutput.additionalContext.trim()) {
      merged.additionalContext.push(hookOutput.additionalContext);
      merged.hookEventName = merged.hookEventName || hookOutput.hookEventName;
    }
  }
  return "continue";
}

function emitMergedOutput(merged: MergedHookOutput, fallbackEventName: string): void {
  if (merged.decision) {
    console.log(JSON.stringify(merged.decision));
    return;
  }

  if (merged.permission) {
    console.log(JSON.stringify({ hookSpecificOutput: merged.permission }));
    return;
  }

  const hookSpecificOutput: JsonObject = {};
  if (merged.hookEventName || merged.updatedInput !== undefined || merged.additionalContext.length > 0) {
    hookSpecificOutput.hookEventName = merged.hookEventName || fallbackEventName;
  }
  if (merged.updatedInput !== undefined) {
    hookSpecificOutput.permissionDecision = "allow";
    hookSpecificOutput.updatedInput = merged.updatedInput;
  }
  if (merged.additionalContext.length > 0) {
    hookSpecificOutput.additionalContext = merged.additionalContext.join("\n\n");
  }

  if (Object.keys(hookSpecificOutput).length > 0) {
    console.log(JSON.stringify({ hookSpecificOutput }));
    return;
  }

  if (merged.continueValue === false) {
    console.log(JSON.stringify({ continue: false }));
  }
}

async function main() {
  const targets = targetArgs();
  if (targets.length === 0) {
    console.error("[PAI FrameworkHookAdapter] Missing --target <hook-file>");
    process.exit(1);
  }

  const framework = argValue("--framework") || process.env.PAI_FRAMEWORK || "codex";
  const hooksDir = import.meta.dir;
  const frameworkDir = resolve(join(hooksDir, ".."));
  const paiDir = existingEnvPath("PAI_DIR") || join(frameworkDir, "PAI");
  const dataDir = fallbackDataDir();
  const settingsPath = existingEnvPath("PAI_SETTINGS_PATH") || join(frameworkDir, "settings.json");
  const configDir = fallbackConfigDir();

  let input: JsonObject = {};
  const raw = await Bun.stdin.text();
  if (raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
    }
  }

  const normalizedInput = normalize(input, framework);
  const normalized = JSON.stringify(normalizedInput);
  const fallbackHookEventName = eventName(input);
  const merged: MergedHookOutput = { additionalContext: [] };
  const runId = `pai-hook-run-${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
  const eventForLog = fallbackHookEventName || (input.hook_event_name ? String(input.hook_event_name) : "unknown");
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const targetArg = targets[targetIndex];
    const targetPath = resolve(join(hooksDir, targetArg));
    if (!existsSync(targetPath)) {
      console.error(`[PAI FrameworkHookAdapter] Target hook not found: ${targetPath}`);
      process.exit(1);
    }
    if (shouldSkipForNestedInference(targetPath)) {
      runLogForTargetSkip(
        runId,
        framework,
        normalizedInput,
        targetPath,
        "nested-inference-skip",
        targetIndex,
        targets.length,
        dataDir,
        eventForLog
      );
      continue;
    }

    const extension = extname(targetPath);
    const runner = extension === ".sh" ? (Bun.which("bash") || "") : process.execPath;
    if (!runner) {
      runLogForTargetSkip(
        runId,
        framework,
        normalizedInput,
        targetPath,
        "runner-unavailable",
        targetIndex,
        targets.length,
        dataDir,
        eventForLog
      );
      continue;
    }
    const childArgs = extension === ".sh" ? [targetPath] : [targetPath];

    const targetTimeoutMs = timeoutMs();
    runLogForTargetStart(
      runId,
      framework,
      normalizedInput,
      targetPath,
      targetTimeoutMs,
      targetIndex,
      targets.length,
      dataDir,
      fallbackHookEventName || input.hook_event_name || "unknown"
    );

    const startEpochMs = Date.now();
    const child = spawnSync(runner, childArgs, {
      input: normalized,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: targetTimeoutMs,
      windowsHide: true,
      env: {
        ...process.env,
        PAI_DIR: paiDir,
        PAI_DATA_DIR: dataDir,
        PAI_FRAMEWORK: framework,
        PAI_FRAMEWORK_DIR: frameworkDir,
        PAI_SETTINGS_PATH: settingsPath,
        PAI_CONFIG_DIR: configDir,
        PAI_IS_SUBAGENT: isSubagentSession(input) ? "1" : process.env.PAI_IS_SUBAGENT || "",
        PAI_PROJECT_DIR: cwd(input),
      },
    });
    const endLog = (statusReason?: string) => runLogForTargetEnd(
      runId,
      framework,
      normalizedInput,
      targetPath,
      {
        status: child.status,
        signal: child.signal,
        error: child.error,
        stdout: child.stdout,
        stderr: child.stderr,
        startEpochMs,
        timeoutMs: targetTimeoutMs,
      },
      statusReason,
      targetIndex,
      targets.length,
      dataDir,
      eventForLog
    );

    if (child.stderr) process.stderr.write(child.stderr);
    const captured = captureStdout(child.stdout || "");
    for (const context of systemReminderContexts(captured.text)) {
      merged.additionalContext.push(context);
      merged.hookEventName = merged.hookEventName || eventForLog;
    }
    for (const line of captured.text) process.stderr.write(`${line}\n`);
    const mergeAction = mergeCapturedJson(merged, captured.json);

    if (child.error) {
      endLog(`child-spawn-error:${child.error.message}`);
      emitMergedOutput(merged, fallbackHookEventName);
      console.error(`[PAI FrameworkHookAdapter] ${basename(targetPath)} failed: ${child.error.message}`);
      process.exit(124);
    }
    if (child.signal) {
      endLog(`child-signal:${child.signal}`);
      emitMergedOutput(merged, fallbackHookEventName);
      console.error(`[PAI FrameworkHookAdapter] ${basename(targetPath)} terminated by signal ${child.signal}`);
      process.exit(124);
    }
    if (child.status === null) {
      endLog("child-status-null");
      emitMergedOutput(merged, fallbackHookEventName);
      console.error(`[PAI FrameworkHookAdapter] ${basename(targetPath)} exited without status`);
      process.exit(124);
    }
    if (child.status === 2) {
      endLog(`child-status-2-block:${childBlockReason(targetPath, child.stderr || "")}`);
      exitAfterChildBlock(framework, targetPath, child.stderr || "", merged, fallbackHookEventName);
    }
    if (child.status !== 0 || mergeAction === "stop") {
      endLog(mergeAction === "stop" ? "merge-stop" : `child-status:${child.status}`);
      emitMergedOutput(merged, fallbackHookEventName);
      process.exit(child.status);
    }
    endLog("completed");
  }

  emitMergedOutput(merged, fallbackHookEventName);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[PAI FrameworkHookAdapter] ${err?.message || err}`);
  process.exit(1);
});
