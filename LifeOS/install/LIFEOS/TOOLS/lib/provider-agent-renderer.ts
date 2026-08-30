export type ProviderAgentTargetId = "codex" | "opencode";

export type PaiAgentDefinition = {
  name: string;
  description: string;
  initialPrompt?: string;
  body: string;
};

type ProviderAgentTarget = {
  id: ProviderAgentTargetId;
  displayName: string;
  instructionFile: string;
  frameworkRootFallback: string;
};

const PROVIDER_AGENT_TARGETS: Record<ProviderAgentTargetId, ProviderAgentTarget> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    instructionFile: "AGENTS.md",
    frameworkRootFallback: "~/.codex",
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    instructionFile: "AGENTS.md",
    frameworkRootFallback: "~/.config/opencode",
  },
};

export function slugifyPaiAgentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "pai-agent";
}

function paiPathBootstrap(target: ProviderAgentTarget): string {
  return [
    "PAI path bootstrap: If `$PAI_DIR` is unset, resolve it before reading PAI files.",
    "Use `$PAI_DATA_DIR` if set; otherwise use `~/.pai`.",
    "Read `$PAI_DATA_DIR/framework.json`; if it has `root`, treat `$PAI_DIR` as `<root>/PAI` and `$PAI_FRAMEWORK_DIR` as `<root>`.",
    `If framework state is missing, treat \`$PAI_DIR\` as \`${target.frameworkRootFallback}/PAI\`.`,
    "Treat `$PAI_DATA_DIR/MEMORY` and `$PAI_DATA_DIR/USER` as the shared memory and user-context roots.",
  ].join("\n");
}

function adaptProviderText(text: string, target: ProviderAgentTarget): string {
  return text
    .replace(/\bCLAUDE\.md\b/g, target.instructionFile)
    .replace(/\bClaude Code\b/g, target.displayName)
    .replace(/\bbuilt-in Claude Code agent\b/g, `${target.displayName} bundled agent`)
    .replace(/\bAGENTS\.md or AGENTS\.md\b/g, "AGENTS.md")
    .replace(/~\/\.claude\/PAI/g, "$PAI_DIR")
    .replace(/~\/\.claude/g, "$PAI_FRAMEWORK_DIR")
    .replace(/\$PAI_FRAMEWORK_DIR\/PAI/g, "$PAI_DIR");
}

export function renderPaiAgentInstructions(
  targetId: ProviderAgentTargetId,
  definition: PaiAgentDefinition
): string {
  const target = PROVIDER_AGENT_TARGETS[targetId];
  const parts = [
    `This PAI agent was rendered from the provider-neutral PAI agent contract for ${target.displayName}.`,
    paiPathBootstrap(target),
    definition.initialPrompt ? `Startup context: ${definition.initialPrompt}` : "",
    definition.body,
  ].filter(Boolean);

  return adaptProviderText(parts.join("\n\n"), target);
}
