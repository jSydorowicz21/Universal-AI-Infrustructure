import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executableCandidates,
  executableSearchPlan,
  platformFacts,
  planDirectoryLink,
  renderHookCommand,
  resolveDataRoot,
  resolveHome,
} from "../platform";
import {
  applyInstallPlan,
  createInstallPlan,
  LIFECYCLE_SCHEMAS,
  planSemanticUninstall,
  recoverJournal,
  uninstallOwned,
} from "../lifecycle";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
async function root() { const value = await mkdtemp(join(tmpdir(), "uai-platform-")); roots.push(value); return value; }

describe("portable platform primitives", () => {
  test("resolves HOME then USERPROFILE then injected homedir", () => {
    expect(resolveHome({ HOME: "/home/a", USERPROFILE: "C:\\Users\\b" }, () => "/fallback")).toBe("/home/a");
    expect(resolveHome({ USERPROFILE: "C:\\Users\\b" }, () => "/fallback")).toBe("C:\\Users\\b");
    expect(resolveHome({}, () => "/fallback")).toBe("/fallback");
    expect(resolveDataRoot({ UAI_DATA_DIR: "/uai", PAI_DATA_DIR: "/pai", HOME: "/h" }, () => "/x")).toBe("/uai");
    expect(resolveDataRoot({ PAI_DATA_DIR: "/pai", HOME: "/h" }, () => "/x")).toBe("/pai");
  });

  test("creates PATHEXT-aware candidates and native command/link plans", () => {
    expect(executableCandidates("bun", { platform: "win32", pathext: ".EXE;.CMD" })).toEqual(["bun", "bun.EXE", "bun.CMD"]);
    expect(renderHookCommand({ platform: "win32", executable: "C:\\Program Files\\Bun\\bun.exe", args: ["C:\\Life OS\\hook.ts", "a'b"] })).toContain("& 'C:\\Program Files\\Bun\\bun.exe'");
    expect(renderHookCommand({ platform: "linux", executable: "/opt/bun", args: ["/tmp/a b.ts"] })).toBe("'/opt/bun' '/tmp/a b.ts'");
    expect(planDirectoryLink("C:\\data", "C:\\profile\\USER", "win32").kind).toBe("junction");
    expect(planDirectoryLink("/data", "/profile/USER", "linux").kind).toBe("symlink");
  });

  test("plans Windows PATH and PATHEXT exactly on every host", () => {
    expect(executableSearchPlan("bun", {
      platform: "win32",
      env: { PATH: "C:\\bin;D:\\tools", PATHEXT: ".EXE;.CMD" },
    })).toEqual([
      "C:\\bin\\bun", "C:\\bin\\bun.EXE", "C:\\bin\\bun.CMD",
      "D:\\tools\\bun", "D:\\tools\\bun.EXE", "D:\\tools\\bun.CMD",
    ]);
  });

  test("reports deterministic WSL, container and headless facts", () => {
    const facts = platformFacts({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu", UAI_CONTAINER: "1", CI: "1" }, release: "microsoft-standard-WSL2" });
    expect(facts).toMatchObject({ os: "linux", wsl: true, container: true, headless: true, tier: "P4" });
  });
});

describe("journaled lifecycle", () => {
  test("publishes plan, journal, ownership and byte snapshot schemas", () => {
    expect(LIFECYCLE_SCHEMAS.installPlan.$id).toBe("uai.install-plan.v1");
    expect(LIFECYCLE_SCHEMAS.mutationJournal.$id).toBe("uai.mutation-journal.v1");
    expect(LIFECYCLE_SCHEMAS.ownershipManifest.$id).toBe("uai.ownership-manifest.v1");
    expect(LIFECYCLE_SCHEMAS.byteSnapshot.$id).toBe("uai.byte-snapshot.v1");
    expect(LIFECYCLE_SCHEMAS.mutationJournal.properties.status.enum).toContain("rollback-conflict");
    expect(LIFECYCLE_SCHEMAS.mutationJournal.properties.entries.items.properties.state.enum).toContain("conflict");
  });
  test("dry-run is read-only and apply/uninstall preserves foreign bytes", async () => {
    const dir = await root();
    const existing = join(dir, "settings.json");
    const created = join(dir, "hooks", "uai.ts");
    await writeFile(existing, Buffer.from('{"foreign":true}\n'));
    const before = await readFile(existing);
    const plan = await createInstallPlan({
      id: "install-1", root: dir,
      mutations: [
        { id: "settings", kind: "write", path: existing, bytes: Buffer.from('{"foreign":true,"uai":true}\n'), ownership: "adopted", structured: "json" },
        { id: "hook", kind: "write", path: created, bytes: Buffer.from("export {};\n"), ownership: "owned" },
      ],
    });
    expect(await readFile(existing)).toEqual(before);
    expect(plan.mutations.every((m) => m.before !== undefined || m.existed === false)).toBeTrue();
    const dry = await applyInstallPlan(plan, { dryRun: true });
    expect(dry.status).toBe("planned");
    expect(await readFile(existing)).toEqual(before);
    const applied = await applyInstallPlan(plan);
    expect(applied.status).toBe("committed");
    await uninstallOwned(applied.manifest);
    expect(await readFile(existing)).toEqual(before);
    expect(await Bun.file(created).exists()).toBeFalse();
  });

  test("preserves restrictive adopted-file mode through apply, rollback and uninstall", async () => {
    const dir = await root();
    const settings = join(dir, "private.json");
    const original = Buffer.from('{"private":true}\n');
    await writeFile(settings, original);
    if (process.platform !== "win32") await chmod(settings, 0o600);
    const expectedMode = (await stat(settings)).mode & 0o777;
    const failingPlan = await createInstallPlan({ id: "mode-rollback", root: dir, mutations: [
      { id: "private", kind: "write", path: settings, bytes: Buffer.from('{"private":true,"uai":true}\n'), ownership: "adopted", structured: "json" },
      { id: "later", kind: "write", path: join(dir, "later.json"), bytes: Buffer.from("{}\n"), ownership: "owned", structured: "json" },
    ] });
    await expect(applyInstallPlan(failingPlan, { injectFailureAfter: 1 })).rejects.toThrow("Injected failure");
    expect(await readFile(settings)).toEqual(original);
    if (process.platform !== "win32") expect((await stat(settings)).mode & 0o777).toBe(0o600);

    const installPlan = await createInstallPlan({ id: "mode-uninstall", root: dir, mutations: [
      { id: "private", kind: "write", path: settings, bytes: Buffer.from('{"private":true,"uai":true}\n'), ownership: "adopted", structured: "json" },
    ] });
    const applied = await applyInstallPlan(installPlan);
    expect((await stat(settings)).mode & 0o777).toBe(expectedMode);
    expect(applied.manifest.artifacts[0].applied.mode).toBe((await stat(settings)).mode);
    expect((await uninstallOwned(applied.manifest)).status).toBe("uninstalled");
    expect(await readFile(settings)).toEqual(original);
    expect((await stat(settings)).mode & 0o777).toBe(expectedMode);
  });

  test("preserves post-install foreign edits and supports journaled semantic uninstall", async () => {
    const dir = await root();
    const settings = join(dir, "settings.json");
    const hook = join(dir, "hooks", "uai.ts");
    await writeFile(settings, `${JSON.stringify({ foreign: true })}\n`);
    const install = await createInstallPlan({ id: "foreign-edit", root: dir, mutations: [
      { id: "settings", kind: "write", path: settings, bytes: Buffer.from(`${JSON.stringify({ foreign: true, uai: { enabled: true } })}\n`), ownership: "adopted", structured: "json" },
      { id: "hook", kind: "write", path: hook, bytes: Buffer.from("export {};\n"), ownership: "owned" },
    ] });
    const applied = await applyInstallPlan(install);
    const edited = { ...JSON.parse(await readFile(settings, "utf8")), addedAfterInstall: { keep: true } };
    const editedBytes = Buffer.from(`${JSON.stringify(edited)}\n`);
    await writeFile(settings, editedBytes);
    const uninstall = await uninstallOwned(applied.manifest);
    expect(uninstall).toMatchObject({ status: "conflicts", preserved: [settings] });
    expect(await readFile(settings)).toEqual(editedBytes);
    expect(await Bun.file(hook).exists()).toBeFalse();

    delete edited.uai;
    const semanticPlan = await planSemanticUninstall(applied.manifest, {
      id: "semantic-uninstall",
      mutations: [{ id: "remove-owned-settings-entry", kind: "write", path: settings, bytes: Buffer.from(`${JSON.stringify(edited)}\n`), ownership: "adopted", structured: "json" }],
    });
    await applyInstallPlan(semanticPlan);
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ foreign: true, addedAfterInstall: { keep: true } });
  });

  test("conflicting uninstall retains only unresolved ownership for a safe retry", async () => {
    const dir = await root();
    const changed = join(dir, "changed.txt");
    const clean = join(dir, "clean.txt");
    const original = Buffer.from("original\n");
    const installed = Buffer.from("installed\n");
    await writeFile(changed, original);
    const plan = await createInstallPlan({ id: "retry-uninstall", root: dir, mutations: [
      { id: "changed", kind: "write", path: changed, bytes: installed, ownership: "adopted" },
      { id: "clean", kind: "write", path: clean, bytes: installed, ownership: "owned" },
    ] });
    const applied = await applyInstallPlan(plan);
    await writeFile(changed, Buffer.from("third-state\n"));
    expect((await uninstallOwned(applied.manifest)).status).toBe("conflicts");
    expect(await Bun.file(clean).exists()).toBeFalse();
    const manifestPath = join(dir, ".uai-ownership", "retry-uninstall.json");
    const retryManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(retryManifest.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual([changed]);
    await writeFile(changed, installed);
    expect((await uninstallOwned(retryManifest)).status).toBe("uninstalled");
    expect(await readFile(changed)).toEqual(original);
    expect(await Bun.file(manifestPath).exists()).toBeFalse();
  });

  test("restores exact prior bytes after injected failure and crash recovery is idempotent", async () => {
    const dir = await root();
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    await writeFile(a, Buffer.from('{"old":1}\r\n'));
    const before = await readFile(a);
    const plan = await createInstallPlan({ id: "fail", root: dir, mutations: [
      { id: "a", kind: "write", path: a, bytes: Buffer.from('{"new":1}\n'), ownership: "adopted", structured: "json" },
      { id: "b", kind: "write", path: b, bytes: Buffer.from('{"new":2}\n'), ownership: "owned", structured: "json" },
    ] });
    await expect(applyInstallPlan(plan, { injectFailureAfter: 1 })).rejects.toThrow("Injected failure");
    expect(await readFile(a)).toEqual(before);
    expect(await Bun.file(b).exists()).toBeFalse();
    const [journalFile] = await readdir(join(dir, ".uai-journal"));
    const recovery = await recoverJournal(join(dir, ".uai-journal", journalFile));
    expect(recovery.status).toBe("rolled-back");
    expect(await readFile(a)).toEqual(before);
  });

  test("applies zero-byte writes and restores zero-byte snapshots on rollback", async () => {
    const dir = await root();
    const emptyOwned = join(dir, "empty-owned");
    const emptyAdopted = join(dir, "empty-adopted");
    const trigger = join(dir, "trigger");
    await writeFile(emptyAdopted, Buffer.alloc(0));
    const plan = await createInstallPlan({ id: "zero-byte-rollback", root: dir, mutations: [
      { id: "empty-owned", kind: "write", path: emptyOwned, bytes: Buffer.alloc(0), ownership: "owned" },
      { id: "empty-adopted", kind: "write", path: emptyAdopted, bytes: Buffer.from("changed"), ownership: "adopted" },
      { id: "trigger", kind: "write", path: trigger, bytes: Buffer.from("never-written"), ownership: "owned" },
    ] });
    await expect(applyInstallPlan(plan, { injectFailureAfter: 2 })).rejects.toThrow("Injected failure");
    expect(await readFile(emptyAdopted)).toEqual(Buffer.alloc(0));
    expect(await Bun.file(emptyOwned).exists()).toBeFalse();
    expect(await Bun.file(trigger).exists()).toBeFalse();
  });

  test("creates and removes a file symlink with the declared target kind", async () => {
    const dir = await root();
    const target = join(dir, "APPEND_SYSTEM.md");
    const linkedPath = join(dir, "profile", "APPEND_SYSTEM.md");
    await writeFile(target, "fixture\n");
    const plan = await createInstallPlan({ id: "file-link", root: dir, mutations: [
      { id: "append-system-link", kind: "link", path: linkedPath, target, targetKind: "file", linkKind: "symlink", ownership: "owned" },
    ] });
    const applied = await applyInstallPlan(plan);
    expect((await lstat(linkedPath)).isSymbolicLink()).toBeTrue();
    expect(await readFile(linkedPath, "utf8")).toBe("fixture\n");
    expect((await uninstallOwned(applied.manifest)).status).toBe("uninstalled");
    expect(await Bun.file(linkedPath).exists()).toBeFalse();
  });

  test("preserves a pre-existing directory link and target on uninstall", async () => {
    const dir = await root();
    const originalTarget = join(dir, "original-user");
    const replacementTarget = join(dir, "replacement-user");
    const linkedPath = join(dir, "profile", "USER");
    await Promise.all([mkdir(originalTarget), mkdir(replacementTarget), mkdir(join(dir, "profile"))]);
    const nativeLinkKind = process.platform === "win32" ? "junction" : "dir";
    await symlink(originalTarget, linkedPath, nativeLinkKind);
    const originalLinkTarget = await readlink(linkedPath);
    const plan = await createInstallPlan({ id: "replace-link", root: dir, mutations: [
      { id: "user-link", kind: "link", path: linkedPath, target: replacementTarget, linkKind: process.platform === "win32" ? "junction" : "symlink", ownership: "adopted" },
    ] });
    expect(plan.mutations[0].before).toMatchObject({ existed: true, kind: "link", linkTarget: originalLinkTarget });
    const applied = await applyInstallPlan(plan);
    expect(await readlink(linkedPath)).not.toBe(originalLinkTarget);
    await uninstallOwned(applied.manifest);
    expect((await lstat(linkedPath)).isSymbolicLink()).toBeTrue();
    expect(await readlink(linkedPath)).toBe(originalLinkTarget);
  });

  test("restores a replaced link when a later mutation fails", async () => {
    const dir = await root();
    const originalTarget = join(dir, "original");
    const replacementTarget = join(dir, "replacement");
    const linkedPath = join(dir, "linked");
    await Promise.all([mkdir(originalTarget), mkdir(replacementTarget)]);
    await symlink(originalTarget, linkedPath, process.platform === "win32" ? "junction" : "dir");
    const originalLinkTarget = await readlink(linkedPath);
    const plan = await createInstallPlan({ id: "link-failure", root: dir, mutations: [
      { id: "replace-link", kind: "link", path: linkedPath, target: replacementTarget, linkKind: process.platform === "win32" ? "junction" : "symlink", ownership: "adopted" },
      { id: "later-write", kind: "write", path: join(dir, "later.json"), bytes: Buffer.from("{}\n"), ownership: "owned", structured: "json" },
    ] });
    await expect(applyInstallPlan(plan, { injectFailureAfter: 1 })).rejects.toThrow("Injected failure");
    expect((await lstat(linkedPath)).isSymbolicLink()).toBeTrue();
    expect(await readlink(linkedPath)).toBe(originalLinkTarget);
  });

  test("persists ownership manifest before commit and recovers an injected boundary crash", async () => {
    const dir = await root();
    const path = join(dir, "boundary.json");
    const original = Buffer.from('{"state":"old"}\n');
    await writeFile(path, original);
    const plan = await createInstallPlan({ id: "manifest-boundary", root: dir, mutations: [
      { id: "state", kind: "write", path, bytes: Buffer.from('{"state":"installed"}\n'), ownership: "adopted", structured: "json" },
    ] });
    const manifestPath = join(dir, ".uai-ownership", "manifest-boundary.json");
    await expect(applyInstallPlan(plan, { injectCrashAfterManifest: true })).rejects.toThrow("Injected crash after ownership manifest persistence");
    const [journalFile] = await readdir(join(dir, ".uai-journal"));
    const journalPath = join(dir, ".uai-journal", journalFile);
    expect(await Bun.file(manifestPath).exists()).toBeTrue();
    expect(JSON.parse(await readFile(journalPath, "utf8")).status).toBe("applying");
    expect(JSON.parse(await readFile(path, "utf8")).state).toBe("installed");
    expect((await recoverJournal(journalPath)).status).toBe("rolled-back");
    expect(await readFile(path)).toEqual(original);
    expect(await Bun.file(manifestPath).exists()).toBeFalse();
  });

  test("recovers a pending journal whose mutation already reached disk", async () => {
    const dir = await root();
    const path = join(dir, "state.json");
    const original = Buffer.from('{"state":"old"}\r\n');
    await writeFile(path, original);
    const plan = await createInstallPlan({ id: "pending-crash", root: dir, mutations: [
      { id: "state", kind: "write", path, bytes: Buffer.from('{"state":"new"}\n'), ownership: "adopted", structured: "json" },
    ] });
    await writeFile(path, Buffer.from('{"state":"new"}\n'));
    const journalPath = join(dir, ".uai-journal", "pending-crash.json");
    await mkdir(join(dir, ".uai-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema: "uai.mutation-journal.v1", plan, status: "applying",
      entries: [{ mutationId: "state", state: "pending", recordedAt: "2026-07-17T00:00:00.000Z" }],
    })}\n`);
    expect((await recoverJournal(journalPath)).status).toBe("rolled-back");
    expect(await readFile(path)).toEqual(original);
    expect((await recoverJournal(journalPath)).status).toBe("rolled-back");
    expect(await readFile(path)).toEqual(original);
  });

  test("preserves an external edit after a pending crash and reports rollback conflict", async () => {
    const dir = await root();
    const path = join(dir, "state.json");
    await writeFile(path, Buffer.from('{"state":"old"}\n'));
    const plan = await createInstallPlan({ id: "pending-external-edit", root: dir, mutations: [
      { id: "state", kind: "write", path, bytes: Buffer.from('{"state":"installed"}\n'), ownership: "adopted", structured: "json" },
    ] });
    const external = Buffer.from('{"state":"external","keep":true}\n');
    await writeFile(path, external);
    const journalPath = join(dir, ".uai-journal", "pending-external-edit.json");
    await mkdir(join(dir, ".uai-journal"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({
      schema: "uai.mutation-journal.v1", plan, status: "applying",
      entries: [{ mutationId: "state", state: "pending", recordedAt: "2026-07-17T00:00:00.000Z" }],
    })}\n`);
    const recovery = await recoverJournal(journalPath);
    expect(recovery).toMatchObject({ status: "rollback-conflict", conflicts: [{ mutationId: "state", path }] });
    expect(await readFile(path)).toEqual(external);
    const persisted = JSON.parse(await readFile(journalPath, "utf8"));
    expect(persisted).toMatchObject({ status: "rollback-conflict", entries: [{ state: "conflict" }] });
  });

  test("aborts on plan drift without erasing the intervening edit", async () => {
    const dir = await root();
    const path = join(dir, "settings.json");
    await writeFile(path, Buffer.from('{"state":"planned"}\n'));
    const plan = await createInstallPlan({ id: "drift", root: dir, mutations: [
      { id: "settings", kind: "write", path, bytes: Buffer.from('{"state":"installed"}\n'), ownership: "adopted", structured: "json" },
    ] });
    const intervening = Buffer.from('{"state":"foreign-edit","key":"preserve"}\n');
    await writeFile(path, intervening);
    await expect(applyInstallPlan(plan)).rejects.toThrow("Plan drift detected");
    expect(await readFile(path)).toEqual(intervening);
  });

  test("rejects duplicate mutation IDs before any write", async () => {
    const dir = await root();
    const first = join(dir, "first.json");
    const second = join(dir, "second.json");
    await expect(createInstallPlan({ id: "duplicate-ids", root: dir, mutations: [
      { id: "duplicate", kind: "write", path: first, bytes: Buffer.from("{}\n"), ownership: "owned", structured: "json" },
      { id: "duplicate", kind: "write", path: second, bytes: Buffer.from("{}\n"), ownership: "owned", structured: "json" },
    ] })).rejects.toThrow("Duplicate mutation ID");
    expect(await Bun.file(first).exists()).toBeFalse();
    expect(await Bun.file(second).exists()).toBeFalse();
  });

  test("rejects a persisted duplicate-ID journal before rollback writes", async () => {
    const dir = await root();
    const first = join(dir, "first.json");
    const second = join(dir, "second.json");
    const firstCurrent = Buffer.from('{"current":"first"}\n');
    const secondCurrent = Buffer.from('{"current":"second"}\n');
    await Promise.all([writeFile(first, firstCurrent), writeFile(second, secondCurrent), mkdir(join(dir, ".uai-journal"), { recursive: true })]);
    const before = { existed: true, kind: "file", bytesBase64: Buffer.from("{}\n").toString("base64") };
    const journal = {
      schema: "uai.mutation-journal.v1", status: "applying",
      plan: {
        schema: "uai.install-plan.v1", id: "duplicate-journal", root: dir, createdAt: "2026-07-17T00:00:00.000Z", gates: [],
        mutations: [
          { id: "duplicate", kind: "write", path: first, ownership: "adopted", bytesBase64: Buffer.from('{"installed":1}\n').toString("base64"), before, existed: true },
          { id: "duplicate", kind: "write", path: second, ownership: "adopted", bytesBase64: Buffer.from('{"installed":2}\n').toString("base64"), before, existed: true },
        ],
      },
      entries: [{ mutationId: "duplicate", state: "pending", recordedAt: "2026-07-17T00:00:00.000Z" }],
    };
    const journalPath = join(dir, ".uai-journal", "duplicate-journal.json");
    const journalBytes = Buffer.from(`${JSON.stringify(journal)}\n`);
    await writeFile(journalPath, journalBytes);
    await expect(recoverJournal(journalPath)).rejects.toThrow("Duplicate mutation ID");
    expect(await readFile(first)).toEqual(firstCurrent);
    expect(await readFile(second)).toEqual(secondCurrent);
    expect(await readFile(journalPath)).toEqual(journalBytes);
  });

  test("invalid structured config is a blocker and byte-identical", async () => {
    const dir = await root();
    const path = join(dir, "invalid.json");
    await writeFile(path, Buffer.from("{ invalid\r\n"));
    const before = await readFile(path);
    await expect(createInstallPlan({ id: "invalid", root: dir, mutations: [
      { id: "bad", kind: "write", path, bytes: Buffer.from("{}"), ownership: "adopted", structured: "json" },
    ] })).rejects.toThrow("Invalid existing JSON");
    expect(await readFile(path)).toEqual(before);
  });

  test("invalid TOML remains byte-identical", async () => {
    const dir = await root();
    const path = join(dir, "invalid.toml");
    await writeFile(path, Buffer.from("[unterminated\r\nforeign = \"keep\"\r\n"));
    const before = await readFile(path);
    await expect(createInstallPlan({ id: "invalid-toml", root: dir, mutations: [
      { id: "bad-toml", kind: "write", path, bytes: Buffer.from("uai = true\n"), ownership: "adopted", structured: "toml" },
    ] })).rejects.toThrow("Invalid existing TOML");
    expect(await readFile(path)).toEqual(before);
  });

  test("invalid YAML remains byte-identical", async () => {
    const dir = await root();
    const path = join(dir, "invalid.yaml");
    await writeFile(path, Buffer.from("valid: true\r\nthis is not a mapping\r\n"));
    const before = await readFile(path);
    await expect(createInstallPlan({ id: "invalid-yaml", root: dir, mutations: [
      { id: "bad-yaml", kind: "write", path, bytes: Buffer.from("uai: true\n"), ownership: "adopted", structured: "yaml" },
    ] })).rejects.toThrow("Invalid existing YAML");
    expect(await readFile(path)).toEqual(before);
  });
  test("rejects traversal and unsafe plan identifiers before mutation", async () => {
    const container = await root();
    const declaredRoot = join(container, "profile");
    const outside = join(container, "outside.txt");
    await mkdir(declaredRoot);
    await expect(createInstallPlan({
      id: "../escape",
      root: declaredRoot,
      mutations: [{ id: "escape", kind: "write", path: outside, bytes: Buffer.from("owned"), ownership: "owned" }],
    })).rejects.toThrow();
    expect(await Bun.file(outside).exists()).toBeFalse();
  });

  test("rejects linked parent escapes before mutation", async () => {
    const container = await root();
    const declaredRoot = join(container, "profile");
    const outside = join(container, "outside");
    const linkedParent = join(declaredRoot, "linked");
    await Promise.all([mkdir(declaredRoot), mkdir(outside)]);
    await symlink(outside, linkedParent, process.platform === "win32" ? "junction" : "dir");
    const escaped = join(linkedParent, "escaped.txt");
    await expect(createInstallPlan({
      id: "linked-parent",
      root: declaredRoot,
      mutations: [{ id: "escape", kind: "write", path: escaped, bytes: Buffer.from("owned"), ownership: "owned" }],
    })).rejects.toThrow();
    expect(await Bun.file(escaped).exists()).toBeFalse();
  });

  test("rejects tampered recovery journals before outside-root rollback", async () => {
    const container = await root();
    const declaredRoot = join(container, "profile");
    const outside = join(container, "outside.txt");
    const applied = Buffer.from("installed");
    await Promise.all([mkdir(join(declaredRoot, ".uai-journal"), { recursive: true }), writeFile(outside, applied)]);
    const journalPath = join(declaredRoot, ".uai-journal", "tampered.json");
    await writeFile(journalPath, `${JSON.stringify({
      schema: "uai.mutation-journal.v1",
      status: "applying",
      plan: {
        schema: "uai.install-plan.v1",
        id: "tampered",
        root: declaredRoot,
        createdAt: new Date().toISOString(),
        gates: [],
        mutations: [{
          id: "escape",
          kind: "write",
          path: outside,
          ownership: "owned",
          bytesBase64: applied.toString("base64"),
          before: { existed: false },
          existed: false,
        }],
      },
      entries: [{ mutationId: "escape", state: "pending", recordedAt: new Date().toISOString() }],
    })}\n`);
    await expect(recoverJournal(journalPath)).rejects.toThrow();
    expect(await readFile(outside)).toEqual(applied);
  });

  test("rejects tampered manifests before outside-root uninstall", async () => {
    const container = await root();
    const declaredRoot = join(container, "profile");
    const outside = join(container, "outside.txt");
    const bytes = Buffer.from("preserve");
    await Promise.all([mkdir(declaredRoot), writeFile(outside, bytes)]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await expect(uninstallOwned({
      schema: "uai.ownership-manifest.v1",
      planId: "tampered",
      root: declaredRoot,
      artifacts: [{
        path: outside,
        ownership: "owned",
        mutationId: "escape",
        before: { existed: false },
        applied: { existed: true, kind: "file", sha256 },
      }],
    })).rejects.toThrow();
    expect(await readFile(outside)).toEqual(bytes);
  });

  test("preserves the original baseline across repeated component updates", async () => {
    const dir = await root();
    const target = join(dir, "component.txt");
    const original = Buffer.from("original");
    await writeFile(target, original);
    const first = await applyInstallPlan(await createInstallPlan({
      id: "stable-component",
      root: dir,
      mutations: [{ id: "component", kind: "write", path: target, bytes: Buffer.from("v1"), ownership: "adopted" }],
    }));
    expect(await readFile(target, "utf8")).toBe("v1");
    const second = await applyInstallPlan(await createInstallPlan({
      id: "stable-component",
      root: dir,
      mutations: [{ id: "component", kind: "write", path: target, bytes: Buffer.from("v2"), ownership: "adopted" }],
    }));
    expect(first.journalPath).not.toBe(second.journalPath);
    expect((await uninstallOwned(second.manifest)).status).toBe("uninstalled");
    expect(await readFile(target)).toEqual(original);
  });
});
