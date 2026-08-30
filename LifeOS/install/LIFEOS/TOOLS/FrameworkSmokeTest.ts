#!/usr/bin/env bun
/**
 * FrameworkSmokeTest - verify PAI framework switching without touching real homes.
 *
 * This creates isolated temporary CLAUDE_HOME / CODEX_HOME / OPENCODE_CONFIG_DIR /
 * PAI_DATA_DIR roots, runs `pai framework switch`, and verifies that each
 * framework gets native config while sharing the same PAI data shape.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

type Framework = "claude" | "codex" | "opencode";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const keep = process.argv.includes("--keep");
const dynamic = process.argv.includes("--dynamic") || process.env.PAI_FRAMEWORK_SMOKE_DYNAMIC === "1";
const paiTool = join(import.meta.dir, "pai.ts");

function selectedFrameworks(): Framework[] {
  const argIndex = process.argv.indexOf("--framework");
  const raw = process.argv.find((value) => value.startsWith("--framework="))?.slice("--framework=".length)
    || (argIndex >= 0 ? process.argv[argIndex + 1] : "")
    || process.env.PAI_FRAMEWORK_SMOKE_FRAMEWORKS
    || "";
  if (!raw) return ["claude", "codex", "opencode"];

  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const valid = new Set<Framework>(["claude", "codex", "opencode"]);
  const frameworks = values.filter((value): value is Framework => valid.has(value as Framework));
  if (frameworks.length !== values.length || frameworks.length === 0) {
    throw new Error(`Invalid --framework value: ${raw}`);
  }
  return frameworks;
}

function uniqueRoot(): string {
  return join(tmpdir(), `pai-framework-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeTreeBestEffort(path: string): void {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 8) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`WARN smoke cleanup skipped for locked temp tree: ${path} (${message})`);
        return;
      }
      sleepSync(250);
    }
  }
}

function outputText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

function parseJsonOutput(value: unknown): Record<string, string> {
  try {
    return JSON.parse(outputText(value).trim());
  } catch {
    return {};
  }
}

function hasOwn(value: Record<string, any>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function checkOpenCodeConfigParses(root: string, allowDynamic: boolean): Check[] {
  const sourceConfig = join(root, "opencode.json");
  const launchHome = join(dirname(root), "opencode-cli-home");
  const launchConfig = join(launchHome, ".config", "opencode");
  mkdirSync(launchConfig, { recursive: true });
  copyFileSync(sourceConfig, join(launchConfig, "opencode.json"));

  if (!allowDynamic) {
    return [{
      name: "opencode debug config parses generated config",
      passed: true,
      detail: "skipped in AV-safe static mode; pass --dynamic or PAI_FRAMEWORK_SMOKE_DYNAMIC=1",
    }];
  }

  const env = {
    ...process.env,
    HOME: launchHome,
    USERPROFILE: launchHome,
    OPENCODE_CONFIG_DIR: launchConfig,
  } as Record<string, string>;
  const version = spawnSync("opencode", ["--version"], {
    cwd: launchConfig,
    env,
    encoding: "utf-8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (version.error) {
    return [{
      name: "opencode CLI available for config parse",
      passed: true,
      detail: `skipped: ${version.error.message}`,
    }];
  }

  const result = spawnSync("opencode", ["debug", "config", "--pure"], {
    cwd: launchConfig,
    env,
    encoding: "utf-8",
    timeout: 30_000,
    windowsHide: true,
  });
  const combined = `${outputText(result.stdout)}\n${outputText(result.stderr)}`;
  return [{
    name: "opencode debug config parses generated config",
    passed: result.status === 0 && !combined.includes("Unrecognized keys"),
    detail: `status=${result.status ?? "null"} ${combined.trim().slice(0, 160)}`,
  }];
}

function decodeEncodedCommand(command: string): string {
  const match = command.match(/(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/=]+)/i);
  if (!match) return "";
  try {
    return Buffer.from(match[1], "base64").toString("utf16le");
  } catch {
    return "";
  }
}

function hookCommandText(hooksJson: string): string {
  const values: string[] = [];
  function visit(value: unknown): void {
    if (typeof value === "string") {
      values.push(value);
      const decoded = decodeEncodedCommand(value);
      if (decoded) values.push(decoded);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  }
  try {
    visit(JSON.parse(hooksJson));
  } catch {}
  return values.join("\n");
}

function windowsDirectBunHookCommandsUseCallOperator(text: string): boolean {
  const commands = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /FrameworkHookAdapter\.ts/i.test(value) && /bun\.exe/i.test(value));
  return commands.length > 0 && commands.every((value) =>
    /^(?:\$env:[A-Z0-9_]+\s*=\s*'(?:[^']|'')*';\s*)*&\s+"[^"]*bun\.exe"/i.test(value)
  );
}

function checkPath(name: string, path: string): Check {
  return {
    name,
    passed: existsSync(path),
    detail: path,
  };
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return existsSync(left) && existsSync(right) && realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function findJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => statSync(b).mtime.getTime() - statSync(a).mtime.getTime());
}

function readFilesUnder(dir: string, predicate: (path: string) => boolean): string {
  if (!existsSync(dir)) return "";
  let text = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      text += readFilesUnder(fullPath, predicate);
    } else if (entry.isFile() && predicate(fullPath)) {
      text += "\n" + readFileSync(fullPath, "utf-8");
    }
  }
  return text;
}

function checkGeneratedAgents(root: string, framework: Framework): Check[] {
  const agentsDir = join(root, "agents");
  const generatedText = readFilesUnder(agentsDir, (path) =>
    framework === "codex" ? path.endsWith(".toml") : path.endsWith(".md"));
  return [
    {
      name: `${framework} generated agents`,
      passed: generatedText.length > 0,
      detail: agentsDir,
    },
    {
      name: `${framework} agents avoid Claude home`,
      passed: generatedText.length > 0 && !generatedText.includes("~/.claude"),
      detail: generatedText.includes("~/.claude") ? "contains ~/.claude" : "no ~/.claude",
    },
    {
      name: `${framework} agents carry framework-relative context`,
      passed: generatedText.includes("$PAI_FRAMEWORK_DIR") || generatedText.includes("$PAI_DIR"),
      detail: "agent startup paths",
    },
    {
      name: `${framework} agents include PAI_DIR fallback bootstrap`,
      passed: framework === "claude" || (generatedText.includes("PAI path bootstrap") && generatedText.includes("$PAI_DATA_DIR/framework.json")),
      detail: framework === "claude" ? "Claude settings provides PAI_DIR" : "agent fallback paths",
    },
    {
      name: `${framework} agents use provider-neutral provenance`,
      passed: framework === "claude" || (generatedText.includes("provider-neutral PAI agent contract") && !generatedText.includes("shared Claude-style PAI agent definition")),
      detail: framework === "claude" ? "Claude keeps canonical markdown" : "provider-native render marker",
    },
  ];
}

function checkOpenCodeTranscript(root: string, data: string): Check[] {
  const pluginPath = join(root, "plugins", "pai-opencode.ts");
  const pluginSource = existsSync(pluginPath) ? readFileSync(pluginPath, "utf-8") : "";
  const sessionCreatedBranch = pluginSource.match(/session\.created"\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  const fakeBin = join(dirname(data), "fake-opencode-bin");
  mkdirSync(fakeBin, { recursive: true });
  const fakeOpenCode = process.platform === "win32" ? join(fakeBin, "opencode.cmd") : join(fakeBin, "opencode");
  if (process.platform === "win32") {
    writeFileSync(fakeOpenCode, [
      "@echo off",
      "echo {\"tab_title\":\"Testing OpenCode.\",\"session_name\":\"Testing OpenCode Cache Path\",\"mode\":\"ALGORITHM\",\"tier\":3,\"mode_reason\":\"framework smoke\"}",
      "exit /b 0",
      "",
    ].join("\r\n"), "utf-8");
  } else {
    writeFileSync(fakeOpenCode, [
      "#!/usr/bin/env sh",
      "printf '%s\\n' '{\"tab_title\":\"Testing OpenCode.\",\"session_name\":\"Testing OpenCode Cache Path\",\"mode\":\"ALGORITHM\",\"tier\":3,\"mode_reason\":\"framework smoke\"}'",
      "",
    ].join("\n"), "utf-8");
    spawnSync("chmod", ["755", fakeOpenCode], { windowsHide: true });
  }
  const repeatMarkerPath = join(data, "opencode-repeat-detection.txt");
  const contextMarkerPath = join(data, "opencode-context-injection.txt");
  const shellEnvMarkerPath = join(data, "opencode-shell-env.json");
  const promptTelemetryPath = join(data, "MEMORY", "OBSERVABILITY", "prompt-processing.jsonl");
  const kittyEnvPath = join(data, "MEMORY", "STATE", "kitty-env.json");
  const kittySessionPath = join(data, "MEMORY", "STATE", "kitty-sessions", "smoke-opencode.json");
  const testEnv = {
    ...process.env,
    PAI_DATA_DIR: data,
    PAI_FRAMEWORK: "opencode",
    PAI_FRAMEWORK_DIR: root,
    PAI_OPENCODE_BIN: fakeOpenCode,
    PAI_OPENCODE_HOOK_TIMEOUT_MS: "5000",
    KITTY_LISTEN_ON: "unix:/tmp/pai-opencode-smoke-kitty",
    KITTY_WINDOW_ID: "smoke-window",
    PATH: `${fakeBin}${delimiter}${process.env.PATH || process.env.Path || ""}`,
    Path: `${fakeBin}${delimiter}${process.env.Path || process.env.PATH || ""}`,
  };
  const script = `
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const userDir = ${JSON.stringify(join(data, "USER"))};
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      ${JSON.stringify(join(data, "USER", "OPINIONS.md"))},
      "### OpenCode context parity\\n\\n**Confidence:** 0.95\\n\\nOpenCode dynamic context should be injected into the first prompt.\\n",
      "utf-8"
    );
    const mod = await import(${JSON.stringify(pluginPath)});
    const hooks = await mod.PAIOpenCodePlugin();
    const session = { sessionId: "smoke-opencode", cwd: ${JSON.stringify(root)} };
    const shellEnvOutput = {};
    await hooks["shell.env"](session, shellEnvOutput);
    writeFileSync(${JSON.stringify(shellEnvMarkerPath)}, JSON.stringify(shellEnvOutput.env || {}), "utf-8");
    if ((shellEnvOutput.env || {}).PAI_DIR !== ${JSON.stringify(join(root, "PAI"))}) {
      throw new Error("OpenCode plugin used stale PAI_DIR: " + (shellEnvOutput.env || {}).PAI_DIR);
    }
    await hooks.event({ event: { ...session, type: "session.created" } });
    const repeatedPrompt = "Please use OpenCode shared memory for this exact repeated smoke prompt.";
    const firstPromptOutput = { prompt: repeatedPrompt };
    await hooks["tui.prompt.append"](session, firstPromptOutput);
    if (!String(firstPromptOutput.prompt || "").includes("OpenCode context parity")) {
      throw new Error("LoadContext did not inject dynamic context into OpenCode prompt");
    }
    writeFileSync(${JSON.stringify(contextMarkerPath)}, "injected", "utf-8");
    await hooks["tui.prompt.append"](session, { prompt: repeatedPrompt });
    writeFileSync(${JSON.stringify(repeatMarkerPath)}, "advisory", "utf-8");
    await hooks.event({ event: { ...session, type: "message.updated", message: { role: "user", content: [{ type: "text", text: "Actually, shared memory should follow OpenCode too." }] } } });
    await hooks.event({ event: { ...session, type: "message.updated", message: { role: "assistant", content: [{ type: "text", text: "Important: OpenCode wrote a PAI transcript." }] } } });
    await hooks["tool.execute.after"]({ ...session, tool: "edit" }, { args: { filePath: "PAI/TOOLS/Smoke.ts" }, output: "ok" });
    await hooks.event({ event: { ...session, type: "session.error", error: "transient model error" } });
  `;

  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: testEnv,
    encoding: "utf-8",
    timeout: 60_000,
    windowsHide: true,
  });

  const staleHome = join(dirname(data), "opencode-stale-home");
  const staleDefaultData = join(staleHome, ".pai");
  const staleEnvData = join(dirname(data), "deleted-opencode-data");
  const staleValidRoot = join(dirname(data), "stale-valid-codex");
  mkdirSync(join(staleValidRoot, "PAI"), { recursive: true });
  mkdirSync(staleDefaultData, { recursive: true });
  writeFileSync(join(staleDefaultData, "framework.json"), JSON.stringify({ active: "opencode", root, dataDir: data }), "utf-8");
  const staleEnv = {
    ...testEnv,
    HOME: staleHome,
    USERPROFILE: staleHome,
    PAI_DATA_DIR: staleEnvData,
    PAI_DIR: join(staleValidRoot, "PAI"),
    PAI_FRAMEWORK_DIR: staleValidRoot,
    PAI_CONFIG_DIR: join(dirname(data), "deleted-opencode-config"),
  };
  const staleResult = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: staleEnv,
    encoding: "utf-8",
    timeout: 60_000,
    windowsHide: true,
  });

  const linkedHome = join(dirname(data), "opencode-linked-home");
  const linkedData = join(dirname(data), "opencode-linked-data");
  const linkedDefaultRoot = join(linkedHome, ".config", "opencode");
  const linkedImportRoot = join(dirname(data), "opencode-linked-import-root");
  const linkedPluginDir = join(linkedImportRoot, "plugins");
  mkdirSync(linkedData, { recursive: true });
  mkdirSync(join(linkedDefaultRoot, "PAI"), { recursive: true });
  mkdirSync(join(linkedDefaultRoot, "hooks", "lib"), { recursive: true });
  mkdirSync(join(linkedDefaultRoot, "plugins"), { recursive: true });
  mkdirSync(join(linkedImportRoot, "hooks", "lib"), { recursive: true });
  mkdirSync(linkedPluginDir, { recursive: true });
  writeFileSync(join(linkedDefaultRoot, "opencode.json"), JSON.stringify({ "$schema": "https://opencode.ai/config.json" }), "utf-8");
  writeFileSync(join(linkedData, "framework.json"), JSON.stringify({ active: "opencode", root: linkedDefaultRoot, dataDir: linkedData }, null, 2), "utf-8");
  copyFileSync(join(import.meta.dir, "..", "..", "hooks", "lib", "paths.ts"), join(linkedImportRoot, "hooks", "lib", "paths.ts"));
  copyFileSync(join(import.meta.dir, "..", "..", "hooks", "lib", "paths.ts"), join(linkedDefaultRoot, "hooks", "lib", "paths.ts"));
  copyFileSync(pluginPath, join(linkedPluginDir, "pai-opencode.ts"));
  const linkedEnv = {
    ...process.env,
    HOME: linkedHome,
    USERPROFILE: linkedHome,
    PAI_DATA_DIR: linkedData,
    PAI_FRAMEWORK: "opencode",
  } as Record<string, string>;
  for (const key of ["OPENCODE_CONFIG_DIR", "PAI_DIR", "PAI_FRAMEWORK_DIR", "PAI_SETTINGS_PATH"]) {
    delete linkedEnv[key];
  }
  const linkedScript = `
    const mod = await import(${JSON.stringify(join(linkedPluginDir, "pai-opencode.ts"))});
    const hooks = await mod.PAIOpenCodePlugin();
    const output = {};
    await hooks["shell.env"]({ sessionId: "linked-root", cwd: ${JSON.stringify(root)} }, output);
    console.log(JSON.stringify(output.env || {}));
  `;
  const linkedResult = spawnSync(process.execPath, ["-e", linkedScript], {
    cwd: linkedImportRoot,
    env: linkedEnv,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  const linkedResolved = parseJsonOutput(linkedResult.stdout);

  const transcriptFiles = findJsonlFiles(join(data, "TRANSCRIPTS", "opencode"));
  const staleTranscriptFiles = findJsonlFiles(join(staleEnvData, "TRANSCRIPTS", "opencode"));
  const transcriptText = transcriptFiles.map((file) => readFileSync(file, "utf-8")).join("\n");
  const promptTelemetry = existsSync(promptTelemetryPath) ? readFileSync(promptTelemetryPath, "utf-8") : "";
  const harvest = spawnSync(process.execPath, [join(import.meta.dir, "SessionHarvester.ts"), "--recent", "1", "--dry-run"], {
    cwd: root,
    env: testEnv,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  const activity = spawnSync(process.execPath, [join(import.meta.dir, "ActivityParser.ts"), "--today"], {
    cwd: root,
    env: testEnv,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  return [
    {
      name: "opencode plugin transcript exits 0",
      passed: result.status === 0,
      detail: `status=${result.status ?? "null"} ${outputText(result.stderr).trim().slice(0, 120)}`,
    },
    {
      name: "opencode plugin ignores stale env roots",
      passed: staleResult.status === 0 && staleTranscriptFiles.length === 0 && transcriptFiles.length > 0,
      detail: `status=${staleResult.status ?? "null"} stale_transcripts=${staleTranscriptFiles.length}`,
    },
    {
      name: "opencode shell env uses active framework PAI_DIR",
      passed: existsSync(shellEnvMarkerPath) && readJson(shellEnvMarkerPath).PAI_DIR === join(root, "PAI"),
      detail: existsSync(shellEnvMarkerPath) ? readJson(shellEnvMarkerPath).PAI_DIR : shellEnvMarkerPath,
    },
    {
      name: "opencode plugin prefers config root over import target",
      passed: linkedResult.status === 0 && linkedResolved.PAI_DIR === join(linkedDefaultRoot, "PAI"),
      detail: `status=${linkedResult.status ?? "null"} PAI_DIR=${linkedResolved.PAI_DIR || ""}`,
    },
    {
      name: "opencode session start persists Kitty env",
      passed: existsSync(kittyEnvPath) && existsSync(kittySessionPath),
      detail: existsSync(kittySessionPath) ? kittySessionPath : kittyEnvPath,
    },
    {
      name: "opencode prompt repeat detection stays advisory",
      passed: existsSync(repeatMarkerPath),
      detail: repeatMarkerPath,
    },
    {
      name: "opencode dynamic context injected",
      passed: existsSync(contextMarkerPath),
      detail: contextMarkerPath,
    },
    {
      name: "opencode plugin transcript file",
      passed: transcriptFiles.length > 0,
      detail: transcriptFiles[0] || join(data, "TRANSCRIPTS", "opencode"),
    },
    {
      name: "opencode plugin transcript messages",
      passed: transcriptText.includes("shared memory should follow OpenCode") && transcriptText.includes("OpenCode wrote a PAI transcript"),
      detail: `${transcriptFiles.length} transcript file(s)`,
    },
    {
      name: "opencode plugin transcript tool call",
      passed: transcriptText.includes('"type":"tool_call"') && transcriptText.includes("PAI/TOOLS/Smoke.ts"),
      detail: "tool_call edit PAI/TOOLS/Smoke.ts",
    },
    {
      name: "opencode transcript harvestable",
      passed: harvest.status === 0 && Number(outputText(harvest.stdout).match(/(\d+)\s+learning\(s\)/)?.[1] || 0) >= 2,
      detail: `status=${harvest.status ?? "null"}`,
    },
    {
      name: "opencode transcript activity parse",
      passed: activity.status === 0 && outputText(activity.stdout).includes("PAI/TOOLS/Smoke.ts"),
      detail: `status=${activity.status ?? "null"}`,
    },
    {
      name: "opencode session start syncs KV (KVSync parity)",
      passed: pluginSource.includes("KVSync.hook.ts") && sessionCreatedBranch.includes("KVSync.hook.ts"),
      detail: sessionCreatedBranch.includes("KVSync.hook.ts") ? "KVSync observed on session.created" : "KVSync missing from session.created branch",
    },
    {
      name: "opencode prompt captures satisfaction (SatisfactionCapture parity)",
      passed: pluginSource.includes("SatisfactionCapture.hook.ts"),
      detail: pluginSource.includes("SatisfactionCapture.hook.ts") ? "SatisfactionCapture wired" : "missing SatisfactionCapture",
    },
    {
      name: "opencode scans every tool result (ContentScanner parity)",
      passed: pluginSource.includes('observe("ContentScanner.hook.ts"') && !pluginSource.includes("CONTENT_TOOLS"),
      detail: pluginSource.includes("CONTENT_TOOLS") ? "still gated by CONTENT_TOOLS" : "unconditional ContentScanner",
    },
    {
      name: "opencode rewrites bash via RTK (RtkPreToolUse parity)",
      passed: pluginSource.includes("RtkPreToolUse.hook.js")
        && pluginSource.includes("hookSpecificOutput?.updatedInput?.command")
        && pluginSource.includes("output.args.command = rewritten"),
      detail: pluginSource.includes("RtkPreToolUse.hook.js") ? "RTK rewrite wired for bash/shell" : "missing RtkPreToolUse",
    },
    {
      name: "opencode dispatches SessionEnd on session.deleted (SessionEndDispatcher parity)",
      passed: pluginSource.includes("SessionEndDispatcher.hook.ts")
        && pluginSource.includes('event?.type === "session.deleted"')
        && pluginSource.includes('hook_event_name: "SessionEnd"'),
      detail: pluginSource.includes("SessionEndDispatcher.hook.ts") ? "session.deleted mapped to SessionEnd" : "missing SessionEndDispatcher",
    },
    {
      name: "opencode session.error records without SessionEnd",
      passed: pluginSource.includes('event?.type === "session.error"') && transcriptText.includes('"eventType":"session.error"'),
      detail: transcriptText.includes('"eventType":"session.error"') ? "session.error recorded" : "session.error not recorded",
    },
    {
      name: "opencode SessionEnd dispatch guards duplicates per session",
      passed: pluginSource.includes("dispatchedSessionEnd")
        && pluginSource.includes("dispatchedSessionEnd.has(id)")
        && pluginSource.includes("dispatchedSessionEnd.add(id)"),
      detail: pluginSource.includes("dispatchedSessionEnd.has(id)") ? "in-memory dedup guard present" : "missing dedup guard",
    },
    {
      name: "opencode shared memory classifier cache written",
      passed: existsSync(join(data, "MEMORY", "STATE", "classifier-cache", "smoke-opencode.json")),
      detail: existsSync(join(data, "MEMORY", "STATE", "classifier-cache", "smoke-opencode.json"))
        ? "classifier cache file present" : "missing classifier cache file",
    },
    {
      name: "opencode shared memory cache hit on repeated prompt",
      passed: promptTelemetry.includes('"source":"shared-memory-cache"'),
      detail: promptTelemetry.includes('"source":"shared-memory-cache"')
        ? "cache hit confirmed" : "no shared-memory-cache telemetry",
    },
  ];
}

function checkFrameworkStatePathFallback(root: string, data: string, framework: Framework): Check[] {
  mkdirSync(root, { recursive: true });
  const toolsPath = join(import.meta.dir, "lib", "paths.ts");
  const hooksPath = join(import.meta.dir, "..", "..", "hooks", "lib", "paths.ts");
  const env = { ...process.env, PAI_DATA_DIR: data } as Record<string, string>;
  for (const key of ["PAI_DIR", "PAI_FRAMEWORK_DIR", "PAI_MEMORY_DIR", "PAI_USER_DIR", "PAI_SETTINGS_PATH"]) {
    delete env[key];
  }

  const script = `
    const tools = await import(${JSON.stringify(toolsPath)});
    const hooks = await import(${JSON.stringify(hooksPath)});
    const transcripts = await import(${JSON.stringify(join(import.meta.dir, "lib", "transcripts.ts"))});
    console.log(JSON.stringify({
      toolsPaiDir: tools.getPaiDir(),
      toolsFrameworkDir: tools.getFrameworkDir(),
      toolsConfigDir: tools.getConfigDir(),
      toolsEnvPath: tools.getEnvPath(),
      toolsMemoryDir: tools.getMemoryDir(),
      toolsUserDir: tools.getUserDir(),
      hooksPaiDir: hooks.getPaiDir(),
      hooksFrameworkDir: hooks.getFrameworkDir(),
      hooksEnvPath: hooks.getEnvPath(),
      hooksMemoryDir: hooks.getMemoryDir(),
      hooksUserDir: hooks.getUserDir(),
      transcriptFrameworkDir: transcripts.getActiveFrameworkRoot("codex")
    }));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });

  const resolved = parseJsonOutput(result.stdout);

  const staleEnv = {
    ...process.env,
    HOME: join(root, "path-home"),
    USERPROFILE: join(root, "path-home"),
    PAI_DATA_DIR: data,
    PAI_DIR: join(root, "deleted-framework", "PAI"),
    PAI_FRAMEWORK_DIR: join(root, "deleted-framework"),
    PAI_CONFIG_DIR: join(root, "deleted-config"),
    PAI_MEMORY_DIR: join(root, "deleted-memory"),
    PAI_USER_DIR: join(root, "deleted-user"),
  } as Record<string, string>;
  writeFileSync(join(root, ".env"), "PAI_FRAMEWORK_ENV=1\n", "utf-8");
  const staleResult = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: staleEnv,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  const staleResolved = parseJsonOutput(staleResult.stdout);

  const home = join(root, "home");
  const homeData = join(home, ".pai");
  mkdirSync(homeData, { recursive: true });
  writeFileSync(join(homeData, "framework.json"), JSON.stringify({ active: "codex", root, dataDir: homeData }), "utf-8");
  const staleDataEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PAI_DATA_DIR: join(root, "deleted-data"),
    PAI_DIR: join(root, "deleted-framework", "PAI"),
    PAI_FRAMEWORK_DIR: join(root, "deleted-framework"),
  } as Record<string, string>;
  const staleDataResult = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: staleDataEnv,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  const staleDataResolved = parseJsonOutput(staleDataResult.stdout);

  const emptyExistingData = join(root, "empty-data");
  mkdirSync(emptyExistingData, { recursive: true });
  const emptyExistingDataEnv = {
    ...staleDataEnv,
    PAI_DATA_DIR: emptyExistingData,
  } as Record<string, string>;
  const emptyExistingDataResult = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: emptyExistingDataEnv,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  const emptyExistingDataResolved = parseJsonOutput(emptyExistingDataResult.stdout);

  const staleExistingData = join(root, "stale-data");
  mkdirSync(staleExistingData, { recursive: true });
  writeFileSync(
    join(staleExistingData, "framework.json"),
    JSON.stringify({ active: "codex", root: join(root, "deleted-framework"), dataDir: staleExistingData }),
    "utf-8",
  );
  const staleExistingDataEnv = {
    ...staleDataEnv,
    PAI_DATA_DIR: staleExistingData,
  } as Record<string, string>;
  const staleExistingDataResult = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: staleExistingDataEnv,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  const staleExistingDataResolved = parseJsonOutput(staleExistingDataResult.stdout);

  const staleExistingDataNoFrameworkEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PAI_DATA_DIR: staleExistingData,
  } as Record<string, string>;
  for (const key of ["PAI_DIR", "PAI_FRAMEWORK_DIR", "PAI_MEMORY_DIR", "PAI_USER_DIR", "PAI_SETTINGS_PATH"]) {
    delete staleExistingDataNoFrameworkEnv[key];
  }
  const staleExistingDataNoFrameworkResult = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: staleExistingDataNoFrameworkEnv,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  const staleExistingDataNoFrameworkResolved = parseJsonOutput(staleExistingDataNoFrameworkResult.stdout);

  const state = readJson(join(data, "framework.json"));
  const explicitFramework = state?.active === "codex" ? "opencode" : "codex";
  const explicitRoot = join(root, "explicit-framework");
  mkdirSync(join(explicitRoot, "PAI"), { recursive: true });
  const explicitEnv = {
    ...process.env,
    HOME: join(root, "explicit-home"),
    USERPROFILE: join(root, "explicit-home"),
    PAI_FRAMEWORK: explicitFramework,
    PAI_DATA_DIR: data,
    PAI_DIR: join(explicitRoot, "PAI"),
    PAI_FRAMEWORK_DIR: explicitRoot,
  } as Record<string, string>;
  const explicitResult = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: explicitEnv,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  const explicitResolved = parseJsonOutput(explicitResult.stdout);

  const providerHomeData = join(root, "provider-home-data");
  const providerHome = join(root, "provider-home");
  mkdirSync(providerHomeData, { recursive: true });
  mkdirSync(providerHome, { recursive: true });
  const providerHomeEnv = {
    ...process.env,
    HOME: providerHome,
    USERPROFILE: providerHome,
    PAI_DATA_DIR: providerHomeData,
    PAI_FRAMEWORK: framework,
  } as Record<string, string>;
  for (const key of [
    "PAI_DIR",
    "PAI_FRAMEWORK_DIR",
    "PAI_MEMORY_DIR",
    "PAI_USER_DIR",
    "PAI_SETTINGS_PATH",
    "CLAUDE_HOME",
    "PAI_CLAUDE_HOME",
    "CODEX_HOME",
    "OPENCODE_CONFIG_DIR",
  ]) {
    delete providerHomeEnv[key];
  }
  if (framework === "claude") providerHomeEnv.CLAUDE_HOME = root;
  if (framework === "codex") providerHomeEnv.CODEX_HOME = root;
  if (framework === "opencode") providerHomeEnv.OPENCODE_CONFIG_DIR = root;
  const providerHomeResult = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: providerHomeEnv,
    encoding: "utf-8",
    timeout: 20_000,
    windowsHide: true,
  });
  const providerHomeResolved = parseJsonOutput(providerHomeResult.stdout);

  return [
    {
      name: "path fallback exits 0",
      passed: result.status === 0,
      detail: `status=${result.status ?? "null"} ${outputText(result.stderr).trim().slice(0, 120)}`,
    },
    {
      name: "tools path fallback uses framework.json",
      passed: resolved.toolsPaiDir === join(root, "PAI") && resolved.toolsFrameworkDir === root,
      detail: JSON.stringify({ pai: resolved.toolsPaiDir, root: resolved.toolsFrameworkDir }),
    },
    {
      name: "hooks path fallback uses framework.json",
      passed: resolved.hooksPaiDir === join(root, "PAI") && resolved.hooksFrameworkDir === root,
      detail: JSON.stringify({ pai: resolved.hooksPaiDir, root: resolved.hooksFrameworkDir }),
    },
    {
      name: "transcript path fallback uses framework.json",
      passed: resolved.transcriptFrameworkDir === root,
      detail: JSON.stringify({ root: resolved.transcriptFrameworkDir }),
    },
    {
      name: "tools path ignores stale PAI_DIR when framework state exists",
      passed: staleResolved.toolsPaiDir === join(root, "PAI") && staleResolved.toolsFrameworkDir === root,
      detail: JSON.stringify({ pai: staleResolved.toolsPaiDir, root: staleResolved.toolsFrameworkDir }),
    },
    {
      name: "hooks path ignores stale PAI_DIR when framework state exists",
      passed: staleResolved.hooksPaiDir === join(root, "PAI") && staleResolved.hooksFrameworkDir === root,
      detail: JSON.stringify({ pai: staleResolved.hooksPaiDir, root: staleResolved.hooksFrameworkDir }),
    },
    {
      name: "transcript path ignores stale PAI_FRAMEWORK_DIR",
      passed: staleResolved.transcriptFrameworkDir === root,
      detail: JSON.stringify({ root: staleResolved.transcriptFrameworkDir }),
    },
    {
      name: "tools path ignores stale PAI_MEMORY_DIR and PAI_USER_DIR",
      passed: staleResolved.toolsMemoryDir === join(data, "MEMORY") && staleResolved.toolsUserDir === join(data, "USER"),
      detail: JSON.stringify({ memory: staleResolved.toolsMemoryDir, user: staleResolved.toolsUserDir }),
    },
    {
      name: "hooks path ignores stale PAI_MEMORY_DIR and PAI_USER_DIR",
      passed: staleResolved.hooksMemoryDir === join(data, "MEMORY") && staleResolved.hooksUserDir === join(data, "USER"),
      detail: JSON.stringify({ memory: staleResolved.hooksMemoryDir, user: staleResolved.hooksUserDir }),
    },
    {
      name: "tools path ignores stale PAI_CONFIG_DIR for env path",
      passed: staleResolved.toolsConfigDir !== join(root, "deleted-config") && staleResolved.toolsEnvPath === join(root, ".env"),
      detail: JSON.stringify({ config: staleResolved.toolsConfigDir, env: staleResolved.toolsEnvPath }),
    },
    {
      name: "hooks path ignores stale PAI_CONFIG_DIR for env path",
      passed: staleResolved.hooksEnvPath === join(root, ".env"),
      detail: JSON.stringify({ env: staleResolved.hooksEnvPath }),
    },
    {
      name: "tools path ignores deleted PAI_DATA_DIR",
      passed: staleDataResolved.toolsPaiDir === join(root, "PAI") && staleDataResolved.toolsFrameworkDir === root,
      detail: JSON.stringify({ pai: staleDataResolved.toolsPaiDir, root: staleDataResolved.toolsFrameworkDir }),
    },
    {
      name: "hooks path ignores deleted PAI_DATA_DIR",
      passed: staleDataResolved.hooksPaiDir === join(root, "PAI") && staleDataResolved.hooksFrameworkDir === root,
      detail: JSON.stringify({ pai: staleDataResolved.hooksPaiDir, root: staleDataResolved.hooksFrameworkDir }),
    },
    {
      name: "tools path ignores empty PAI_DATA_DIR when default state exists",
      passed: emptyExistingDataResolved.toolsPaiDir === join(root, "PAI") && emptyExistingDataResolved.toolsFrameworkDir === root,
      detail: JSON.stringify({ pai: emptyExistingDataResolved.toolsPaiDir, root: emptyExistingDataResolved.toolsFrameworkDir }),
    },
    {
      name: "hooks path ignores empty PAI_DATA_DIR when default state exists",
      passed: emptyExistingDataResolved.hooksPaiDir === join(root, "PAI") && emptyExistingDataResolved.hooksFrameworkDir === root,
      detail: JSON.stringify({ pai: emptyExistingDataResolved.hooksPaiDir, root: emptyExistingDataResolved.hooksFrameworkDir }),
    },
    {
      name: "tools path ignores invalid PAI_DATA_DIR framework state",
      passed: staleExistingDataResolved.toolsPaiDir === join(root, "PAI") && staleExistingDataResolved.toolsFrameworkDir === root,
      detail: JSON.stringify({ pai: staleExistingDataResolved.toolsPaiDir, root: staleExistingDataResolved.toolsFrameworkDir }),
    },
    {
      name: "hooks path ignores invalid PAI_DATA_DIR framework state",
      passed: staleExistingDataResolved.hooksPaiDir === join(root, "PAI") && staleExistingDataResolved.hooksFrameworkDir === root,
      detail: JSON.stringify({ pai: staleExistingDataResolved.hooksPaiDir, root: staleExistingDataResolved.hooksFrameworkDir }),
    },
    {
      name: "tools path ignores invalid PAI_DATA_DIR without stale env",
      passed: staleExistingDataNoFrameworkResolved.toolsPaiDir === join(root, "PAI") && staleExistingDataNoFrameworkResolved.toolsFrameworkDir === root,
      detail: JSON.stringify({ pai: staleExistingDataNoFrameworkResolved.toolsPaiDir, root: staleExistingDataNoFrameworkResolved.toolsFrameworkDir }),
    },
    {
      name: "hooks path ignores invalid PAI_DATA_DIR without stale env",
      passed: staleExistingDataNoFrameworkResolved.hooksPaiDir === join(root, "PAI") && staleExistingDataNoFrameworkResolved.hooksFrameworkDir === root,
      detail: JSON.stringify({ pai: staleExistingDataNoFrameworkResolved.hooksPaiDir, root: staleExistingDataNoFrameworkResolved.hooksFrameworkDir }),
    },
    {
      name: "tools path explicit different-framework env overrides framework.json",
      passed: explicitResolved.toolsPaiDir === join(explicitRoot, "PAI") && explicitResolved.toolsFrameworkDir === explicitRoot,
      detail: JSON.stringify({ pai: explicitResolved.toolsPaiDir, root: explicitResolved.toolsFrameworkDir }),
    },
    {
      name: "hooks path explicit different-framework env overrides framework.json",
      passed: explicitResolved.hooksPaiDir === join(explicitRoot, "PAI") && explicitResolved.hooksFrameworkDir === explicitRoot,
      detail: JSON.stringify({ pai: explicitResolved.hooksPaiDir, root: explicitResolved.hooksFrameworkDir }),
    },
    {
      name: "tools path uses provider home env without PAI_DIR",
      passed: providerHomeResolved.toolsPaiDir === join(root, "PAI") && providerHomeResolved.toolsFrameworkDir === root,
      detail: JSON.stringify({
        status: providerHomeResult.status,
        pai: providerHomeResolved.toolsPaiDir,
        root: providerHomeResolved.toolsFrameworkDir,
      }),
    },
    {
      name: "hooks path uses provider home env without PAI_DIR",
      passed: providerHomeResolved.hooksPaiDir === join(root, "PAI") && providerHomeResolved.hooksFrameworkDir === root,
      detail: JSON.stringify({
        status: providerHomeResult.status,
        pai: providerHomeResolved.hooksPaiDir,
        root: providerHomeResolved.hooksFrameworkDir,
      }),
    },
  ];
}

function runSwitch(framework: Framework, base: string): { root: string; data: string; config: string; checks: Check[]; stdout: string; stderr: string } {
  const root = join(base, framework);
  const data = join(base, "pai-data");
  const config = join(base, "pai-config");
  mkdirSync(base, { recursive: true });
  if (framework === "codex") {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "config.toml"), [
      'model = "gpt-5.5"',
      'model_reasoning_effort = "high"',
      'plan_mode_reasoning_effort = "xhigh"',
      "",
      "[model_providers.custom_local]",
      'name = "Custom Local Provider"',
      'base_url = "http://127.0.0.1:8000/v1"',
      'wire_api = "responses"',
      "",
      "[profiles.custom-local]",
      'model = "custom-model"',
      'model_provider = "custom_local"',
      "",
      "[plugins.\"browser@openai-bundled\"]",
      "enabled = true",
      "",
    ].join("\n"));
  }

  const env: Record<string, string> = {
    ...process.env,
    PAI_DATA_DIR: data,
    PAI_CONFIG_DIR: config,
    PAI_FRAMEWORK: framework,
    PAI_DIR: join(root, "PAI"),
    PAI_FRAMEWORK_DIR: root,
    PAI_SETTINGS_PATH: join(root, "settings.json"),
    PAI_SKIP_USER_ENV_UPDATE: "1",
    PAI_USER_ENV_TARGET: "Process",
  } as Record<string, string>;
  delete env.PAI_MEMORY_DIR;
  delete env.PAI_USER_DIR;
  if (framework === "claude") env.CLAUDE_HOME = root;
  if (framework === "codex") env.CODEX_HOME = root;
  if (framework === "opencode") env.OPENCODE_CONFIG_DIR = root;

  const result = spawnSync(process.execPath, [paiTool, "framework", "switch", framework], {
    cwd: join(import.meta.dir, "..", ".."),
    env,
    encoding: "utf-8",
    timeout: 30_000,
    windowsHide: true,
  });

  const checks: Check[] = [
    {
      name: `${framework} switch exits 0`,
      passed: result.status === 0,
      detail: `status=${result.status ?? "null"}`,
    },
    checkPath(`${framework} root`, root),
    checkPath(`${framework} instructions`, join(root, framework === "claude" ? "CLAUDE.md" : "AGENTS.md")),
    checkPath(`${framework} settings.json`, join(root, "settings.json")),
    checkPath(`${framework} shared MEMORY`, join(data, "MEMORY")),
    checkPath(`${framework} shared USER`, join(data, "USER")),
    checkPath(`${framework} framework PAI/MEMORY`, join(root, "PAI", "MEMORY")),
    checkPath(`${framework} framework PAI/USER`, join(root, "PAI", "USER")),
    checkPath(`${framework} framework state`, join(data, "framework.json")),
  ];

  const instructionPath = join(root, framework === "claude" ? "CLAUDE.md" : "AGENTS.md");
  if (existsSync(instructionPath)) {
    const instructionText = readFileSync(instructionPath, "utf-8");
    checks.push({
      name: `${framework} instructions avoid fixed Claude PAI root`,
      passed: framework === "claude" || !instructionText.includes("~/.claude/PAI"),
      detail: framework === "claude" ? "Claude native root allowed" : "AGENTS.md path rewrite",
    });
  }

  const systemPromptPath = join(root, "PAI", "PAI_SYSTEM_PROMPT.md");
  if (existsSync(systemPromptPath)) {
    const systemPromptText = readFileSync(systemPromptPath, "utf-8");
    checks.push({
      name: `${framework} system prompt references native instruction file`,
      passed: framework === "claude"
        ? systemPromptText.includes("CLAUDE.md")
        : systemPromptText.includes("AGENTS.md") && !systemPromptText.includes("format from CLAUDE.md"),
      detail: framework === "claude" ? "Claude uses CLAUDE.md" : "provider uses AGENTS.md",
    });
    checks.push({
      name: `${framework} system prompt avoids fixed Claude home`,
      passed: framework === "claude" || !systemPromptText.includes("~/.claude"),
      detail: framework === "claude" ? "Claude native root allowed" : "framework home path rewrite",
    });
  }

  if (framework === "claude") {
    checks.push(checkPath("claude CLAUDE.md", join(root, "CLAUDE.md")));
    checks.push(checkPath("claude hooks directory", join(root, "hooks")));
    checks.push(...checkGeneratedAgents(root, framework));
    if (existsSync(join(root, "settings.json"))) {
      const settings = readJson(join(root, "settings.json"));
      checks.push({
        name: "claude settings carry PAI_DATA_DIR",
        passed: settings.env?.PAI_DATA_DIR === data,
        detail: `PAI_DATA_DIR=${settings.env?.PAI_DATA_DIR || ""}`,
      });
    }
  }

  if (framework === "codex") {
    checks.push(checkPath("codex config.toml", join(root, "config.toml")));
    checks.push(checkPath("codex hooks.json", join(root, "hooks.json")));
    checks.push(checkPath("codex memory delete tool", join(root, "PAI", "TOOLS", "MemoryDelete.ts")));
    checks.push(...checkGeneratedAgents(root, framework));
    if (existsSync(join(root, "hooks.json"))) {
      const hooksText = readFileSync(join(root, "hooks.json"), "utf-8");
      const decodedHooksText = hookCommandText(hooksText);
      checks.push({
        name: "codex hooks carry PAI_DATA_DIR",
        passed: decodedHooksText.includes("PAI_DATA_DIR"),
        detail: "hooks.json command env",
      });
      checks.push({
        name: "codex hooks include question tab",
        passed: decodedHooksText.includes("SetQuestionTab.hook.ts"),
        detail: "AskUserQuestion/request_user_input hook",
      });
      checks.push({
        name: "codex hooks include agent invocation",
        passed: decodedHooksText.includes("AgentInvocation.hook.ts"),
        detail: "Agent hook",
      });
      checks.push({
        name: "codex hooks include session KV sync",
        passed: decodedHooksText.includes("KVSync.hook.ts"),
        detail: "SessionStart observability sync hook",
      });
      checks.push({
        name: "codex hooks include mode classification",
        passed: decodedHooksText.includes("PromptProcessing.hook.ts"),
        detail: "UserPromptSubmit mode hook",
      });
      checks.push({
        name: "codex hooks include satisfaction capture",
        passed: decodedHooksText.includes("SatisfactionCapture.hook.ts"),
        detail: "UserPromptSubmit satisfaction hook",
      });
      checks.push({
        name: "codex PromptProcessing hook leaves adapter headroom",
        passed: hooksText.includes('"timeout": 40') && decodedHooksText.includes("--timeout-ms") && decodedHooksText.includes("35000"),
        detail: "outer timeout exceeds child inference + notify fallback budget",
      });
      checks.push({
        name: "codex hooks include ISA checkpoint sync",
        passed: decodedHooksText.includes("ISASync.hook.ts") && decodedHooksText.includes("CheckpointPerISC.hook.ts"),
        detail: "PostToolUse write hooks",
      });
      checks.push({
        name: "codex Windows hook commands avoid encoded PowerShell",
        passed: process.platform !== "win32" || (!hooksText.includes("-EncodedCommand")
          && !hooksText.includes("powershell.exe")
          && decodedHooksText.includes("bun.exe")
          && decodedHooksText.includes("FrameworkHookAdapter.ts")
          && !hooksText.includes("cmd.exe /d /s /c")
          && !hooksText.includes("bun.cmd")),
        detail: "commandWindows direct Bun runner",
      });
      checks.push({
        name: "codex Windows hook commands use PowerShell call operator",
        passed: process.platform !== "win32" || windowsDirectBunHookCommandsUseCallOperator(decodedHooksText),
        detail: "quoted bun.exe paths must be invoked with &",
      });
    }
    if (existsSync(join(root, "config.toml"))) {
      const configText = readFileSync(join(root, "config.toml"), "utf-8");
      checks.push({
        name: "codex config preserves existing model",
        passed: configText.includes('model = "gpt-5.5"')
          && configText.includes('model_reasoning_effort = "high"')
          && configText.includes('plan_mode_reasoning_effort = "xhigh"'),
        detail: "model settings",
      });
      checks.push({
        name: "codex config preserves custom providers profiles plugins",
        passed: configText.includes("[model_providers.custom_local]")
          && configText.includes("[profiles.custom-local]")
          && configText.includes("[plugins.\"browser@openai-bundled\"]"),
        detail: "custom TOML sections",
      });
      checks.push({
        name: "codex config adds managed PAI block",
        passed: configText.includes("# BEGIN PAI MANAGED ROOT CONFIG") && configText.includes("# END PAI MANAGED ROOT CONFIG"),
        detail: "managed root block",
      });
    }
  }

  if (framework === "opencode") {
    checks.push(checkPath("opencode opencode.json", join(root, "opencode.json")));
    checks.push(checkPath("opencode plugin", join(root, "plugins", "pai-opencode.ts")));
    checks.push(...checkGeneratedAgents(root, framework));
    if (existsSync(join(root, "opencode.json"))) {
      const configJson = readJson(join(root, "opencode.json"));
      checks.push({
        name: "opencode config omits unsupported env key",
        passed: !hasOwn(configJson, "env"),
        detail: hasOwn(configJson, "env") ? "contains env" : "schema-clean",
      });
      checks.push({
        name: "opencode config omits unsupported pai key",
        passed: !hasOwn(configJson, "pai"),
        detail: hasOwn(configJson, "pai") ? "contains pai" : "schema-clean",
      });
      checks.push({
        name: "opencode config keeps AGENTS instructions",
        passed: Array.isArray(configJson.instructions) && configJson.instructions.includes("AGENTS.md"),
        detail: JSON.stringify(configJson.instructions || []),
      });
      checks.push(...checkOpenCodeConfigParses(root, dynamic));
    }
    checks.push(...checkOpenCodeTranscript(root, data));
  }

  if (existsSync(join(data, "framework.json"))) {
    const state = readJson(join(data, "framework.json"));
    checks.push({
      name: `${framework} state active`,
      passed: state.active === framework && state.root === root && state.dataDir === data,
      detail: JSON.stringify({ active: state.active, root: state.root, dataDir: state.dataDir }),
    });
    checks.push(...checkFrameworkStatePathFallback(root, data, framework));
  }

  return {
    root,
    data,
    config,
    checks,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function checkManagedPaiRefresh(framework: Framework, base: string): Check[] {
  const root = join(base, framework);
  const data = join(base, "pai-data");
  const config = join(base, "pai-config");
  const env: Record<string, string> = {
    ...process.env,
    PAI_DATA_DIR: data,
    PAI_CONFIG_DIR: config,
    PAI_FRAMEWORK: framework,
    PAI_DIR: join(root, "PAI"),
    PAI_FRAMEWORK_DIR: root,
    PAI_SETTINGS_PATH: join(root, "settings.json"),
    PAI_SKIP_USER_ENV_UPDATE: "1",
    PAI_USER_ENV_TARGET: "Process",
  } as Record<string, string>;
  delete env.PAI_MEMORY_DIR;
  delete env.PAI_USER_DIR;
  if (framework === "claude") env.CLAUDE_HOME = root;
  if (framework === "codex") env.CODEX_HOME = root;
  if (framework === "opencode") env.OPENCODE_CONFIG_DIR = root;

  const first = spawnSync(process.execPath, [paiTool, "framework", "switch", framework], {
    cwd: join(import.meta.dir, "..", ".."),
    env,
    encoding: "utf-8",
    timeout: 30_000,
    windowsHide: true,
  });

  const staleAlgorithmDir = join(root, "PAI", "ALGORITHM");
  rmSync(staleAlgorithmDir, { recursive: true, force: true });
  mkdirSync(staleAlgorithmDir, { recursive: true });
  writeFileSync(join(staleAlgorithmDir, "LATEST"), "stale", "utf-8");
  const staleHooksDir = join(root, "hooks");
  rmSync(staleHooksDir, { recursive: true, force: true });
  mkdirSync(staleHooksDir, { recursive: true });
  writeFileSync(join(staleHooksDir, "FrameworkHookAdapter.ts"), "stale", "utf-8");
  const customHookPath = join(staleHooksDir, "CustomLocalOnly.hook.ts");
  writeFileSync(customHookPath, "custom", "utf-8");
  const oldData = join(base, "old-pai-data");
  const oldUser = join(oldData, "USER");
  mkdirSync(oldUser, { recursive: true });
  for (const staleUserLink of [join(root, "USER"), join(root, "PAI", "USER")]) {
    rmSync(staleUserLink, { recursive: true, force: true });
    mkdirSync(dirname(staleUserLink), { recursive: true });
    symlinkSync(oldUser, staleUserLink, process.platform === "win32" ? "junction" : "dir");
  }

  const second = spawnSync(process.execPath, [paiTool, "framework", "switch", framework], {
    cwd: join(import.meta.dir, "..", ".."),
    env,
    encoding: "utf-8",
    timeout: 30_000,
    windowsHide: true,
  });

  const sourceLatest = readFileSync(join(import.meta.dir, "..", "ALGORITHM", "LATEST"), "utf-8");
  const refreshedLatestPath = join(root, "PAI", "ALGORITHM", "LATEST");
  const refreshedLatest = existsSync(refreshedLatestPath) ? readFileSync(refreshedLatestPath, "utf-8") : "";
  const sourceHook = readFileSync(join(import.meta.dir, "..", "..", "hooks", "FrameworkHookAdapter.ts"), "utf-8");
  const refreshedHookPath = join(root, "hooks", "FrameworkHookAdapter.ts");
  const refreshedHook = existsSync(refreshedHookPath) ? readFileSync(refreshedHookPath, "utf-8") : "";
  const linkedUser = join(root, "USER");
  const linkedPaiUser = join(root, "PAI", "USER");
  const expectedUser = join(data, "USER");

  return [
    {
      name: `${framework} managed PAI refresh setup exits 0`,
      passed: first.status === 0,
      detail: `status=${first.status ?? "null"}`,
    },
    {
      name: `${framework} managed PAI refresh switch exits 0`,
      passed: second.status === 0,
      detail: `status=${second.status ?? "null"}`,
    },
    {
      name: `${framework} managed PAI bundle refreshes stale files`,
      passed: refreshedLatest === sourceLatest,
      detail: refreshedLatestPath,
    },
    {
      name: `${framework} managed framework directory refreshes stale files`,
      passed: refreshedHook === sourceHook,
      detail: refreshedHookPath,
    },
    {
      name: `${framework} managed framework directory preserves custom files`,
      passed: existsSync(customHookPath) && readFileSync(customHookPath, "utf-8") === "custom",
      detail: customHookPath,
    },
    {
      name: `${framework} framework USER link retargets stale link`,
      passed: sameRealPath(linkedUser, expectedUser),
      detail: linkedUser,
    },
    {
      name: `${framework} PAI USER link retargets stale link`,
      passed: sameRealPath(linkedPaiUser, expectedUser),
      detail: linkedPaiUser,
    },
  ];
}

function checkCustomProviderHomeCreation(base: string): Check[] {
  const root = join(base, "custom-codex-home");
  const data = join(base, "pai-data");
  const config = join(base, "pai-config");
  mkdirSync(data, { recursive: true });
  const env: Record<string, string> = {
    ...process.env,
    CODEX_HOME: root,
    PAI_DATA_DIR: data,
    PAI_CONFIG_DIR: config,
    PAI_SETTINGS_PATH: join(root, "settings.json"),
    PAI_SKIP_USER_ENV_UPDATE: "1",
    PAI_USER_ENV_TARGET: "Process",
  } as Record<string, string>;
  for (const key of ["PAI_FRAMEWORK", "PAI_FRAMEWORK_DIR", "PAI_DIR", "PAI_MEMORY_DIR", "PAI_USER_DIR"]) delete env[key];

  const result = spawnSync(process.execPath, [paiTool, "framework", "switch", "codex"], {
    cwd: join(import.meta.dir, "..", ".."),
    env,
    encoding: "utf-8",
    timeout: 30_000,
    windowsHide: true,
  });
  const statePath = join(data, "framework.json");
  const state = existsSync(statePath) ? readJson(statePath) : {};

  return [
    {
      name: "custom CODEX_HOME switch exits 0",
      passed: result.status === 0,
      detail: `status=${result.status ?? "null"} ${outputText(result.stderr).trim().slice(0, 120)}`,
    },
    {
      name: "custom CODEX_HOME root created",
      passed: existsSync(root),
      detail: root,
    },
    {
      name: "custom CODEX_HOME recorded in framework state",
      passed: state.active === "codex" && state.root === root,
      detail: JSON.stringify({ active: state.active, root: state.root }),
    },
  ];
}

function printResult(label: string, checks: Check[]) {
  console.log(`\n${label}`);
  for (const check of checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name} - ${check.detail}`);
  }
}

const base = uniqueRoot();
const frameworks = selectedFrameworks();
if (!dynamic && frameworks.includes("opencode")) {
  console.log("INFO OpenCode framework smoke is running in AV-safe static mode; pass --dynamic or PAI_FRAMEWORK_SMOKE_DYNAMIC=1 to run real opencode CLI config parsing.");
}
const isolatedResults = frameworks.map((framework) => runSwitch(framework, join(base, `${framework}-case`)));
const sequenceBase = join(base, "switch-sequence");
const sequenceData = join(sequenceBase, "pai-data");
const memoryMarker = join(sequenceData, "MEMORY", "STATE", "provider-swap-memory.md");
const userMarker = join(sequenceData, "USER", "PROJECTS", "provider-swap-user.md");
const memoryMarkerText = `provider-swap-memory:${Date.now()}`;
const userMarkerText = `provider-swap-user:${Date.now()}`;
mkdirSync(join(sequenceData, "MEMORY", "STATE"), { recursive: true });
mkdirSync(join(sequenceData, "USER", "PROJECTS"), { recursive: true });
writeFileSync(memoryMarker, memoryMarkerText, "utf-8");
writeFileSync(userMarker, userMarkerText, "utf-8");
const sequenceResults = frameworks.map((framework) => runSwitch(framework, sequenceBase));
const refreshResults = frameworks.map((framework) => ({
  framework,
  checks: checkManagedPaiRefresh(framework, join(base, `${framework}-refresh`)),
}));
const customHomeChecks = checkCustomProviderHomeCreation(join(base, "custom-provider-home"));
let failed = 0;

for (const [index, framework] of frameworks.entries()) {
  const result = isolatedResults[index];
  printResult(`${framework} isolated`, result.checks);
  failed += result.checks.filter((check) => !check.passed).length;
  const stderr = outputText(result.stderr).trim();
  if (stderr) {
    console.log(`${framework} stderr:\n${stderr}`);
  }
}

for (const [index, framework] of frameworks.entries()) {
  const result = sequenceResults[index];
  printResult(`${framework} shared switch`, result.checks);
  failed += result.checks.filter((check) => !check.passed).length;
  const stderr = outputText(result.stderr).trim();
  if (stderr) {
    console.log(`${framework} shared-switch stderr:\n${stderr}`);
  }
}

for (const result of refreshResults) {
  printResult(`${result.framework} managed refresh`, result.checks);
  failed += result.checks.filter((check) => !check.passed).length;
}

printResult("custom provider home switch", customHomeChecks);
failed += customHomeChecks.filter((check) => !check.passed).length;

const sequenceDataDirs = new Set(sequenceResults.map((result) => result.data));
const finalStatePath = join(sequenceData, "framework.json");
const finalState = existsSync(finalStatePath) ? readJson(finalStatePath) : {};
const expectedFinalFramework = frameworks[frameworks.length - 1];
const sequenceChecks: Check[] = [
  {
    name: "shared switch sequence reuses one PAI_DATA_DIR",
    passed: sequenceDataDirs.size === 1,
    detail: Array.from(sequenceDataDirs).join(", "),
  },
  {
    name: "shared switch sequence final active framework",
    passed: finalState.active === expectedFinalFramework && finalState.dataDir === join(sequenceBase, "pai-data"),
    detail: JSON.stringify({ active: finalState.active, dataDir: finalState.dataDir }),
  },
];
for (const result of sequenceResults) {
  const memoryPath = join(result.root, "PAI", "MEMORY", "STATE", "provider-swap-memory.md");
  const userPath = join(result.root, "PAI", "USER", "PROJECTS", "provider-swap-user.md");
  sequenceChecks.push({
    name: `${finalState.active ? result.root.split(/[\\/]/).pop() : "framework"} sees shared memory marker`,
    passed: existsSync(memoryPath) && readFileSync(memoryPath, "utf-8") === memoryMarkerText,
    detail: memoryPath,
  });
  sequenceChecks.push({
    name: `${finalState.active ? result.root.split(/[\\/]/).pop() : "framework"} sees shared user marker`,
    passed: existsSync(userPath) && readFileSync(userPath, "utf-8") === userMarkerText,
    detail: userPath,
  });
}
printResult("shared switch sequence", sequenceChecks);
failed += sequenceChecks.filter((check) => !check.passed).length;

if (keep) {
  console.log(`\nKept smoke test root: ${base}`);
} else {
  removeTreeBestEffort(base);
}

if (failed > 0) {
  console.error(`\n${failed} framework smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nAll framework smoke checks passed.");
