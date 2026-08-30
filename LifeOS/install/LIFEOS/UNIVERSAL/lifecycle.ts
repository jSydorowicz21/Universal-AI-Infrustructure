import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type OwnershipClass = "owned" | "adopted" | "foreign" | "user-data" | "unknown";
export type StructuredFormat = "json" | "yaml" | "toml";

export interface ByteSnapshot {
  existed: boolean;
  kind?: "file" | "directory" | "link";
  linkTarget?: string;
  linkKind?: "junction" | "symlink";
  linkTargetKind?: "file" | "directory" | "unknown";
  bytesBase64?: string;
  sha256?: string;
  mode?: number;
}

export type MutationInput =
  | { id: string; kind: "write"; path: string; bytes: Uint8Array; mode?: number; ownership: OwnershipClass; structured?: StructuredFormat }
  | { id: string; kind: "delete"; path: string; ownership: OwnershipClass }
  | { id: string; kind: "link"; path: string; target: string; targetKind?: "file" | "directory"; linkKind: "junction" | "symlink"; ownership: OwnershipClass };

export type PlannedMutation = Omit<MutationInput, "bytes"> & { bytesBase64?: string; before: ByteSnapshot; existed: boolean };
export interface Gate { id: string; passed: boolean; message: string }
export interface InstallPlan { schema: "uai.install-plan.v1"; id: string; root: string; createdAt: string; gates: Gate[]; mutations: PlannedMutation[] }
export interface RollbackConflict { mutationId: string; path: string; reason: "artifact-drift-during-rollback"; expectedApplied: ArtifactIdentity; current: ArtifactIdentity }
export interface JournalEntry { mutationId: string; state: "pending" | "applied" | "rolled-back" | "conflict"; recordedAt: string; conflict?: RollbackConflict }
export interface MutationJournal { schema: "uai.mutation-journal.v1"; plan: InstallPlan; previousManifest?: OwnershipManifest; status: "applying" | "committed" | "rolling-back" | "rolled-back" | "rollback-conflict"; entries: JournalEntry[] }
export interface RecoveryResult { status: MutationJournal["status"]; conflicts: RollbackConflict[] }
export interface ArtifactIdentity { existed: boolean; kind?: ByteSnapshot["kind"]; sha256?: string; mode?: number; linkTarget?: string; linkKind?: ByteSnapshot["linkKind"]; linkTargetKind?: ByteSnapshot["linkTargetKind"] }
export interface OwnedArtifact { path: string; ownership: OwnershipClass; mutationId: string; before: ByteSnapshot; applied: ArtifactIdentity }
export interface OwnershipManifest { schema: "uai.ownership-manifest.v1"; planId: string; root: string; artifacts: OwnedArtifact[] }
export interface ApplyResult { status: "planned" | "committed"; journalPath: string; manifest: OwnershipManifest }
export interface UninstallConflict { path: string; reason: "artifact-changed-after-install" | "missing-applied-identity"; expected?: ArtifactIdentity; current: ArtifactIdentity }
export interface UninstallResult { status: "uninstalled" | "conflicts"; restored: string[]; preserved: string[]; conflicts: UninstallConflict[] }

