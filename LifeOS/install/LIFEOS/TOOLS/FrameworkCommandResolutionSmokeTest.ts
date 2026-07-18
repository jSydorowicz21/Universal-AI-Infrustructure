#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function resolveWindowsCommand(command: string, pathValue: string, pathExtValue = ".COM;.EXE;.BAT;.CMD"): string {
  if (command.includes("\\") || command.includes("/") || extname(command)) return command;

  const pathEntries = pathValue.split(delimiter).filter(Boolean);
  const pathExts = pathExtValue
    .split(";")
    .map((ext) => ext.toLowerCase());
  const candidateExts = [".cmd", ".exe", ".bat", "", ...pathExts]
    .filter((ext, index, all) => all.indexOf(ext) === index);

  for (const dir of pathEntries) {
    for (const ext of candidateExts) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }

  return command;
}

function quoteCmdArg(value: string): string {
  if (value === "") return "\"\"";
  if (!/[ \t&()^|<>"%]/.test(value)) return value;
  return `"${value.replace(/"/g, "\"\"").replace(/%/g, "%%")}"`;
}

function frameworkSpawnArgs(args: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "win32") return args;

  const command = resolveWindowsCommand(args[0], env.PATH || "", env.PATHEXT || ".COM;.EXE;.BAT;.CMD");
  const ext = extname(command).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return [command, ...args.slice(1)];

  const cmd = env.ComSpec || "cmd.exe";
  const line = [command, ...args.slice(1)].map(quoteCmdArg).join(" ");
  return [cmd, "/d", "/s", "/c", line];
}

function assert(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
}

const root = mkdtempSync(join(tmpdir(), "pai-framework-command-smoke-"));
try {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "codex.cmd");
  writeFileSync(shim, "@echo codex-shim-ok %*\r\n", "utf-8");

  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
  };
  const args = frameworkSpawnArgs(["codex", "--version"], env);

  if (process.platform === "win32") {
    assert("Windows shim resolved through cmd.exe", args[0].toLowerCase().endsWith("cmd.exe"), args.join(" "));
    const result = spawnSync(args[0], args.slice(1), { encoding: "utf-8", env, windowsHide: true });
    assert("Windows codex.cmd shim executes", result.status === 0, result.stderr || result.stdout);
    assert("Windows codex.cmd receives args", result.stdout.includes("codex-shim-ok --version"), result.stdout.trim());
  } else {
    assert("Non-Windows args unchanged", args.join("\0") === ["codex", "--version"].join("\0"));
  }
} finally {
  const resolved = resolve(root);
  if (dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-framework-command-smoke-")) {
    rmSync(resolved, { recursive: true, force: true });
  }
}
