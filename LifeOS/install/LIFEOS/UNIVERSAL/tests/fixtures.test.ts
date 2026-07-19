import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { lowerDecision, normalizeNativeEvent, type FirstPartyAdapterId } from "../adapters";
import { registerToolProvider, type ToolProviderManifest } from "../capabilities";
import { platformFacts } from "../platform";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("deterministic fixture pack", () => {
  test("normalizes native pre-tool forms and lowers native blocks", async () => {
    const fixtures = await Bun.file(join(FIXTURES, "events", "pre-tool.json")).json() as Record<FirstPartyAdapterId, unknown>;
    for (const [adapterId, payload] of Object.entries(fixtures) as [FirstPartyAdapterId, unknown][]) {
      expect(normalizeNativeEvent(adapterId, payload)).toMatchObject({ type: "tool.before", nativeSessionId: "native-1", tool: { name: "Bash", input: { command: "echo hi" } } });
      const lowered = lowerDecision(adapterId, { action: "block", reason: "fixture-block" });
      expect(lowered.exitCode === 2 || lowered.output?.block === true || lowered.output?.decision === "block" || lowered.output?.permission === "deny").toBeTrue();
    }
  });

  test("matches Windows, macOS, Linux, WSL and container facts", async () => {
    const fixtures = await Bun.file(join(FIXTURES, "platforms.json")).json() as { name: string; input: Parameters<typeof platformFacts>[0]; expect: Record<string, unknown> }[];
    for (const fixture of fixtures) expect(platformFacts({ ...fixture.input, homedir: () => "/fallback", tmpdir: () => "/tmp" }), fixture.name).toMatchObject(fixture.expect);
  });

  test("executes uai_echo without exposing rejected environment", async () => {
    const fixture = await Bun.file(join(FIXTURES, "uai-echo.json")).json() as ToolProviderManifest;
    const provider = registerToolProvider(fixture);
    expect(provider.audit).not.toContain("fixture-secret-never-log");
    expect(await provider.execute("uai_echo", { fixture: true })).toEqual({ fixture: true, provider: "uai-echo-fixture" });
  });
});
