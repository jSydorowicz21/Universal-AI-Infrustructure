type JsonObject = Record<string, any>;

export type FrameworkHookContract = "codex" | "claude" | "opencode";

export type BlockEmission = {
  output?: JsonObject;
  exitCode: number;
};

export function frameworkHookContract(framework: string): FrameworkHookContract {
  const normalized = framework.trim().toLowerCase();
  if (normalized === "codex") return "codex";
  if (normalized === "opencode") return "opencode";
  return "claude";
}

export function blockEmissionForFramework(framework: string, reason: string): BlockEmission {
  const cleaned = reason.trim() || "[PAI SECURITY] Tool call blocked by security policy.";
  const contract = frameworkHookContract(framework);
  if (contract === "codex" || contract === "opencode") {
    return {
      output: {
        decision: "block",
        reason: cleaned,
      },
      exitCode: 0,
    };
  }

  return { exitCode: 2 };
}

export function shouldExitCleanlyOnBlock(framework: string): boolean {
  const contract = frameworkHookContract(framework);
  return contract === "codex" || contract === "opencode";
}
