#!/usr/bin/env bun
/**
 * AgentGuard.hook.ts — command-native foreground/background agent guard.
 *
 * Mirrors Pulse's /hooks/agent-guard behavior for frameworks that execute
 * command hooks instead of HTTP hooks.
 */

const FAST_AGENT_TYPES = ["Explore"];
const FAST_MODELS = ["haiku"];

async function readStdin(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });
    process.stdin.on("error", () => { clearTimeout(timer); resolve(data); });
  });
}

function toolInput(payload: any): Record<string, any> {
  return payload?.tool_input || payload?.toolInput || payload?.input || {};
}

function emit(output: Record<string, any>): void {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: output })}\n`);
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const ti = toolInput(payload);
  if (FAST_AGENT_TYPES.includes(String(ti.subagent_type || "")) || FAST_MODELS.includes(String(ti.model || ""))) return;

  const name = ti.description || ti.name || ti.subagent_type || "unknown";
  if (ti.run_in_background === true) {
    emit({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: `WATCHDOG: Background agent "${name}" launching. If not already running, start an agent watchdog Monitor:\nMonitor({ description: "Agent watchdog", persistent: true, timeout_ms: 3600000, command: "bun $PAI_DIR/TOOLS/AgentWatchdog.ts" })`,
    });
    return;
  }

  if (/##\s*Scope[\s\S]*?Timing:\s*FAST/i.test(String(ti.prompt || ""))) return;

  emit({
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: "Foreground agent warning",
    additionalContext: `WARNING: Foreground agent "${name}" — consider run_in_background: true`,
  });
}

main().catch(() => process.exit(0));
