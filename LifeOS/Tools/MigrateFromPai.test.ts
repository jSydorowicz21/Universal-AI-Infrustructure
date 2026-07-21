import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run, type Args } from "./MigrateFromPai";

// ── Test harness (mirrors LifeOS/install/LIFEOS/OMP/stabilization.test.ts) ──

const temps: string[] = [];
const rootEnvironmentVariables = ["UAI_DATA_DIR", "PAI_DATA_DIR", "UAI_CONFIG_DIR", "PAI_CONFIG_DIR"] as const;
const inheritedRootEnvironment: Record<(typeof rootEnvironmentVariables)[number], string | undefined> = {
	UAI_DATA_DIR: process.env.UAI_DATA_DIR,
	PAI_DATA_DIR: process.env.PAI_DATA_DIR,
	UAI_CONFIG_DIR: process.env.UAI_CONFIG_DIR,
	PAI_CONFIG_DIR: process.env.PAI_CONFIG_DIR,
};

function clearRootEnvironment(): void {
	for (const name of rootEnvironmentVariables) delete process.env[name];
}

function restoreRootEnvironment(): void {
	for (const name of rootEnvironmentVariables) {
		const value = inheritedRootEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

beforeEach(() => {
	clearRootEnvironment();
});

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	restoreRootEnvironment();
});

// ── Fixture helpers ──

/** A staged old-PAI profile inside a temp HOME-like root. All paths are
 * distinct subdirs of the temp root — never the live `~/.claude` / `~/.pai`. */
interface Fixture {
	home: string;
	configRoot: string;
	paiDir: string;
	oldDataDir: string;
	dataDir: string;
}

function stageOldPaiProfile(home: string, opts: { sameRoot?: boolean } = {}): Fixture {
	const configRoot = join(home, ".claude");
	const paiDir = join(configRoot, "PAI");
	const oldDataDir = join(home, opts.sameRoot ? ".pai" : ".pai-old");
	const dataDir = join(home, opts.sameRoot ? ".pai" : ".pai-new");

	// Config-side PAI/USER: identity, TELOS, PROJECTS (flat filenames).
	mkdirSync(join(paiDir, "USER", "TELOS"), { recursive: true });
	mkdirSync(join(paiDir, "USER", "PROJECTS"), { recursive: true });
	writeFileSync(join(paiDir, "USER", "PRINCIPAL_IDENTITY.md"), "# Principal\nname: Test\n");
	writeFileSync(join(paiDir, "USER", "DA_IDENTITY.md"), "# DA\nname: TestDA\n");
	writeFileSync(join(paiDir, "USER", "PROJECTS", "PROJECTS.md"), "# Projects\n- A\n");
	writeFileSync(join(paiDir, "USER", "TELOS", "PRINCIPAL_TELOS.md"), "# TELOS\nmission: x\n");
	// An unmapped file to prove same-relative-path carry.
	writeFileSync(join(paiDir, "USER", "CUSTOM_NOTES.md"), "# Notes\nrandom unmapped\n");

	// Old-data USER: RESUME, Config/PAI_CONFIG.yaml.
	mkdirSync(join(oldDataDir, "USER", "Config"), { recursive: true });
	writeFileSync(join(oldDataDir, "USER", "RESUME.md"), "# Resume\n");
	writeFileSync(join(oldDataDir, "USER", "Config", "PAI_CONFIG.yaml"), "apiKey: placeholder\n");

	// CLAUDE.md with @PAI/... imports.
	writeFileSync(
		join(configRoot, "CLAUDE.md"),
		[
			"# Root",
			"@PAI/USER/PRINCIPAL_IDENTITY.md",
			"@PAI/USER/DA_IDENTITY.md",
			"@PAI/USER/PROJECTS/PROJECTS.md",
			"@PAI/USER/TELOS/PRINCIPAL_TELOS.md",
			"",
		].join("\n"),
	);

	// settings.json with a PAI-path hook command.
	writeFileSync(
		join(configRoot, "settings.json"),
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{ matcher: "*", hooks: [{ type: "command", command: "bun $HOME/.claude/PAI/TOOLS/Hook.ts" }] },
				],
			},
		}) + "\n",
	);

	return { home, configRoot, paiDir, oldDataDir, dataDir };
}

