import { isAbsolute, join, relative, resolve } from "node:path";
import { lstat, readFile, readlink, rm } from "node:fs/promises";
import { ADAPTER_CONTRACT, isExternalAdapterId, type AdapterDescriptor, type ExternalAdapterId } from "./contract";
import { applyInstallPlan, createInstallPlan, uninstallOwned } from "./lifecycle";
import { assertPhysicalInstructionPath, firstPartyBootstrapProvider, type FirstPartyBootstrapProvider } from "./bootstrap";

export interface ExternalDiscovery { detected: boolean; cliVersion?: string; roots: string[] }
export interface ExternalAdapterTemplate {
  id: ExternalAdapterId;
  version: string;
  discover(): ExternalDiscovery;
  instruction: { relativePath: string; sentinel: string };
  losses?: string[];
}
export interface ExternalDiscoveryResult extends ExternalDiscovery {
  descriptor: AdapterDescriptor;
  certification: "C0";
}
export interface ExternalBootstrapResult {
  certification: "C1";
  probes: string[];
  evidence: { adapterVersion: string; cliVersion: string; profileRoot: string; evidenceUri: string };
  cleanup(): Promise<void>;
}
export interface ExternalAdapter {
  descriptor: AdapterDescriptor;
  discover(): ExternalDiscoveryResult;
  bootstrapFixture(profileRoot: string): Promise<ExternalBootstrapResult>;
}

export const ADAPTER_FIXTURE_PACK = {
  discovery: { required: ["detected", "roots"], negative: ["clean-machine", "stale-config-only"] },
  bootstrap: { required: ["instruction-sentinel", "byte-preserving-uninstall", "profile-root-isolation"] },
  firstPartyBootstrap: {
    adapters: ["claude", "codex", "opencode"],
    required: ["explicit-selection", "binary-version", "documented-instruction-path", "byte-preserving-uninstall"],
    lifecycleBlocking: false,
  },
  transcript: { required: ["parser-version", "source-line", "malformed-count"], optional: true },
  hooks: { required: ["fail-mode"], unsupportedByDefault: true },
  mcp: { required: ["environment-allowlist", "redacted-audit"], lifecycleEvidence: false },
} as const;

export function getFirstPartyBootstrapProvider(id: string): FirstPartyBootstrapProvider | undefined {
  return firstPartyBootstrapProvider(id);
}

export function createExternalAdapter(template: ExternalAdapterTemplate): ExternalAdapter {
  if (!isExternalAdapterId(template.id)) throw new Error(`Invalid external adapter id: ${template.id}`);
  if (!template.instruction.relativePath || isAbsolute(template.instruction.relativePath) || relative(".", template.instruction.relativePath).startsWith("..")) throw new Error("Instruction path must be relative and cannot escape the profile root");
  if (!template.instruction.sentinel) throw new Error("Instruction sentinel is required for C1");
  const descriptor: AdapterDescriptor = {
    contract: ADAPTER_CONTRACT,
    adapter: { id: template.id, version: template.version, class: "discovery-only" },
    discovery: { state: "detected", confidence: 0.5 },
    certification: "C0",
    losses: template.losses ?? ["SDK adapter has not provided native lifecycle or transcript surfaces"],
  };
  return {
    descriptor,
    discover() {
      const observed = template.discover();
      return { ...observed, descriptor: { ...descriptor, discovery: { state: observed.detected ? "detected" : "unsupported", confidence: observed.detected ? 1 : 0, roots: observed.roots, cliVersion: observed.cliVersion } }, certification: "C0" };
    },
    async bootstrapFixture(profileRoot) {
      const discovery = template.discover();
      if (!discovery.detected) throw new Error(`${template.id} was not detected`);
      if (!discovery.cliVersion?.trim()) throw new Error(`${template.id} C1 requires an observed CLI version`);
      const canonicalRoot = resolve(profileRoot);
      if (!discovery.roots.some((root) => resolve(root) === canonicalRoot)) throw new Error("Bootstrap profile root was not returned by discovery");
      const path = join(canonicalRoot, template.instruction.relativePath);
      await assertPhysicalInstructionPath(canonicalRoot, path);
      let existing: Buffer | undefined;
      try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`Bootstrap instruction must be a physical regular file: ${path}`);
        existing = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const replacement = existing
        ? Buffer.concat([existing, Buffer.from(`${existing.at(-1) === 0x0a ? "" : "\n"}${template.instruction.sentinel}\n`)])
        : Buffer.from(`${template.instruction.sentinel}\n`);
      const plan = await createInstallPlan({
        id: `${template.id.replace(":", "-")}-c1`,
        root: canonicalRoot,
        mutations: [{ id: "instruction", kind: "write", path, bytes: replacement, ownership: existing ? "adopted" : "owned" }],
      });
      const first = await applyInstallPlan(plan);
      try {
        const content = await Bun.file(path).text();
        if (!content.includes(template.instruction.sentinel)) throw new Error("Instruction sentinel was not observed after bootstrap");
        const uninstall = await uninstallOwned(first.manifest);
        if (uninstall.status !== "uninstalled") throw new Error(`External adapter cleanup preserved changed artifacts: ${uninstall.preserved.join(", ")}`);
        const before = plan.mutations[0]!.before;
        let restored = false;
        try {
          const metadata = await lstat(path);
          if (before.existed && before.kind === "file" && metadata.isFile() && before.bytesBase64 !== undefined) {
            restored = Buffer.compare(await readFile(path), Buffer.from(before.bytesBase64, "base64")) === 0;
          } else if (before.existed && before.kind === "link" && metadata.isSymbolicLink()) {
            restored = await readlink(path) === before.linkTarget;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") restored = !before.existed;
          else throw error;
        }
        if (!restored) throw new Error("External bootstrap did not restore its original baseline");
      } catch (error) {
        await uninstallOwned(first.manifest).catch(() => undefined);
        throw error;
      } finally {
        await rm(first.journalPath, { force: true });
      }
      const applied = await applyInstallPlan(plan);
      const cliVersion = discovery.cliVersion;
      const evidenceUri = `uai-fixture://${template.id}/instruction-sentinel/${encodeURIComponent(cliVersion)}`;
      return {
        certification: "C1",
        probes: ["instruction-sentinel", "byte-preserving-uninstall", "profile-root-isolation"],
        evidence: { adapterVersion: template.version, cliVersion, profileRoot: canonicalRoot, evidenceUri },
        async cleanup() {
          const uninstall = await uninstallOwned(applied.manifest);
          if (uninstall.status === "conflicts") throw new Error(`External adapter cleanup preserved changed artifacts: ${uninstall.preserved.join(", ")}`);
          await rm(applied.journalPath, { force: true });
        },
      };
    },
  };
}
