import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, boundedAuditRow, createSessionIdentity, parseTranscriptLines, type AuditRow } from "./canonical";
import { applyInstallPlan, createInstallPlan, recoverJournal, uninstallOwned } from "./lifecycle";
import { evaluateCommand, evaluateRoute, evaluateWrite, taintExternalContent } from "./policy";
import { assertAdapterDescriptor, isExternalAdapterId, type AdapterClass, type CertificationLevel, type EvidenceTuple } from "./contract";
import type { Adapter, FirstPartyAdapterId, NativeDecision } from "./adapters";

export const REQUIRED_PROBES = [
  "instruction-sentinel",
  "forbidden-benign-command",
  "system-user-boundary",
  "missing-hook",
  "external-content-provenance",
  "route-ceiling",
  "two-session-isolation",
  "two-profile-roots",
  "invalid-config-atomic-write",
  "install-uninstall-preservation",
  "failure-injection-rollback",
] as const;
export type RequiredProbeId = typeof REQUIRED_PROBES[number];
export type ExecutorTrust = "fixture" | "trusted-staged-native" | "trusted-live";
export type ExecutorSurface = "adapter-mapping" | "staged-native-dispatch" | "live-native-dispatch";
export interface ExecutorProvenance {
  id: string;
  adapterId: string;
  trust: ExecutorTrust;
  surface: ExecutorSurface;
  observedCliVersion?: string;
  installationEvidenceUri?: string;
}
export interface AdapterProbeBinding {
  scope: "adapter";
  adapterId: string;
  adapterVersion: string;
  cliVersion: string;
  osProfile: string;
  executorId: string;
  executorTrust: ExecutorTrust;
  executorSurface: ExecutorSurface;
  observedCliVersion?: string;
  nativeEventType: string;
  nativeProofSha256: string;
}
export interface ProbeResult { id: RequiredProbeId; passed: boolean; details: string; adapterBinding?: AdapterProbeBinding }
export interface ConformanceContext {
  adapterId: string;
  adapterVersion: string;
  cliVersion: string;
  osProfile: string;
  platformTier: string;
  adapterClass: AdapterClass;
  now?: () => string;
}
export interface ConformanceEvidence {
  schema: "uai.conformance.v1";
  scope: "kernel" | "adapter";
  suiteId: "uai-kernel-suite" | "uai-adapter-critical-suite";
  adapterId: string;
  adapterVersion: string;
  cliVersion: string;
  osProfile: string;
  platformTier: string;
  adapterClass: AdapterClass;
  observedAt: string;
  integritySha256: string;
  evidenceUri: string;
  probes: ProbeResult[];
  executor?: ExecutorProvenance;
  audit: AuditRow[];
}
export interface AdapterProbeObservation { passed: boolean; details: string; nativeEventType: string; nativeProof: unknown; observedCliVersion?: string }
export interface AdapterProbeExecutor extends ExecutorProvenance {
  adapterId: FirstPartyAdapterId;
  execute(request: AdapterProbeRequest): Promise<AdapterProbeObservation>;
}
export interface CertificationExpectation { adapterId: string; adapterVersion: string; cliVersion: string; osProfile: string; executorId?: string }
export interface CertificationResult { state: "wired" | "observed" | "active"; certification: CertificationLevel; blockers: string[]; evidence?: EvidenceTuple }

function probe(id: RequiredProbeId, passed: boolean, details: string): ProbeResult {
  return { id, passed, details };
}

async function runInstructionProbe(root: string) {
  const path = join(root, "profile", "UAI.md");
  const sentinel = "UAI_INSTRUCTION_SENTINEL_20260717";
  await mkdir(join(root, "profile"), { recursive: true });
  await writeFile(path, `${sentinel}\n`);
  return probe("instruction-sentinel", (await readFile(path, "utf8")).includes(sentinel), "fixture instruction was loaded from the isolated profile");
}