export const LIFECYCLE_SCHEMAS = {
  byteSnapshot: {
    $id: "uai.byte-snapshot.v1", type: "object", required: ["existed"],
    properties: { existed: { type: "boolean" }, kind: { enum: ["file", "directory", "link"] }, bytesBase64: { type: "string" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, mode: { type: "integer" }, linkTarget: { type: "string" }, linkKind: { enum: ["junction", "symlink"] }, linkTargetKind: { enum: ["file", "directory", "unknown"] } },
  },
  installPlan: {
    $id: "uai.install-plan.v1", type: "object", required: ["schema", "id", "root", "createdAt", "gates", "mutations"],
    properties: { schema: { const: "uai.install-plan.v1" }, id: { type: "string" }, root: { type: "string" }, createdAt: { type: "string", format: "date-time" }, gates: { type: "array" }, mutations: { type: "array" } },
  },
  mutationJournal: {
    $id: "uai.mutation-journal.v1", type: "object", required: ["schema", "plan", "status", "entries"],
    properties: {
      schema: { const: "uai.mutation-journal.v1" },
      plan: { $ref: "uai.install-plan.v1" },
      status: { enum: ["applying", "committed", "rolling-back", "rolled-back", "rollback-conflict"] },
      entries: {
        type: "array",
        items: {
          type: "object", required: ["mutationId", "state", "recordedAt"],
          properties: {
            mutationId: { type: "string" },
            state: { enum: ["pending", "applied", "rolled-back", "conflict"] },
            recordedAt: { type: "string", format: "date-time" },
            conflict: { type: "object" },
          },
        },
      },
    },
  },
  ownershipManifest: {
    $id: "uai.ownership-manifest.v1", type: "object", required: ["schema", "planId", "root", "artifacts"],
    properties: { schema: { const: "uai.ownership-manifest.v1" }, planId: { type: "string" }, root: { type: "string" }, artifacts: { type: "array" } },
  },
} as const;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function snapshot(path: string): Promise<ByteSnapshot> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const linkTarget = await readlink(path);
      let linkTargetKind: ByteSnapshot["linkTargetKind"] = "unknown";
      try {
        const targetMetadata = await stat(path);
        linkTargetKind = targetMetadata.isDirectory() ? "directory" : targetMetadata.isFile() ? "file" : "unknown";
      } catch {
        // Broken links remain restorable from their raw target.
      }
      return {
        existed: true, kind: "link", linkTarget, linkTargetKind,
        linkKind: process.platform === "win32" && linkTargetKind === "directory" ? "junction" : "symlink",
        mode: metadata.mode,
      };
    }
    if (metadata.isDirectory()) return { existed: true, kind: "directory", mode: metadata.mode };
    if (!metadata.isFile()) throw new Error(`Unsupported artifact type at ${path}`);
    const bytes = await readFile(path);
    return { existed: true, kind: "file", bytesBase64: bytes.toString("base64"), sha256: digest(bytes), mode: metadata.mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { existed: false };
    throw error;
  }
}


function validateStructured(bytes: Uint8Array, format: StructuredFormat, label: string): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    if (format === "json") JSON.parse(text);
    else if (format === "yaml") Bun.YAML.parse(text);
    else Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${label} ${format.toUpperCase()}: ${(error as Error).message}`);
  }
}

function assertUniqueMutationIds(mutations: readonly { id: string }[]): void {
  const mutationIds = new Set<string>();
  for (const mutation of mutations) {
    if (mutationIds.has(mutation.id)) throw new Error(`Duplicate mutation ID: ${mutation.id}`);
    mutationIds.add(mutation.id);
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_MUTATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const OWNERSHIP: Record<OwnershipClass, true> = { owned: true, adopted: true, foreign: true, "user-data": true, unknown: true };
const SNAPSHOT_KINDS: Record<NonNullable<ByteSnapshot["kind"]>, true> = { file: true, directory: true, link: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${label}`);
  }
}

function assertSafeMutationId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_MUTATION_ID.test(value)) throw new Error(`Invalid ${label}`);
}

function comparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(comparablePath(root), comparablePath(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function assertContainedPath(root: string, candidate: string, label = "mutation path"): Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(candidate)) throw new Error(`${label} and root must be absolute`);
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (!isWithin(rootPath, candidatePath)) throw new Error(`${label} escapes declared root: ${candidate}`);

  let boundary = rootPath;
  while (true) {
    try {
      const metadata = await lstat(boundary);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Declared root crosses a linked or non-directory boundary: ${boundary}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(boundary);
      if (parent === boundary) throw new Error(`Declared root has no physical parent: ${root}`);
      boundary = parent;
    }
  }
  const physicalBoundary = await realpath(boundary);
  let ancestor = dirname(candidatePath);
  while (true) {
    try {
      const physicalAncestor = await realpath(ancestor);
      if (!isWithin(physicalBoundary, physicalAncestor)) throw new Error(`${label} crosses a linked parent outside declared root: ${candidate}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor || !isWithin(boundary, parent)) throw new Error(`${label} has no contained physical parent: ${candidate}`);
      ancestor = parent;
    }
  }
}

function assertSnapshot(value: unknown, label: string): asserts value is ByteSnapshot {
  if (!isRecord(value) || typeof value.existed !== "boolean") throw new Error(`Invalid ${label}`);
  if (value.kind !== undefined && (typeof value.kind !== "string" || !(value.kind in SNAPSHOT_KINDS))) throw new Error(`Invalid ${label}.kind`);
  if (value.mode !== undefined && (!Number.isInteger(value.mode) || (value.mode as number) < 0)) throw new Error(`Invalid ${label}.mode`);
  if (value.bytesBase64 !== undefined && typeof value.bytesBase64 !== "string") throw new Error(`Invalid ${label}.bytesBase64`);
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))) throw new Error(`Invalid ${label}.sha256`);
  if (value.kind === "file" && value.existed && typeof value.bytesBase64 !== "string") throw new Error(`Invalid ${label}: file snapshot lacks bytes`);
  if (typeof value.bytesBase64 === "string") {
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.toString("base64") !== value.bytesBase64) throw new Error(`Invalid ${label}.bytesBase64 encoding`);
    if (typeof value.sha256 === "string" && digest(bytes) !== value.sha256) throw new Error(`Invalid ${label}.sha256 digest`);
  }
  if (value.kind === "link" && value.existed && typeof value.linkTarget !== "string") throw new Error(`Invalid ${label}: link snapshot lacks target`);
}

async function assertValidPlan(value: unknown): Promise<InstallPlan> {
  if (!isRecord(value) || value.schema !== "uai.install-plan.v1") throw new Error("Unsupported install plan schema");
  assertSafeId(value.id, "plan ID");
  if (typeof value.root !== "string" || !isAbsolute(value.root)) throw new Error("Invalid plan root");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Invalid plan timestamp");
  if (!Array.isArray(value.gates) || !Array.isArray(value.mutations)) throw new Error("Invalid install plan arrays");
  assertUniqueMutationIds(value.mutations as { id: string }[]);
  for (const [index, raw] of (value.mutations as unknown[]).entries()) {
    if (!isRecord(raw)) throw new Error(`Invalid mutation ${index}`);
    assertSafeMutationId(raw.id, `mutation ${index} ID`);
    if (raw.kind !== "write" && raw.kind !== "delete" && raw.kind !== "link") throw new Error(`Invalid mutation ${index} kind`);
    if (typeof raw.path !== "string") throw new Error(`Invalid mutation ${index} path`);
    if (typeof raw.ownership !== "string" || !(raw.ownership in OWNERSHIP)) throw new Error(`Invalid mutation ${index} ownership`);
    assertSnapshot(raw.before, `mutation ${index} before`);
    if (typeof raw.existed !== "boolean" || raw.existed !== raw.before.existed) throw new Error(`Invalid mutation ${index} existed`);
    if (raw.kind === "write" && typeof raw.bytesBase64 !== "string") throw new Error(`Invalid mutation ${index} bytes`);
    if (raw.kind === "write") {
      const bytes = Buffer.from(raw.bytesBase64 as string, "base64");
      if (bytes.toString("base64") !== raw.bytesBase64) throw new Error(`Invalid mutation ${index} bytes encoding`);
    }
    await assertContainedPath(value.root, raw.path, `mutation ${index} path`);
  }
  return value as unknown as InstallPlan;
}

export async function assertValidOwnershipManifest(value: unknown): Promise<OwnershipManifest> {
  if (!isRecord(value) || value.schema !== "uai.ownership-manifest.v1") throw new Error("Unsupported ownership manifest schema");
  assertSafeId(value.planId, "manifest plan ID");
  if (typeof value.root !== "string" || !isAbsolute(value.root) || !Array.isArray(value.artifacts)) throw new Error("Invalid ownership manifest");
  for (const [index, raw] of (value.artifacts as unknown[]).entries()) {
    if (!isRecord(raw) || typeof raw.path !== "string" || typeof raw.mutationId !== "string") throw new Error(`Invalid ownership artifact ${index}`);
    assertSafeMutationId(raw.mutationId, `ownership artifact ${index} mutation ID`);
    if (typeof raw.ownership !== "string" || !(raw.ownership in OWNERSHIP)) throw new Error(`Invalid ownership artifact ${index} class`);
    assertSnapshot(raw.before, `ownership artifact ${index} before`);
    if (!isRecord(raw.applied) || typeof raw.applied.existed !== "boolean") throw new Error(`Invalid ownership artifact ${index} applied identity`);
    await assertContainedPath(value.root, raw.path, `ownership artifact ${index} path`);
  }
  return value as unknown as OwnershipManifest;
}

async function assertValidJournal(value: unknown, journalPath: string): Promise<MutationJournal> {
  if (!isRecord(value) || value.schema !== "uai.mutation-journal.v1") throw new Error("Unsupported mutation journal schema");
  const plan = await assertValidPlan(value.plan);
  await assertContainedPath(plan.root, journalPath, "journal path");
  if (dirname(resolve(journalPath)) !== resolve(plan.root, ".uai-journal")) throw new Error("Journal is outside the canonical journal directory");
  if (!Array.isArray(value.entries) || !["applying", "committed", "rolling-back", "rolled-back", "rollback-conflict"].includes(String(value.status))) throw new Error("Invalid mutation journal");
  const mutationIds = new Set(plan.mutations.map((mutation) => mutation.id));
  for (const [index, raw] of (value.entries as unknown[]).entries()) {
    if (!isRecord(raw) || typeof raw.mutationId !== "string" || !mutationIds.has(raw.mutationId)) throw new Error(`Invalid journal entry ${index}`);
    if (!["pending", "applied", "rolled-back", "conflict"].includes(String(raw.state))) throw new Error(`Invalid journal entry ${index} state`);
    if (typeof raw.recordedAt !== "string" || !Number.isFinite(Date.parse(raw.recordedAt))) throw new Error(`Invalid journal entry ${index} timestamp`);
  }
  if (value.previousManifest !== undefined) {
    const previous = await assertValidOwnershipManifest(value.previousManifest);
    if (previous.root !== plan.root || previous.planId !== plan.id) throw new Error("Previous manifest coordinates do not match plan");
  }
  return value as unknown as MutationJournal;
}

export async function createInstallPlan(input: { id?: string; root: string; mutations: MutationInput[]; gates?: Gate[]; now?: () => string }): Promise<InstallPlan> {
  const id = input.id ?? randomUUID();
  assertSafeId(id, "plan ID");
  if (!isAbsolute(input.root)) throw new Error("Install root must be absolute");
  const root = resolve(input.root);
  const gates = input.gates ?? [];
  const failed = gates.find((gate) => !gate.passed);
  if (failed) throw new Error(`Install gate failed (${failed.id}): ${failed.message}`);
  assertUniqueMutationIds(input.mutations);
  const mutations: PlannedMutation[] = [];
  for (const mutation of input.mutations) {
    assertSafeMutationId(mutation.id, "mutation ID");
    if (mutation.ownership === "foreign" || mutation.ownership === "user-data") throw new Error(`Refusing mutation of ${mutation.ownership} path: ${mutation.path}`);
    await assertContainedPath(root, mutation.path);
    const before = await snapshot(mutation.path);
    if (before.kind === "directory") throw new Error(`Refusing to mutate directory without a recursive snapshot: ${mutation.path}`);
    if (mutation.kind === "write" && mutation.mode !== undefined && (!Number.isInteger(mutation.mode) || mutation.mode < 0 || mutation.mode > 0o777)) throw new Error(`Invalid write mode for ${mutation.path}`);
    if (mutation.kind === "write" && mutation.structured) {
      if (before.existed && before.bytesBase64 !== undefined) validateStructured(Buffer.from(before.bytesBase64, "base64"), mutation.structured, "existing");
      validateStructured(mutation.bytes, mutation.structured, "replacement");
    }
    mutations.push(mutation.kind === "write"
      ? { id: mutation.id, kind: mutation.kind, path: resolve(mutation.path), mode: mutation.mode ?? (before.existed && before.mode !== undefined ? before.mode & 0o777 : 0o600), ownership: mutation.ownership, structured: mutation.structured, bytesBase64: Buffer.from(mutation.bytes).toString("base64"), before, existed: before.existed }
      : { ...mutation, path: resolve(mutation.path), before, existed: before.existed });
  }
  const createdAt = (input.now ?? (() => new Date().toISOString()))();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Invalid plan timestamp");
  return { schema: "uai.install-plan.v1", id, root, createdAt, gates, mutations };
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EISDIR" || code === "EINVAL" || code === "EPERM" || code === "EBADF")) return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWrite(path: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.uai-tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.chmod(mode & 0o777);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, mode & 0o777);
    await fsyncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeJournal(path: string, journal: MutationJournal): Promise<void> {
  await assertContainedPath(journal.plan.root, path, "journal path");
  await atomicWrite(path, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`));
}

async function applyMutation(mutation: PlannedMutation): Promise<void> {
  if (mutation.kind === "write") {
    if (mutation.bytesBase64 === undefined) throw new Error(`Write mutation ${mutation.id} has no bytes`);
    await atomicWrite(mutation.path, Buffer.from(mutation.bytesBase64, "base64"), mutation.mode ?? 0o600);
  } else if (mutation.kind === "delete") {
    await rm(mutation.path, { recursive: true, force: true });
  } else {
    await mkdir(dirname(mutation.path), { recursive: true });
    await rm(mutation.path, { recursive: true, force: true });
    const type = mutation.linkKind === "junction" ? "junction" : mutation.targetKind === "file" ? "file" : "dir";
    await symlink(mutation.target, mutation.path, type);
  }
}

async function restoreSnapshot(path: string, before: ByteSnapshot): Promise<void> {
  await rm(path, { recursive: true, force: true });
  if (!before.existed) return;
  const kind = before.kind ?? (before.bytesBase64 !== undefined ? "file" : undefined);
  if (kind === "file") {
    if (before.bytesBase64 === undefined) throw new Error(`Cannot restore file without bytes: ${path}`);
    await atomicWrite(path, Buffer.from(before.bytesBase64, "base64"), before.mode !== undefined ? before.mode & 0o777 : 0o600);
    if (before.mode !== undefined) await chmod(path, before.mode & 0o777);
    return;
  }
  if (kind === "link") {
    if (!before.linkTarget) throw new Error(`Cannot restore link without target: ${path}`);
    await mkdir(dirname(path), { recursive: true });
    const type = before.linkKind === "junction" ? "junction" : before.linkTargetKind === "file" ? "file" : "dir";
    await symlink(before.linkTarget, path, type);
    return;
  }
  if (kind === "directory") {
    await mkdir(path, { recursive: true });
    if (before.mode !== undefined) await chmod(path, before.mode & 0o777);
    return;
  }
  throw new Error(`Cannot restore unknown artifact type: ${path}`);
}

async function restoreMutation(mutation: PlannedMutation): Promise<void> {
  await restoreSnapshot(mutation.path, mutation.before);
}

function identityOf(value: ByteSnapshot): ArtifactIdentity {
  const kind = value.kind ?? (value.bytesBase64 !== undefined ? "file" : undefined);
  return { existed: value.existed, kind, sha256: value.sha256, mode: value.mode, linkTarget: value.linkTarget, linkKind: value.linkKind, linkTargetKind: value.linkTargetKind };
}

function expectedIdentity(mutation: PlannedMutation): ArtifactIdentity {
  if (mutation.kind === "write") {
    if (mutation.bytesBase64 === undefined) throw new Error(`Write mutation ${mutation.id} has no bytes`);
    return { existed: true, kind: "file", sha256: digest(Buffer.from(mutation.bytesBase64, "base64")), mode: mutation.mode ?? 0o600 };
  }
  if (mutation.kind === "link") return { existed: true, kind: "link", linkTarget: mutation.target, linkKind: mutation.linkKind, linkTargetKind: mutation.targetKind ?? "directory" };
  return { existed: false };
}

function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  if (left.existed !== right.existed) return false;
  if (!left.existed) return true;
  if (left.kind !== right.kind) return false;
  if (left.kind === "file") return left.sha256 === right.sha256 && left.mode === right.mode;
  if (left.kind === "link") return left.linkTarget === right.linkTarget && left.linkKind === right.linkKind && left.linkTargetKind === right.linkTargetKind;
  return left.mode === right.mode;
}