function argsFor(fixture: Fixture, overrides: Partial<Args> = {}): Args {
	return {
		configRoot: fixture.configRoot,
		paiDir: fixture.paiDir,
		oldDataDir: fixture.oldDataDir,
		dataDir: fixture.dataDir,
		apply: false,
		json: false,
		...overrides,
	};
}

/** Read every regular file under `root`, returning a map of absolute → bytes.
 * Used to byte-snapshot a tree before/after an operation (proves zero mutation). */
function snapshotTree(root: string): Record<string, Buffer> {
	const out: Record<string, Buffer> = {};
	if (!existsSync(root)) return out;
	const visit = (dir: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, e.name);
			if (e.isDirectory()) visit(full);
			else if (e.isFile()) out[full] = readFileSync(full);
		}
	};
	visit(root);
	return out;
}

/** Asserts two byte-snapshots are identical (same file set, same bytes). */
function expectSnapshotsEqual(before: Record<string, Buffer>, after: Record<string, Buffer>): void {
	expect(Object.keys(after).length).toBe(Object.keys(before).length);
	for (const [path, bytes] of Object.entries(before)) {
		expect(after[path]).toEqual(bytes);
	}
}

// ── Tests ──

describe("PAI → LifeOS migration", () => {
	test("old-PAI fixture tree migrates fully with mapped renames and unmapped carry", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-full-"));
		const args = argsFor(fixture);
		const preview = run(args);
		expect(preview.status).toBe("preview");
		// Mapped: PRINCIPAL_IDENTITY, DA_IDENTITY, PROJECTS, PRINCIPAL_TELOS.
		expect(preview.summary.mapped).toBe(4);
		// Unmapped-carried: CUSTOM_NOTES.md, RESUME.md, Config/PAI_CONFIG.yaml.
		expect(preview.summary["unmapped-carried"]).toBe(3);
		expect(preview.summary.total).toBe(7);

		// Apply and verify the migrated tree shape.
		const applied = run({ ...args, apply: true });
		expect(applied.status).toBe("applied");
		expect(applied.ok).toBe(true);

		// Mapped renames land at their renamed destinations.
		expect(readFileSync(join(fixture.dataDir, "USER", "PRINCIPAL", "PRINCIPAL_IDENTITY.md"), "utf-8")).toContain("# Principal");
		expect(readFileSync(join(fixture.dataDir, "USER", "DIGITAL_ASSISTANT", "DA_IDENTITY.md"), "utf-8")).toContain("# DA");
		// PROJECTS/PROJECTS.md → USER/PROJECTS.md (dir flattened to file).
		expect(readFileSync(join(fixture.dataDir, "USER", "PROJECTS.md"), "utf-8")).toContain("# Projects");
		expect(readFileSync(join(fixture.dataDir, "USER", "TELOS", "PRINCIPAL_TELOS.md"), "utf-8")).toContain("# TELOS");

		// Unmapped files carried at same relative path.
		expect(readFileSync(join(fixture.dataDir, "USER", "CUSTOM_NOTES.md"), "utf-8")).toContain("random unmapped");
		expect(readFileSync(join(fixture.dataDir, "USER", "RESUME.md"), "utf-8")).toContain("# Resume");
		expect(readFileSync(join(fixture.dataDir, "USER", "Config", "PAI_CONFIG.yaml"), "utf-8")).toContain("apiKey");

		// The OLD source tree is untouched (read-only).
		expect(readFileSync(join(fixture.paiDir, "USER", "PRINCIPAL_IDENTITY.md"), "utf-8")).toContain("# Principal");

		// Verification covers every planned destination.
		expect(applied.verification?.verified).toBe(7);
		expect(applied.verification?.failed.length).toBe(0);
	});

	test("conflict at destination preserves .replaced-* and applies source", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-conflict-"));
		const args = argsFor(fixture);

		// Pre-seed a DIFFERENT PROJECTS.md at the destination.
		mkdirSync(join(fixture.dataDir, "USER"), { recursive: true });
		writeFileSync(join(fixture.dataDir, "USER", "PROJECTS.md"), "NEWER DIFFERENT CONTENT\n");

		const applied = run({ ...args, apply: true });
		expect(applied.status).toBe("applied");
		expect(applied.summary["conflict-preserve"]).toBe(1);

		// The destination now holds the SOURCE content (live-wins).
		expect(readFileSync(join(fixture.dataDir, "USER", "PROJECTS.md"), "utf-8")).toContain("# Projects");
		// The displaced destination was preserved as <file>.replaced-<stamp>.
		const replaced = readdirSync(join(fixture.dataDir, "USER")).filter((n) => n.startsWith("PROJECTS.md.replaced-"));
		expect(replaced.length).toBe(1);
		expect(readFileSync(join(fixture.dataDir, "USER", replaced[0]), "utf-8")).toBe("NEWER DIFFERENT CONTENT\n");
	});

	test("identical files at destination are skipped", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-identical-"));
		const args = argsFor(fixture);

		// First apply: everything copied.
		const first = run({ ...args, apply: true });
		expect(first.summary.mapped + first.summary["unmapped-carried"]).toBe(7);

		// Second apply: everything byte-identical → identical-skip.
		const second = run({ ...args, apply: true });
		expect(second.status).toBe("applied");
		expect(second.summary["identical-skip"]).toBe(7);
		expect(second.summary.mapped).toBe(0);
		expect(second.summary["unmapped-carried"]).toBe(0);
		expect(second.summary["conflict-preserve"]).toBe(0);
		// No .replaced-* files were created on the idempotent pass.
		const replacedFiles = readdirSync(join(fixture.dataDir, "USER")).filter((n) => n.includes(".replaced-"));
		expect(replacedFiles.length).toBe(0);
	});

	test("preview mutates nothing (byte-snapshot before/after)", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-preview-"));
		const args = argsFor(fixture);

		const beforeHome = snapshotTree(fixture.home);
		const preview = run(args);
		expect(preview.status).toBe("preview");

		// Snapshot after preview — must be byte-identical.
		const afterHome = snapshotTree(fixture.home);
		expectSnapshotsEqual(beforeHome, afterHome);
		// The new data root must not have been created.
		expect(existsSync(join(fixture.dataDir, "USER"))).toBe(false);
	});

	test("symlink in source refuses with zero mutations", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-symlink-src-"));
		const args = argsFor(fixture);

		// Drop a symlink inside the OLD source tree, pointing at an existing file.
		symlinkSync(
			join(fixture.paiDir, "USER", "TELOS", "PRINCIPAL_TELOS.md"),
			join(fixture.paiDir, "USER", "link.md"),
		);

		const beforeHome = snapshotTree(fixture.home);
		const applied = run({ ...args, apply: true });
		expect(applied.status).toBe("refused");
		expect(applied.refused).toContain("links are not allowed");

		const afterHome = snapshotTree(fixture.home);
		expectSnapshotsEqual(beforeHome, afterHome);
		expect(existsSync(join(fixture.dataDir, "USER"))).toBe(false);
	});

	test("junction at destination refuses with zero mutations", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-junction-dst-"));
		const args = argsFor(fixture);

		// Pre-create the new USER dir as a junction to an EXISTING foreign target.
		// Junctions created via symlinkSync(target, path, "junction") ARE
		// detected by lstatSync().isSymbolicLink() in this runtime (confirmed
		// by stabilization.test.ts:535/1565). physicalTreeFailure must refuse it.
		const foreignTarget = join(fixture.home, "foreign-target");
		mkdirSync(foreignTarget, { recursive: true });
		mkdirSync(dirname(join(fixture.dataDir, "USER")), { recursive: true });
		symlinkSync(foreignTarget, join(fixture.dataDir, "USER"), process.platform === "win32" ? "junction" : "dir");

		const beforeHome = snapshotTree(fixture.home);
		const applied = run({ ...args, apply: true });
		expect(applied.status).toBe("refused");
		expect(applied.refused).toContain("unsafe physical tree");

		const afterHome = snapshotTree(fixture.home);
		expectSnapshotsEqual(beforeHome, afterHome);
		// The foreign target must not have received any migrated files.
		expect(readdirSync(foreignTarget).length).toBe(0);
	});

	test("dangling junction at destination root refuses with zero mutations", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-dangling-dst-"));
		const args = argsFor(fixture);

		// Create a DANGLING junction at the destination root — its target does
		// NOT exist. existsSync() follows links and returns false here, so the
		// safety gate MUST be lstat-based (unconditional physicalTreeFailure),
		// not existsSync-based, or a dangling junction would be treated as
		// absent and the migration would write THROUGH it.
		mkdirSync(dirname(join(fixture.dataDir, "USER")), { recursive: true });
		symlinkSync(join(fixture.home, "does-not-exist"), join(fixture.dataDir, "USER"), process.platform === "win32" ? "junction" : "dir");

		const beforeHome = snapshotTree(fixture.home);
		const applied = run({ ...args, apply: true });
		expect(applied.status).toBe("refused");
		expect(applied.refused).toContain("unsafe physical tree");

		const afterHome = snapshotTree(fixture.home);
		expectSnapshotsEqual(beforeHome, afterHome);
	});

	test("refuses a checked-out LifeOS source tree before reading migration sources", () => {
		const home = temp("uai-migrate-source-repo-");
		const configRoot = join(home, "source-repo");
		const paiDir = join(configRoot, "PAI");
		const dataDir = join(home, ".pai-new");
		mkdirSync(join(configRoot, ".git"), { recursive: true });
		mkdirSync(join(configRoot, "LifeOS", "install"), { recursive: true });
		mkdirSync(join(configRoot, "LifeOS", "Tools"), { recursive: true });
		writeFileSync(join(configRoot, "LifeOS", "Tools", "InstallEngine.ts"), "");
		mkdirSync(join(paiDir, "USER"), { recursive: true });
		writeFileSync(join(paiDir, "USER", "CUSTOM.md"), "must not copy\n");

		const report = run({
			configRoot,
			paiDir,
			oldDataDir: join(home, ".pai-old"),
			dataDir,
			apply: true,
			json: true,
		});

		expect(report.status).toBe("refused");
		expect(report.refused).toContain("source tree");
		expect(existsSync(join(dataDir, "USER", "CUSTOM.md"))).toBe(false);
	});

	test("missing old install returns nothing-to-migrate", () => {
		const home = temp("uai-migrate-empty-");
		const configRoot = join(home, ".claude");
		const paiDir = join(configRoot, "PAI");
		const dataDir = join(home, ".pai-new");
		mkdirSync(configRoot, { recursive: true });
		mkdirSync(dataDir, { recursive: true });

		const report = run({
			configRoot,
			paiDir,
			oldDataDir: join(home, ".pai-old"),
			dataDir,
			apply: true,
			json: true,
		});
		expect(report.status).toBe("nothing-to-migrate");
		expect(report.ok).toBe(true);
		expect(report.summary.total).toBe(0);
		expect(report.plan.length).toBe(0);
	});

	test("idempotent second apply is all identical-skip", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-idempotent-"));
		const args = argsFor(fixture);

		const first = run({ ...args, apply: true });
		expect(first.status).toBe("applied");
		expect(first.verification?.verified).toBe(first.summary.total);
		expect(first.verification?.failed.length).toBe(0);

		const second = run({ ...args, apply: true });
		expect(second.status).toBe("applied");
		expect(second.summary["identical-skip"]).toBe(second.summary.total);
		expect(second.summary.mapped).toBe(0);
		expect(second.summary["unmapped-carried"]).toBe(0);
		expect(second.summary["conflict-preserve"]).toBe(0);
		expect(second.verification?.verified).toBe(second.summary.total);
		expect(second.verification?.failed.length).toBe(0);
	});

	test("works when old and new data roots are the SAME directory without self-copy damage", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-same-root-"), { sameRoot: true });
		expect(fixture.oldDataDir).toBe(fixture.dataDir);
		const args = argsFor(fixture);

		const applied = run({ ...args, apply: true });
		expect(applied.status).toBe("applied");
		expect(applied.ok).toBe(true);

		// The old-data USER file (RESUME.md) is its OWN destination — it must
		// be present, unchanged, and NOT clobbered or self-copied.
		expect(readFileSync(join(fixture.dataDir, "USER", "RESUME.md"), "utf-8")).toBe("# Resume\n");

		// The config-side mapped renames landed correctly under the shared root.
		expect(readFileSync(join(fixture.dataDir, "USER", "PRINCIPAL", "PRINCIPAL_IDENTITY.md"), "utf-8")).toContain("# Principal");
		expect(readFileSync(join(fixture.dataDir, "USER", "DIGITAL_ASSISTANT", "DA_IDENTITY.md"), "utf-8")).toContain("# DA");
		expect(readFileSync(join(fixture.dataDir, "USER", "PROJECTS.md"), "utf-8")).toContain("# Projects");

		// No .replaced-* files (nothing was overwritten — RESUME.md was identical-skip).
		const replacedFiles = readdirSync(join(fixture.dataDir, "USER")).filter((n) => n.includes(".replaced-"));
		expect(replacedFiles.length).toBe(0);

		expect(applied.verification?.failed.length).toBe(0);
	});

	test("preserves every collision when PAI and old-data sources share a destination", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-duplicate-source-"));
		const args = argsFor(fixture);
		const destination = join(fixture.dataDir, "USER", "TELOS", "PRINCIPAL_TELOS.md");
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, "PREEXISTING DESTINATION\n");
		mkdirSync(join(fixture.oldDataDir, "USER", "TELOS"), { recursive: true });
		writeFileSync(join(fixture.oldDataDir, "USER", "TELOS", "PRINCIPAL_TELOS.md"), "OLD DATA WINS\n");

		const applied = run({ ...args, apply: true });

		expect(applied.status).toBe("applied");
		expect(readFileSync(destination, "utf-8")).toBe("OLD DATA WINS\n");
		const preserved = readdirSync(dirname(destination))
			.filter((name) => name.startsWith("PRINCIPAL_TELOS.md.replaced-"))
			.map((name) => readFileSync(join(dirname(destination), name), "utf-8"))
			.sort();
		expect(preserved).toEqual(["# TELOS\nmission: x\n", "PREEXISTING DESTINATION\n"]);
		expect(applied.verification?.failed).toEqual([]);
	});
	test("advisory surfaces @PAI CLAUDE.md imports and PAI-path settings hooks with exact replacements", () => {
		const fixture = stageOldPaiProfile(temp("uai-migrate-advisory-"));
		const args = argsFor(fixture);

		const preview = run(args);
		expect(preview.advisory.claudeMdImports.length).toBe(4);

		const importSuggestions = preview.advisory.claudeMdImports.map((i) => i.suggestion).sort();
		expect(importSuggestions).toContain("@LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md");
		expect(importSuggestions).toContain("@LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY.md");
		expect(importSuggestions).toContain("@LIFEOS/USER/PROJECTS.md");
		expect(importSuggestions).toContain("@LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md");

		expect(preview.advisory.settingsHooks.length).toBe(1);
		const hook = preview.advisory.settingsHooks[0];
		expect(hook.text).toContain("/.claude/PAI/TOOLS/Hook.ts");
		expect(hook.suggestion).toContain("/.claude/LIFEOS/TOOLS/Hook.ts");
		expect(hook.suggestion).not.toContain("/PAI/");
	});
});