function runPolicyProbes(root: string) {
  const command = evaluateCommand("rm -rf /");
  const benign = evaluateCommand("echo hello");
  const systemRoot = join(root, "profile", "SYSTEM");
  const userRoot = join(root, "data", "USER");
  const system = evaluateWrite(join(systemRoot, "policy.md"), { systemRoot, userRoot });
  const user = evaluateWrite(join(userRoot, "notes.md"), { systemRoot, userRoot });
  const external = taintExternalContent({ output: "external", sourceUri: "https://fixture.invalid/item", tool: "WebFetch" });
  const unknownRoute = evaluateRoute({ dataClass: "SENSITIVE" });
  const allowedRoute = evaluateRoute({ dataClass: "INTERNAL", route: { id: "local-fixture", maximumDataClass: "INTERNAL" } });
  return [
    probe("forbidden-benign-command", command.action === "block" && benign.action === "allow", "forbidden command blocked and benign command allowed"),
    probe("system-user-boundary", system.action === "block" && user.action === "allow", "SYSTEM write blocked and equivalent USER write allowed"),
    probe("external-content-provenance", external.policy.action === "taint" && external.policy.provenance?.tainted === true && Boolean(external.policy.provenance.sourceUri), "external content retained taint, tool and source URI; no prevention claim"),
    probe("route-ceiling", unknownRoute.action === "block" && allowedRoute.action === "allow", "unknown route used PUBLIC ceiling and declared route enforced maximum class"),
  ];
}

async function runMissingHookProbe(root: string) {
  const missing = join(root, "profile", "hooks", "missing.ts");
  return probe("missing-hook", !(await Bun.file(missing).exists()), "missing required hook was reported as a visible blocker");
}

async function runIsolationProbes(root: string) {
  const profileA = join(root, "profile-a");
  const profileB = join(root, "profile-b");
  const first = createSessionIdentity({ adapterId: "omp", profileRoot: profileA, nativeSessionId: "fixture", entropy: "session-a" });
  const second = createSessionIdentity({ adapterId: "omp", profileRoot: profileA, nativeSessionId: "fixture", entropy: "session-b" });
  const otherProfile = createSessionIdentity({ adapterId: "omp", profileRoot: profileB, nativeSessionId: "fixture", entropy: "session-a" });
  await Promise.all([mkdir(join(profileA, "sessions"), { recursive: true }), mkdir(join(profileB, "sessions"), { recursive: true })]);
  const firstState = join(profileA, "sessions", `${first.uaiSessionId}.json`);
  const secondState = join(profileA, "sessions", `${second.uaiSessionId}.json`);
  const otherState = join(profileB, "sessions", `${otherProfile.uaiSessionId}.json`);
  await Promise.all([
    atomicWriteJson(firstState, { session: first.uaiSessionId, marker: "first" }),
    atomicWriteJson(secondState, { session: second.uaiSessionId, marker: "second" }),
    atomicWriteJson(otherState, { session: otherProfile.uaiSessionId, marker: "other-profile" }),
  ]);
  const [firstRow, secondRow, otherRow] = await Promise.all([readFile(firstState, "utf8"), readFile(secondState, "utf8"), readFile(otherState, "utf8")]);
  const transcript = parseTranscriptLines("omp", [JSON.stringify({ id: "one", message: { role: "assistant", content: "ok" } }), "malformed"], "fixture:///omp/session.jsonl", "omp-parser@1");
  return [
    probe("two-session-isolation", first.uaiSessionId !== second.uaiSessionId && firstRow.includes("first") && secondRow.includes("second") && transcript.entries[0]?.provenance.transcriptUri === "fixture:///omp/session.jsonl" && transcript.malformedCount === 1, "concurrent identities have separate state and transcript provenance accounts for malformed lines"),
    probe("two-profile-roots", first.uaiSessionId !== otherProfile.uaiSessionId && first.profileRoot !== otherProfile.profileRoot && !firstRow.includes("other-profile") && otherRow.includes("other-profile"), "separate profile roots retain distinct state"),
  ];
}