function sameSnapshot(left: ByteSnapshot, right: ByteSnapshot): boolean {
  return sameIdentity(identityOf(left), identityOf(right)) && left.mode === right.mode;
}

function matchesExpectedApplied(current: ByteSnapshot, mutation: PlannedMutation): boolean {
  const expected = expectedIdentity(mutation);
  const observed = identityOf(current);
  if (expected.existed !== observed.existed) return false;
  if (!expected.existed) return true;
  if (expected.kind !== observed.kind) return false;
  if (expected.kind === "file") return expected.sha256 === observed.sha256 && (process.platform === "win32" || observed.mode === undefined || (observed.mode & 0o777) === expected.mode);
  if (expected.kind === "link") return expected.linkTarget === observed.linkTarget && expected.linkKind === observed.linkKind && expected.linkTargetKind === observed.linkTargetKind;
  return false;
}

function manifestFor(plan: InstallPlan, applied?: ByteSnapshot[], previous?: OwnershipManifest): OwnershipManifest {
  const previousByPath = new Map((previous?.artifacts ?? []).map((artifact) => [artifact.path, artifact]));
  const artifacts = plan.mutations.map((mutation, index) => {
    const prior = previousByPath.get(mutation.path);
    previousByPath.delete(mutation.path);
    return {
      path: mutation.path,
      ownership: mutation.ownership,
      mutationId: mutation.id,
      before: prior?.before ?? mutation.before,
      applied: applied ? identityOf(applied[index]) : expectedIdentity(mutation),
    };
  });
  artifacts.push(...previousByPath.values());
  return { schema: "uai.ownership-manifest.v1", planId: plan.id, root: plan.root, artifacts };
}

