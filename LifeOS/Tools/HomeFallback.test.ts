import { describe, expect, test } from "bun:test";
import { resolveInstallerHome } from "./InstallEngine";

const CALLERS = [
  "ActivateImports",
  "DeployComponents",
  "LinkUser",
  "ScaffoldUser",
  "SeedPulse",
] as const;

describe("installer home fallback", () => {
  for (const caller of CALLERS) {
    test(`${caller} receives the native home when HOME is absent`, () => {
      expect(resolveInstallerHome({}, "/native/home")).toBe("/native/home");
    });
  }

  test("an explicit HOME wins over the native fallback", () => {
    expect(resolveInstallerHome({ HOME: "/shell/home" }, "/native/home")).toBe("/shell/home");
  });

  test("an empty HOME uses the native fallback", () => {
    expect(resolveInstallerHome({ HOME: "  " }, "/native/home")).toBe("/native/home");
  });
});
