#!/usr/bin/env bun
/**
 * CodexFrameworkAgentExecutionSmokeTest
 *
 * Runtime (not source-string) proof that the exported Codex paths actually
 * invoke `codex exec` with the contracted flags. We build a fully isolated
 * temp HOME/USERPROFILE/CODEX_HOME/PAI_DATA_DIR/PAI_CONFIG_DIR and a temp PATH
 * containing a fake `codex` shim (plus `codex.cmd` on Windows). The shim records
 * the argv + stdin it receives and exits 0, so no live Codex auth or provider is
 * touched.
 *
 * Because `Bun.which("codex")` (the no-options form the launchers use) resolves
 * against the *startup* environment, the temp PATH must be in place before the
 * process starts. So the parent stages the temp env + shims and re-execs itself;
 * the child inherits the patched PATH at startup and drives the real launchers:
 * - runFrameworkAgent() -> `codex exec` workspace-write, --skip-git-repo-check,
 *   --cd <cwd>, prompt on stdin.
 * - inference()         -> `codex exec` read-only, --ignore-user-config /
 *   --ignore-rules, --cd <cwd>, combined prompt on stdin.
 *
 * Complements the source-string checks in CodexNativeRuntimeSmokeTest.ts by
 * executing the real launchers end-to-end against a controllable binary.
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
}

function readRecording(path: string): Recording {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  return {
    argv: Array.isArray(parsed.argv) ? parsed.argv : [],
    stdin: typeof parsed.stdin === "string" ? parsed.stdin : "",
  };
}

/** True when `flag` appears immediately followed by `value`. */
function hasFlagValue(argv: string[], flag: string, value: string): boolean {
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] === value;
}

const RECORDER_SOURCE = `
const recordFile = process.env.FAKE_CODEX_RECORD_FILE;
const argv = process.argv.slice(2);
let stdin = "";
try {
  stdin = await Bun.stdin.text();
} catch {}
if (recordFile) {
  await Bun.write(recordFile, JSON.stringify({ argv, stdin }));
}
process.stdout.write("FAKE_CODEX_OK\\n");
process.exit(0);
`;