async function rollbackJournal(journalPath: string, journal: MutationJournal): Promise<RollbackConflict[]> {
  assertUniqueMutationIds(journal.plan.mutations);
  journal.status = "rolling-back";
  await writeJournal(journalPath, journal);
  const conflicts = journal.entries.flatMap((entry) => entry.state === "conflict" && entry.conflict ? [entry.conflict] : []);
  const maybeApplied = journal.entries.filter((entry) => entry.state === "applied" || entry.state === "pending");
  for (const entry of maybeApplied.reverse()) {
    const mutation = journal.plan.mutations.find((candidate) => candidate.id === entry.mutationId);
    if (!mutation) throw new Error(`Journal references unknown mutation ${entry.mutationId}`);
    await assertContainedPath(journal.plan.root, mutation.path);
    const current = await snapshot(mutation.path);
    if (sameSnapshot(current, mutation.before)) {
      entry.state = "rolled-back";
      entry.recordedAt = new Date().toISOString();
      await writeJournal(journalPath, journal);
      continue;
    }
    if (matchesExpectedApplied(current, mutation)) {
      await restoreMutation(mutation);
      entry.state = "rolled-back";
      entry.recordedAt = new Date().toISOString();
      await writeJournal(journalPath, journal);
      continue;
    }
    const conflict: RollbackConflict = {
      mutationId: mutation.id,
      path: mutation.path,
      reason: "artifact-drift-during-rollback",
      expectedApplied: expectedIdentity(mutation),
      current: identityOf(current),
    };
    entry.state = "conflict";
    entry.conflict = conflict;
    entry.recordedAt = new Date().toISOString();
    conflicts.push(conflict);
    await writeJournal(journalPath, journal);
  }
  journal.status = conflicts.length ? "rollback-conflict" : "rolled-back";
  await writeJournal(journalPath, journal);
  return conflicts;
}

