import type { FirstPartyAdapterId } from "./adapters";

export interface ToolProviderManifest {
  id: string;
  command: string;
  args?: string[];
  tools: string[];
  env: Record<string, string>;
  allowedEnv: string[];
  auth?: "none" | "environment" | "interactive";
  approvals?: "required" | "optional" | "unsupported";
  sandbox?: "required" | "preferred" | "unsupported";
  toolFilter?: string[];
}
export interface RegisteredToolProvider {
  manifest: Omit<ToolProviderManifest, "env"> & { env: Record<string, string> };
  audit: string;
  execute(tool: string, input: Record<string, unknown>): Promise<unknown>;
  evidenceScope: "tool-plane-only";
}
export interface LoweredIntent { adapterId: FirstPartyAdapterId; nativeName?: string; config: Record<string, unknown>; losses: string[] }
export interface CommandIntent { id: string; prompt: string }
export interface AgentIntent { id: string; instructions: string; model?: string; reasoning?: string }
export interface PromptIntent { id: string; content: string; authority: "system" | "developer" | "context" | "user" }

export function redactEnvironment(environment: Record<string, string>, allowedNames: readonly string[]): { allowed: Record<string, string>; redacted: Record<string, string> } {
  const allowedNameSet = new Set(allowedNames);
  const allowed: Record<string, string> = {};
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (allowedNameSet.has(name)) allowed[name] = value;
    else redacted[name] = "[REDACTED]";
  }
  return { allowed, redacted };
}

export function registerToolProvider(input: ToolProviderManifest): RegisteredToolProvider {
  const scrubbed = redactEnvironment(input.env, input.allowedEnv);
  const manifest = { ...input, env: scrubbed.allowed };
  const audit = JSON.stringify({ id: input.id, command: input.command, tools: input.tools, env: { ...scrubbed.allowed, ...scrubbed.redacted }, evidenceScope: "tool-plane-only" });
  return {
    manifest,
    audit,
    evidenceScope: "tool-plane-only",
    async execute(tool, value) {
      if (!input.tools.includes(tool)) throw new Error(`Tool ${tool} is not allowlisted for provider ${input.id}`);
      if (tool === "uai_echo") return { ...value, provider: input.id };
      throw new Error(`Fixture executor has no implementation for ${tool}`);
    },
  };
}

export function lowerCommandIntent(adapterId: FirstPartyAdapterId, intent: CommandIntent): LoweredIntent {
  const nativeName = `/${intent.id}`;
  if (adapterId === "claude") return { adapterId, nativeName, config: { commandFile: `.claude/commands/${intent.id}.md`, content: intent.prompt }, losses: [] };
  if (adapterId === "omp") return { adapterId, nativeName, config: { command: intent.id, prompt: intent.prompt }, losses: [] };
  if (adapterId === "codex") return { adapterId, config: { instruction: intent.prompt }, losses: ["no native slash-command installation surface proven"] };
  return { adapterId, nativeName, config: { command: intent.id, template: intent.prompt }, losses: ["command namespace and argument semantics may differ"] };
}

export function lowerAgentIntent(adapterId: FirstPartyAdapterId, intent: AgentIntent): LoweredIntent {
  if (adapterId === "claude") return { adapterId, nativeName: intent.id, config: { agentFile: `.claude/agents/${intent.id}.md`, instructions: intent.instructions, model: intent.model }, losses: intent.reasoning ? ["reasoning knob is not portable"] : [] };
  if (adapterId === "omp") return { adapterId, nativeName: intent.id, config: { agent: { name: intent.id, prompt: intent.instructions, model: intent.model } }, losses: intent.reasoning ? ["reasoning knob requires adapter-specific evidence"] : [] };
  if (adapterId === "codex") return { adapterId, config: { instructions: intent.instructions }, losses: ["no native reusable agent surface proven", ...(intent.model ? ["model selection remains launch-scoped"] : []), ...(intent.reasoning ? ["reasoning setting is adapter-specific"] : [])] };
  return { adapterId, nativeName: intent.id, config: { agent: intent.id, prompt: intent.instructions, model: intent.model }, losses: intent.reasoning ? ["reasoning setting unsupported"] : [] };
}

export function lowerPromptIntent(adapterId: FirstPartyAdapterId, intent: PromptIntent): LoweredIntent & { effectiveAuthority: PromptIntent["authority"] } {
  if (adapterId === "claude") return { adapterId, config: { appendSystemPrompt: intent.content }, losses: [], effectiveAuthority: intent.authority };
  if (adapterId === "omp") return { adapterId, config: { appendSystemFile: "APPEND_SYSTEM.md", content: intent.content }, losses: [], effectiveAuthority: intent.authority };
  if (adapterId === "codex") return { adapterId, config: { instructionFile: "AGENTS.md", content: intent.content }, losses: intent.authority === "system" ? ["system authority not proven; lowered to context"] : [], effectiveAuthority: intent.authority === "system" ? "context" : intent.authority };
  return { adapterId, config: { instructionFile: "AGENTS.md", content: intent.content }, losses: intent.authority === "system" ? ["system authority not proven; lowered to context"] : [], effectiveAuthority: intent.authority === "system" ? "context" : intent.authority };
}
