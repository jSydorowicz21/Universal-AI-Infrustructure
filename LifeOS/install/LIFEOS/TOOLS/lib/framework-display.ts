import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getFrameworkDir } from "./paths";

type JsonObject = Record<string, unknown>;

function normalizeFramework(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function readJson(path: string): JsonObject {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readCodexModel(root: string): string {
  const envModel = firstString(
    process.env.PAI_CODEX_MODEL,
    process.env.PAI_CODEX_MODEL_STANDARD,
    process.env.PAI_CODEX_MODEL_FAST,
  );
  if (envModel) return envModel;

  try {
    const config = readFileSync(join(root, "config.toml"), "utf-8");
    const match = config.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    if (match?.[1]) return match[1].trim();
  } catch {}

  return "gpt-5.5";
}

function readOpenCodeModel(root: string): string {
  const envModel = firstString(
    process.env.PAI_OPENCODE_MODEL,
    process.env.PAI_OPENCODE_MODEL_STANDARD,
    process.env.PAI_OPENCODE_MODEL_FAST,
  );
  if (envModel) return envModel;

  const config = readJson(join(root, "opencode.json"));
  const provider = config.provider && typeof config.provider === "object" ? config.provider as JsonObject : {};
  return firstString(config.model, provider.model, "default");
}

function readClaudeModel(root: string): string {
  const settings = readJson(join(root, "settings.json"));
  const env = settings.env && typeof settings.env === "object" ? settings.env as JsonObject : {};
  return firstString(
    process.env.PAI_CLAUDE_MODEL,
    process.env.ANTHROPIC_MODEL,
    process.env.CLAUDE_MODEL,
    env.ANTHROPIC_MODEL,
    env.CLAUDE_MODEL,
    "default",
  );
}

export function activeFrameworkId(root = getFrameworkDir()): string {
  const envFramework = normalizeFramework(process.env.PAI_FRAMEWORK);
  if (envFramework) {
    if (envFramework === "openai" || envFramework === "openaicodex") return "codex";
    if (envFramework === "open" || envFramework === "opencode") return "opencode";
    if (envFramework === "claudecode" || envFramework === "claude") return "claude";
  }

  const settings = readJson(join(root, "settings.json"));
  const pai = settings.pai && typeof settings.pai === "object" ? settings.pai as JsonObject : {};
  const settingsFramework = normalizeFramework(pai.framework);
  if (settingsFramework) return settingsFramework;
  if (existsSync(join(root, "config.toml")) && existsSync(join(root, "hooks.json"))) return "codex";
  if (existsSync(join(root, "opencode.json"))) return "opencode";
  return "claude";
}

export function frameworkDisplayName(framework = activeFrameworkId()): string {
  if (framework === "codex") return "Codex";
  if (framework === "opencode") return "OpenCode";
  if (framework === "claude") return "Claude";
  return framework || "PAI";
}

export function activeModelLabel(root = getFrameworkDir(), framework = activeFrameworkId(root)): string {
  if (framework === "codex") return readCodexModel(root);
  if (framework === "opencode") return readOpenCodeModel(root);
  if (framework === "claude") return readClaudeModel(root);
  return "default";
}

export function activeRuntimeLabel(root = getFrameworkDir()): string {
  const framework = activeFrameworkId(root);
  const model = activeModelLabel(root, framework);
  return `${frameworkDisplayName(framework)} ${model}`.trim();
}