class InjectedManifestBoundaryCrash extends Error {}

export async function applyInstallPlan(plan: InstallPlan, options: { dryRun?: boolean; injectFailureAfter?: number; injectCrashAfterManifest?: boolean } = {}): Promise<ApplyResult> {
  const validatedPlan = await assertValidPlan(plan);
  const journalPath = join(validatedPlan.root, ".uai-journal", `${validatedPlan.id}-${randomUUID()}.json`);
  const manifestPath = join(validatedPlan.root, ".uai-ownership", `${validatedPlan.id}.json`);
  await Promise.all([
    assertContainedPath(validatedPlan.root, journalPath, "journal path"),
    assertContainedPath(validatedPlan.root, manifestPath, "manifest path"),
  ]);
  let previousManifest: OwnershipManifest | undefined;
  if (await Bun.file(manifestPath).exists()) {
    previousManifest = await assertValidOwnershipManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    if (previousManifest.root !== validatedPlan.root || previousManifest.planId !== validatedPlan.id) {
      throw new Error("Existing ownership manifest coordinates do not match install plan");
    }
  }
  const plannedManifest = manifestFor(validatedPlan, undefined, previousManifest);
  if (options.dryRun) return { status: "planned", journalPath, manifest: plannedManifest };
  const journal: MutationJournal = {
    schema: "uai.mutation-journal.v1",
    plan: validatedPlan,
    previousManifest,
    status: "applying",
    entries: [],
  };
  await writeJournal(journalPath, journal);
  try {
    for (const [index, mutation] of validatedPlan.mutations.entries()) {
      const entry: JournalEntry = { mutationId: mutation.id, state: "pending", recordedAt: new Date().toISOString() };
      journal.entries.push(entry);
      await writeJournal(journalPath, journal);
      if (options.injectFailureAfter === index) throw new Error(`Injected failure before mutation ${mutation.id}`);
      await assertContainedPath(validatedPlan.root, mutation.path);
      const current = await snapshot(mutation.path);
      if (!sameSnapshot(current, mutation.before)) {
        entry.state = "rolled-back";
        entry.recordedAt = new Date().toISOString();
        await writeJournal(journalPath, journal);
        throw new Error(`Plan drift detected for ${mutation.path}; replan required`);
      }
      await assertContainedPath(validatedPlan.root, mutation.path);
      await applyMutation(mutation);
      entry.state = "applied";
      entry.recordedAt = new Date().toISOString();
      await writeJournal(journalPath, journal);
      if (options.injectFailureAfter === index + 1) throw new Error(`Injected failure after mutation ${mutation.id}`);
    }
    const manifest = manifestFor(validatedPlan, await Promise.all(validatedPlan.mutations.map(async (mutation) => {
      await assertContainedPath(validatedPlan.root, mutation.path);
      return snapshot(mutation.path);
    })), previousManifest);
    await assertContainedPath(validatedPlan.root, manifestPath, "manifest path");
    await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    if (options.injectCrashAfterManifest) throw new InjectedManifestBoundaryCrash("Injected crash after ownership manifest persistence");
    journal.status = "committed";
    await writeJournal(journalPath, journal);
    return { status: "committed", journalPath, manifest };
  } catch (error) {
    if (error instanceof InjectedManifestBoundaryCrash) throw error;
    const conflicts = await rollbackJournal(journalPath, journal);
    if (!conflicts.length) {
      if (previousManifest) await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(previousManifest, null, 2)}\n`));
      else await rm(manifestPath, { force: true });
    }
    if (conflicts.length) throw new Error(`Install failed and rollback preserved conflicting artifacts: ${conflicts.map((conflict) => conflict.path).join(", ")}`, { cause: error });
    throw error;
  }
}

export async function recoverJournal(journalPath: string): Promise<RecoveryResult> {
  const journal = await assertValidJournal(JSON.parse(await readFile(journalPath, "utf8")), journalPath);
  const existingConflicts = journal.entries.flatMap((entry) => entry.state === "conflict" && entry.conflict ? [entry.conflict] : []);
  if (journal.status === "committed" || journal.status === "rolled-back" || journal.status === "rollback-conflict") return { status: journal.status, conflicts: existingConflicts };
  const conflicts = await rollbackJournal(journalPath, journal);
  if (!conflicts.length) {
    const manifestPath = join(journal.plan.root, ".uai-ownership", `${journal.plan.id}.json`);
    await assertContainedPath(journal.plan.root, manifestPath, "manifest path");
    if (journal.previousManifest) await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(journal.previousManifest, null, 2)}\n`));
    else await rm(manifestPath, { force: true });
  }
  return { status: conflicts.length ? "rollback-conflict" : "rolled-back", conflicts };
}

