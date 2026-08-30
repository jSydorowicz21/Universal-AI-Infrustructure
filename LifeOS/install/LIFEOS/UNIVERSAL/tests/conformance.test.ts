import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_PROBES, runConformance, runAdapterConformance, createFixtureHarnessExecutor, certifyFromEvidence } from "../conformance";
import { ADAPTERS } from "../adapters";
import { createExternalAdapter } from "../sdk";

const kernelContext = {
  adapterId: "kernel",
  adapterVersion: "1.0.0",
  cliVersion: "fixture-1.0.0",
  osProfile: "linux:fixture",
  platformTier: "P2",
  adapterClass: "compatibility",
  now: () => "2026-07-17T00:00:00.000Z",
} as const;

const ompContext = {
  adapterId: "omp",
  adapterVersion: "1.0.0",
  cliVersion: "fixture-1.0.0",
  osProfile: "linux:fixture",
  platformTier: "P2",
  adapterClass: "native",
  now: () => "2026-07-17T00:00:00.000Z",
} as const;

describe("deterministic conformance", () => {
  test("runs every required positive and negative control without credentials", async () => {
    const result = await runConformance(kernelContext);
    expect(result.scope).toBe("kernel");
    expect(result.probes.map((probe) => probe.id).sort()).toEqual([...REQUIRED_PROBES].sort());
    expect(result.probes.every((probe) => probe.passed)).toBeTrue();
    expect(result.probes.find((probe) => probe.id === "failure-injection-rollback")).toMatchObject({ passed: true });
    expect(result.audit.every((row) => !JSON.stringify(row).includes("secret"))).toBeTrue();
    expect(result.evidenceUri).toStartWith("data:application/json;sha256,");
  });

  test("kernel, fixture, and nominal trust labels remain capped below active", async () => {
    const expected = { adapterId: "omp", adapterVersion: "1.0.0", cliVersion: "fixture-1.0.0", osProfile: "linux:fixture", executorId: "uai-fixture-harness@1" };
    expect(certifyFromEvidence({ wired: true, expected })).toEqual({ state: "wired", certification: "C0", blockers: ["missing conformance evidence"] });
    const kernel = await runConformance(kernelContext);
    const kernelCertification = certifyFromEvidence({ wired: true, evidence: kernel, expected, now: () => "2026-07-17T00:00:00.000Z" });
    expect(kernelCertification.state).not.toBe("active");
    expect(kernelCertification.blockers).toContain("evidence scope is kernel, not adapter");

    const fixtureExecutor = createFixtureHarnessExecutor("omp");
    const fixtureEvidence = await runAdapterConformance({ context: ompContext, adapter: ADAPTERS.omp, executor: fixtureExecutor });
    expect(fixtureEvidence.probes.find((probe) => probe.id === "failure-injection-rollback")?.adapterBinding).toMatchObject({
      adapterId: "omp", executorId: "uai-fixture-harness@1", scope: "adapter",
    });
    const fixtureCertification = certifyFromEvidence({ wired: true, evidence: fixtureEvidence, expected, now: () => "2026-07-17T00:00:00.000Z" });
    expect(fixtureCertification).toMatchObject({ state: "observed", certification: "C2" });
    expect(fixtureCertification.blockers).toContain("fixture executor cannot certify active");

    const nominalExecutor = {
      ...fixtureExecutor,
      id: "caller-labeled-trusted@1",
      trust: "trusted-staged-native" as const,
      surface: "staged-native-dispatch" as const,
      observedCliVersion: ompContext.cliVersion,
      installationEvidenceUri: "fixture:///self-asserted-install.json",
      execute: async (request: Parameters<typeof fixtureExecutor.execute>[0]) => ({
        ...await fixtureExecutor.execute(request),
        observedCliVersion: ompContext.cliVersion,
      }),
    };
    const nominalEvidence = await runAdapterConformance({ context: ompContext, adapter: ADAPTERS.omp, executor: nominalExecutor });
    const nominal = certifyFromEvidence({
      wired: true, evidence: nominalEvidence, expected: { ...expected, executorId: nominalExecutor.id },
      now: () => "2026-07-17T00:00:00.000Z",
    });
    expect(nominal).toMatchObject({ state: "observed", certification: "C2" });
    expect(nominal.blockers).toContain("no repository-owned certifying executor is registered");
  }, 20_000);

  test("rejects fake, forged, stale and mismatched adapter evidence", async () => {
    const evidence = await runAdapterConformance({ context: ompContext, adapter: ADAPTERS.omp, executor: createFixtureHarnessExecutor("omp") });
    const expected = { adapterId: "omp", adapterVersion: "1.0.0", cliVersion: "fixture-1.0.0", osProfile: "linux:fixture", executorId: "uai-fixture-harness@1" };
    const forged = { ...evidence, evidenceUri: "data:application/json;sha256,forged" };
    expect(certifyFromEvidence({ wired: true, evidence: forged, expected, now: () => "2026-07-17T00:00:00.000Z" }).state).not.toBe("active");
    expect(certifyFromEvidence({ wired: true, evidence, expected: { ...expected, cliVersion: "mismatch" }, now: () => "2026-07-17T00:00:00.000Z" }).state).not.toBe("active");
    const stale = await runAdapterConformance({ context: { ...ompContext, now: () => "2025-01-01T00:00:00.000Z" }, adapter: ADAPTERS.omp, executor: createFixtureHarnessExecutor("omp") });
    expect(certifyFromEvidence({ wired: true, evidence: stale, expected, now: () => "2026-07-17T00:00:00.000Z", maxAgeMs: 86_400_000 }).state).not.toBe("active");
    const future = await runAdapterConformance({ context: { ...ompContext, now: () => "2026-08-01T00:00:00.000Z" }, adapter: ADAPTERS.omp, executor: createFixtureHarnessExecutor("omp") });
    expect(certifyFromEvidence({ wired: true, evidence: future, expected, now: () => "2026-07-17T00:00:00.000Z" }).state).not.toBe("active");
    const fakePayload = {
      ...evidence,
      adapterId: "fake",
      probes: evidence.probes.map((probe) => ({ ...probe, adapterBinding: probe.adapterBinding ? { ...probe.adapterBinding, adapterId: "fake" } : undefined })),
    };
    const { integritySha256: _integrity, evidenceUri: _uri, ...unsignedFake } = fakePayload;
    const fakeDigest = createHash("sha256").update(JSON.stringify(unsignedFake)).digest("hex");
    const validlyHashedFake = { ...unsignedFake, integritySha256: fakeDigest, evidenceUri: `data:application/json;sha256,${fakeDigest}` };
    const fakeResult = certifyFromEvidence({ wired: true, evidence: validlyHashedFake, expected: { ...expected, adapterId: "fake" }, now: () => "2026-07-17T00:00:00.000Z" });
    expect(fakeResult.state).not.toBe("active");
    expect(fakeResult.blockers).toContain("invalid adapter identity");
  }, 20_000);

  test("malformed, null, empty, and integrity-forged artifacts remain C0 without throwing", async () => {
    const expected = { adapterId: "omp", adapterVersion: "1.0.0", cliVersion: "fixture-1.0.0", osProfile: "linux:fixture" };
    for (const evidence of [null, {}, { schema: "uai.conformance.v1", probes: null }, {
      schema: "uai.conformance.v1",
      scope: "adapter",
      suiteId: "uai-adapter-critical-suite",
      adapterId: "omp",
      adapterVersion: "1.0.0",
      cliVersion: "fixture-1.0.0",
      osProfile: "linux:fixture",
      platformTier: "P2",
      adapterClass: "native",
      observedAt: "2026-07-17T00:00:00.000Z",
      integritySha256: "0".repeat(64),
      evidenceUri: `data:application/json;sha256,${"0".repeat(64)}`,
      probes: [],
      audit: [],
    }]) {
      const result = certifyFromEvidence({
        wired: true,
        evidence: evidence as never,
        expected,
        now: () => "2026-07-17T00:00:00.000Z",
      });
      expect(result.state).toBe("wired");
      expect(result.certification).toBe("C0");
      expect(result.blockers.length).toBeGreaterThan(0);
    }
  });

  test("fixture executor can never return active for first-party or external adapter identities", async () => {
    const evidence = await runAdapterConformance({ context: ompContext, adapter: ADAPTERS.omp, executor: createFixtureHarnessExecutor("omp") });
    for (const adapterId of ["claude", "omp", "codex", "opencode", "external:test"]) {
      const changed = {
        ...evidence,
        adapterId,
        executor: evidence.executor ? { ...evidence.executor, adapterId } : undefined,
        probes: evidence.probes.map((probe) => ({ ...probe, adapterBinding: probe.adapterBinding ? { ...probe.adapterBinding, adapterId } : undefined })),
      };
      const { integritySha256: _integrity, evidenceUri: _uri, ...payload } = changed;
      const integritySha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const rebound = { ...payload, integritySha256, evidenceUri: `data:application/json;sha256,${integritySha256}` };
      const result = certifyFromEvidence({
        wired: true, evidence: rebound,
        expected: { adapterId, adapterVersion: evidence.adapterVersion, cliVersion: evidence.cliVersion, osProfile: evidence.osProfile, executorId: "uai-fixture-harness@1" },
        now: () => "2026-07-17T00:00:00.000Z",
      });
      expect(result.state, adapterId).not.toBe("active");
      expect(result.blockers, adapterId).toContain("fixture executor cannot certify active");
    }
  });

  test("synthetic external adapter reaches C0/C1 through SDK only", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "uai-external-"));
    try {
      const adapter = createExternalAdapter({
        id: "external:test",
        version: "1.0.0",
        discover: () => ({ detected: true, cliVersion: "fixture-1.0.0", roots: [profileRoot] }),
        instruction: { relativePath: "UAI.md", sentinel: "UAI_EXTERNAL_TEST_SENTINEL" },
      });
      expect(adapter.discover().certification).toBe("C0");
      const c1 = await adapter.bootstrapFixture(profileRoot);
      expect(c1.certification).toBe("C1");
      expect(c1.probes).toContain("instruction-sentinel");
      await c1.cleanup();
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  });

  test("external SDK rejects a linked instruction parent before reading or writing", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "uai-external-parent-link-"));
    const external = await mkdtemp(join(tmpdir(), "uai-external-parent-target-"));
    try {
      await writeFile(join(external, "UAI.md"), "EXTERNAL_INSTRUCTION_SENTINEL");
      await symlink(external, join(profileRoot, "rules"), process.platform === "win32" ? "junction" : "dir");
      const adapter = createExternalAdapter({
        id: "external:parent-link",
        version: "1.0.0",
        discover: () => ({ detected: true, cliVersion: "fixture-1.0.0", roots: [profileRoot] }),
        instruction: { relativePath: "rules/UAI.md", sentinel: "UAI_EXTERNAL_PARENT_LINK" },
      });
      await expect(adapter.bootstrapFixture(profileRoot)).rejects.toThrow("linked ancestor");
      expect(await Bun.file(join(external, "UAI.md")).text()).toBe("EXTERNAL_INSTRUCTION_SENTINEL");
    } finally {
      await Promise.all([rm(profileRoot, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]);
    }
  });

  test("external SDK refuses C1 without an observed CLI version", async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), "uai-external-unversioned-"));
    try {
      const adapter = createExternalAdapter({
        id: "external:unversioned",
        version: "1.0.0",
        discover: () => ({ detected: true, roots: [profileRoot] }),
        instruction: { relativePath: "UAI.md", sentinel: "UAI_EXTERNAL_UNVERSIONED" },
      });
      await expect(adapter.bootstrapFixture(profileRoot)).rejects.toThrow("CLI version");
      expect(await Bun.file(join(profileRoot, "UAI.md")).exists()).toBeFalse();
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
  });
});