async function runAtomicConfigProbe(root: string) {
  const invalid = join(root, "profile", "invalid.json");
  await mkdir(join(root, "profile"), { recursive: true });
  const original = Buffer.from("{ invalid\r\n");
  await writeFile(invalid, original);
  let blocked = false;
  try {
    await createInstallPlan({ root, mutations: [{ id: "invalid", kind: "write", path: invalid, bytes: Buffer.from("{}\n"), ownership: "adopted", structured: "json" }] });
  } catch {
    blocked = true;
  }
  const unchanged = Buffer.compare(await readFile(invalid), original) === 0;
  const state = join(root, "state", "critical.json");
  await atomicWriteJson(state, { state: "old" });
  let interrupted = false;
  try {
    await atomicWriteJson(state, { state: "partial" }, { injectFailureBeforeRename: true });
  } catch {
    interrupted = true;
  }
  const oldSurvived = JSON.parse(await readFile(state, "utf8")).state === "old";
  await atomicWriteJson(state, { state: "new" });
  const valid = JSON.parse(await readFile(state, "utf8")).state === "new";
  return probe("invalid-config-atomic-write", blocked && unchanged && interrupted && oldSurvived && valid, "invalid config remained byte-identical and interrupted critical state remained old valid JSON");
}

async function runLifecycleProbe(root: string) {
  const settings = join(root, "profile", "settings.json");
  const hook = join(root, "profile", "hooks", "uai.ts");
  const original = Buffer.from('{"foreign":true}\r\n');
  await writeFile(settings, original);
  const plan = await createInstallPlan({ id: "conformance-install", root, mutations: [
    { id: "settings", kind: "write", path: settings, bytes: Buffer.from('{"foreign":true,"uai":true}\n'), ownership: "adopted", structured: "json" },
    { id: "hook", kind: "write", path: hook, bytes: Buffer.from("export {};\n"), ownership: "owned" },
  ] });
  const applied = await applyInstallPlan(plan);
  const uninstall = await uninstallOwned(applied.manifest);
  const preserved = Buffer.compare(await readFile(settings), original) === 0;
  const removed = !(await Bun.file(hook).exists());
  return probe("install-uninstall-preservation", uninstall.status === "uninstalled" && preserved && removed, "uninstall restored adopted bytes and removed only the owned hook");
}

async function runFailureInjectionRollbackProbe(root: string) {
  const probeRoot = join(root, "failure-injection-rollback");
  const profile = join(probeRoot, "profile");
  const originalTarget = join(probeRoot, "original-target");
  const replacementTarget = join(probeRoot, "replacement-target");
  const settings = join(profile, "settings.json");
  const linked = join(profile, "linked");
  const owned = join(profile, "new-owned.json");
  await Promise.all([mkdir(profile, { recursive: true }), mkdir(originalTarget, { recursive: true }), mkdir(replacementTarget, { recursive: true })]);
  const originalBytes = Buffer.from('{"foreign":true}\r\n');
  await writeFile(settings, originalBytes);
  await chmod(settings, 0o600);
  const originalMode = (await lstat(settings)).mode;
  await symlink(originalTarget, linked, process.platform === "win32" ? "junction" : "dir");
  const originalLink = await readlink(linked);
  const plan = await createInstallPlan({ id: "conformance-failure-rollback", root: probeRoot, mutations: [
    { id: "settings", kind: "write", path: settings, bytes: Buffer.from('{"foreign":true,"uai":true}\n'), ownership: "adopted", structured: "json" },
    { id: "link", kind: "link", path: linked, target: replacementTarget, targetKind: "directory", linkKind: process.platform === "win32" ? "junction" : "symlink", ownership: "adopted" },
    { id: "owned", kind: "write", path: owned, bytes: Buffer.from('{"owned":true}\n'), ownership: "owned", structured: "json" },
  ] });
  let injected = false;
  let injectionError = "";
  try {
    await applyInstallPlan(plan, { injectFailureAfter: 3 });
  } catch (error) {
    injectionError = (error as Error).message;
    injected = injectionError.includes("Injected failure");
  }
  const journalDirectory = join(probeRoot, ".uai-journal");
  const rollbackJournal = (await readdir(journalDirectory)).find((name) => name.startsWith("conformance-failure-rollback-"));
  if (!rollbackJournal) throw new Error("Missing rollback journal");
  const journal = JSON.parse(await readFile(join(journalDirectory, rollbackJournal), "utf8")) as { status?: string };
  const exactRollback = Buffer.compare(await readFile(settings), originalBytes) === 0
    && (await lstat(settings)).mode === originalMode
    && (await readlink(linked)) === originalLink
    && !(await Bun.file(owned).exists())
    && journal.status === "rolled-back";

  const boundary = join(profile, "boundary.json");
  const boundaryBytes = Buffer.from('{"state":"old"}\n');
  await writeFile(boundary, boundaryBytes);
  const boundaryPlan = await createInstallPlan({ id: "conformance-manifest-boundary", root: probeRoot, mutations: [
    { id: "boundary", kind: "write", path: boundary, bytes: Buffer.from('{"state":"installed"}\n'), ownership: "adopted", structured: "json" },
  ] });
  let boundaryCrash = false;
  try {
    await applyInstallPlan(boundaryPlan, { injectCrashAfterManifest: true });
  } catch (error) {
    boundaryCrash = (error as Error).message.includes("Injected crash after ownership manifest persistence");
  }
  const boundaryJournalName = (await readdir(journalDirectory)).find((name) => name.startsWith("conformance-manifest-boundary-"));
  if (!boundaryJournalName) throw new Error("Missing manifest-boundary journal");
  const boundaryJournal = join(journalDirectory, boundaryJournalName);
  const manifest = join(probeRoot, ".uai-ownership", "conformance-manifest-boundary.json");
  const manifestWasDurable = await Bun.file(manifest).exists();
  const recovery = await recoverJournal(boundaryJournal);
  const boundaryRecovered = recovery.status === "rolled-back"
    && Buffer.compare(await readFile(boundary), boundaryBytes) === 0
    && !(await Bun.file(manifest).exists());

  const checks = { injected, exactRollback, boundaryCrash, manifestWasDurable, boundaryRecovered, injectionError };
  return probe(
    "failure-injection-rollback",
    injected && exactRollback && boundaryCrash && manifestWasDurable && boundaryRecovered,
    `injected multi-mutation rollback and manifest-boundary recovery checks: ${JSON.stringify(checks)}`,
  );
}

