import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIRST_PARTY_BOOTSTRAP_PROVIDERS,
  type BinaryVersionProbe,
  type BootstrapAdapterId,
} from "../bootstrap";
import { HarnessRegistry, discoverHarness } from "../registry";
import { getFirstPartyBootstrapProvider } from "../sdk";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixtureRoot() {
  const value = await mkdtemp(join(tmpdir(), "uai-first-party-bootstrap-"));
  roots.push(value);
  return value;
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

const configBytes: Record<BootstrapAdapterId, Buffer> = {
  claude: Buffer.from('{"foreign":true}\r\n'),
  codex: Buffer.from('model = "fixture"\r\n'),
  opencode: Buffer.from('{"$schema":"https://opencode.ai/config.json","foreign":true}\r\n'),
};

describe("first-party C0/C1 bootstrap providers", () => {
  test("clean machine and unselected providers never choose a default", async () => {
    expect(discoverHarness({})).toEqual({ selected: undefined, candidates: [] });
    const root = await fixtureRoot();
    for (const provider of Object.values(FIRST_PARTY_BOOTSTRAP_PROVIDERS)) {
      const result = await provider.discover({ profileRoot: root, probe: { find: async () => undefined, version: async () => undefined } });
      expect(result).toMatchObject({ detected: false, certification: "C0", blocker: "adapter was not explicitly selected" });
    }
    const claude = FIRST_PARTY_BOOTSTRAP_PROVIDERS.claude;
    expect(await claude.discover({
      selection: "claude", profileRoot: root,
      probe: { find: async () => undefined, version: async () => undefined },
    })).toMatchObject({ detected: false, certification: "C0", blocker: "claude executable was not found" });
    expect(await claude.discover({
      selection: "claude", profileRoot: root,
      probe: { find: async () => join(root, "claude"), version: async () => undefined },
    })).toMatchObject({ detected: false, certification: "C0", blocker: "claude --version did not produce a successful version" });
  });

  for (const adapterId of ["claude", "codex", "opencode"] as const) {
    test(`${adapterId} uses its documented instruction surface and restores foreign bytes`, async () => {
      const provider = FIRST_PARTY_BOOTSTRAP_PROVIDERS[adapterId];
      const root = await fixtureRoot();
      const profileRoot = join(root, "profile");
      const binaryPath = join(root, "bin", provider.surface.executable);
      await mkdir(join(root, "bin"), { recursive: true });
      await writeFile(binaryPath, `fake ${adapterId} binary\n`);
      const probe: BinaryVersionProbe = {
        find: async (executable) => executable === provider.surface.executable ? binaryPath : undefined,
        version: async (path) => path === binaryPath ? `${adapterId}-fixture-1.0.0` : undefined,
      };
      const discovery = await provider.discover({ selection: adapterId, profileRoot, probe });
      expect(discovery).toMatchObject({ detected: true, certification: "C0", binaryPath, cliVersion: `${adapterId}-fixture-1.0.0` });
      expect(discovery.sourceDocs.length).toBeGreaterThan(0);
      expect(discovery.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const instructionPath = join(profileRoot, provider.surface.instruction.relativePath);
      const configPath = join(profileRoot, provider.surface.config.relativePath);
      const originalInstruction = Buffer.from(`# Foreign ${adapterId} instructions\r\nkeep exactly\r\n`);
      const originalConfig = configBytes[adapterId];
      await mkdir(profileRoot, { recursive: true });
      await writeFile(instructionPath, originalInstruction);
      await writeFile(configPath, originalConfig);
      const instructionHash = digest(originalInstruction);
      const configHash = digest(originalConfig);

      const bootstrap = await provider.planC1(discovery);
      expect(bootstrap.certification).toBe("C0");
      expect(bootstrap.plan.mutations).toHaveLength(1);
      expect(bootstrap.plan.mutations[0]).toMatchObject({ kind: "write", path: instructionPath, ownership: "adopted" });
      expect(bootstrap.instructionPath).toBe(instructionPath);
      expect(bootstrap.configPath).toBe(configPath);

      const applied = await provider.applyC1(bootstrap);
      expect(applied).toMatchObject({ certification: "C1", adapterId, cliVersion: `${adapterId}-fixture-1.0.0` });
      expect((await readFile(instructionPath, "utf8"))).toContain(provider.surface.instruction.sentinel);
      expect(digest(await readFile(configPath))).toBe(configHash);
      expect(applied.losses).toContain("instruction bootstrap does not prove lifecycle blocking");
      expect(applied.evidence.sourceDocs).toEqual(provider.surface.sourceDocs);
      expect(applied.evidence.lastVerified).toBe(provider.surface.lastVerified);

      const uninstall = await provider.uninstallC1(applied);
      expect(uninstall.status).toBe("uninstalled");
      expect(digest(await readFile(instructionPath))).toBe(instructionHash);
      expect(digest(await readFile(configPath))).toBe(configHash);
      expect(await Bun.file(applied.journalPath).exists()).toBeFalse();
      expect(await Bun.file(applied.manifestPath).exists()).toBeFalse();
    });
  }


  test("apply refuses caller-authored and cross-root bootstrap plans", async () => {
    const root = await fixtureRoot();
    const claimed = join(root, "claimed");
    const outside = join(root, "outside");
    await Promise.all([mkdir(claimed), mkdir(outside)]);
    const provider = FIRST_PARTY_BOOTSTRAP_PROVIDERS.claude;
    const discovery = await provider.discover({
      selection: "claude",
      profileRoot: claimed,
      probe: {
        find: async () => join(root, "claude"),
        version: async () => "claude-fixture-1.0.0",
      },
    });
    const planned = await provider.planC1(discovery);
    const outsideInstruction = join(outside, "CLAUDE.md");
    const forged = {
      ...planned,
      instructionPath: outsideInstruction,
      configPath: join(outside, "settings.json"),
      profileRoot: claimed,
      plan: {
        ...planned.plan,
        root: outside,
        mutations: planned.plan.mutations.map((mutation) => ({ ...mutation, path: outsideInstruction })),
      },
    };
    await expect(provider.applyC1(forged)).rejects.toThrow();
    expect(await Bun.file(outsideInstruction).exists()).toBeFalse();
  });
  test("registry, SDK, and metadata fixture expose only the proven first-party providers", async () => {
    const registry = new HarnessRegistry();
    expect(registry.bootstrapProvider("claude")?.surface.instruction.relativePath).toBe("CLAUDE.md");
    expect(registry.bootstrapProvider("omp")).toBeUndefined();
    expect(getFirstPartyBootstrapProvider("codex")).toBe(FIRST_PARTY_BOOTSTRAP_PROVIDERS.codex);
    expect(getFirstPartyBootstrapProvider("external:test")).toBeUndefined();
    const fixture = await Bun.file(join(import.meta.dir, "..", "fixtures", "bootstrap-surfaces.json")).json() as Array<{ adapterId: BootstrapAdapterId; instructionPath: string; configPath: string; sourceDoc: string; lastVerified: string }>;
    expect(fixture.map(({ adapterId, instructionPath, configPath }) => ({ adapterId, instructionPath, configPath }))).toEqual(
      Object.values(FIRST_PARTY_BOOTSTRAP_PROVIDERS).map(({ surface }) => ({
        adapterId: surface.adapterId, instructionPath: surface.instruction.relativePath, configPath: surface.config.relativePath,
      })),
    );
    for (const row of fixture) {
      const surface = FIRST_PARTY_BOOTSTRAP_PROVIDERS[row.adapterId].surface;
      expect(surface.sourceDocs).toContain(row.sourceDoc);
      expect(surface.lastVerified).toBe(row.lastVerified);
    }
  });
});
