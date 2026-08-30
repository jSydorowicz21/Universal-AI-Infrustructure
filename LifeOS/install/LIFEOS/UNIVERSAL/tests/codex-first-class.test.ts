import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, FIRST_PARTY_ADAPTERS, lowerDecision, normalizeNativeEvent } from "../adapters";
import { lowerAgentIntent, lowerCommandIntent, lowerPromptIntent } from "../capabilities";
import { parseTranscriptLines } from "../canonical";
import { certifyFromEvidence, createFixtureHarnessExecutor, runAdapterConformance, type ConformanceEvidence } from "../conformance";
import { FIRST_PARTY_BOOTSTRAP_PROVIDERS, type BinaryVersionProbe } from "../bootstrap";
import { discoverHarness, HarnessRegistry } from "../registry";
import { getFirstPartyBootstrapProvider } from "../sdk";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
async function fixtureRoot() { const value = await mkdtemp(join(tmpdir(), "uai-codex-first-class-")); roots.push(value); return value; }

const CODEX_CONTEXT = {
  adapterId: "codex",
  adapterVersion: "1.0.0",
  cliVersion: "codex-cli-fixture-0.142.0",
  osProfile: `${process.platform}:credential-free-fixture`,
  platformTier: process.platform === "darwin" ? "P1" : process.platform === "win32" ? "P3" : "P2",
  adapterClass: "compatibility" as const,
  now: () => "2026-07-17T00:00:00.000Z",
};

const expected = { adapterId: "codex", adapterVersion: "1.0.0", cliVersion: CODEX_CONTEXT.cliVersion, osProfile: CODEX_CONTEXT.osProfile, executorId: "uai-fixture-harness@1" };