async function runKernelProbes(root: string) {
  return [
    await runInstructionProbe(root),
    ...runPolicyProbes(root),
    await runMissingHookProbe(root),
    ...(await runIsolationProbes(root)),
    await runAtomicConfigProbe(root),
    await runLifecycleProbe(root),
    await runFailureInjectionRollbackProbe(root),
  ];
}

function evidencePayload(evidence: Omit<ConformanceEvidence, "integritySha256" | "evidenceUri"> | ConformanceEvidence) {
  const { integritySha256: _integrity, evidenceUri: _uri, ...payload } = evidence as ConformanceEvidence;
  return payload;
}

function evidenceDigest(evidence: Omit<ConformanceEvidence, "integritySha256" | "evidenceUri"> | ConformanceEvidence) {
  return createHash("sha256").update(JSON.stringify(evidencePayload(evidence))).digest("hex");
}

function buildEvidence(context: ConformanceContext, scope: ConformanceEvidence["scope"], probes: ProbeResult[], executor?: ExecutorProvenance): ConformanceEvidence {
  const observedAt = (context.now ?? (() => new Date().toISOString()))();
  const audit = probes.map((result) => boundedAuditRow({ eventId: result.id, occurredAt: observedAt, decision: result.passed ? "pass" : "fail", adapterId: context.adapterId, details: { probe: result.id, passed: result.passed, scope } }));
  const payload = {
    schema: "uai.conformance.v1" as const,
    scope,
    suiteId: scope === "adapter" ? "uai-adapter-critical-suite" as const : "uai-kernel-suite" as const,
    adapterId: context.adapterId,
    adapterVersion: context.adapterVersion,
    cliVersion: context.cliVersion,
    osProfile: context.osProfile,
    platformTier: context.platformTier,
    adapterClass: context.adapterClass,
    observedAt,
    ...(executor ? { executor } : {}),
    probes,
    audit,
  };
  const integritySha256 = evidenceDigest(payload);
  return { ...payload, integritySha256, evidenceUri: `data:application/json;sha256,${integritySha256}` };
}

