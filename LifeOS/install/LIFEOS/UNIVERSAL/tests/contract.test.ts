import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ADAPTER_CONTRACT,
  EXTERNAL_ADAPTER_ID_PATTERN,
  UAI_ADAPTER_V1_SCHEMA,
  assertAdapterDescriptor,
  validateAdapterDescriptor,
  type AdapterId,
} from "../contract";
import { certifyFromEvidence, type ConformanceEvidence } from "../conformance";
import { discoverHarness, HarnessRegistry } from "../registry";
import { createExternalAdapter } from "../sdk";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "adapters");

describe("uai.adapter.v1 contract", () => {
  test("validates every adapter fixture", async () => {
    const files = (await readdir(FIXTURES)).filter((name) => name.endsWith(".json"));
    expect(files.sort()).toEqual([
      "claude.json",
      "codex.json",
      "external-test.json",
      "omp.json",
      "opencode.json",
      "unknown.json",
    ]);
    for (const file of files) {
      const fixture = await Bun.file(join(FIXTURES, file)).json();
      expect(validateAdapterDescriptor(fixture), file).toEqual({ ok: true, errors: [] });
      expect(assertAdapterDescriptor(fixture).contract).toBe(ADAPTER_CONTRACT);
    }
  });

  test("rejects critical active capability without complete evidence tuple", () => {
    const invalid = {
      contract: ADAPTER_CONTRACT,
      adapter: { id: "external:bad", version: "1.0.0", class: "native" },
      discovery: { state: "detected", confidence: 1 },
      capabilities: {
        lifecycleBlocking: {
          critical: true,
          state: "active",
          evidence: {
            adapterVersion: "1.0.0",
            cliVersion: "1.2.3",
            platform: { os: "linux", profile: "default" },
            probeId: "block-negative",
            observedAt: "2026-07-17T00:00:00.000Z"
          }
        }
      }
    };
    const result = validateAdapterDescriptor(invalid);
    expect(result.ok).toBeFalse();
    expect(result.errors.join(" ")).toContain("evidenceUri");
  });

  test("schema requires the public contract and keeps unsupported optional", () => {
    expect(UAI_ADAPTER_V1_SCHEMA.properties.contract.const).toBe("uai.adapter.v1");
    expect(UAI_ADAPTER_V1_SCHEMA.required).not.toContain("capabilities");
    const descriptor = assertAdapterDescriptor({
      contract: ADAPTER_CONTRACT,
      adapter: { id: "external:minimal", version: "1.0.0", class: "discovery-only" },
      discovery: { state: "detected", confidence: 0.5 },
    });
    expect(descriptor.capabilities).toBeUndefined();
  });

  test("rejects malformed external adapter identity at every package boundary", async () => {
    const invalidId = "external:Bad/Path";
    const descriptor = {
      contract: ADAPTER_CONTRACT,
      adapter: { id: invalidId, version: "1.0.0", class: "discovery-only" },
      discovery: { state: "detected", confidence: 1 },
    };
    expect(validateAdapterDescriptor(descriptor).errors).toContain("adapter.id is invalid");
    expect(() => discoverHarness({ explicit: invalidId })).toThrow("Invalid external adapter id");
    const registry = new HarnessRegistry();
    expect(() => registry.register(invalidId as AdapterId, "discovery-only", "1.0.0")).toThrow("Invalid adapter id");
    expect(() => createExternalAdapter({
      id: invalidId as `external:${string}`,
      version: "1.0.0",
      discover: () => ({ detected: true, cliVersion: "fixture", roots: ["/fixture"] }),
      instruction: { relativePath: "UAI.md", sentinel: "UAI_SENTINEL" },
    })).toThrow("Invalid external adapter id");
    const evidence = {
      schema: "uai.conformance.v1", scope: "adapter", suiteId: "uai-adapter-critical-suite",
      adapterId: invalidId, adapterVersion: "1.0.0", cliVersion: "fixture", osProfile: "linux:fixture",
      platformTier: "P2", adapterClass: "discovery-only", observedAt: "2026-07-17T00:00:00.000Z",
      integritySha256: "invalid", evidenceUri: "fixture://invalid", probes: [], audit: [],
    } satisfies ConformanceEvidence;
    expect(certifyFromEvidence({
      wired: true, evidence,
      expected: { adapterId: invalidId, adapterVersion: "1.0.0", cliVersion: "fixture", osProfile: "linux:fixture" },
      now: () => "2026-07-17T00:00:00.000Z",
    }).blockers).toContain("invalid adapter identity");
    const staticSchema = await Bun.file(join(import.meta.dir, "..", "schemas", "uai.adapter.v1.schema.json")).json();
    expect(UAI_ADAPTER_V1_SCHEMA.properties.adapter.properties.id.anyOf[1].pattern).toBe(EXTERNAL_ADAPTER_ID_PATTERN);
    expect(staticSchema.properties.adapter.properties.id.anyOf[1].pattern).toBe(EXTERNAL_ADAPTER_ID_PATTERN);
  });

  test("runtime validator rejects every schema-level malformed shape", () => {
    const valid = {
      contract: ADAPTER_CONTRACT,
      adapter: { id: "unknown", version: "1.0.0", class: "unsupported" },
      discovery: { state: "unsupported", confidence: 0, roots: ["/fixture"], cliVersion: "1.0.0" },
      capabilities: {
        hooks: {
          critical: false,
          state: "detected",
          failMode: "advisory",
          losses: ["not wired"],
          evidence: {
            adapterVersion: "1.0.0",
            cliVersion: "1.0.0",
            platform: { os: "linux", profile: "fixture" },
            probeId: "fixture",
            observedAt: "2026-07-17T00:00:00.000Z",
            evidenceUri: "fixture:///evidence",
          },
        },
      },
      certification: "C0",
      losses: ["unsupported"],
    };
    expect(validateAdapterDescriptor(valid).ok).toBeTrue();
    const malformed = [
      { ...valid, extra: true },
      { ...valid, adapter: { ...valid.adapter, extra: true } },
      { ...valid, discovery: { ...valid.discovery, roots: [7] } },
      { ...valid, discovery: { ...valid.discovery, cliVersion: 42 } },
      { ...valid, losses: [7] },
      { ...valid, capabilities: { hooks: { ...valid.capabilities.hooks, critical: "false" } } },
      { ...valid, capabilities: { hooks: { ...valid.capabilities.hooks, losses: [false] } } },
      { ...valid, capabilities: { hooks: { ...valid.capabilities.hooks, extra: true } } },
      { ...valid, capabilities: { hooks: { ...valid.capabilities.hooks, evidence: { ...valid.capabilities.hooks.evidence, extra: true } } } },
      { ...valid, capabilities: { hooks: { ...valid.capabilities.hooks, evidence: { ...valid.capabilities.hooks.evidence, platform: { ...valid.capabilities.hooks.evidence.platform, extra: true } } } } },
      { ...valid, capabilities: { hooks: { ...valid.capabilities.hooks, evidence: { ...valid.capabilities.hooks.evidence, observedAt: "2026-02-30T00:00:00Z" } } } },
    ];
    for (const [index, value] of malformed.entries()) {
      expect(validateAdapterDescriptor(value).ok, `malformed corpus ${index}`).toBeFalse();
    }
  });
});