describe("Codex first-class adapter: discovery, registry, canonical, lowering, lifecycle, conformance", () => {
  test("is registered, discoverable, and classified as compatibility with version evidence", () => {
    const discovery = discoverHarness({ explicit: "codex" });
    expect(discovery.selected).toMatchObject({ id: "codex", adapterClass: "compatibility", state: "discovery", certification: "C0" });

    const envDiscovery = discoverHarness({ env: { UAI_HARNESS: "codex" } });
    expect(envDiscovery.selected?.id).toBe("codex");
    expect(envDiscovery.selected?.source).toBe("environment");

    const registry = new HarnessRegistry();
    registry.register("codex", "compatibility", CODEX_CONTEXT.cliVersion);
    const wired = registry.recordWired("codex");
    expect(wired).toMatchObject({ id: "codex", adapterClass: "compatibility", version: CODEX_CONTEXT.cliVersion, state: "wired", certification: "C0" });

    const provider = registry.bootstrapProvider("codex");
    expect(provider?.surface.adapterId).toBe("codex");
    expect(getFirstPartyBootstrapProvider("codex")).toBe(FIRST_PARTY_BOOTSTRAP_PROVIDERS.codex);
  });

  test("descriptor declares explicit, honest capability states without overclaiming parity", () => {
    const descriptor = FIRST_PARTY_ADAPTERS.codex;
    expect(descriptor.contract).toBe("uai.adapter.v1");
    expect(descriptor.adapter).toMatchObject({ id: "codex", class: "compatibility" });
    expect(descriptor.certification).toBe("C0");
    expect(descriptor.capabilities?.lifecycleBlocking).toMatchObject({ critical: true, state: "degraded", failMode: "fail-visible-open" });
    expect(descriptor.capabilities?.lifecycleBlocking?.losses).toContain("native PreToolUse hooks block via trust-reviewed command handlers; managed hooks require policy trust");
    expect(descriptor.capabilities?.transcript?.state).toBe("wired");
    expect(descriptor.capabilities?.mcp?.state).toBe("detected");
    expect(descriptor.losses).toContain("system authority depends on managed configuration");
  });

  test("normalizes native Codex pre-tool, post-tool, and transcript shapes into canonical events", () => {
    const preTool = normalizeNativeEvent("codex", { hook_event_name: "PreToolUse", session_id: "native-1", tool_name: "Bash", tool_input: { command: "echo hi" } });
    expect(preTool).toMatchObject({ type: "tool.before", adapterId: "codex", nativeSessionId: "native-1", tool: { name: "Bash", input: { command: "echo hi" } } });

    const postTool = normalizeNativeEvent("codex", {
      hook_event_name: "PostToolUse", session_id: "native-1", tool_name: "WebFetch", tool_input: {},
      tool_response: "external", provenance: { transcriptUri: "file:///t.jsonl", sourceUri: "https://example.test", tainted: true },
    });
    expect(postTool).toMatchObject({ type: "tool.after", result: { output: "external", provenance: { tainted: true } } });

    const parsed = parseTranscriptLines("codex", [
      JSON.stringify({ type: "response_item", id: "e1", role: "assistant", content: "ok" }),
      "not-json",
      JSON.stringify({ type: "response_item", id: "e2", role: "tool", content: "external", source_uri: "https://example.test", tainted: true }),
    ], "file:///tmp/codex.jsonl", "codex-parser@1");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.malformedCount).toBe(1);
    expect(parsed.entries[1].provenance).toMatchObject({ sourceEventId: "e2", sourceUri: "https://example.test", tainted: true });
  });

  test("lowers canonical decisions, commands, agents, and prompts with explicit Codex losses", () => {
    expect(lowerDecision("codex", { action: "block", reason: "no" })).toEqual({ exitCode: 0, output: { decision: "block", reason: "no" } });
    expect(lowerDecision("codex", { action: "allow" })).toEqual({ exitCode: 0, output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } } });
    expect(lowerDecision("codex", { action: "update", updatedInput: { command: "safe" }, additionalContext: ["ctx"] })).toEqual({ exitCode: 0, output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "safe" }, additionalContext: "ctx" } } });
    expect(lowerDecision("codex", { action: "advisory", additionalContext: ["note one", "note two"] })).toEqual({ exitCode: 0, output: { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "note one\nnote two" } } });

    expect(lowerCommandIntent("codex", { id: "interview", prompt: "Ask" })).toMatchObject({ adapterId: "codex" });
    expect(lowerCommandIntent("codex", { id: "interview", prompt: "Ask" }).losses).toContain("no native slash-command installation surface proven");
    expect(lowerCommandIntent("codex", { id: "interview", prompt: "Ask" }).nativeName).toBeUndefined();

    expect(lowerAgentIntent("codex", { id: "reviewer", instructions: "Review" }).nativeName).toBe("reviewer");
    expect(lowerAgentIntent("codex", { id: "reviewer", instructions: "Review" }).losses).toContain("no implicit installation-time spawn; delegation requires explicit user request or AGENTS.md/skill instruction");
    expect(lowerAgentIntent("codex", { id: "r", instructions: "i", model: "gpt-5" }).losses).toContain("model selection is per-agent-file, not per-invocation");

    const systemPrompt = lowerPromptIntent("codex", { id: "policy", content: "Policy", authority: "system" });
    expect(systemPrompt.effectiveAuthority).toBe("context");
    expect(systemPrompt.losses).toContain("system authority not proven; lowered to context");
    expect(lowerPromptIntent("codex", { id: "p", content: "c", authority: "user" }).effectiveAuthority).toBe("user");
  });

  test("runs the full 11-probe adapter conformance suite against the Codex adapter and earns C2, never active", async () => {
    const evidence: ConformanceEvidence = await runAdapterConformance({
      context: CODEX_CONTEXT,
      adapter: ADAPTERS.codex,
      executor: createFixtureHarnessExecutor("codex"),
    });
    expect(evidence.scope).toBe("adapter");
    expect(evidence.adapterId).toBe("codex");
    expect(evidence.probes).toHaveLength(11);
    expect(evidence.probes.every((probe) => probe.passed)).toBeTrue();
    expect(evidence.probes.find((probe) => probe.id === "failure-injection-rollback")?.adapterBinding).toMatchObject({
      adapterId: "codex", executorId: "uai-fixture-harness@1", scope: "adapter",
    });

    const certification = certifyFromEvidence({ wired: true, evidence, expected, now: CODEX_CONTEXT.now });
    expect(certification.state).toBe("observed");
    expect(certification.certification).toBe("C2");
    expect(certification.blockers).toContain("C3 requires native adapter class");
    expect(certification.blockers).toContain("fixture executor cannot certify active");
    expect(certification.state).not.toBe("active");
  });

  test("fail-visible boundary: a caller-labeled trusted executor still cannot certify Codex active", async () => {
    const fixtureExecutor = createFixtureHarnessExecutor("codex");
    const nominalExecutor = {
      ...fixtureExecutor,
      id: "caller-labeled-trusted@1",
      trust: "trusted-staged-native" as const,
      surface: "staged-native-dispatch" as const,
      observedCliVersion: CODEX_CONTEXT.cliVersion,
      installationEvidenceUri: "fixture:///self-asserted-install.json",
      execute: async (request: Parameters<typeof fixtureExecutor.execute>[0]) => ({
        ...await fixtureExecutor.execute(request),
        observedCliVersion: CODEX_CONTEXT.cliVersion,
      }),
    };
    const evidence = await runAdapterConformance({ context: CODEX_CONTEXT, adapter: ADAPTERS.codex, executor: nominalExecutor });
    const nominal = certifyFromEvidence({ wired: true, evidence, expected: { ...expected, executorId: nominalExecutor.id }, now: CODEX_CONTEXT.now });
    expect(nominal.state).toBe("observed");
    expect(nominal.certification).toBe("C2");
    expect(nominal.blockers).toContain("C3 requires native adapter class");
    expect(nominal.state).not.toBe("active");
  });

  test("fixture Codex probe proves discovery, version evidence, plan/apply/status/uninstall round-trip", async () => {
    const tempRoot = await fixtureRoot();
    const profileRoot = join(tempRoot, "profile");
    const codexBin = join(tempRoot, "codex-fixture");
    const probe: BinaryVersionProbe = {
      find: async (executable) => executable === "codex" ? codexBin : undefined,
      version: async (path) => path === codexBin ? "codex-cli 0.142.0" : undefined,
    };

    const provider = FIRST_PARTY_BOOTSTRAP_PROVIDERS.codex;
    const discovery = await provider.discover({ selection: "codex", profileRoot, probe });
    expect(discovery).toMatchObject({ detected: true, cliVersion: "codex-cli 0.142.0", certification: "C0" });
    expect(discovery.binaryPath).toBe(codexBin);

    const registry = new HarnessRegistry();
    registry.register("codex", "compatibility", discovery.cliVersion!);
    registry.recordWired("codex");

    const bootstrap = await provider.planC1(discovery);
    expect(bootstrap.schema).toBe("uai.first-party-bootstrap-plan.v1");
    expect(bootstrap.adapterId).toBe("codex");
    expect(bootstrap.instructionPath).toBe(join(profileRoot, "AGENTS.md"));
    expect(bootstrap.configPath).toBe(join(profileRoot, "config.toml"));
    expect(bootstrap.sentinel).toBe("UAI_CODEX_INSTRUCTION_SENTINEL_V1");
    expect(bootstrap.plan.mutations).toHaveLength(1);
    expect(bootstrap.plan.mutations[0]).toMatchObject({ kind: "write", path: join(profileRoot, "AGENTS.md"), ownership: "owned" });

    const applied = await provider.applyC1(bootstrap);
    expect(applied).toMatchObject({ certification: "C1", adapterId: "codex", cliVersion: "codex-cli 0.142.0" });
    expect(applied.probes).toEqual(["instruction-sentinel", "byte-preserving-uninstall", "profile-root-isolation"]);
    expect(applied.evidence.evidenceUri).toBe("uai-bootstrap://codex/c1/codex-cli%200.142.0");
    expect(applied.losses).toContain("instruction bootstrap does not prove lifecycle blocking");
    expect((await readFile(applied.instructionPath, "utf8"))).toContain(bootstrap.sentinel);

    registry.recordObserved("codex", applied.evidence.evidenceUri);
    expect(registry.get("codex")).toMatchObject({ state: "observed", observedEvidenceUri: applied.evidence.evidenceUri });

    const uninstall = await provider.uninstallC1(applied);
    expect(uninstall.status).toBe("uninstalled");
    expect(uninstall.restored).toHaveLength(1);
    expect(uninstall.conflicts).toHaveLength(0);
    expect(await Bun.file(applied.journalPath).exists()).toBeFalse();
    expect(await Bun.file(applied.manifestPath).exists()).toBeFalse();
  });

  test("bootstrap refuses an unselected Codex provider and a missing executable without defaulting", async () => {
    const root = await fixtureRoot();
    const provider = FIRST_PARTY_BOOTSTRAP_PROVIDERS.codex;
    const unselected = await provider.discover({ selection: "claude", profileRoot: root, probe: { find: async () => undefined, version: async () => undefined } });
    expect(unselected).toMatchObject({ detected: false, blocker: "adapter was not explicitly selected" });
    const noBinary = await provider.discover({ selection: "codex", profileRoot: root, probe: { find: async () => undefined, version: async () => undefined } });
    expect(noBinary).toMatchObject({ detected: false, blocker: "codex executable was not found" });
    const noVersion = await provider.discover({ selection: "codex", profileRoot: root, probe: { find: async () => join(root, "codex"), version: async () => undefined } });
    expect(noVersion).toMatchObject({ detected: false, blocker: "codex --version did not produce a successful version" });
  });
});