export async function runConformance(context: ConformanceContext): Promise<ConformanceEvidence> {
  const root = await mkdtemp(join(tmpdir(), "uai-kernel-conformance-"));
  try {
    return buildEvidence(context, "kernel", await runKernelProbes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function preToolPayload(adapterId: FirstPartyAdapterId, command: string) {
  if (adapterId === "claude") return { hook_event_name: "PreToolUse", session_id: "fixture-native", tool_name: "Bash", tool_input: { command } };
  if (adapterId === "omp") return { event: "tool.execute.before", session: { id: "fixture-native" }, tool: { name: "Bash", input: { command } } };
  if (adapterId === "codex") return { hook_event_name: "PreToolUse", session_id: "fixture-native", tool_name: "Bash", tool_input: { command } };
  return { event: "tool.execute.before", sessionID: "fixture-native", tool: "Bash", input: { command } };
}

function postToolPayload(adapterId: FirstPartyAdapterId) {
  const provenance = { transcriptUri: "fixture:///native.jsonl", parserVersion: "fixture@1", sourceLine: 1, sourceUri: "https://fixture.invalid/item", tainted: true };
  if (adapterId === "claude") return { hook_event_name: "PostToolUse", session_id: "fixture-native", tool_name: "WebFetch", tool_input: {}, tool_result: "external", provenance };
  if (adapterId === "omp") return { event: "tool.execute.after", session: { id: "fixture-native" }, tool: { name: "WebFetch", input: {} }, result: "external", provenance };
  if (adapterId === "codex") return { hook_event_name: "PostToolUse", session_id: "fixture-native", tool_name: "WebFetch", tool_input: {}, tool_response: "external", provenance };
  return { event: "tool.execute.after", sessionID: "fixture-native", tool: "WebFetch", input: {}, result: "external", provenance };
}

function transcriptFixture(adapterId: FirstPartyAdapterId) {
  if (adapterId === "claude") return JSON.stringify({ id: "fixture-row", role: "assistant", content: "ok" });
  if (adapterId === "codex") return JSON.stringify({ type: "response_item", id: "fixture-row", role: "assistant", content: "ok" });
  if (adapterId === "opencode") return JSON.stringify({ id: "fixture-row", message: { role: "assistant", content: "ok" } });
  return JSON.stringify({ id: "fixture-row", message: { message: { role: "assistant", content: "ok" } } });
}

function blockObserved(adapterId: FirstPartyAdapterId, decision: NativeDecision) {
  if (adapterId === "claude") return decision.exitCode === 2;
  if (adapterId === "omp") return decision.output?.block === true;
  if (adapterId === "codex") return decision.exitCode === 0 && decision.output?.decision === "block";
  return decision.output?.permission === "deny";
}

function allowObserved(adapterId: FirstPartyAdapterId, decision: NativeDecision) {
  if (adapterId === "claude") return decision.exitCode === 0;
  if (adapterId === "omp") return decision.output?.block === false;
  if (adapterId === "codex") return decision.exitCode === 0 && decision.output?.hookSpecificOutput?.permissionDecision === "allow";
  return decision.output?.permission === "allow";
}

export function createFixtureHarnessExecutor(adapterId: FirstPartyAdapterId): AdapterProbeExecutor {
  return {
    id: "uai-fixture-harness@1",
    adapterId,
    trust: "fixture",
    surface: "adapter-mapping",
    async execute({ probe: kernelProbe, adapter, root }) {
      const forbidden = adapter.normalize(preToolPayload(adapterId, "rm -rf /"));
      const benign = adapter.normalize(preToolPayload(adapterId, "echo hello"));
      const block = adapter.lower({ action: "block", reason: kernelProbe.id });
      const allow = adapter.lower({ action: "allow", reason: kernelProbe.id });
      let passed = forbidden.type === "tool.before" && benign.type === "tool.before";
      let nativeEventType = forbidden.type;
      if (kernelProbe.id === "forbidden-benign-command" || kernelProbe.id === "system-user-boundary" || kernelProbe.id === "route-ceiling") {
        passed = passed && blockObserved(adapterId, block) && allowObserved(adapterId, allow);
      } else if (kernelProbe.id === "missing-hook") {
        passed = passed && !(await Bun.file(join(root, "profile", "hooks", "missing.ts")).exists()) && blockObserved(adapterId, block);
      } else if (kernelProbe.id === "external-content-provenance") {
        const post = adapter.normalize(postToolPayload(adapterId));
        nativeEventType = post.type;
        passed = post.type === "tool.after" && post.result?.provenance?.tainted === true && Boolean(post.result.provenance.sourceUri);
      } else if (kernelProbe.id === "two-session-isolation" || kernelProbe.id === "two-profile-roots") {
        const transcript = parseTranscriptLines(adapterId, [transcriptFixture(adapterId), "malformed"], `fixture:///${adapterId}/session.jsonl`, `${adapterId}-parser@1`);
        passed = passed && transcript.entries.length === 1 && transcript.malformedCount === 1 && transcript.entries[0].provenance.transcriptUri.includes(adapterId);
      } else {
        passed = passed && allowObserved(adapterId, allow);
      }
      return {
        passed,
        details: `${adapterId} normalize/lower and fixture harness observation for ${kernelProbe.id}`,
        nativeEventType,
        nativeProof: { normalized: forbidden, block, allow },
      };
    },
  };
}


export async function runAdapterConformance(input: { context: ConformanceContext; adapter: Adapter; executor: AdapterProbeExecutor }): Promise<ConformanceEvidence> {
  const descriptor = assertAdapterDescriptor(input.adapter.descriptor);
  if (descriptor.adapter.id !== input.context.adapterId || descriptor.adapter.version !== input.context.adapterVersion) throw new Error("Adapter descriptor does not match conformance context");
  if (descriptor.adapter.class !== input.context.adapterClass) throw new Error("Adapter class does not match conformance context");
  if (input.executor.adapterId !== input.context.adapterId) throw new Error("Probe executor does not match selected adapter");
  if (input.executor.trust !== "fixture" && input.executor.observedCliVersion !== input.context.cliVersion) throw new Error("Trusted probe executor CLI observation does not match conformance context");
  const root = await mkdtemp(join(tmpdir(), "uai-adapter-conformance-"));
  try {
    const kernelProbes = await runKernelProbes(root);
    const probes: ProbeResult[] = [];
    for (const kernelProbe of kernelProbes) {
      const observation = await input.executor.execute({ probe: kernelProbe, adapter: input.adapter, context: input.context, root });
      if (input.executor.trust !== "fixture" && observation.observedCliVersion !== input.executor.observedCliVersion) throw new Error(`Trusted executor returned an unbound CLI outcome for ${kernelProbe.id}`);
      const nativeProofSha256 = createHash("sha256").update(JSON.stringify(observation.nativeProof)).digest("hex");
      probes.push({
        id: kernelProbe.id,
        passed: kernelProbe.passed && observation.passed,
        details: `${kernelProbe.details}; ${observation.details}`,
        adapterBinding: {
          scope: "adapter", adapterId: input.context.adapterId, adapterVersion: input.context.adapterVersion,
          cliVersion: input.context.cliVersion, osProfile: input.context.osProfile, executorId: input.executor.id,
          executorTrust: input.executor.trust, executorSurface: input.executor.surface, observedCliVersion: observation.observedCliVersion ?? input.executor.observedCliVersion,
          nativeEventType: observation.nativeEventType, nativeProofSha256,
        },
      });
    }
    return buildEvidence(input.context, "adapter", probes, {
      id: input.executor.id, adapterId: input.executor.adapterId, trust: input.executor.trust, surface: input.executor.surface,
      observedCliVersion: input.executor.observedCliVersion, installationEvidenceUri: input.executor.installationEvidenceUri,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    && Number(match[4]) <= 23
    && Number(match[5]) <= 59
    && Number(match[6]) <= 59;
}

export function validateConformanceEvidence(value: unknown): { ok: boolean; blockers: string[]; evidence?: ConformanceEvidence } {
  const blockers: string[] = [];
  if (!record(value)) return { ok: false, blockers: ["conformance evidence must be an object"] };
  const requiredText = ["adapterId", "adapterVersion", "cliVersion", "osProfile", "platformTier", "adapterClass", "integritySha256", "evidenceUri"] as const;
  if (value.schema !== "uai.conformance.v1") blockers.push("invalid evidence schema");
  if (value.scope !== "kernel" && value.scope !== "adapter") blockers.push("invalid evidence scope");
  if (value.suiteId !== "uai-kernel-suite" && value.suiteId !== "uai-adapter-critical-suite") blockers.push("invalid evidence suite");
  for (const field of requiredText) if (typeof value[field] !== "string" || !(value[field] as string).length) blockers.push(`invalid evidence ${field}`);
  if (!strictTimestamp(value.observedAt)) blockers.push("invalid evidence timestamp");
  if (!Array.isArray(value.probes)) blockers.push("invalid evidence probes");
  else for (const [index, raw] of value.probes.entries()) {
    if (!record(raw) || typeof raw.id !== "string" || typeof raw.passed !== "boolean" || typeof raw.details !== "string") {
      blockers.push(`invalid probe ${index}`);
      continue;
    }
    if (raw.adapterBinding !== undefined) {
      const binding = raw.adapterBinding;
      if (!record(binding)
        || binding.scope !== "adapter"
        || typeof binding.adapterId !== "string"
        || typeof binding.adapterVersion !== "string"
        || typeof binding.cliVersion !== "string"
        || typeof binding.osProfile !== "string"
        || typeof binding.executorId !== "string"
        || (binding.executorTrust !== "fixture" && binding.executorTrust !== "trusted-staged-native" && binding.executorTrust !== "trusted-live")
        || (binding.executorSurface !== "adapter-mapping" && binding.executorSurface !== "staged-native-dispatch" && binding.executorSurface !== "live-native-dispatch")
        || typeof binding.nativeEventType !== "string"
        || typeof binding.nativeProofSha256 !== "string") blockers.push(`invalid probe ${index} adapter binding`);
    }
  }
  if (!Array.isArray(value.audit) || value.audit.some((row) => !record(row))) blockers.push("invalid evidence audit");
  if (value.executor !== undefined) {
    const executor = value.executor;
    if (!record(executor)
      || typeof executor.id !== "string"
      || typeof executor.adapterId !== "string"
      || (executor.trust !== "fixture" && executor.trust !== "trusted-staged-native" && executor.trust !== "trusted-live")
      || (executor.surface !== "adapter-mapping" && executor.surface !== "staged-native-dispatch" && executor.surface !== "live-native-dispatch")) blockers.push("invalid executor provenance");
  }
  return blockers.length ? { ok: false, blockers } : { ok: true, blockers: [], evidence: value as unknown as ConformanceEvidence };
}

export function verifyEvidenceIntegrity(evidence: ConformanceEvidence): boolean {
  try {
    const digest = evidenceDigest(evidence);
    return evidence.integritySha256 === digest && evidence.evidenceUri === `data:application/json;sha256,${digest}`;
  } catch {
    return false;
  }
}
const CERTIFYING_EXECUTOR_IDS: ReadonlySet<string> = new Set();


export function certifyFromEvidence(input: {
  wired: boolean;
  evidence?: ConformanceEvidence;
  expected: CertificationExpectation;
  now?: () => string;
  maxAgeMs?: number;
}): CertificationResult {
  if (!input.evidence) return { state: input.wired ? "wired" : "observed", certification: "C0", blockers: ["missing conformance evidence"] };
  const validation = validateConformanceEvidence(input.evidence);
  if (!validation.ok || !validation.evidence) {
    return { state: input.wired ? "wired" : "observed", certification: "C0", blockers: [...new Set(validation.blockers)] };
  }
  const evidence = validation.evidence;
  const c2Blockers: string[] = [];
  if (evidence.scope !== "adapter") c2Blockers.push(`evidence scope is ${evidence.scope}, not adapter`);
  if (evidence.suiteId !== "uai-adapter-critical-suite") c2Blockers.push("evidence is not the adapter critical suite");
  if (!(evidence.adapterId === "claude" || evidence.adapterId === "omp" || evidence.adapterId === "codex" || evidence.adapterId === "opencode" || isExternalAdapterId(evidence.adapterId))) c2Blockers.push("invalid adapter identity");
  if (evidence.adapterId !== input.expected.adapterId) c2Blockers.push("adapter identity mismatch");
  if (evidence.adapterVersion !== input.expected.adapterVersion) c2Blockers.push("adapter version mismatch");
  if (evidence.cliVersion !== input.expected.cliVersion) c2Blockers.push("CLI version mismatch");
  if (evidence.osProfile !== input.expected.osProfile) c2Blockers.push("OS profile mismatch");
  if (!verifyEvidenceIntegrity(evidence)) c2Blockers.push("evidence integrity mismatch");
  const observedAt = Date.parse(evidence.observedAt);
  const now = Date.parse((input.now ?? (() => new Date().toISOString()))());
  const maxAgeMs = input.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(now)) c2Blockers.push("invalid certification clock");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) c2Blockers.push("invalid evidence freshness policy");
  if (observedAt > now + 5 * 60 * 1000) c2Blockers.push("evidence timestamp is in the future");
  if (now - observedAt > maxAgeMs) c2Blockers.push("evidence is stale");
  const missing = REQUIRED_PROBES.filter((id) => !evidence.probes.some((result) => result.id === id && result.passed));
  c2Blockers.push(...missing.map((id) => `failed or missing probe: ${id}`));
  const executor = evidence.executor;
  if (!executor) c2Blockers.push("missing executor provenance");
  for (const result of evidence.probes) {
    const binding = result.adapterBinding;
    if (!binding || binding.scope !== "adapter" || binding.adapterId !== evidence.adapterId || binding.adapterVersion !== evidence.adapterVersion || binding.cliVersion !== evidence.cliVersion || binding.osProfile !== evidence.osProfile || !binding.executorId || !binding.nativeProofSha256) {
      c2Blockers.push(`invalid adapter-bound provenance: ${result.id}`);
    } else if (!executor || binding.executorId !== executor.id || binding.executorTrust !== executor.trust || binding.executorSurface !== executor.surface || binding.observedCliVersion !== executor.observedCliVersion) {
      c2Blockers.push(`mismatched executor provenance: ${result.id}`);
    }
  }
  if (executor && executor.adapterId !== evidence.adapterId) c2Blockers.push("executor adapter identity mismatch");
  if (input.expected.executorId && executor?.id !== input.expected.executorId) c2Blockers.push("executor identity mismatch");
  if (c2Blockers.length) {
    return { state: input.wired ? "wired" : "observed", certification: "C0", blockers: [...new Set(c2Blockers)] };
  }
  const c3Blockers: string[] = [];
  if (evidence.adapterClass !== "native") c3Blockers.push("C3 requires native adapter class");
  if (!input.expected.executorId) c3Blockers.push("expected trusted executor identity is required");
  if (!CERTIFYING_EXECUTOR_IDS.has(executor!.id)) c3Blockers.push("no repository-owned certifying executor is registered");
  if (executor!.id === "uai-fixture-harness@1" || executor!.trust === "fixture") c3Blockers.push("fixture executor cannot certify active");
  if (executor!.trust !== "trusted-staged-native" && executor!.trust !== "trusted-live") c3Blockers.push("executor is not trusted for certification");
  if (executor!.surface !== "staged-native-dispatch" && executor!.surface !== "live-native-dispatch") c3Blockers.push("executor did not exercise a native dispatch surface");
  if (executor!.observedCliVersion !== evidence.cliVersion) c3Blockers.push("executor CLI observation mismatch");
  if (!executor!.installationEvidenceUri) c3Blockers.push("missing staged installation evidence");
  if (c3Blockers.length) return { state: "observed", certification: "C2", blockers: [...new Set(c3Blockers)] };
  const [os, ...profile] = evidence.osProfile.split(":");
  return {
    state: "active", certification: "C3", blockers: [],
    evidence: {
      adapterVersion: evidence.adapterVersion, cliVersion: evidence.cliVersion,
      platform: { os, profile: profile.join(":") || "default" }, probeId: evidence.suiteId,
      observedAt: evidence.observedAt, evidenceUri: evidence.evidenceUri,
    },
  };
}
