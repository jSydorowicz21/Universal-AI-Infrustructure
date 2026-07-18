#!/usr/bin/env bun
/**
 * OpenCodeFrameworkAgentExecutionSmokeTest
 *
 * Runtime (not source-string) proof that the exported OpenCode launcher path
 * actually invokes `opencode run -` with the contracted args, cwd, and stdin.
 * We build a fully isolated temp HOME/USERPROFILE/OPENCODE_CONFIG_DIR/
 * PAI_DATA_DIR/PAI_CONFIG_DIR and a temp PATH containing a fake `opencode` shim
 * (plus `opencode.cmd` on Windows). The shim records the argv + cwd + stdin +
 * a few env markers it receives and exits 0, so no live OpenCode auth or
 * provider is touched.
 *
 * Because `Bun.which("opencode")` (the no-options form the launcher uses)
 * resolves against the *startup* environment, the temp PATH must be in place
 * before the process starts. So the parent stages the temp env + shims and
 * re-execs itself; the child inherits the patched PATH at startup and drives
 * the real launcher:
 * - runFrameworkAgent() -> `opencode run -`, prompt on stdin, cwd = opts.cwd.
 * - PAI_OPENCODE_BIN overrides Bun.which (parity with PAI_CODEX_BIN).
 * - opts.model propagates: an explicit model becomes `--model <provider/model>`
 *   (verified against `opencode run --help`) while the base command stays
 *   `opencode run -`; PAI_OPENCODE_MODEL supplies the default (parity with
 *   PAI_CODEX_MODEL).
 *
 * - inference() under OpenCode invokes `opencode run --pure -`, sends the
 *   combined system/user prompt on stdin, honors PAI_OPENCODE_BIN and
 *   PAI_OPENCODE_MODEL_<LEVEL>, and scrubs Anthropic credentials.
 *
 * Complements the source/config coverage in FrameworkSmokeTest.ts (config gen +
 * plugin transcript) by executing the real launcher end-to-end against a
 * controllable binary, mirroring CodexFrameworkAgentExecutionSmokeTest.ts.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

type Check = { name: string; passed: boolean; detail: string };

const checks: Check[] = [];
function check(name: string, passed: boolean, detail = ""): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

interface Recording {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

function readRecording(path: string): Recording {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  return {
    argv: Array.isArray(parsed.argv) ? parsed.argv : [],
    stdin: typeof parsed.stdin === "string" ? parsed.stdin : "",
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
    env: parsed.env && typeof parsed.env === "object" ? parsed.env : {},
  };
}

const RECORDER_SOURCE = `
const recordFile = process.env.FAKE_OPENCODE_RECORD_FILE;
const argv = process.argv.slice(2);
let stdin = "";
try {
  stdin = await Bun.stdin.text();
} catch {}
if (recordFile) {
  await Bun.write(recordFile, JSON.stringify({
    argv,
    stdin,
    cwd: process.cwd(),
    env: {
      PAI_FRAMEWORK: process.env.PAI_FRAMEWORK,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDECODE: process.env.CLAUDECODE,
      PAI_INFERENCE_CHILD: process.env.PAI_INFERENCE_CHILD,
      PAI_DISABLE_RECURSIVE_HOOKS: process.env.PAI_DISABLE_RECURSIVE_HOOKS,
    },
  }));
}
process.stdout.write("FAKE_OPENCODE_OK\\n");
process.exit(0);
`;

// ---------------------------------------------------------------------------
// Parent: stage isolated env + fake opencode shim, then re-exec self as child.
// `Bun.which("opencode")` reads the startup environment, so the shim must be on
// PATH before the test process begins — hence the re-exec.
// ---------------------------------------------------------------------------
function runParent(): number {
  const tempRoot = mkdtempSync(join(tmpdir(), "pai-opencode-exec-smoke-"));
  try {
    const home = join(tempRoot, "home");
    const opencodeConfig = join(tempRoot, "opencode-config");
    const paiData = join(tempRoot, "pai-data");
    const configDir = join(tempRoot, "config");
    const binDir = join(tempRoot, "bin");
    const workspace = join(tempRoot, "workspace");
    const recordDir = join(tempRoot, "record");
    for (const dir of [home, opencodeConfig, paiData, configDir, binDir, workspace, recordDir]) {
      mkdirSync(dir, { recursive: true });
    }

    // Fake opencode shim: records argv + cwd + stdin via a tiny Bun recorder, then exits 0.
    const recorderPath = join(binDir, "opencode-recorder.ts");
    writeFileSync(recorderPath, RECORDER_SOURCE);
    if (process.platform === "win32") {
      // .cmd is what `Bun.which("opencode")` resolves to on Windows (PATHEXT) and
      // what a packaged opencode install ships, so exercising it proves the
      // launcher spawns .cmd shims correctly.
      writeFileSync(join(binDir, "opencode.cmd"), `@echo off\r\nbun "${recorderPath}" %*\r\nexit /b %errorlevel%\r\n`);
    } else {
      const shim = join(binDir, "opencode");
      writeFileSync(shim, `#!/usr/bin/env bash\nexec bun "${recorderPath}" "$@"\n`);
      chmodSync(shim, 0o755);
    }

    // Build the child's startup environment. Windows stores the search path
    // under `Path`, not `PATH`; prepend to the existing key so the child resolves
    // our shim ahead of any real opencode install.
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnv[key] = value;
    }
    const pathKey = Object.keys(childEnv).find((k) => k.toLowerCase() === "path") || "PATH";
    childEnv[pathKey] = binDir + delimiter + (childEnv[pathKey] || "");
    childEnv.PAI_FAKE_OPENCODE_CHILD = "1";
    childEnv.PAI_FRAMEWORK = "opencode";
    childEnv.HOME = home;
    childEnv.USERPROFILE = home;
    childEnv.OPENCODE_CONFIG_DIR = opencodeConfig;
    childEnv.PAI_DATA_DIR = paiData;
    childEnv.PAI_CONFIG_DIR = configDir;
    childEnv.FAKE_OPENCODE_BIN_DIR = binDir;
    childEnv.FAKE_OPENCODE_WORKSPACE = workspace;
    childEnv.FAKE_OPENCODE_RECORD_DIR = recordDir;
    // Inject API credentials so the child can prove frameworkAgentEnv() scrubs them.
    childEnv.ANTHROPIC_API_KEY = "sk-ant-FAKE-should-be-scrubbed";
    childEnv.ANTHROPIC_AUTH_TOKEN = "FAKE-auth-should-be-scrubbed";
    childEnv.CLAUDECODE = "1";
    delete childEnv.PAI_DIR;
    delete childEnv.PAI_FRAMEWORK_DIR;
    delete childEnv.PAI_OPENCODE_BIN;
    delete childEnv.PAI_OPENCODE_MODEL;
    delete childEnv.PAI_OPENCODE_MODEL_FAST;
    delete childEnv.PAI_OPENCODE_MODEL_STANDARD;
    delete childEnv.PAI_OPENCODE_MODEL_SMART;

    const child = Bun.spawnSync([process.execPath, import.meta.path], {
      env: childEnv,
      stdout: "inherit",
      stderr: "inherit",
      windowsHide: true,
    });
    return child.exitCode ?? 1;
  } finally {
    const resolved = resolve(tempRoot);
    if (dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-opencode-exec-smoke-")) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Child: PATH already patched at startup; drive the real exported launcher.
// ---------------------------------------------------------------------------
async function runChild(): Promise<void> {
  const { runFrameworkAgent, buildFrameworkAgentCommand } = await import("./lib/framework-agent");
  const { inference } = await import("./Inference");
  const { getActiveFramework } = await import("./lib/transcripts");

  const binDir = process.env.FAKE_OPENCODE_BIN_DIR!;
  const workspace = process.env.FAKE_OPENCODE_WORKSPACE!;
  const recordDir = process.env.FAKE_OPENCODE_RECORD_DIR!;

  const resolvedOpenCode = Bun.which("opencode");
  check(
    "fake opencode shim resolves ahead of any real opencode",
    Boolean(resolvedOpenCode && resolve(resolvedOpenCode).startsWith(resolve(binDir))),
    resolvedOpenCode || "Bun.which('opencode') returned null",
  );

  check(
    "active framework resolves to opencode",
    getActiveFramework() === "opencode",
    getActiveFramework(),
  );

  // --- 1. Framework agent path (runFrameworkAgent) ---------------------------
  const agentRecord = join(recordDir, "agent.json");
  const agentPrompt = "PAI-FAKE-OPENCODE::framework-agent prompt payload";
  process.env.FAKE_OPENCODE_RECORD_FILE = agentRecord;
  const agentResult = await runFrameworkAgent(agentPrompt, { cwd: workspace });

  check(
    "runFrameworkAgent invoked fake opencode (exit 0, FAKE_OPENCODE_OK)",
    agentResult.exitCode === 0 && agentResult.framework === "opencode" && agentResult.stdout.includes("FAKE_OPENCODE_OK"),
    `exit=${agentResult.exitCode} framework=${agentResult.framework} label=${agentResult.label} stderr=${agentResult.stderr.trim().slice(0, 200)}`,
  );

  const agent = readRecording(agentRecord);
  check(
    "framework agent runs `opencode run` with stdin sentinel",
    agent.argv.length === 2 && agent.argv[0] === "run" && agent.argv[1] === "-",
    agent.argv.join(" "),
  );
  check(
    "framework agent spawns opencode in the requested cwd",
    resolve(agent.cwd) === resolve(workspace),
    `cwd=${agent.cwd} expected=${workspace}`,
  );
  check(
    "framework agent delivers the prompt payload on stdin",
    agent.stdin === agentPrompt,
    JSON.stringify(agent.stdin.slice(0, 120)),
  );
  check(
    "framework agent env sets PAI_FRAMEWORK=opencode and scrubs Anthropic credentials",
    agent.env.PAI_FRAMEWORK === "opencode" &&
      agent.env.ANTHROPIC_API_KEY === undefined &&
      agent.env.ANTHROPIC_AUTH_TOKEN === undefined,
    `PAI_FRAMEWORK=${agent.env.PAI_FRAMEWORK} ANTHROPIC_API_KEY=${agent.env.ANTHROPIC_API_KEY ?? "<unset>"}`,
  );

  // --- 1b. PAI_OPENCODE_BIN override (parity with PAI_CODEX_BIN) --------------
  // The launcher must prefer an explicit PAI_OPENCODE_BIN over Bun.which. We use
  // buildFrameworkAgentCommand (pure, no spawn) so the pinned path need not exist.
  const sentinelBin = join(binDir, "pinned-opencode-sentinel");
  const prevBin = process.env.PAI_OPENCODE_BIN;
  process.env.PAI_OPENCODE_BIN = sentinelBin;
  const pinnedSpec = buildFrameworkAgentCommand("PAI-FAKE-OPENCODE::override probe", { cwd: workspace });
  if (prevBin === undefined) delete process.env.PAI_OPENCODE_BIN;
  else process.env.PAI_OPENCODE_BIN = prevBin;
  check(
    "PAI_OPENCODE_BIN overrides Bun.which for the opencode command",
    pinnedSpec.command === sentinelBin && pinnedSpec.framework === "opencode",
    `command=${pinnedSpec.command} expected=${sentinelBin}`,
  );

  // --- 1c. Model propagation -------------------------------------------------
  // OpenCode's `run` command accepts `--model <provider/model>`; explicit model
  // requests are forwarded while the no-model path above remains `run -`.
  const modeledSpec = buildFrameworkAgentCommand("PAI-FAKE-OPENCODE::model probe", {
    cwd: workspace,
    model: "anthropic/claude-sonnet-4-6",
  });
  check(
    "opts.model propagates to opencode as --model provider/model",
    modeledSpec.args.length === 4 &&
      modeledSpec.args[0] === "run" &&
      modeledSpec.args[1] === "--model" &&
      modeledSpec.args[2] === "anthropic/claude-sonnet-4-6" &&
      modeledSpec.args[3] === "-",
    modeledSpec.args.join(" "),
  );

  const prevDefaultModel = process.env.PAI_OPENCODE_MODEL;
  process.env.PAI_OPENCODE_MODEL = "anthropic/claude-haiku-4-5";
  const defaultModeledSpec = buildFrameworkAgentCommand("PAI-FAKE-OPENCODE::default model probe", {
    cwd: workspace,
  });
  if (prevDefaultModel === undefined) delete process.env.PAI_OPENCODE_MODEL;
  else process.env.PAI_OPENCODE_MODEL = prevDefaultModel;
  check(
    "PAI_OPENCODE_MODEL supplies default framework-agent model",
    defaultModeledSpec.args.join(" ") === "run --model anthropic/claude-haiku-4-5 -",
    defaultModeledSpec.args.join(" "),
  );

  // --- 2. Inference path ------------------------------------------------------
  const inferenceRecord = join(recordDir, "inference.json");
  const prevRecord = process.env.FAKE_OPENCODE_RECORD_FILE;
  const prevBinForInference = process.env.PAI_OPENCODE_BIN;
  const prevFastModel = process.env.PAI_OPENCODE_MODEL_FAST;
  process.env.FAKE_OPENCODE_RECORD_FILE = inferenceRecord;
  process.env.PAI_OPENCODE_BIN = resolvedOpenCode!;
  process.env.PAI_OPENCODE_MODEL_FAST = "anthropic/claude-haiku-4-5";
  const inferenceResult = await inference({
    systemPrompt: "PAI fake OpenCode inference system prompt",
    userPrompt: "PAI fake OpenCode inference user prompt",
    level: "fast",
    timeout: 10_000,
  });
  if (prevRecord === undefined) delete process.env.FAKE_OPENCODE_RECORD_FILE;
  else process.env.FAKE_OPENCODE_RECORD_FILE = prevRecord;
  if (prevBinForInference === undefined) delete process.env.PAI_OPENCODE_BIN;
  else process.env.PAI_OPENCODE_BIN = prevBinForInference;
  if (prevFastModel === undefined) delete process.env.PAI_OPENCODE_MODEL_FAST;
  else process.env.PAI_OPENCODE_MODEL_FAST = prevFastModel;

  check(
    "inference invokes fake opencode under active OpenCode framework",
    inferenceResult.success && inferenceResult.output.includes("FAKE_OPENCODE_OK"),
    `success=${inferenceResult.success} error=${inferenceResult.error ?? "<none>"}`,
  );

  const inferenceCall = readRecording(inferenceRecord);
  check(
    "inference runs `opencode run --pure --model <model> -`",
    inferenceCall.argv.join(" ") === "run --pure --model anthropic/claude-haiku-4-5 -",
    inferenceCall.argv.join(" "),
  );
  check(
    "inference sends combined system and user prompt on stdin",
    inferenceCall.stdin.includes("System instructions:") &&
      inferenceCall.stdin.includes("PAI fake OpenCode inference system prompt") &&
      inferenceCall.stdin.includes("User request:") &&
      inferenceCall.stdin.includes("PAI fake OpenCode inference user prompt"),
    JSON.stringify(inferenceCall.stdin.slice(0, 180)),
  );
  check(
    "inference env marks child mode and scrubs Anthropic credentials",
    inferenceCall.env.PAI_FRAMEWORK === "opencode" &&
      inferenceCall.env.PAI_INFERENCE_CHILD === "1" &&
      inferenceCall.env.PAI_DISABLE_RECURSIVE_HOOKS === "1" &&
      inferenceCall.env.ANTHROPIC_API_KEY === undefined &&
      inferenceCall.env.ANTHROPIC_AUTH_TOKEN === undefined &&
      inferenceCall.env.CLAUDECODE === undefined,
    `PAI_FRAMEWORK=${inferenceCall.env.PAI_FRAMEWORK} child=${inferenceCall.env.PAI_INFERENCE_CHILD} ANTHROPIC_API_KEY=${inferenceCall.env.ANTHROPIC_API_KEY ?? "<unset>"}`,
  );
}

if (process.env.PAI_FAKE_OPENCODE_CHILD === "1") {
  try {
    await runChild();
  } catch (err) {
    check("smoke test executed without throwing", false, err instanceof Error ? err.message : String(err));
  }
  const failed = checks.filter((item) => !item.passed);
  if (failed.length > 0) {
    console.error(`\nOpenCode framework-agent execution smoke failed: ${failed.length} check(s).`);
    process.exit(1);
  }
  console.log("\nAll OpenCode framework-agent execution checks passed.");
  process.exit(0);
} else {
  process.exit(runParent());
}
