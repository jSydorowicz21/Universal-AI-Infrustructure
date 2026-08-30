import { getActiveFramework, type FrameworkId } from "./transcripts";
import { getConfigDir, getFrameworkDir, getPaiDataDir, getPaiDir } from "./paths";

export type FrameworkAgentMode = "print" | "interactive";

export interface FrameworkAgentOptions {
  cwd: string;
  mode?: FrameworkAgentMode;
  allowedTools?: string;
  model?: string;
  timeoutMs?: number;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface FrameworkAgentCommand {
  framework: FrameworkId;
  label: string;
  command: string;
  args: string[];
  input?: string;
  env: Record<string, string>;
}

export interface FrameworkAgentResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  framework: FrameworkId;
  label: string;
}

export const DEFAULT_AGENT_TOOLS =
  "Edit,Write,Bash,Read,Glob,Grep,WebFetch,WebSearch,Task,TaskCreate,TaskUpdate,TaskList,NotebookEdit";

export const DEFAULT_WORKER_TOOLS =
  "Edit,Write,Bash,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit";

export function frameworkAgentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { ...source } as Record<string, string>;
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.PAI_DIR = getPaiDir();
  env.PAI_DATA_DIR = getPaiDataDir();
  env.PAI_FRAMEWORK = getActiveFramework();
  env.PAI_FRAMEWORK_DIR = getFrameworkDir();
  env.PAI_CONFIG_DIR = getConfigDir();
  return env;
}

function maybeModelArg(framework: FrameworkId, model?: string): string[] {
  if (!model) return [];
  // claude, codex, and opencode all accept `--model <model>` on their run/exec
  // entrypoints. OpenCode expects the provider/model form (e.g.
  // `anthropic/claude-sonnet-4-6`); the caller is responsible for that shape.
  if (framework === "claude") return ["--model", model];
  if (framework === "codex") return ["--model", model];
  if (framework === "opencode") return ["--model", model];
  return [];
}

export function buildFrameworkAgentCommand(
  prompt: string,
  opts: FrameworkAgentOptions,
): FrameworkAgentCommand {
  const framework = getActiveFramework();
  const mode = opts.mode ?? "print";
  const env = frameworkAgentEnv();

  if (framework === "codex") {
    const command = process.env.PAI_CODEX_BIN || Bun.which("codex") || "codex";
    if (mode === "interactive") {
      return {
        framework,
        label: "codex",
        command,
        args: [
          "--cd", opts.cwd,
          ...maybeModelArg(framework, opts.model ?? process.env.PAI_CODEX_MODEL),
          prompt,
        ],
        env,
      };
    }

    return {
      framework,
      label: "codex exec",
      command,
      args: [
        "exec",
        "--sandbox", opts.sandbox ?? "workspace-write",
        "--skip-git-repo-check",
        "--cd", opts.cwd,
        ...maybeModelArg(framework, opts.model ?? process.env.PAI_CODEX_MODEL),
        "-",
      ],
      input: prompt,
      env,
    };
  }

  if (framework === "opencode") {
    // Mirror the Codex PAI_CODEX_BIN override so an explicit binary can be pinned.
    // Model propagation: `opencode run` accepts `-m, --model <provider/model>`
    // (verified against `opencode run --help`). Forward an explicit opts.model,
    // falling back to PAI_OPENCODE_MODEL (parity with PAI_CODEX_MODEL). When no
    // model is supplied the base command stays the bare `opencode run -` contract.
    // Flags precede the `-` stdin sentinel so they parse as options, not message.
    const command = process.env.PAI_OPENCODE_BIN || Bun.which("opencode") || "opencode";
    return {
      framework,
      label: "opencode run",
      command,
      args: [
        "run",
        ...maybeModelArg(framework, opts.model ?? process.env.PAI_OPENCODE_MODEL),
        "-",
      ],
      input: prompt,
      env,
    };
  }

  const command = process.env.PAI_CLAUDE_BIN || Bun.which("claude") || "claude";
  const allowedTools = opts.allowedTools ?? DEFAULT_AGENT_TOOLS;
  const model = opts.model ?? process.env.PAI_CLAUDE_MODEL ?? process.env.ANTHROPIC_MODEL ?? process.env.CLAUDE_MODEL;
  const args = mode === "interactive"
    ? [
        prompt,
        "--allowedTools", allowedTools,
        ...maybeModelArg(framework, model),
      ]
    : [
        "-p", prompt,
        "--allowedTools", allowedTools,
        ...maybeModelArg(framework, model),
      ];

  return {
    framework,
    label: mode === "interactive" ? "claude" : "claude -p",
    command,
    args,
    env,
  };
}

export async function runFrameworkAgent(
  prompt: string,
  opts: FrameworkAgentOptions,
): Promise<FrameworkAgentResult> {
  const spec = buildFrameworkAgentCommand(prompt, opts);
  const proc = Bun.spawn([spec.command, ...spec.args], {
    cwd: opts.cwd,
    env: spec.env,
    stdin: spec.input ? new Blob([spec.input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  const timer = opts.timeoutMs ? setTimeout(() => proc.kill("SIGTERM"), opts.timeoutMs) : null;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);

  return {
    exitCode,
    stdout,
    stderr,
    framework: spec.framework,
    label: spec.label,
  };
}
