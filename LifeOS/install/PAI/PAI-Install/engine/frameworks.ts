/**
 * Framework target registry for PAI installs.
 *
 * PAI's source bundle is still shared; this layer decides which agent
 * framework owns the top-level instructions, config, and install root.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { FrameworkId, FrameworkTarget } from "./types";

// ── UAI brand env aliases (scoped rename Phase 1) ──────────────────────────
// UAI_* environment variables take precedence over their PAI_* equivalents so
// the installer honors the UAI names. No data is moved; a no-op when unset.
// See PAI/DOCUMENTATION/UaiScopedRenamePlan.md.
for (const key of ["DIR", "DATA_DIR", "CONFIG_DIR", "FRAMEWORK_DIR", "FRAMEWORK"] as const) {
  const uaiVal = process.env[`UAI_${key}`];
  if (uaiVal !== undefined && uaiVal !== "") process.env[`PAI_${key}`] = uaiVal;
}

export const FRAMEWORK_IDS: readonly FrameworkId[] = ["claude", "codex", "opencode"] as const;

const FRAMEWORK_LABELS: Record<FrameworkId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function normalizeFramework(value: string | undefined | null): FrameworkId | null {
  const normalized = (value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return null;
  if (normalized === "claude" || normalized === "claudecode") return "claude";
  if (normalized === "codex" || normalized === "openai" || normalized === "openaicodex") return "codex";
  if (normalized === "opencode" || normalized === "open") return "opencode";
  return null;
}

export function defaultFramework(): FrameworkId {
  return normalizeFramework(process.env.PAI_FRAMEWORK) || "claude";
}

export function getFrameworkTarget(id: FrameworkId = defaultFramework()): FrameworkTarget {
  const home = homeDir();
  const configDir = getPaiConfigDir();

  if (id === "codex") {
    return {
      id,
      displayName: FRAMEWORK_LABELS[id],
      command: "codex",
      installRoot: process.env.CODEX_HOME || join(home, ".codex"),
      configDir,
      instructionFile: "AGENTS.md",
      settingsFile: "config.toml",
      supportsHooks: true,
      supportsSkills: true,
    };
  }

  if (id === "opencode") {
    return {
      id,
      displayName: FRAMEWORK_LABELS[id],
      command: "opencode",
      installRoot: process.env.OPENCODE_CONFIG_DIR || join(home, ".config", "opencode"),
      configDir,
      instructionFile: "AGENTS.md",
      settingsFile: "opencode.json",
      supportsHooks: true,
      supportsSkills: true,
    };
  }

  return {
    id: "claude",
    displayName: FRAMEWORK_LABELS.claude,
    command: "claude",
    installRoot: process.env.CLAUDE_HOME || process.env.PAI_CLAUDE_HOME || join(home, ".claude"),
    configDir,
    instructionFile: "CLAUDE.md",
    settingsFile: "settings.json",
    supportsHooks: true,
    supportsSkills: true,
  };
}

export function getPaiDataDir(): string {
  return process.env.PAI_DATA_DIR || join(homeDir(), ".pai");
}

export function getPaiConfigDir(): string {
  return process.env.PAI_CONFIG_DIR && existsSync(process.env.PAI_CONFIG_DIR)
    ? process.env.PAI_CONFIG_DIR
    : join(homeDir(), ".config", "PAI");
}

export function frameworkChoices(): Array<{ label: string; value: FrameworkId; description: string }> {
  return [
    {
      label: "Claude Code",
      value: "claude",
      description: "Installs PAI into ~/.claude using Claude Code settings, hooks, commands, agents, and skills.",
    },
    {
      label: "Codex",
      value: "codex",
      description: "Installs PAI into CODEX_HOME or ~/.codex, writes AGENTS.md/config.toml, and keeps skills in the Codex home.",
    },
    {
      label: "OpenCode",
      value: "opencode",
      description: "Installs PAI into OPENCODE_CONFIG_DIR or ~/.config/opencode with AGENTS.md, opencode.json, skills, and a PAI plugin.",
    },
  ];
}

export function frameworkCliInstallCommands(id: FrameworkId): string[] {
  switch (id) {
    case "claude":
      return [
        "bun install -g @anthropic-ai/claude-code",
      ];
    case "codex":
      return [
        "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
        "bun install -g @openai/codex",
      ];
    case "opencode":
      return [
        "curl -fsSL https://opencode.ai/install | bash",
        "bun install -g opencode-ai",
      ];
  }
}
