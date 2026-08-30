export function isSubagentSession(input?: Record<string, unknown>): boolean {
  if (truthy(process.env.PAI_IS_SUBAGENT)) return true;
  if (process.env.CLAUDE_CODE_AGENT_TASK_ID) return true;
  if (process.env.CLAUDE_AGENT_TYPE) return true;
  if (process.env.CODEX_AGENT_TYPE || process.env.CODEX_AGENT_ID) return true;
  if (process.env.OPENCODE_AGENT_TYPE || process.env.OPENCODE_AGENT_ID) return true;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.env.PAI_PROJECT_DIR || "";
  if (/[\\/]\.claude[\\/]Agents[\\/]/i.test(projectDir)) return true;
  if (/[\\/]agents[\\/][^\\/]+$/i.test(projectDir) && truthy(process.env.PAI_FRAMEWORK)) return true;

  if (!input) return false;
  if (truthy(input.is_subagent) || truthy(input.isSubagent) || truthy(input.subagent)) return true;
  if (typeof input.agent_type === "string" || typeof input.agentType === "string") return true;
  if (typeof input.parent_session_id === "string" || typeof input.parentSessionId === "string") return true;
  const source = stringValue(input.source || input.event || input.type).toLowerCase();
  if (source.includes("subagent") || source.includes("agent.start")) return true;

  const agent = input.agent;
  if (agent && typeof agent === "object") return true;
  const session = input.session;
  if (session && typeof session === "object") {
    const record = session as Record<string, unknown>;
    if (truthy(record.is_subagent) || truthy(record.isSubagent)) return true;
    if (typeof record.parent_id === "string" || typeof record.parentId === "string") return true;
  }
  return false;
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
