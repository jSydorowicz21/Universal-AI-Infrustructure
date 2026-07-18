import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  applyInstallPlan,
  createInstallPlan,
  uninstallOwned,
  type InstallPlan,
  type OwnershipManifest,
  type UninstallResult,
} from "./lifecycle";

export type BootstrapAdapterId = "claude" | "codex" | "opencode";

export interface BinaryVersionProbe {
  find(executable: string): Promise<string | undefined>;
  version(binaryPath: string): Promise<string | undefined>;
}

export interface BootstrapSurface {
  adapterId: BootstrapAdapterId;
  adapterVersion: "1.0.0";
  executable: string;
  instruction: { relativePath: string; sentinel: string; authority: "project-context" | "user-context" };
  config: { relativePath: string; format: "json" | "toml" };
  sourceDocs: readonly string[];
  lastVerified: string;
  losses: readonly string[];
}

export interface BootstrapDiscovery {
  adapterId: BootstrapAdapterId;
  detected: boolean;
  certification: "C0";
  profileRoot: string;
  binaryPath?: string;
  cliVersion?: string;
  blocker?: string;
  sourceDocs: readonly string[];
  lastVerified: string;
  losses: readonly string[];
}

export interface C1BootstrapPlan {
  schema: "uai.first-party-bootstrap-plan.v1";
  adapterId: BootstrapAdapterId;
  adapterVersion: "1.0.0";
  certification: "C0";
  cliVersion: string;
  profileRoot: string;
  instructionPath: string;
  configPath: string;
  sentinel: string;
  plan: InstallPlan;
  sourceDocs: readonly string[];
  lastVerified: string;
  losses: readonly string[];
}

export interface C1BootstrapResult {
  certification: "C1";
  adapterId: BootstrapAdapterId;
  adapterVersion: "1.0.0";
  cliVersion: string;
  profileRoot: string;
  instructionPath: string;
  configPath: string;
  journalPath: string;
  manifestPath: string;
  manifest: OwnershipManifest;
  probes: readonly ["instruction-sentinel", "byte-preserving-uninstall", "profile-root-isolation"];
  losses: readonly string[];
  evidence: {
    evidenceUri: string;
    sourceDocs: readonly string[];
    lastVerified: string;
    instructionPath: string;
    configPath: string;
  };
}

export interface FirstPartyBootstrapProvider {
  surface: BootstrapSurface;
  discover(input: { selection?: string; profileRoot: string; probe?: BinaryVersionProbe }): Promise<BootstrapDiscovery>;
  planC1(discovery: BootstrapDiscovery): Promise<C1BootstrapPlan>;
  applyC1(bootstrap: C1BootstrapPlan): Promise<C1BootstrapResult>;
  uninstallC1(applied: C1BootstrapResult): Promise<UninstallResult>;
}

const COMMON_LOSSES = [
  "instruction bootstrap does not prove lifecycle blocking",
  "C1 does not prove native hooks, transcript export, session isolation, or C3 controls",
] as const;

export const FIRST_PARTY_BOOTSTRAP_SURFACES: Record<BootstrapAdapterId, BootstrapSurface> = {
  claude: {
    adapterId: "claude", adapterVersion: "1.0.0", executable: "claude",
    instruction: { relativePath: "CLAUDE.md", sentinel: "UAI_CLAUDE_INSTRUCTION_SENTINEL_V1", authority: "user-context" },
    config: { relativePath: "settings.json", format: "json" },
    sourceDocs: ["https://code.claude.com/docs/en/memory", "https://code.claude.com/docs/en/settings"],
    lastVerified: "2026-07-17",
    losses: [...COMMON_LOSSES, "native Claude hook wiring remains an installer-owned integration"],
  },
  codex: {
    adapterId: "codex", adapterVersion: "1.0.0", executable: "codex",
    instruction: { relativePath: "AGENTS.md", sentinel: "UAI_CODEX_INSTRUCTION_SENTINEL_V1", authority: "user-context" },
    config: { relativePath: "config.toml", format: "toml" },
    sourceDocs: ["https://developers.openai.com/codex/guides/agents-md/", "https://developers.openai.com/codex/config-reference/"],
    lastVerified: "2026-07-17",
    losses: [...COMMON_LOSSES, "AGENTS.md supplies instructions but no native lifecycle-blocking contract"],
  },
  opencode: {
    adapterId: "opencode", adapterVersion: "1.0.0", executable: "opencode",
    instruction: { relativePath: "AGENTS.md", sentinel: "UAI_OPENCODE_INSTRUCTION_SENTINEL_V1", authority: "user-context" },
    config: { relativePath: "opencode.json", format: "json" },
    sourceDocs: ["https://opencode.ai/docs/rules/", "https://opencode.ai/docs/config/"],
    lastVerified: "2026-07-17",
    losses: [...COMMON_LOSSES, "AGENTS.md does not prove blocking plugin-event semantics or system authority"],
  },
};

