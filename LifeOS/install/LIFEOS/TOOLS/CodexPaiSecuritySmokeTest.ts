#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectSystem } from "../PAI-Install/engine/detect";
import { FRAMEWORK_IDS, frameworkCliInstallCommands } from "../PAI-Install/engine/frameworks";

function assert(name: string, condition: boolean, detail = ""): void {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
}

const marker = join(tmpdir(), `pai-detect-shell-injection-${Date.now()}`);
const originalShell = process.env.SHELL;

try {
  for (const framework of FRAMEWORK_IDS) {
    const commands = frameworkCliInstallCommands(framework);
    assert(`${framework} install commands avoid npm`, !commands.some((cmd) => /\bnpm\b|\bnpx\b/.test(cmd)), commands.join(" | "));
  }

  process.env.SHELL = `/bin/sh; touch ${marker}`;
  detectSystem("codex");
  assert("detectSystem does not execute SHELL through a shell", !existsSync(marker), marker);
} finally {
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  if (existsSync(marker)) rmSync(marker, { force: true });
}
