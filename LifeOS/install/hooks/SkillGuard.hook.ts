#!/usr/bin/env bun
/**
 * SkillGuard.hook.ts — command-native Skill guard for Codex/OpenCode hooks.
 *
 * Claude can call Pulse's /hooks/skill-guard HTTP route directly. Codex uses
 * command hooks, so this mirrors the small synchronous policy locally.
 */

const DEFAULT_BLOCKED_SKILLS = ["keybindings-help"];

function blockedSkills(): string[] {
  const configured = process.env.PAI_BLOCKED_SKILLS || "";
  if (!configured.trim()) return DEFAULT_BLOCKED_SKILLS;
  return configured.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

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

function skillName(payload: any): string {
  const input = payload?.tool_input || payload?.toolInput || payload?.input || {};
  return String(input.skill || input.name || input.command || "").toLowerCase().trim();
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

  const skill = skillName(payload);
  if (!skill || !blockedSkills().includes(skill)) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `BLOCKED: "${skill}" is a known false-positive skill triggered by position bias. The user did NOT ask about keybindings. Continue with the ACTUAL task the user requested.`,
    },
  }) + "\n");
}

main().catch(() => process.exit(0));