// ---------------------------------------------------------------------------
// Parent: stage isolated env + fake codex shim, then re-exec self as the child.
// `Bun.which("codex")` reads the startup environment, so the shim must be on
// PATH before the test process begins — hence the re-exec.
// ---------------------------------------------------------------------------
function runParent(): number {
  const tempRoot = mkdtempSync(join(tmpdir(), "pai-codex-exec-smoke-"));
  try {
    const home = join(tempRoot, "home");
    const codexHome = join(tempRoot, "codex-home");
    const paiData = join(tempRoot, "pai-data");
    const configDir = join(tempRoot, "config");
    const binDir = join(tempRoot, "bin");
    const workspace = join(tempRoot, "workspace");
    const inferenceCwd = join(tempRoot, "inference-cwd");
    const recordDir = join(tempRoot, "record");
    for (const dir of [home, codexHome, paiData, configDir, binDir, workspace, inferenceCwd, recordDir]) {
      mkdirSync(dir, { recursive: true });
    }

    // Fake codex shim: records argv + stdin via a tiny Bun recorder, then exits 0.
    const recorderPath = join(binDir, "codex-recorder.ts");
    writeFileSync(recorderPath, RECORDER_SOURCE);
    if (process.platform === "win32") {
      // .cmd is what `Bun.which("codex")` resolves to on Windows (PATHEXT) and
      // what an npm-global codex install ships, so exercising it proves the
      // launchers spawn .cmd shims correctly.
      writeFileSync(join(binDir, "codex.cmd"), `@echo off\r\nbun "${recorderPath}" %*\r\nexit /b %errorlevel%\r\n`);
    } else {
      const shim = join(binDir, "codex");
      writeFileSync(shim, `#!/usr/bin/env bash\nexec bun "${recorderPath}" "$@"\n`);
      chmodSync(shim, 0o755);
    }

    // Build the child's startup environment. Windows stores the search path
    // under `Path`, not `PATH`; prepend to the existing key so the child resolves
    // our shim ahead of any real codex install.
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) childEnv[key] = value;
    }
    const pathKey = Object.keys(childEnv).find((k) => k.toLowerCase() === "path") || "PATH";
    childEnv[pathKey] = binDir + delimiter + (childEnv[pathKey] || "");
    childEnv.PAI_FAKE_CODEX_CHILD = "1";
    childEnv.PAI_FRAMEWORK = "codex";
    childEnv.HOME = home;
    childEnv.USERPROFILE = home;
    childEnv.CODEX_HOME = codexHome;
    childEnv.PAI_DATA_DIR = paiData;
    childEnv.PAI_CONFIG_DIR = configDir;
    childEnv.PAI_CODEX_INFERENCE_CWD = inferenceCwd;
    childEnv.FAKE_CODEX_BIN_DIR = binDir;
    childEnv.FAKE_CODEX_WORKSPACE = workspace;
    childEnv.FAKE_CODEX_INFER_CWD = inferenceCwd;
    childEnv.FAKE_CODEX_RECORD_DIR = recordDir;
    for (const key of [
      "PAI_DIR",
      "PAI_FRAMEWORK_DIR",
      "PAI_CODEX_MODEL",
      "PAI_CODEX_MODEL_FAST",
      "PAI_CODEX_MODEL_STANDARD",
      "PAI_CODEX_MODEL_CLASSIFIER",
      "PAI_CODEX_REASONING_EFFORT",
      "PAI_CODEX_REASONING_FAST",
      "PAI_CODEX_REASONING_STANDARD",
      "PAI_CODEX_REASONING_CLASSIFIER",
    ]) {
      delete childEnv[key];
    }

    const child = Bun.spawnSync([process.execPath, import.meta.path], {
      env: childEnv,
      stdout: "inherit",
      stderr: "inherit",
      windowsHide: true,
    });
    return child.exitCode ?? 1;
  } finally {
    const resolved = resolve(tempRoot);
    if (dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-codex-exec-smoke-")) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Child: PATH already patched at startup; drive the real exported launchers.
// ---------------------------------------------------------------------------
async function runChild(): Promise<void> {
  const { runFrameworkAgent } = await import("./lib/framework-agent");
  const { inference } = await import("./Inference");

  const binDir = process.env.FAKE_CODEX_BIN_DIR!;
  const workspace = process.env.FAKE_CODEX_WORKSPACE!;
  const inferenceCwd = process.env.FAKE_CODEX_INFER_CWD!;
  const recordDir = process.env.FAKE_CODEX_RECORD_DIR!;

  const resolvedCodex = Bun.which("codex");
  check(
    "fake codex shim resolves ahead of any real codex",
    Boolean(resolvedCodex && resolve(resolvedCodex).startsWith(resolve(binDir))),
    resolvedCodex || "Bun.which('codex') returned null",
  );

  // --- 1. Framework agent path (runFrameworkAgent) ---------------------------
  const agentRecord = join(recordDir, "agent.json");
  const agentPrompt = "PAI-FAKE-CODEX::framework-agent prompt payload";
  process.env.FAKE_CODEX_RECORD_FILE = agentRecord;
  const agentResult = await runFrameworkAgent(agentPrompt, { cwd: workspace });

  check(
    "runFrameworkAgent invoked fake codex (exit 0, FAKE_CODEX_OK)",
    agentResult.exitCode === 0 && agentResult.framework === "codex" && agentResult.stdout.includes("FAKE_CODEX_OK"),
    `exit=${agentResult.exitCode} framework=${agentResult.framework} stderr=${agentResult.stderr.trim().slice(0, 200)}`,
  );

  const agent = readRecording(agentRecord);
  check(
    "framework agent runs `codex exec` with workspace-write sandbox",
    agent.argv[0] === "exec" && hasFlagValue(agent.argv, "--sandbox", "workspace-write"),
    agent.argv.join(" "),
  );
  check(
    "framework agent passes --skip-git-repo-check, --cd <cwd>, stdin sentinel",
    agent.argv.includes("--skip-git-repo-check") &&
      hasFlagValue(agent.argv, "--cd", workspace) &&
      agent.argv[agent.argv.length - 1] === "-",
    agent.argv.join(" "),
  );
  check(
    "framework agent delivers the prompt payload on stdin",
    agent.stdin === agentPrompt,
    JSON.stringify(agent.stdin.slice(0, 120)),
  );

  // --- 2. Inference path (inference) -----------------------------------------
  const inferRecord = join(recordDir, "inference.json");
  const systemPrompt = "PAI-FAKE-CODEX::system-instructions-marker";
  const userPrompt = "PAI-FAKE-CODEX::user-request-marker";
  process.env.FAKE_CODEX_RECORD_FILE = inferRecord;
  const inferResult = await inference({ systemPrompt, userPrompt, level: "fast", timeout: 60_000 });

  check(
    "inference invoked fake codex (success)",
    inferResult.success && inferResult.output.includes("FAKE_CODEX_OK"),
    `success=${inferResult.success} error=${inferResult.error ?? ""}`,
  );

  const infer = readRecording(inferRecord);
  check(
    "inference runs `codex exec` with read-only sandbox",
    infer.argv[0] === "exec" && hasFlagValue(infer.argv, "--sandbox", "read-only"),
    infer.argv.join(" "),
  );
  check(
    "inference passes --ignore-user-config and --ignore-rules",
    infer.argv.includes("--ignore-user-config") && infer.argv.includes("--ignore-rules"),
    infer.argv.join(" "),
  );
  check(
    "inference disables Codex memories and plugins",
    infer.argv.join("\0").includes("--disable\0memories") && infer.argv.join("\0").includes("--disable\0plugins"),
    infer.argv.join(" "),
  );
  check(
    "fast inference uses classifier-sized Codex model by default",
    hasFlagValue(infer.argv, "--model", "gpt-5.3-codex-spark") &&
      !hasFlagValue(infer.argv, "--model", "gpt-5.5"),
    infer.argv.join(" "),
  );
  check(
    "fast inference uses low Codex reasoning",
    infer.argv.includes('model_reasoning_effort="low"') &&
      infer.argv.includes('plan_mode_reasoning_effort="low"'),
    infer.argv.join(" "),
  );
  check(
    "inference pins isolated --cd and stdin sentinel",
    hasFlagValue(infer.argv, "--cd", inferenceCwd) && infer.argv[infer.argv.length - 1] === "-",
    infer.argv.join(" "),
  );
  check(
    "inference delivers system + user prompt on stdin",
    infer.stdin.includes(systemPrompt) && infer.stdin.includes(userPrompt),
    JSON.stringify(infer.stdin.slice(0, 160)),
  );
}

if (process.env.PAI_FAKE_CODEX_CHILD === "1") {
  try {
    await runChild();
  } catch (err) {
    check("smoke test executed without throwing", false, err instanceof Error ? err.message : String(err));
  }
  const failed = checks.filter((item) => !item.passed);
  if (failed.length > 0) {
    console.error(`\nCodex framework-agent execution smoke failed: ${failed.length} check(s).`);
    process.exit(1);
  }
  console.log("\nAll Codex framework-agent execution checks passed.");
  process.exit(0);
} else {
  process.exit(runParent());
}
