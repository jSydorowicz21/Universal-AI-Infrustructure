#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outputRoot = await mkdtemp(join(tmpdir(), "uai-universal-compile-"));
const entries = ["index.ts", "run-conformance.ts"] as const;

try {
  for (const entry of entries) {
    const output = join(outputRoot, entry.replace(/\.ts$/, ".js"));
    const child = Bun.spawn([process.execPath, "build", entry, "--no-bundle", "--target", "bun", "--outfile", output], {
      cwd: import.meta.dir,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Compilation failed for ${entry} with exit code ${exitCode}`);
  }
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}