export async function uninstallOwned(manifest: OwnershipManifest): Promise<UninstallResult> {
  const validatedManifest = await assertValidOwnershipManifest(manifest);
  const result: UninstallResult = { status: "uninstalled", restored: [], preserved: [], conflicts: [] };
  for (const artifact of [...validatedManifest.artifacts].reverse()) {
    if (artifact.ownership === "foreign" || artifact.ownership === "user-data" || artifact.ownership === "unknown") continue;
    await assertContainedPath(validatedManifest.root, artifact.path, "ownership artifact path");
    const current = identityOf(await snapshot(artifact.path));
    if (!artifact.applied) {
      result.preserved.push(artifact.path);
      result.conflicts.push({ path: artifact.path, reason: "missing-applied-identity", current });
      continue;
    }
    if (!sameIdentity(current, artifact.applied)) {
      result.preserved.push(artifact.path);
      result.conflicts.push({ path: artifact.path, reason: "artifact-changed-after-install", expected: artifact.applied, current });
      continue;
    }
    await assertContainedPath(validatedManifest.root, artifact.path, "ownership artifact path");
    await restoreSnapshot(artifact.path, artifact.before);
    result.restored.push(artifact.path);
  }
  result.status = result.conflicts.length ? "conflicts" : "uninstalled";
  const manifestPath = join(validatedManifest.root, ".uai-ownership", `${validatedManifest.planId}.json`);
  await assertContainedPath(validatedManifest.root, manifestPath, "manifest path");
  if (result.status === "uninstalled") {
    await rm(manifestPath, { force: true });
  } else {
    const unresolvedPaths = new Set(result.conflicts.map((conflict) => resolve(conflict.path)));
    const retryManifest: OwnershipManifest = {
      ...validatedManifest,
      artifacts: validatedManifest.artifacts.filter((artifact) => unresolvedPaths.has(resolve(artifact.path))),
    };
    await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(retryManifest, null, 2)}\n`));
  }
  return result;
}

export async function planSemanticUninstall(manifest: OwnershipManifest, input: { id?: string; mutations: MutationInput[] }): Promise<InstallPlan> {
  const validatedManifest = await assertValidOwnershipManifest(manifest);
  const manifestPaths = new Set(validatedManifest.artifacts.map((artifact) => resolve(artifact.path)));
  for (const mutation of input.mutations) {
    await assertContainedPath(validatedManifest.root, mutation.path);
    if (!manifestPaths.has(resolve(mutation.path))) throw new Error(`Semantic uninstall cannot mutate unowned path: ${mutation.path}`);
  }
  return createInstallPlan({ id: input.id ?? `${validatedManifest.planId}-semantic-uninstall`, root: validatedManifest.root, mutations: input.mutations });
}