const DEFAULT_BINARY_PROBE: BinaryVersionProbe = {
  async find(executable) {
    return Bun.which(executable) ?? undefined;
  },
  async version(binaryPath) {
    const child = Bun.spawn([binaryPath, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) return undefined;
    return `${stdout}\n${stderr}`.trim().split(/\r?\n/, 1)[0] || undefined;
  },
};

function appendSentinel(existing: Uint8Array | undefined, surface: BootstrapSurface): Buffer {
  const before = existing ? Buffer.from(existing) : Buffer.alloc(0);
  if (before.includes(surface.instruction.sentinel)) return before;
  const prefix = before.length === 0 ? "" : before.at(-1) === 0x0a ? "\n" : "\n\n";
  const section = `${prefix}<!-- UAI ${surface.adapterId} ${surface.adapterVersion} BEGIN -->\n${surface.instruction.sentinel}\n<!-- UAI ${surface.adapterId} ${surface.adapterVersion} END -->\n`;
  return Buffer.concat([before, Buffer.from(section)]);
}

export async function assertPhysicalInstructionPath(profileRoot: string, path: string): Promise<void> {
  const root = resolve(profileRoot);
  const candidate = resolve(path);
  const delta = relative(root, candidate);
  if (delta === ".." || delta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(delta)) {
    throw new Error(`Bootstrap instruction escapes the selected profile root: ${path}`);
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const segments = delta.split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error(`Bootstrap instruction crosses a linked ancestor: ${current}`);
    const physical = await realpath(current);
    const physicalDelta = relative(canonicalRoot, physical);
    if (physicalDelta === ".." || physicalDelta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(physicalDelta)) {
      throw new Error(`Bootstrap instruction escapes the selected profile root: ${path}`);
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) throw new Error(`Bootstrap instruction has a non-directory ancestor: ${current}`);
  }
}

function provider(surface: BootstrapSurface): FirstPartyBootstrapProvider {
  const discoveries = new WeakMap<BootstrapDiscovery, { profileRoot: string; binaryPath?: string; cliVersion?: string }>();
  const plans = new WeakMap<C1BootstrapPlan, string>();
  return {
    surface,
    async discover(input) {
      const base = {
        adapterId: surface.adapterId, certification: "C0" as const, profileRoot: resolve(input.profileRoot),
        sourceDocs: surface.sourceDocs, lastVerified: surface.lastVerified, losses: surface.losses,
      };
      let result: BootstrapDiscovery;
      if (input.selection !== surface.adapterId) result = { ...base, detected: false, blocker: "adapter was not explicitly selected" };
      else {
        const probe = input.probe ?? DEFAULT_BINARY_PROBE;
        const binaryPath = await probe.find(surface.executable);
        if (!binaryPath) result = { ...base, detected: false, blocker: `${surface.executable} executable was not found` };
        else {
          const cliVersion = await probe.version(binaryPath);
          result = cliVersion
            ? { ...base, detected: true, binaryPath, cliVersion }
            : { ...base, detected: false, binaryPath, blocker: `${surface.executable} --version did not produce a successful version` };
        }
      }
      discoveries.set(result, { profileRoot: result.profileRoot, binaryPath: result.binaryPath, cliVersion: result.cliVersion });
      return result;
    },
    async planC1(discovery) {
      const issuedDiscovery = discoveries.get(discovery);
      if (!issuedDiscovery) throw new Error("Discovery was not created by this bootstrap provider");
      if (discovery.profileRoot !== issuedDiscovery.profileRoot || discovery.binaryPath !== issuedDiscovery.binaryPath || discovery.cliVersion !== issuedDiscovery.cliVersion) {
        throw new Error("Discovery changed after provider validation");
      }
      if (discovery.adapterId !== surface.adapterId) throw new Error(`Discovery belongs to ${discovery.adapterId}, not ${surface.adapterId}`);
      if (!discovery.detected || !discovery.cliVersion || !discovery.binaryPath) throw new Error(discovery.blocker ?? `${surface.adapterId} is not detected`);
      if (!isAbsolute(discovery.profileRoot)) throw new Error("Bootstrap profile root must be absolute");
      const instructionPath = join(discovery.profileRoot, surface.instruction.relativePath);
      const configPath = join(discovery.profileRoot, surface.config.relativePath);
      await assertPhysicalInstructionPath(discovery.profileRoot, instructionPath);
      let existing: Buffer | undefined;
      try {
        const metadata = await lstat(instructionPath);
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`Bootstrap instruction must be a physical regular file: ${instructionPath}`);
        existing = await readFile(instructionPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const bytes = appendSentinel(existing, surface);
      const plan = await createInstallPlan({
        id: `first-party-${surface.adapterId}-c1-${randomUUID()}`,
        root: discovery.profileRoot,
        mutations: [{
          id: "instruction", kind: "write", path: instructionPath, bytes,
          ownership: existing ? "adopted" : "owned",
        }],
      });
      const result: C1BootstrapPlan = {
        schema: "uai.first-party-bootstrap-plan.v1", adapterId: surface.adapterId, adapterVersion: surface.adapterVersion,
        certification: "C0", cliVersion: discovery.cliVersion, profileRoot: discovery.profileRoot,
        instructionPath, configPath, sentinel: surface.instruction.sentinel, plan,
        sourceDocs: surface.sourceDocs, lastVerified: surface.lastVerified, losses: surface.losses,
      };
      plans.set(result, JSON.stringify({
        adapterId: result.adapterId,
        adapterVersion: result.adapterVersion,
        cliVersion: result.cliVersion,
        profileRoot: result.profileRoot,
        instructionPath: result.instructionPath,
        configPath: result.configPath,
        sentinel: result.sentinel,
        plan: result.plan,
      }));
      return result;
    },
    async applyC1(bootstrap) {
      const issued = plans.get(bootstrap);
      if (!issued) throw new Error("Bootstrap plan was not created by this provider");
      const currentCoordinates = JSON.stringify({
        adapterId: bootstrap.adapterId,
        adapterVersion: bootstrap.adapterVersion,
        cliVersion: bootstrap.cliVersion,
        profileRoot: bootstrap.profileRoot,
        instructionPath: bootstrap.instructionPath,
        configPath: bootstrap.configPath,
        sentinel: bootstrap.sentinel,
        plan: bootstrap.plan,
      });
      if (currentCoordinates !== issued) throw new Error("Bootstrap plan changed after provider validation");
      const expectedInstructionPath = join(bootstrap.profileRoot, surface.instruction.relativePath);
      const expectedConfigPath = join(bootstrap.profileRoot, surface.config.relativePath);
      const mutation = bootstrap.plan.mutations[0];
      if (bootstrap.schema !== "uai.first-party-bootstrap-plan.v1"
        || bootstrap.adapterId !== surface.adapterId
        || bootstrap.adapterVersion !== surface.adapterVersion
        || bootstrap.certification !== "C0"
        || !bootstrap.cliVersion
        || bootstrap.instructionPath !== expectedInstructionPath
        || bootstrap.configPath !== expectedConfigPath
        || bootstrap.sentinel !== surface.instruction.sentinel
        || bootstrap.plan.root !== bootstrap.profileRoot
        || bootstrap.plan.mutations.length !== 1
        || !mutation
        || mutation.kind !== "write"
        || mutation.id !== "instruction"
        || mutation.path !== expectedInstructionPath
        || !mutation.bytesBase64
        || !Buffer.from(mutation.bytesBase64, "base64").includes(surface.instruction.sentinel)) {
        throw new Error("Bootstrap plan does not match the provider surface");
      }
      const firstApplied = await applyInstallPlan(bootstrap.plan);
      try {
        const content = await readFile(bootstrap.instructionPath, "utf8");
        if (!content.includes(bootstrap.sentinel)) throw new Error(`${surface.adapterId} instruction sentinel was not observed`);
        const cleanup = await uninstallOwned(firstApplied.manifest);
        if (cleanup.status !== "uninstalled") throw new Error(`Bootstrap round-trip cleanup conflicted: ${cleanup.preserved.join(", ")}`);
        const before = mutation.before;
        let restored = false;
        try {
          const metadata = await lstat(bootstrap.instructionPath);
          if (before.existed && before.kind === "file" && metadata.isFile() && before.bytesBase64 !== undefined) {
            restored = Buffer.compare(await readFile(bootstrap.instructionPath), Buffer.from(before.bytesBase64, "base64")) === 0;
          } else if (before.existed && before.kind === "link" && metadata.isSymbolicLink()) {
            restored = await readlink(bootstrap.instructionPath) === before.linkTarget;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") restored = !before.existed;
          else throw error;
        }
        if (!restored) throw new Error("Bootstrap round-trip did not restore the preinstall baseline byte-for-byte");
      } catch (error) {
        await uninstallOwned(firstApplied.manifest).catch(() => undefined);
        throw error;
      } finally {
        await rm(firstApplied.journalPath, { force: true });
      }
      const applied = await applyInstallPlan(bootstrap.plan);
      const manifestPath = join(bootstrap.profileRoot, ".uai-ownership", `${bootstrap.plan.id}.json`);
      return {
        certification: "C1", adapterId: surface.adapterId, adapterVersion: surface.adapterVersion,
        cliVersion: bootstrap.cliVersion, profileRoot: bootstrap.profileRoot,
        instructionPath: bootstrap.instructionPath, configPath: bootstrap.configPath,
        journalPath: applied.journalPath, manifestPath, manifest: applied.manifest,
        probes: ["instruction-sentinel", "byte-preserving-uninstall", "profile-root-isolation"],
        losses: bootstrap.losses,
        evidence: {
          evidenceUri: `uai-bootstrap://${surface.adapterId}/c1/${encodeURIComponent(bootstrap.cliVersion)}`,
          sourceDocs: bootstrap.sourceDocs, lastVerified: bootstrap.lastVerified,
          instructionPath: bootstrap.instructionPath, configPath: bootstrap.configPath,
        },
      };
    },
    async uninstallC1(applied) {
      if (applied.adapterId !== surface.adapterId || applied.adapterVersion !== surface.adapterVersion) throw new Error("Applied bootstrap does not match provider version");
      const result = await uninstallOwned(applied.manifest);
      if (result.status === "uninstalled") {
        await Promise.all([rm(applied.journalPath, { force: true }), rm(applied.manifestPath, { force: true })]);
        for (const directory of [dirname(applied.journalPath), dirname(applied.manifestPath)]) await rmdir(directory).catch(() => undefined);
      }
      return result;
    },
  };
}

export const FIRST_PARTY_BOOTSTRAP_PROVIDERS: Record<BootstrapAdapterId, FirstPartyBootstrapProvider> = {
  claude: provider(FIRST_PARTY_BOOTSTRAP_SURFACES.claude),
  codex: provider(FIRST_PARTY_BOOTSTRAP_SURFACES.codex),
  opencode: provider(FIRST_PARTY_BOOTSTRAP_SURFACES.opencode),
};

export function firstPartyBootstrapProvider(id: string): FirstPartyBootstrapProvider | undefined {
  return id === "claude" || id === "codex" || id === "opencode" ? FIRST_PARTY_BOOTSTRAP_PROVIDERS[id] : undefined;
}
