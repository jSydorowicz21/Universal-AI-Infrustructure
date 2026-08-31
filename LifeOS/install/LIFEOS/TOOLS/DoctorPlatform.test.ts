import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bareCommandProblem, firstCommandToken, requiresExecutableBit, resolveExecutable } from "./DoctorPlatform";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Doctor platform executable discovery", () => {
  test("resolves Windows PATHEXT shims from semicolon-delimited PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-doctor-path-"));
    roots.push(root);
    const binDir = join(root, "Program Files", "Tools");
    mkdirSync(binDir, { recursive: true });
    const executable = join(binDir, "probe.cmd");
    writeFileSync(executable, "@exit /b 0\r\n");

    expect(resolveExecutable("probe", { PATH: `${join(root, "missing")};${binDir}`, PATHEXT: ".EXE;.cmd" }, "win32")).toBe(executable);
  });

  test("uses POSIX executable bits only on POSIX platforms", () => {
    expect(requiresExecutableBit("win32")).toBe(false);
    expect(requiresExecutableBit("linux")).toBe(true);
    expect(requiresExecutableBit("darwin")).toBe(true);
  });
  test("parses quoted and unquoted hook command executables", () => {
    expect(firstCommandToken(String.raw`"C:\Program Files\Bun\bun.exe" C:\hooks\guard.ts`)).toBe(String.raw`C:\Program Files\Bun\bun.exe`);
    expect(firstCommandToken("bun /opt/lifeos/guard.ts")).toBe("bun");
  });

  test("requires explicit script interpreters on Windows without imposing POSIX rules", () => {
    expect(bareCommandProblem("C:\\hooks\\guard.ts", 0o666, "#!/usr/bin/env bun", "win32"))
      .toBe("guard.ts: bare script requires an explicit interpreter on Windows");
    expect(bareCommandProblem("C:\\hooks\\guard.cmd", 0o666, "@echo off", "win32")).toBeNull();
    expect(bareCommandProblem("/hooks/guard.ts", 0o666, "#!/usr/bin/env bun", "linux"))
      .toBe("guard.ts: not executable (chmod +x)");
    expect(bareCommandProblem("/hooks/guard.ts", 0o755, "export {};", "darwin"))
      .toBe("guard.ts: no #! shebang");
  });
});
