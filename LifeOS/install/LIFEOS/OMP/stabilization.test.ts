import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOmpManager, OMP_CERTIFICATION_EXECUTOR_ID, type OmpManager } from "./manage";
import { copyMissing, detectEnv, findExecutable, resolveHomeDir, resolveInstallRoots, setupUserSeparation } from "../../../Tools/InstallEngine";
import { runInstallHooks } from "../../../Tools/InstallHooks";
import { runInstallSettings } from "../../../Tools/InstallSettings";
import { deployCoreTransactional, deployDependencies } from "../../../Tools/DeployCore";
import { getOmpSessionIdentity, resetOmpSessionIdentitiesForTests } from "./session";
import { pulseAvailable, resetPulseAvailabilityForTests, runProcessWithTimeout, startDetachedProcess } from "./extensions/lifeos-hooks/index";
import { reviewerArgs, reviewLockIsStale } from "../../hooks/MemoryReviewFire.hook";
import { resolveServiceRoots, runBoundedServiceCommand, runServiceUninstallCommands, serviceCommandExitCode, servicePlatformSupport, shellQuote } from "../TOOLS/Services";
import { ADAPTERS } from "../UNIVERSAL/adapters";
import { createFixtureHarnessExecutor, runAdapterConformance } from "../UNIVERSAL/conformance";
import { frameworkSessionIdentity } from "../../hooks/FrameworkHookAdapter";
import { uninstallOwned, type OwnershipManifest } from "../UNIVERSAL/lifecycle";

const temps: string[] = [];
const sourceOmp = import.meta.dir;
const sourceLifeos = dirname(sourceOmp);
const sourceHooks = join(sourceLifeos, "..", "hooks");
const lifeosRoot = dirname(dirname(sourceLifeos));
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

function fixtureEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		UAI_DATA_DIR: join(home, ".pai"),
		PAI_DATA_DIR: join(home, ".pai"),
		UAI_CONFIG_DIR: join(home, ".claude"),
		PAI_CONFIG_DIR: join(home, ".claude"),
		...overrides,
	};
}

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

function stageRequiredHooks(home: string): string {
	const hooksDir = join(home, ".claude", "hooks");
	mkdirSync(dirname(hooksDir), { recursive: true });
	cpSync(sourceHooks, hooksDir, { recursive: true });
	return hooksDir;
}

function manager(home: string, injectFailureAt?: "after-link" | "after-config"): OmpManager {
	return createOmpManager({
		home,
		agentDir: join(home, ".omp", "agent"),
		hooksDir: join(home, ".claude", "hooks"),
		probeExecutable: null,
		lifeosDir: sourceLifeos,
		sourceDir: sourceOmp,
		injectFailureAt,
	});
}

beforeEach(() => {
	clearRootEnvironment();
});

afterEach(() => {
	resetOmpSessionIdentitiesForTests();
	delete process.env.LIFEOS_TEST_FAIL_INSTALL_HOOKS;
	resetPulseAvailabilityForTests();
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	restoreRootEnvironment();
});

describe("transactional OMP installation", () => {
	test("core-only source fails before creating the profile", async () => {
		const root = temp("uai-omp-core-only-");
		const source = join(root, "core", "OMP");
		const liveSentinel = join(root, "unrelated-live-profile", "sentinel.txt");
		mkdirSync(dirname(liveSentinel), { recursive: true });
		writeFileSync(liveSentinel, "do-not-touch\n");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "APPEND_SYSTEM.md"), "core only\n");
		const agentDir = join(root, "profile", "agent");
		const m = createOmpManager({ home: root, agentDir, hooksDir: join(root, "missing-hooks"), sourceDir: source, lifeosDir: dirname(source) });
		const result = await m.install();
		expect(result.ok).toBe(false);
		expect(result.problems.some((problem) => problem.includes("hook"))).toBe(true);
		expect(existsSync(agentDir)).toBe(false);
		expect(readFileSync(liveSentinel, "utf8")).toBe("do-not-touch\n");
	});

	test("malformed YAML is byte-identical and blocks before mutation", async () => {
		const home = temp("uai-omp-malformed-");
		stageRequiredHooks(home);
		const agentDir = join(home, ".omp", "agent");
		mkdirSync(agentDir, { recursive: true });
		const config = join(agentDir, "config.yml");
		const before = "extensions: [unterminated\nforeign: keep\n";
		writeFileSync(config, before);
		const result = await manager(home).install();
		expect(result.ok).toBe(false);
		expect(readFileSync(config, "utf8")).toBe(before);
		expect(existsSync(join(agentDir, "APPEND_SYSTEM.md"))).toBe(false);
	});

	test("injected failure rolls back config and prior constitution bytes", async () => {
		const home = temp("uai-omp-rollback-");
		stageRequiredHooks(home);
		const agentDir = join(home, ".omp", "agent");
		mkdirSync(agentDir, { recursive: true });
		const config = join(agentDir, "config.yml");
		const append = join(agentDir, "APPEND_SYSTEM.md");
		const configBefore = "foreign: keep\nextensions:\n  - /foreign/ext\n";
		const appendBefore = "foreign constitution\n";
		writeFileSync(config, configBefore);
		writeFileSync(append, appendBefore);
		const result = await manager(home, "after-config").install();
		expect(result.ok).toBe(false);
		expect(readFileSync(config, "utf8")).toBe(configBefore);
		expect(readFileSync(append, "utf8")).toBe(appendBefore);
	});

	test("valid install and uninstall preserve foreign config and restore prior link", async () => {
		const home = temp("uai-omp-uninstall-");
		stageRequiredHooks(home);
		const agentDir = join(home, ".omp", "agent");
		mkdirSync(agentDir, { recursive: true });
		const config = join(agentDir, "config.yml");
		const priorTarget = join(home, "prior.md");
		writeFileSync(config, "foreign:\n  nested: keep\nextensions:\n  - /foreign/ext\n");
		writeFileSync(priorTarget, "prior\n");
		symlinkSync(priorTarget, join(agentDir, "APPEND_SYSTEM.md"), process.platform === "win32" ? "file" : undefined);
		const installed = await manager(home).install();
		expect(installed.ok).toBe(true);
		const wired = Bun.YAML.parse(readFileSync(config, "utf8")) as { extensions: string[]; foreign: { nested: string } };
		expect(wired.foreign.nested).toBe("keep");
		expect(wired.extensions.length).toBe(6);
		const status = manager(home).status();
		expect(status.wired).toBe(true);
		expect(status.active).toBe(false);
		expect(status.loadable).toBe(true);
		const removed = await manager(home).uninstall();
		expect(removed.ok).toBe(true);
		expect(readFileSync(config, "utf8")).toBe("foreign:\n  nested: keep\nextensions:\n  - /foreign/ext\n");
		expect(lstatSync(join(agentDir, "APPEND_SYSTEM.md")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(agentDir, "APPEND_SYSTEM.md"), "utf8")).toBe("prior\n");
	});

	test("default OMP preflight uses the canonical selected config root", async () => {
		const home = temp("uai-omp-selected-config-");
		const configRoot = join(home, "selected");
		const hooksDir = join(configRoot, "hooks");
		cpSync(sourceHooks, hooksDir, { recursive: true });
		const previous = process.env.UAI_CONFIG_DIR;
		process.env.UAI_CONFIG_DIR = configRoot;
		try {
			const selected = createOmpManager({
				home,
				agentDir: join(home, "omp-agent"),
				sourceDir: sourceOmp,
				lifeosDir: sourceLifeos,
				probeExecutable: null,
			});
			const installed = await selected.install();
			expect(installed.ok, installed.problems.join("\n")).toBe(true);
			expect((await selected.uninstall()).ok).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.UAI_CONFIG_DIR;
			else process.env.UAI_CONFIG_DIR = previous;
		}
	});

	test("semantic uninstall preserves config added after install", async () => {
		const home = temp("uai-omp-post-install-foreign-");
		stageRequiredHooks(home);
		expect((await manager(home).install()).ok).toBe(true);
		const config = join(home, ".omp", "agent", "config.yml");
		const installed = Bun.YAML.parse(readFileSync(config, "utf8")) as { extensions: string[] };
		writeFileSync(config, `${Bun.YAML.stringify({
			extensions: [...installed.extensions, "/foreign/after-install"],
			foreignAfterInstall: { keep: true },
		}).trimEnd()}\n`);
		const removed = await manager(home).uninstall();
		expect(removed.ok).toBe(true);
		const preserved = Bun.YAML.parse(readFileSync(config, "utf8")) as {
			extensions: string[];
			foreignAfterInstall: { keep: boolean };
		};
		expect(preserved.extensions).toEqual(["/foreign/after-install"]);
		expect(preserved.foreignAfterInstall.keep).toBe(true);
	});

	test("uninstall conflicts fail visibly and retain ownership for retry", async () => {
		const home = temp("uai-omp-uninstall-conflict-");
		stageRequiredHooks(home);
		const m = manager(home);
		expect((await m.install()).ok).toBe(true);
		const append = join(home, ".omp", "agent", "APPEND_SYSTEM.md");
		const appliedBytes = readFileSync(append);
		const ownership = JSON.parse(readFileSync(m.paths.manifestPath, "utf8")) as OwnershipManifest;
		const applied = ownership.artifacts.find((artifact) => artifact.path === append)?.applied;
		if (!applied || applied.kind !== "file") throw new Error("OMP ownership manifest did not record the applied constitution");
		if (process.platform !== "win32") expect(statSync(append).mode & 0o777).toBe(applied.mode);
		unlinkSync(append);
		writeFileSync(append, "foreign edit\n");
		const conflicted = await m.uninstall();
		expect(conflicted.ok).toBe(false);
		expect(conflicted.problems.join("\n")).toContain("preserved changed artifact");
		expect(readFileSync(append, "utf8")).toBe("foreign edit\n");
		expect(existsSync(m.paths.manifestPath)).toBe(true);

		writeFileSync(append, appliedBytes);
		if (process.platform !== "win32" && applied.mode !== undefined) chmodSync(append, applied.mode & 0o777);
		const retried = await m.uninstall();
		expect(retried.ok, retried.problems.join("\n")).toBe(true);
		expect(existsSync(m.paths.manifestPath)).toBe(false);
		expect(existsSync(append)).toBe(false);
	});

	test("live control is observed but cannot self-certify active", async () => {
		const home = temp("uai-omp-active-probe-");
		stageRequiredHooks(home);
		const installed = await manager(home).install();
		expect(installed.ok).toBe(true);
		const executable = join(home, process.platform === "win32" ? "omp.cmd" : "omp");
		if (process.platform === "win32") {
			writeFileSync(executable, "@echo off\r\necho omp 1.2.3\r\n");
		} else {
			writeFileSync(executable, "#!/bin/sh\necho omp 1.2.3\n");
			chmodSync(executable, 0o755);
		}
		const probed = createOmpManager({
			home,
			agentDir: join(home, ".omp", "agent"),
			hooksDir: join(home, ".claude", "hooks"),
			lifeosDir: sourceLifeos,
			sourceDir: sourceOmp,
			probeExecutable: executable,
		}).status();
		expect(probed.active).toBe(false);
		expect(probed.evidence?.adapterVersion).toBe("uai.adapter.v1");
		expect(probed.evidence?.cliVersion).toContain("1.2.3");
		expect(probed.evidence?.probeId).toBe("omp-safety-dangerous-command-v1");
		expect(probed.evidence?.evidenceUri).toStartWith("urn:uai:probe:");
		expect(probed.descriptor.capabilities?.["critical.system-file-guard"]?.state).toBe("wired");
		expect(probed.descriptor.capabilities?.["agent.pulse-guard"]).toMatchObject({
			state: "degraded",
			failMode: "fail-visible-open",
		});
		expect(probed.descriptor.certification).toBe("C0");
	});
	test("status rejects fixture evidence even when the runtime tuple matches", async () => {
		const home = temp("uai-omp-certified-status-");
		stageRequiredHooks(home);
		expect((await manager(home).install()).ok).toBe(true);
		const agentDir = join(home, ".omp", "agent");
		const executable = join(home, process.platform === "win32" ? "omp.cmd" : "omp");
		if (process.platform === "win32") writeFileSync(executable, "@echo off\r\necho omp 1.2.3\r\n");
		else {
			writeFileSync(executable, "#!/bin/sh\necho omp 1.2.3\n");
			chmodSync(executable, 0o755);
		}
		const evidence = await runAdapterConformance({
			context: {
				adapterId: "omp",
				adapterVersion: "1.0.0",
				cliVersion: "omp 1.2.3",
				osProfile: `${process.platform}:${agentDir}`,
				platformTier: process.platform === "win32" ? "P3" : process.platform === "darwin" ? "P1" : "P2",
				adapterClass: "native",
			},
			adapter: ADAPTERS.omp,
			executor: createFixtureHarnessExecutor("omp"),
		});
		writeFileSync(join(agentDir, ".uai-control-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
		const status = createOmpManager({
			home,
			agentDir,
			hooksDir: join(home, ".claude", "hooks"),
			lifeosDir: sourceLifeos,
			sourceDir: sourceOmp,
			probeExecutable: executable,
		}).status();
		expect(status.active).toBe(false);
		expect(status.descriptor.certification).toBe("C0");
		expect(status.descriptor.capabilities?.["critical.system-file-guard"]?.state).toBe("wired");
		expect(status.descriptor.capabilities?.["critical.system-file-guard"]?.evidence).toBeUndefined();
	});

	test("invalid required hook syntax and extension manifests block install and status loadability", async () => {
		const home = temp("uai-omp-invalid-entrypoint-");
		stageRequiredHooks(home);
		const invalidHook = join(home, ".claude", "hooks", "SystemFileGuard.hook.ts");
		writeFileSync(invalidHook, "export const broken = ;\n");
		const invalid = manager(home);
		const result = await invalid.install();
		expect(result.ok).toBe(false);
		expect(result.problems.some((problem) => problem.includes("entrypoint build failed") || problem.includes("entrypoint import failed")), result.problems.join("\n")).toBe(true);
		expect(invalid.status().loadable).toBe(false);
		expect(existsSync(join(home, ".omp", "agent", "config.yml"))).toBe(false);

		const manifestHome = temp("uai-omp-invalid-manifest-");
		stageRequiredHooks(manifestHome);
		const sourceDir = join(manifestHome, "OMP");
		cpSync(sourceOmp, sourceDir, { recursive: true });
		const packagePath = join(sourceDir, "extensions", "lifeos-hooks", "package.json");
		const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
		packageJson.omp = { extensions: ["./missing.ts"] };
		writeFileSync(packagePath, JSON.stringify(packageJson));
		const invalidManifest = createOmpManager({
			home: manifestHome,
			agentDir: join(manifestHome, ".omp", "agent"),
			hooksDir: join(manifestHome, ".claude", "hooks"),
			lifeosDir: sourceLifeos,
			sourceDir,
		});
		const manifestResult = await invalidManifest.install();
		expect(manifestResult.ok).toBe(false);
		expect(manifestResult.problems.some((problem) => problem.includes("manifest export"))).toBe(true);
	});


});

describe("full hook profile transaction", () => {
	test("malformed settings blocks without writing hook files", async () => {
		const root = temp("uai-hooks-malformed-");
		const configRoot = join(root, "profile");
		mkdirSync(configRoot, { recursive: true });
		const settingsPath = join(configRoot, "settings.json");
		const before = "{ malformed\n";
		writeFileSync(settingsPath, before);
		const result = await runInstallHooks({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(false);
		expect(readFileSync(settingsPath, "utf8")).toBe(before);
		expect(existsSync(join(configRoot, "hooks"))).toBe(false);
	});

	test("full install preserves foreign settings and hook files", async () => {
		const root = temp("uai-hooks-full-");
		const configRoot = join(root, "profile");
		mkdirSync(join(configRoot, "hooks"), { recursive: true });
		writeFileSync(join(configRoot, "hooks", "foreign.ts"), "foreign\n");
		writeFileSync(join(configRoot, "settings.json"), `${JSON.stringify({ foreign: { keep: true }, hooks: {} }, null, 2)}\n`);

		const result = await runInstallHooks({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(true);
		expect(result.hookFilesCopied).toBeGreaterThan(10);
		expect(readFileSync(join(configRoot, "hooks", "foreign.ts"), "utf8")).toBe("foreign\n");
		const settings = JSON.parse(readFileSync(join(configRoot, "settings.json"), "utf8")) as { foreign: { keep: boolean }; hooks: Record<string, unknown> };
		expect(settings.foreign.keep).toBe(true);
		expect(Object.keys(settings.hooks).length).toBeGreaterThan(1);
	}, 30_000);

	test("custom-root hook commands resolve to the selected OMP-shared config root", async () => {
		const root = temp("uai-hooks-selected-root-");
		const configRoot = join(root, "omp-selected-config");
		const result = await runInstallHooks({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(true);
		const settings = JSON.parse(readFileSync(join(configRoot, "settings.json"), "utf8")) as Record<string, unknown>;
		const commands: string[] = [];
		const visit = (value: unknown): void => {
			if (Array.isArray(value)) for (const item of value) visit(item);
			else if (value && typeof value === "object") {
				for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
					if (key === "command" && typeof item === "string") commands.push(item);
					else visit(item);
				}
			}
		};
		visit(settings.hooks);
		const guardPath = join(configRoot, "hooks", "PreToolGuard.hook.ts");
		expect(commands.some((command) => command.includes(guardPath))).toBe(true);
		expect(commands.some((command) => command.includes("$HOME/.claude"))).toBe(false);
		expect(existsSync(guardPath)).toBe(true);
	});

	test("injected failure restores exact settings and hook tree", async () => {
		const root = temp("uai-hooks-rollback-");
		const configRoot = join(root, "profile");
		mkdirSync(join(configRoot, "hooks"), { recursive: true });
		const settingsBefore = "{\n  \"foreign\": true\n}\n";
		writeFileSync(join(configRoot, "settings.json"), settingsBefore);
		writeFileSync(join(configRoot, "hooks", "foreign.ts"), "sentinel\n");
		process.env.LIFEOS_TEST_FAIL_INSTALL_HOOKS = "after-settings";
		try {
			const result = await runInstallHooks({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
			expect(result.ok).toBe(false);
		} finally {
			delete process.env.LIFEOS_TEST_FAIL_INSTALL_HOOKS;
		}
		expect(readFileSync(join(configRoot, "settings.json"), "utf8")).toBe(settingsBefore);
		expect(readFileSync(join(configRoot, "hooks", "foreign.ts"), "utf8")).toBe("sentinel\n");
		expect(existsSync(join(configRoot, "hooks", "Safety.hook.ts"))).toBe(false);
	}, 30_000);
	test("plan drift blocks settings mutation and preserves third-state hook bytes", async () => {
		const root = temp("uai-hooks-drift-");
		const configRoot = join(root, "profile");
		mkdirSync(join(configRoot, "hooks"), { recursive: true });
		mkdirSync(configRoot, { recursive: true });
		const settingsPath = join(configRoot, "settings.json");
		const before = `${JSON.stringify({ foreign: true }, null, 2)}\n`;
		writeFileSync(settingsPath, before);
		process.env.LIFEOS_TEST_DRIFT_INSTALL_HOOKS = "1";
		try {
			const result = await runInstallHooks({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("Plan drift");
		} finally {
			delete process.env.LIFEOS_TEST_DRIFT_INSTALL_HOOKS;
		}
		expect(readFileSync(settingsPath, "utf8")).toBe(before);
		expect(existsSync(join(configRoot, "hooks"))).toBe(true);
	}, 30_000);

	test("defined unsupported settings hooks shape remains byte-identical", async () => {
		const root = temp("uai-hooks-shape-");
		const configRoot = join(root, "profile");
		mkdirSync(configRoot, { recursive: true });
		const settingsPath = join(configRoot, "settings.json");
		const before = `${JSON.stringify({ hooks: ["foreign-shape"], keep: true }, null, 2)}\n`;
		writeFileSync(settingsPath, before);
		const result = await runInstallHooks({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(false);
		expect(readFileSync(settingsPath, "utf8")).toBe(before);
		expect(existsSync(join(configRoot, "hooks"))).toBe(false);
	});

	test("source payload symlinks are rejected before journal serialization", async () => {
		const root = temp("uai-hooks-payload-link-");
		const configRoot = join(root, "profile");
		const skillRoot = join(root, "skill");
		const payload = join(skillRoot, "install", "hooks");
		const external = join(root, "external-secret.txt");
		const sentinel = "FAILED_INSTALL_LIVE_SECRET_SENTINEL";
		mkdirSync(payload, { recursive: true });
		mkdirSync(configRoot, { recursive: true });
		writeFileSync(join(payload, "hooks.json"), `${JSON.stringify({ hooks: {} })}\n`);
		writeFileSync(external, sentinel);
		symlinkSync(external, join(payload, "leak.ts"), "file");
		const result = await runInstallHooks({ configRoot, skillRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(false);
		const journalDirectory = join(configRoot, ".uai-journal");
		const persisted = existsSync(journalDirectory)
			? readdirSync(journalDirectory).map((file) => readFileSync(join(journalDirectory, file), "utf8")).join("\n")
			: "";
		expect(persisted).not.toContain(sentinel);
		expect(existsSync(join(configRoot, "hooks", "leak.ts"))).toBe(false);
	});

	test("hook recovery rejects a linked journal directory before reading its sentinel", async () => {
		const root = temp("uai-hooks-journal-parent-link-");
		const configRoot = join(root, "profile");
		const externalJournal = join(root, "external-journal");
		mkdirSync(configRoot, { recursive: true });
		mkdirSync(externalJournal, { recursive: true });
		writeFileSync(join(externalJournal, "claude-install-hooks-sentinel.json"), "EXTERNAL_JOURNAL_SENTINEL");
		symlinkSync(externalJournal, join(configRoot, ".uai-journal"), process.platform === "win32" ? "junction" : "dir");
		const result = await runInstallHooks({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("physical directory");
		expect(existsSync(join(configRoot, "settings.json"))).toBe(false);
	});

	test("hook recovery rejects multiple matching journals deterministically", async () => {
		const root = temp("uai-hooks-journal-ambiguous-");
		const configRoot = join(root, "profile");
		const journals = join(configRoot, ".uai-journal");
		mkdirSync(journals, { recursive: true });
		writeFileSync(join(journals, "claude-install-hooks-b.json"), "{}");
		writeFileSync(join(journals, "claude-install-hooks-a.json"), "{}");
		const result = await runInstallHooks({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("ambiguous across journals: claude-install-hooks-a.json, claude-install-hooks-b.json");
		expect(existsSync(join(configRoot, "settings.json"))).toBe(false);
	});
});
describe("settings lifecycle transaction", () => {
	test("settings payload links are rejected before reading external bytes", async () => {
		const root = temp("uai-settings-payload-link-");
		const configRoot = join(root, "profile");
		const skillRoot = join(root, "skill");
		const installRoot = join(skillRoot, "install");
		const external = join(root, "external.json");
		mkdirSync(installRoot, { recursive: true });
		writeFileSync(external, "{\"SETTINGS_SECRET_SENTINEL\":true}\n");
		symlinkSync(external, join(installRoot, "settings.system.json"), "file");

		const result = await runInstallSettings({ configRoot, skillRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(false);
		expect(existsSync(join(configRoot, "settings.json"))).toBe(false);
	});

	test("malformed settings remain byte-identical", async () => {
		const root = temp("uai-settings-malformed-");
		const configRoot = join(root, "profile");
		mkdirSync(configRoot, { recursive: true });
		const path = join(configRoot, "settings.json");
		const before = "{ malformed\n";
		writeFileSync(path, before);
		const result = await runInstallSettings({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("merge preserves foreign JSON, mode, and writes an owned backup", async () => {
		const root = temp("uai-settings-foreign-");
		const configRoot = join(root, "profile");
		mkdirSync(configRoot, { recursive: true });
		const path = join(configRoot, "settings.json");
		writeFileSync(path, `${JSON.stringify({ foreign: { keep: true }, env: { FOREIGN: "yes" } }, null, 2)}\n`);
		chmodSync(path, 0o640);
		const beforeMode = statSync(path).mode & 0o777;
		const result = await runInstallSettings({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(true);
		const current = JSON.parse(readFileSync(path, "utf8")) as { foreign: { keep: boolean }; env: { FOREIGN: string } };
		expect(current.foreign.keep).toBe(true);
		expect(current.env.FOREIGN).toBe("yes");
		expect(statSync(path).mode & 0o777).toBe(beforeMode);
		expect(readdirSync(configRoot).some((name) => name.startsWith("settings.json.backup-"))).toBe(true);
	});

	test("settings expansion binds LifeOS roots to the selected config root", async () => {
		const root = temp("uai-settings-selected-root-");
		const skillRoot = join(root, "skill");
		const configRoot = join(root, "codex-selected-config");
		mkdirSync(join(skillRoot, "install"), { recursive: true });
		writeFileSync(join(skillRoot, "install", "settings.system.json"), JSON.stringify({
			env: {
				LIFEOS_CONFIG_DIR: "$HOME/.claude",
				LIFEOS_DIR: "$HOME/.claude/LIFEOS",
				OTHER_HOME_PATH: "$HOME/other",
			},
		}));
		const result = await runInstallSettings({ configRoot, skillRoot, apply: true, allowDev: false });
		expect(result.ok).toBe(true);
		const settings = JSON.parse(readFileSync(join(configRoot, "settings.json"), "utf8")) as { env: Record<string, string> };
		expect(settings.env.LIFEOS_CONFIG_DIR).toBe(configRoot);
		expect(settings.env.LIFEOS_DIR).toBe(join(configRoot, "LIFEOS"));
	});
	test("injected settings failure restores exact prior bytes", async () => {
		const root = temp("uai-settings-rollback-");
		const configRoot = join(root, "profile");
		mkdirSync(configRoot, { recursive: true });
		const path = join(configRoot, "settings.json");
		const before = `${JSON.stringify({ foreign: true }, null, 2)}\n`;
		writeFileSync(path, before);
		process.env.LIFEOS_TEST_FAIL_INSTALL_SETTINGS = "after-settings";
		try {
			const result = await runInstallSettings({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
			expect(result.ok).toBe(false);
		} finally {
			delete process.env.LIFEOS_TEST_FAIL_INSTALL_SETTINGS;
		}
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("settings plan drift preserves third-state bytes", async () => {
		const root = temp("uai-settings-drift-");
		const configRoot = join(root, "profile");
		mkdirSync(configRoot, { recursive: true });
		const path = join(configRoot, "settings.json");
		writeFileSync(path, `${JSON.stringify({ foreign: true }, null, 2)}\n`);
		process.env.LIFEOS_TEST_DRIFT_INSTALL_SETTINGS = "1";
		try {
			const result = await runInstallSettings({ configRoot, skillRoot: lifeosRoot, apply: true, allowDev: false });
			expect(result.ok).toBe(false);
		} finally {
			delete process.env.LIFEOS_TEST_DRIFT_INSTALL_SETTINGS;
		}
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ thirdState: true });
	});
});


describe("runtime dependency merge", () => {
	test("dependency payload manifest links are rejected before parsing", async () => {
		const root = temp("uai-dependency-payload-link-");
		const payloadInstall = join(root, "payload", "install");
		const configRoot = join(root, "profile");
		const external = join(root, "external-package.json");
		mkdirSync(payloadInstall, { recursive: true });
		mkdirSync(configRoot, { recursive: true });
		writeFileSync(external, "{\"dependencies\":{\"EXTERNAL_SECRET_SENTINEL\":\"1.0.0\"}}\n");
		symlinkSync(external, join(payloadInstall, "package.json"), "file");

		const result = await deployDependencies(payloadInstall, configRoot, true);
		expect(result.blockers.join("\n")).toContain("physical regular file");
		expect(existsSync(join(configRoot, "package.json"))).toBe(false);
	});

	test("merges required imports into an existing manifest and resolves them", async () => {
		const root = temp("uai-runtime-deps-");
		const payloadInstall = join(root, "payload", "install");
		const configRoot = join(root, "profile");
		const dependencyRoot = join(configRoot, "node_modules", "uai-fixture-dep");
		mkdirSync(payloadInstall, { recursive: true });
		mkdirSync(configRoot, { recursive: true });
		mkdirSync(dependencyRoot, { recursive: true });
		writeFileSync(join(dependencyRoot, "package.json"), JSON.stringify({ name: "uai-fixture-dep", version: "1.0.0", type: "module", exports: "./index.ts" }));
		writeFileSync(join(dependencyRoot, "index.ts"), "export const fixture = true;\n");
		writeFileSync(join(payloadInstall, "package.json"), JSON.stringify({ dependencies: { "uai-fixture-dep": "1.0.0" } }));
		writeFileSync(join(configRoot, "package.json"), `${JSON.stringify({ name: "foreign-profile", private: true, extensions: { keep: true } }, null, 2)}\n`);
		const result = await deployDependencies(payloadInstall, configRoot, true);
		expect(result.blockers).toEqual([]);
		expect(result.failures).toEqual([]);
		const manifest = JSON.parse(readFileSync(join(configRoot, "package.json"), "utf8")) as { name: string; extensions: { keep: boolean }; dependencies: Record<string, string> };
		expect(manifest.name).toBe("foreign-profile");
		expect(manifest.extensions.keep).toBe(true);
		expect(manifest.dependencies["uai-fixture-dep"]).toBe("1.0.0");
		expect(realpathSync(Bun.resolveSync("uai-fixture-dep", configRoot))).toBe(realpathSync(join(dependencyRoot, "index.ts")));
	});

	test("malformed existing package manifest blocks byte-identically", async () => {
		const root = temp("uai-runtime-deps-malformed-");
		const payloadInstall = join(root, "payload", "install");
		const configRoot = join(root, "profile");
		mkdirSync(payloadInstall, { recursive: true });
		mkdirSync(configRoot, { recursive: true });
		writeFileSync(join(payloadInstall, "package.json"), JSON.stringify({ dependencies: { yaml: "^2.8.2" } }));
		const before = "{ broken package\n";
		writeFileSync(join(configRoot, "package.json"), before);
		const result = await deployDependencies(payloadInstall, configRoot, true);
		expect(result.blockers.length).toBe(1);
		expect(readFileSync(join(configRoot, "package.json"), "utf8")).toBe(before);
	});
	test("unresolved imports block before manifest mutation", async () => {
		const root = temp("uai-runtime-deps-unresolved-");
		const payloadInstall = join(root, "payload", "install");
		const configRoot = join(root, "profile");
		mkdirSync(payloadInstall, { recursive: true });
		mkdirSync(configRoot, { recursive: true });
		const path = join(configRoot, "package.json");
		const before = `${JSON.stringify({ foreign: true }, null, 2)}\n`;
		writeFileSync(path, before);
		writeFileSync(join(payloadInstall, "package.json"), JSON.stringify({ dependencies: { "uai-missing-dep": "1.0.0" } }));
		const result = await deployDependencies(payloadInstall, configRoot, true);
		expect(result.blockers[0]).toContain("refusing non-transactional package-manager mutation");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("incompatible dependency version and missing exports block before mutation", async () => {
		const root = temp("uai-runtime-deps-version-");
		const payloadInstall = join(root, "payload", "install");
		const configRoot = join(root, "profile");
		const dependencyRoot = join(configRoot, "node_modules", "uai-fixture-dep");
		mkdirSync(payloadInstall, { recursive: true });
		mkdirSync(dependencyRoot, { recursive: true });
		writeFileSync(join(dependencyRoot, "package.json"), JSON.stringify({ name: "uai-fixture-dep", version: "0.9.0" }));
		writeFileSync(join(dependencyRoot, "index.ts"), "export const fixture = true;\n");
		writeFileSync(join(payloadInstall, "package.json"), JSON.stringify({ dependencies: { "uai-fixture-dep": "^0.2.0" } }));
		const manifestPath = join(configRoot, "package.json");
		const before = `${JSON.stringify({ dependencies: { "uai-fixture-dep": "^0.9.0" } }, null, 2)}\n`;
		writeFileSync(manifestPath, before);
		const result = await deployDependencies(payloadInstall, configRoot, true);
		expect(result.blockers.join("\n")).toContain("incompatible");
		expect(readFileSync(manifestPath, "utf8")).toBe(before);
	});

	test("injected dependency failure restores the prior manifest exactly", async () => {
		const root = temp("uai-runtime-deps-rollback-");
		const payloadInstall = join(root, "payload", "install");
		const configRoot = join(root, "profile");
		const dependencyRoot = join(configRoot, "node_modules", "uai-fixture-dep");
		mkdirSync(payloadInstall, { recursive: true });
		mkdirSync(dependencyRoot, { recursive: true });
		writeFileSync(join(dependencyRoot, "package.json"), JSON.stringify({ name: "uai-fixture-dep", version: "1.0.0", exports: "./index.ts" }));
		writeFileSync(join(dependencyRoot, "index.ts"), "export const fixture = true;\n");
		writeFileSync(join(payloadInstall, "package.json"), JSON.stringify({ dependencies: { "uai-fixture-dep": "1.0.0" } }));
		const path = join(configRoot, "package.json");
		const before = `${JSON.stringify({ foreign: true }, null, 2)}\n`;
		writeFileSync(path, before);
		process.env.LIFEOS_TEST_FAIL_DEPLOY_DEPENDENCIES = "after-manifest";
		try {
			const result = await deployDependencies(payloadInstall, configRoot, true);
			expect(result.failures.length).toBe(1);
		} finally {
			delete process.env.LIFEOS_TEST_FAIL_DEPLOY_DEPENDENCIES;
		}
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("dependency plan drift preserves third-state manifest bytes", async () => {
		const root = temp("uai-runtime-deps-drift-");
		const payloadInstall = join(root, "payload", "install");
		const configRoot = join(root, "profile");
		const dependencyRoot = join(configRoot, "node_modules", "uai-fixture-dep");
		mkdirSync(payloadInstall, { recursive: true });
		mkdirSync(dependencyRoot, { recursive: true });
		writeFileSync(join(dependencyRoot, "package.json"), JSON.stringify({ name: "uai-fixture-dep", version: "1.0.0", exports: "./index.ts" }));
		writeFileSync(join(dependencyRoot, "index.ts"), "export const fixture = true;\n");
		writeFileSync(join(payloadInstall, "package.json"), JSON.stringify({ dependencies: { "uai-fixture-dep": "1.0.0" } }));
		const path = join(configRoot, "package.json");
		writeFileSync(path, `${JSON.stringify({ foreign: true }, null, 2)}\n`);
		process.env.LIFEOS_TEST_DRIFT_DEPLOY_DEPENDENCIES = "1";
		try {
			const result = await deployDependencies(payloadInstall, configRoot, true);
			expect(result.failures.length).toBe(1);
		} finally {
			delete process.env.LIFEOS_TEST_DRIFT_DEPLOY_DEPENDENCIES;
		}
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ thirdState: true });
	});
});
describe("core deployment lifecycle transaction", () => {
	function fixture(prefix: string): { root: string; payloadInstall: string; configRoot: string } {
		const root = temp(prefix);
		const payloadInstall = join(root, "payload", "install");
		const configRoot = join(root, "profile");
		const dependencyRoot = join(configRoot, "node_modules", "uai-fixture-dep");
		mkdirSync(join(payloadInstall, "skills", "Fixture"), { recursive: true });
		mkdirSync(join(payloadInstall, "LIFEOS", "TOOLS"), { recursive: true });
		mkdirSync(dependencyRoot, { recursive: true });
		writeFileSync(join(payloadInstall, "skills", "Fixture", "SKILL.md"), "fixture\n");
		writeFileSync(join(payloadInstall, "LIFEOS", "TOOLS", "Fixture.ts"), "export const fixture = true;\n");
		writeFileSync(join(payloadInstall, "package.json"), JSON.stringify({ dependencies: { "uai-fixture-dep": "1.0.0" } }));
		writeFileSync(join(dependencyRoot, "package.json"), JSON.stringify({ name: "uai-fixture-dep", version: "1.0.0", exports: "./index.ts" }));
		writeFileSync(join(dependencyRoot, "index.ts"), "export const fixture = true;\n");
		writeFileSync(join(configRoot, "foreign.txt"), "sentinel\n");
		return { root, payloadInstall, configRoot };
	}

	test("fresh DeployCore applies a complete dependency-free payload from an empty profile", async () => {
		const root = temp("uai-core-fresh-");
		const payloadInstall = join(root, "payload", "install");
		const configRoot = join(root, "empty-profile");
		mkdirSync(join(payloadInstall, "skills", "Fixture"), { recursive: true });
		mkdirSync(join(payloadInstall, "LIFEOS", "TOOLS"), { recursive: true });
		writeFileSync(join(payloadInstall, "skills", "Fixture", "SKILL.md"), "fixture\n");
		writeFileSync(join(payloadInstall, "LIFEOS", "TOOLS", "Fixture.ts"), "export const fixture = true;\n");
		cpSync(join(lifeosRoot, "install", "package.json"), join(payloadInstall, "package.json"));

		const results = await deployCoreTransactional(payloadInstall, configRoot);

		expect(results.flatMap((result) => result.blockers)).toEqual([]);
		expect(results.flatMap((result) => result.failures)).toEqual([]);
		expect(existsSync(join(configRoot, "node_modules"))).toBe(false);
		const manifest = JSON.parse(readFileSync(join(configRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
		expect(manifest.dependencies).toEqual({});
		expect(readFileSync(join(configRoot, "skills", "Fixture", "SKILL.md"), "utf8")).toBe("fixture\n");
		expect(readFileSync(join(configRoot, "LIFEOS", "TOOLS", "Fixture.ts"), "utf8")).toContain("fixture = true");
	}, 30_000);

	test("core payload symlinks are rejected before lifecycle serialization", async () => {
		const { root, payloadInstall, configRoot } = fixture("uai-core-payload-link-");
		const secret = "CORE_PAYLOAD_SECRET_SENTINEL";
		const external = join(root, "external.ts");
		writeFileSync(external, secret);
		symlinkSync(external, join(payloadInstall, "skills", "Fixture", "leak.ts"), "file");

		const results = await deployCoreTransactional(payloadInstall, configRoot);
		expect(results.flatMap((result) => result.failures).join("\n")).toContain("payload links are not allowed");
		expect(existsSync(join(configRoot, "skills", "Fixture", "leak.ts"))).toBe(false);
		const journalDir = join(configRoot, ".uai-journal");
		const journalBytes = existsSync(journalDir)
			? readdirSync(journalDir).map((name) => readFileSync(join(journalDir, name), "utf8")).join("\n")
			: "";
		expect(journalBytes).not.toContain(secret);
	});

	test("applies core payload and package manifest through one lifecycle plan", async () => {
		const { payloadInstall, configRoot } = fixture("uai-core-lifecycle-");
		const results = await deployCoreTransactional(payloadInstall, configRoot);
		expect(results.flatMap((result) => result.blockers)).toEqual([]);
		expect(results.flatMap((result) => result.failures)).toEqual([]);
		expect(readFileSync(join(configRoot, "skills", "Fixture", "SKILL.md"), "utf8")).toBe("fixture\n");
		expect(readFileSync(join(configRoot, "LIFEOS", "TOOLS", "Fixture.ts"), "utf8")).toContain("fixture = true");
		expect(readFileSync(join(configRoot, "foreign.txt"), "utf8")).toBe("sentinel\n");
		expect(JSON.parse(readFileSync(join(configRoot, "package.json"), "utf8")).dependencies["uai-fixture-dep"]).toBe("1.0.0");
	});

	test("core update applies changed owned payload and uninstall preserves the original baseline", async () => {
		const { payloadInstall, configRoot } = fixture("uai-core-update-");
		const target = join(configRoot, "LIFEOS", "TOOLS", "Fixture.ts");
		expect((await deployCoreTransactional(payloadInstall, configRoot)).flatMap((result) => result.failures)).toEqual([]);
		writeFileSync(join(payloadInstall, "LIFEOS", "TOOLS", "Fixture.ts"), "export const fixture = 'v2';\n");

		const updated = await deployCoreTransactional(payloadInstall, configRoot);
		expect(updated.flatMap((result) => result.failures)).toEqual([]);
		expect(readFileSync(target, "utf8")).toContain("'v2'");

		const manifestPath = join(configRoot, ".uai-ownership", "claude-deploy-core.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as OwnershipManifest;
		expect((await uninstallOwned(manifest)).status).toBe("uninstalled");
		expect(existsSync(target)).toBe(false);
	});

	test("core update refuses drifted owned payload without overwriting it", async () => {
		const { payloadInstall, configRoot } = fixture("uai-core-update-drift-");
		const source = join(payloadInstall, "LIFEOS", "TOOLS", "Fixture.ts");
		const target = join(configRoot, "LIFEOS", "TOOLS", "Fixture.ts");
		expect((await deployCoreTransactional(payloadInstall, configRoot)).flatMap((result) => result.failures)).toEqual([]);
		writeFileSync(target, "user edit\n");
		writeFileSync(source, "export const fixture = 'v2';\n");

		const updated = await deployCoreTransactional(payloadInstall, configRoot);
		expect(updated.flatMap((result) => result.failures).join("\n")).toContain("changed after install");
		expect(readFileSync(target, "utf8")).toBe("user edit\n");
	});

	test("injected core failure rolls back every planned target mutation", async () => {
		const { payloadInstall, configRoot } = fixture("uai-core-rollback-");
		process.env.LIFEOS_TEST_FAIL_DEPLOY_CORE = "after-runtime";
		try {
			const results = await deployCoreTransactional(payloadInstall, configRoot);
			expect(results.flatMap((result) => result.failures).length).toBeGreaterThan(0);
		} finally {
			delete process.env.LIFEOS_TEST_FAIL_DEPLOY_CORE;
		}
		expect(existsSync(join(configRoot, "skills", "Fixture", "SKILL.md"))).toBe(false);
		expect(existsSync(join(configRoot, "LIFEOS", "TOOLS", "Fixture.ts"))).toBe(false);
		expect(existsSync(join(configRoot, "package.json"))).toBe(false);
		expect(readFileSync(join(configRoot, "foreign.txt"), "utf8")).toBe("sentinel\n");
	});

	test("core plan drift preserves the third-state target", async () => {
		const { payloadInstall, configRoot } = fixture("uai-core-drift-");
		process.env.LIFEOS_TEST_DRIFT_DEPLOY_CORE = "1";
		try {
			const results = await deployCoreTransactional(payloadInstall, configRoot);
			expect(results.flatMap((result) => result.failures).length).toBeGreaterThan(0);
		} finally {
			delete process.env.LIFEOS_TEST_DRIFT_DEPLOY_CORE;
		}
		expect(readFileSync(join(configRoot, "skills", "Fixture", "SKILL.md"), "utf8")).toBe("third-state\n");
		expect(existsSync(join(configRoot, "package.json"))).toBe(false);
	});
});


describe("payload copy containment", () => {
	test("generic installer copying rejects nested source links", () => {
		const root = temp("uai-copy-payload-link-");
		const source = join(root, "source");
		const target = join(root, "target");
		const external = join(root, "external.txt");
		mkdirSync(source);
		writeFileSync(external, "COPY_SECRET_SENTINEL");
		symlinkSync(external, join(source, "leak.txt"), "file");


		const result = copyMissing(source, target);
		expect(result.failures.join("\n")).toContain("payload link");
		expect(existsSync(join(target, "leak.txt"))).toBe(false);
	});
});

describe("native Windows and session isolation primitives", () => {
	test("HOME-unset fixture resolves USERPROFILE and PATHEXT command", () => {
		const home = temp("uai-win-home-");
		const bin = join(home, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "omp.cmd"), "@echo off\r\necho fake\r\n");
		expect(resolveHomeDir({ USERPROFILE: home }, "C:\\fallback")).toBe(home);
		expect(findExecutable("omp", { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32")).toBe(join(bin, "omp.cmd"));
	});

	test("explicit UAI config root keeps detected Codex and OMP harness coordinates coherent", () => {
		const root = temp("uai-detect-selected-harness-");
		const selectedRoot = join(root, "selected-config");
		for (const [harness, adapterEnv] of [
			["codex", { CODEX_HOME: join(root, "detected-codex") }],
			["omp", { PI_CODING_AGENT_DIR: join(root, "detected-omp") }],
		] as const) {
			mkdirSync(Object.values(adapterEnv)[0], { recursive: true });
			const detected = detectEnv(fixtureEnv(root, {
				UAI_HARNESS: harness,
				UAI_CONFIG_DIR: selectedRoot,
				PAI_CONFIG_DIR: undefined,
				...adapterEnv,
			}));
			expect(detected.harness.name).toBe(harness);
			expect(detected.configRoot).toBe(selectedRoot);
			expect(detected.harness.configRoot).toBe(selectedRoot);
			expect(detected.harness.skillsDir).toBe(join(selectedRoot, "skills"));
		}
	});

	test("identity hook imports with HOME unset and selected custom roots", async () => {
		const root = temp("uai-identity-home-");
		const configRoot = join(root, "config");
		const dataRoot = join(root, "data");
		mkdirSync(join(dataRoot, "USER"), { recursive: true });
		mkdirSync(configRoot, { recursive: true });
		writeFileSync(join(configRoot, "settings.json"), "{}\n");
		const identity = join(sourceHooks, "lib", "identity.ts");
		const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(pathToFileURL(identity).href)}); console.log(\"loaded\")`], {
			env: fixtureEnv(root, {
				HOME: undefined,
				USERPROFILE: root,
				UAI_DATA_DIR: dataRoot,
				PAI_DATA_DIR: undefined,
				UAI_CONFIG_DIR: undefined,
				PAI_CONFIG_DIR: undefined,
				CLAUDE_CONFIG_DIR: configRoot,
				LIFEOS_DIR: join(configRoot, "LIFEOS"),
			}),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([

			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain("loaded");
	});

	test("two native sessions receive distinct stable root-bound identities", () => {
		const root = temp("uai-session-ids-");
		const managerA = { getSessionFile: () => join(root, "profile-a", "sessions", "a.jsonl") };
		const managerB = { getSessionFile: () => join(root, "profile-b", "sessions", "b.jsonl") };
		const a1 = getOmpSessionIdentity({ sessionManager: managerA, cwd: join(root, "work") }, join(root, "profile-a"));
		const a2 = getOmpSessionIdentity({ sessionManager: managerA, cwd: join(root, "work") }, join(root, "profile-a"));
		const b = getOmpSessionIdentity({ sessionManager: managerB, cwd: join(root, "work") }, join(root, "profile-b"));
		expect(a1.uaiSessionId).toBe(a2.uaiSessionId);
		expect(a1.uaiSessionId).not.toBe(b.uaiSessionId);
		expect(a1.nativeSessionId).toBe("a");
		expect(b.nativeSessionId).toBe("b");
	});
});

	test("generic adapter fallback is stable and never uses a shared literal", () => {
		const profile = temp("uai-framework-profile-");
		const previous = process.env.UAI_PROFILE_ROOT;
		process.env.UAI_PROFILE_ROOT = profile;
		try {
			const first = frameworkSessionIdentity({ session: { id: "native-a" }, transcript_path: join(profile, "a.jsonl") }, "codex");
			const repeat = frameworkSessionIdentity({ session: { id: "native-a" }, transcript_path: join(profile, "a.jsonl") }, "codex");
			const second = frameworkSessionIdentity({ session: { id: "native-b" }, transcript_path: join(profile, "b.jsonl") }, "codex");
			expect(first.uaiSessionId).toBe(repeat.uaiSessionId);
			expect(first.uaiSessionId).not.toBe(second.uaiSessionId);
			expect(first.uaiSessionId).not.toContain("pai-framework-session");
			expect(first.nativeSessionId).toBe("native-a");
		} finally {
			if (previous === undefined) delete process.env.UAI_PROFILE_ROOT;
			else process.env.UAI_PROFILE_ROOT = previous;
		}
	});
describe("memory review transcript provenance", () => {
	test("the stopping transcript is passed explicitly to the reviewer", () => {
		const transcript = join(temp("uai-transcript-"), "stopping-session.jsonl");
		expect(reviewerArgs(8, transcript)).toContain(transcript);
		expect(reviewerArgs(8, transcript).slice(-2)).toEqual(["--input", transcript]);
	});

	test("fresh leases are never stolen from an owner whose liveness probe is unavailable", () => {
		const now = Date.parse("2026-07-17T12:00:00.000Z");
		expect(reviewLockIsStale(
			{ pid: 999999, createdAt: "2026-07-17T11:59:59.000Z" },
			now,
			Date.parse("2026-07-17T11:59:59.000Z"),
		)).toBe(false);
		expect(reviewLockIsStale(
			{ pid: 999999, createdAt: "2026-07-17T11:50:00.000Z" },
			now,
			Date.parse("2026-07-17T11:50:00.000Z"),
		)).toBe(true);
	});

	test("concurrent sessions retain separate cadence state", async () => {
		const root = temp("uai-review-state-");
		const lifeosDir = join(root, "LIFEOS");
		const dataRoot = join(root, "data");
		mkdirSync(join(dataRoot, "USER", "CONFIG"), { recursive: true });
		writeFileSync(join(dataRoot, "USER", "CONFIG", "memory-review.json"), JSON.stringify({ turn_threshold: 50, min_minutes_between: 0 }));
		const hook = join(sourceHooks, "MemoryReviewFire.hook.ts");
		const run = async (sessionId: string, transcript: string): Promise<void> => {
			const child = Bun.spawn([process.execPath, hook], {
				env: fixtureEnv(root, { LIFEOS_DIR: lifeosDir, UAI_DATA_DIR: dataRoot, PAI_DATA_DIR: dataRoot }),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			child.stdin.write(JSON.stringify({ session_id: sessionId, uai_session_id: sessionId, transcript_path: transcript }));
			child.stdin.end();
			const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			expect(exitCode, stderr).toBe(0);
		};
		await Promise.all([
			run("uai-omp-session-a", join(root, "a.jsonl")),

			run("uai-omp-session-b", join(root, "b.jsonl")),
		]);
		const state = JSON.parse(readFileSync(join(lifeosDir, "MEMORY", "OBSERVABILITY", "review-state.json"), "utf8")) as { sessions: Record<string, unknown> };
		expect(Object.keys(state.sessions).sort()).toEqual(["uai-omp-session-a", "uai-omp-session-b"]);
	});
	test("failed reviewer completion retains pending cadence and exits visibly", async () => {
		const root = temp("uai-review-failure-");
		const lifeosDir = join(root, "LIFEOS");
		const dataRoot = join(root, "data");
		mkdirSync(join(dataRoot, "USER", "CONFIG"), { recursive: true });
		writeFileSync(join(dataRoot, "USER", "CONFIG", "memory-review.json"), JSON.stringify({ turn_threshold: 1, min_minutes_between: 0 }));
		const hook = join(sourceHooks, "MemoryReviewFire.hook.ts");
		const child = Bun.spawn([process.execPath, hook], {
			env: fixtureEnv(root, { LIFEOS_DIR: lifeosDir, UAI_DATA_DIR: dataRoot, PAI_DATA_DIR: dataRoot }),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		child.stdin.write(JSON.stringify({ session_id: "failed-session", transcript_path: join(root, "missing.jsonl") }));
		child.stdin.end();
		expect(await child.exited).not.toBe(0);
		const state = JSON.parse(readFileSync(join(lifeosDir, "MEMORY", "OBSERVABILITY", "review-state.json"), "utf8")) as { sessions: Record<string, { pending_review: boolean; turn_count_since_last_review: number; last_review_at: string | null }> };
		expect(state.sessions["failed-session"]).toMatchObject({
			pending_review: true,
			turn_count_since_last_review: 1,
			last_review_at: null,
		});
	});

	test("review execution releases cadence lock and preserves turns arriving in flight", async () => {
		const root = temp("uai-review-inflight-");
		const lifeosDir = join(root, "LIFEOS");
		const dataRoot = join(root, "data");
		const statePath = join(lifeosDir, "MEMORY", "OBSERVABILITY", "review-state.json");
		mkdirSync(join(dataRoot, "USER", "CONFIG"), { recursive: true });
		mkdirSync(join(lifeosDir, "TOOLS"), { recursive: true });
		writeFileSync(join(dataRoot, "USER", "CONFIG", "memory-review.json"), JSON.stringify({ turn_threshold: 1, min_minutes_between: 0 }));
		writeFileSync(join(lifeosDir, "TOOLS", "MemoryReviewer.ts"), "await Bun.sleep(1200); process.exit(0);\n");
		const hook = join(sourceHooks, "MemoryReviewFire.hook.ts");
		const env = fixtureEnv(root, { LIFEOS_DIR: lifeosDir, UAI_DATA_DIR: dataRoot, PAI_DATA_DIR: dataRoot });
		const start = (sessionId: string) => {
			const child = Bun.spawn([process.execPath, hook], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
			child.stdin.write(JSON.stringify({ session_id: sessionId, uai_session_id: sessionId }));
			child.stdin.end();
			return child;
		};
		const first = start("inflight-session");
		let pendingObserved = false;
		// This cross-process integration must observe the durable state file; fake timers
		// cannot advance a separately spawned Bun process.
		for (let attempt = 0; attempt < 100; attempt++) {
			if (existsSync(statePath)) {
				const state = JSON.parse(readFileSync(statePath, "utf8")) as { sessions?: Record<string, { pending_review?: boolean; review_attempt?: unknown }> };
				if (state.sessions?.["inflight-session"]?.pending_review && state.sessions["inflight-session"].review_attempt) {
					pendingObserved = true;
					break;
				}
			}
			await Bun.sleep(20);
		}
		expect(pendingObserved).toBe(true);
		const secondStarted = Date.now();
		const second = start("inflight-session");
		expect(await second.exited).toBe(0);
		expect(Date.now() - secondStarted).toBeLessThan(500);
		expect(await first.exited).toBe(0);
		const finalState = JSON.parse(readFileSync(statePath, "utf8")) as { sessions: Record<string, { pending_review: boolean; turn_count_since_last_review: number; last_review_at: string | null; review_attempt?: unknown }> };
		expect(finalState.sessions["inflight-session"]).toMatchObject({
			pending_review: true,
			turn_count_since_last_review: 1,
		});
		expect(finalState.sessions["inflight-session"].review_attempt).toBeUndefined();
		expect(finalState.sessions["inflight-session"].last_review_at).not.toBeNull();
	}, 10_000);
	test("demonstrably stale cadence locks recover", async () => {
		const root = temp("uai-review-lock-");
		const lifeosDir = join(root, "LIFEOS");
		const dataRoot = join(root, "data");
		const observationDir = join(lifeosDir, "MEMORY", "OBSERVABILITY");
		mkdirSync(join(dataRoot, "USER", "CONFIG"), { recursive: true });
		mkdirSync(observationDir, { recursive: true });
		writeFileSync(join(dataRoot, "USER", "CONFIG", "memory-review.json"), JSON.stringify({ turn_threshold: 50, min_minutes_between: 0 }));
		const lockPath = join(observationDir, "review-state.json.lock");
		writeFileSync(lockPath, JSON.stringify({ owner: "dead-owner", pid: 999999, createdAt: "2000-01-01T00:00:00.000Z" }));
		const hook = join(sourceHooks, "MemoryReviewFire.hook.ts");
		const child = Bun.spawn([process.execPath, hook], {
			env: fixtureEnv(root, { LIFEOS_DIR: lifeosDir, UAI_DATA_DIR: dataRoot, PAI_DATA_DIR: dataRoot }),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		child.stdin.write(JSON.stringify({ session_id: "stale-lock-session" }));
		child.stdin.end();
		expect(await child.exited).toBe(0);
		expect(existsSync(lockPath)).toBe(false);
	});

});
	test("reviewer prompt and Telegram rendering use canonical data-root proposal targets", async () => {
		const root = temp("uai-review-target-render-");
		const dataRoot = join(root, "data");
		const lifeosDir = join(root, "runtime");
		const reviewerPath = join(sourceLifeos, "TOOLS", "MemoryReviewer.ts");
		const telegramPath = join(sourceLifeos, "PULSE", "lib", "telegram-proposals.ts");
		const probe = [
			`const reviewer = await import(${JSON.stringify(pathToFileURL(reviewerPath).href)});`,
			`const telegram = await import(${JSON.stringify(pathToFileURL(telegramPath).href)});`,
			"const targets = reviewer.reviewerProposalTargets();",
			"const identity = targets.identity[0];",
			"const message = telegram.formatProposalMessage({ id: 'p1', ts: new Date().toISOString(), status: 'pending', target_kind: 'identity', target_file: identity, edit: 'x', confidence: 0.5, rationale: 'r' });",
			"console.log(JSON.stringify({ targets, message }));",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", probe], {
			env: fixtureEnv(root, { HOME: undefined, USERPROFILE: root, UAI_DATA_DIR: dataRoot, PAI_DATA_DIR: dataRoot, LIFEOS_DIR: lifeosDir }),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout) as { targets: Record<string, string[]>; message: string };
		expect(result.targets.identity[0]).toStartWith(join(dataRoot, "USER"));
		expect(JSON.stringify(result.targets)).not.toContain(join(lifeosDir, "USER"));
		expect(result.message).toContain("PRINCIPAL");
	});

	test("only clean canonical transcript evidence is trusted for auto-apply", async () => {
		const reviewer = await import("../TOOLS/MemoryReviewer");
		const root = temp("uai-review-provenance-");
		const cleanPath = join(root, "clean.jsonl");
		writeFileSync(cleanPath, [
			JSON.stringify({ timestamp: "2026-07-17T00:00:00Z", message: { role: "user", content: "remember this" } }),
			JSON.stringify({ timestamp: "2026-07-17T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "understood" }] } }),
		].join("\n"));
		const clean = reviewer.extractRecentExchanges(cleanPath, 5);
		expect(reviewer.reviewerProvenance(clean)).toBe("tainted");
		writeFileSync(cleanPath, `${readFileSync(cleanPath, "utf8")}\n{malformed`);
		const malformed = reviewer.extractRecentExchanges(cleanPath, 5);
		expect(reviewer.reviewerProvenance(malformed)).toBe("tainted");
		expect(reviewer.reviewerProvenance({ length: 0, malformedCount: 0, tainted: false })).toBe("unknown");
	});
describe("reviewer proposal security", () => {
	test("arbitrary and linked proposal targets are rejected before queue or apply", async () => {
		const root = temp("uai-proposal-root-");
		const configRoot = join(root, "config");
		const dataRoot = join(root, "data");
		const outside = join(root, "outside");
		mkdirSync(join(dataRoot, "USER"), { recursive: true });
		mkdirSync(outside, { recursive: true });
		const memorySystem = join(sourceLifeos, "TOOLS", "MemorySystem.ts");
		const env = fixtureEnv(root, {
			HOME: undefined,
			USERPROFILE: root,
			UAI_DATA_DIR: dataRoot,
			PAI_DATA_DIR: undefined,
			UAI_CONFIG_DIR: undefined,
			PAI_CONFIG_DIR: undefined,
			CLAUDE_CONFIG_DIR: configRoot,
			LIFEOS_DIR: join(configRoot, "LIFEOS"),
		});
		const run = async (target: string) => {
			const item = { type: "proposal", target_kind: "identity", target_file: target, edit: "SECRET_SENTINEL", confidence: 1, rationale: "tainted model output" };
			// The subprocess intentionally tests a runtime-selected installed module under isolated roots.
			const source = `const { add } = await import(${JSON.stringify(pathToFileURL(memorySystem).href)}); console.log(JSON.stringify(add(${JSON.stringify(item)})));`;
			const child = Bun.spawn([process.execPath, "-e", source], { env, stdout: "pipe", stderr: "pipe" });
			const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
			expect(exitCode, stderr).toBe(0);
			return JSON.parse(stdout) as { ok: boolean; message?: string };
		};

		const arbitrary = join(outside, "owned.md");
		expect((await run(arbitrary)).ok).toBe(false);
		expect(existsSync(arbitrary)).toBe(false);

		const linkedParent = join(dataRoot, "USER", "PRINCIPAL");
		symlinkSync(outside, linkedParent, process.platform === "win32" ? "junction" : "dir");
		const allowedThroughLink = join(linkedParent, "PRINCIPAL_IDENTITY.md");
		expect((await run(allowedThroughLink)).ok).toBe(false);
		expect(existsSync(join(outside, "PRINCIPAL_IDENTITY.md"))).toBe(false);
		expect(existsSync(join(configRoot, "LIFEOS", "MEMORY", "OBSERVABILITY", "pending-proposals.jsonl"))).toBe(false);
	});
});
describe("Pulse availability recovery", () => {
	test("negative availability expires instead of caching forever", async () => {
		const originalFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			if (calls === 1) throw new Error("transient Pulse outage");
			return new Response("", { status: 200 });
		}) as typeof fetch;
		try {
			expect(await pulseAvailable(1_000)).toBe(false);
			expect(await pulseAvailable(1_500)).toBe(false);
			expect(calls).toBe(1);
			expect(await pulseAvailable(3_001)).toBe(true);
			expect(calls).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
			resetPulseAvailabilityForTests();
		}
	});
});
describe("canonical Pulse memory roots", () => {
	test("memory API reads runtime evidence and USER memory from their selected roots", async () => {
		const root = temp("uai-pulse-memory-roots-");
		const dataRoot = join(root, "data");
		const lifeosDir = join(root, "runtime");
		const observationDir = join(lifeosDir, "MEMORY", "OBSERVABILITY");
		const principalPath = join(dataRoot, "USER", "PRINCIPAL", "PRINCIPAL_MEMORY.md");
		mkdirSync(observationDir, { recursive: true });
		mkdirSync(dirname(principalPath), { recursive: true });
		writeFileSync(join(observationDir, "review-state.json"), JSON.stringify({ turn_count_since_last_review: 7, pending_review: true }));
		writeFileSync(join(observationDir, "pending-proposals.jsonl"), `${JSON.stringify({ id: "p1", ts: new Date().toISOString(), status: "pending" })}\n`);
		writeFileSync(principalPath, "<!-- BEGIN ENTRIES -->\nPREFERENCE: custom root\n<!-- END ENTRIES -->\n");
		const memoryModule = join(sourceLifeos, "PULSE", "modules", "memory.ts");
		const menubarModule = join(sourceLifeos, "PULSE", "modules", "menubar.ts");
		const probe = [
			`const memory = await import(${JSON.stringify(pathToFileURL(memoryModule).href)});`,
			`const menubar = await import(${JSON.stringify(pathToFileURL(menubarModule).href)});`,
			"const memoryResponse = await memory.handleRequest(new Request('http://localhost/api/memory'), '/api/memory');",
			"const menubarResponse = await menubar.handleRequest(new Request('http://localhost/api/menubar'), '/api/menubar');",
			"console.log(JSON.stringify({ memory: await memoryResponse.json(), menubar: await menubarResponse.json() }));",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", probe], {
			env: fixtureEnv(join(root, "wrong-home"), { UAI_DATA_DIR: dataRoot, PAI_DATA_DIR: dataRoot, LIFEOS_DIR: lifeosDir }),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
		const snapshot = JSON.parse(stdout) as {
			memory: { reviewState: { turn_count_since_last_review: number }; principalMemory: { entries: string[] } };
			menubar: { counts: { memoryPending: number } };
		};
		expect(snapshot.memory.reviewState.turn_count_since_last_review).toBe(7);
		expect(snapshot.memory.principalMemory.entries).toEqual(["PREFERENCE: custom root"]);
		expect(snapshot.menubar.counts.memoryPending).toBe(1);
	});
});

describe("installer root and platform separation", () => {
	test("LIFEOS_CONFIG_DIR never becomes the canonical data root", async () => {
		const platform = await import("../UNIVERSAL/platform");
		const root = temp("uai-data-root-separation-");
		expect(platform.resolveDataRoot({ HOME: root, USERPROFILE: root, LIFEOS_CONFIG_DIR: join(root, "config") })).toBe(join(root, ".pai"));
		expect(resolveInstallRoots({ HOME: root, USERPROFILE: root, LIFEOS_CONFIG_DIR: join(root, "config") }, "claude-code", root).dataRoot).toBe(join(root, ".pai"));
	});

	test("unsupported launchd deployment refuses before staging runtime TOOLS", async () => {
		if (process.platform === "darwin") return;
		const root = temp("uai-launchd-platform-");
		const configRoot = join(root, "profile");
		const deploy = join(lifeosRoot, "Tools", "DeployComponents.ts");
		const child = Bun.spawn([process.execPath, deploy, "--components", "pulse", "--config-root", configRoot, "--skill-root", lifeosRoot, "--apply"], {
			env: fixtureEnv(root),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
		expect(exitCode).not.toBe(0);
		expect(stdout).toContain("launchd services are unsupported");
		expect(existsSync(join(configRoot, "LIFEOS", "TOOLS"))).toBe(false);
	});
});


describe("service platform gates", () => {
describe("setup tool HOME fallback", () => {
	test("USERPROFILE-only dry runs resolve native Windows roots", async () => {
		const home = temp("uai-setup-userprofile-");

		const configRoot = join(home, ".claude");
		mkdirSync(join(configRoot, "LIFEOS", "TOOLS"), { recursive: true });
		writeFileSync(join(configRoot, "CLAUDE.md"), "# fixture\n");
		writeFileSync(join(configRoot, "LIFEOS", "TOOLS", "GenerateTelosSummary.ts"), "export {};\n");
		const env = fixtureEnv(home, {
			HOME: undefined,
			USERPROFILE: home,
			UAI_DATA_DIR: undefined,
			PAI_DATA_DIR: undefined,
			UAI_CONFIG_DIR: undefined,
			PAI_CONFIG_DIR: undefined,
		});
		delete env.CLAUDE_CONFIG_DIR;
		delete env.LIFEOS_CONFIG_DIR;
		for (const tool of ["ActivateImports", "LinkUser", "SeedPulse"]) {
			const child = Bun.spawn([process.execPath, join(lifeosRoot, "Tools", `${tool}.ts`)], {
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, `${tool}: ${stderr}`).toBe(0);
			if (tool !== "ActivateImports") {
				const normalizedOutput = stdout.replaceAll("\\", "/").replace(/\/+/g, "/");
				expect(normalizedOutput).toContain(home.replaceAll("\\", "/"));
			}
			expect(stdout).not.toContain('"~');
		}
	});
	test("SeedPulse rejects a linked TOOLS root before executing a generator", async () => {
		const root = temp("uai-seed-pulse-tools-link-");
		const configRoot = join(root, "profile");
		const externalTools = join(root, "external-tools");
		const marker = join(root, "generator-executed");
		mkdirSync(join(configRoot, "LIFEOS"), { recursive: true });
		mkdirSync(externalTools, { recursive: true });
		writeFileSync(join(externalTools, "GenerateTelosSummary.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
		writeFileSync(join(externalTools, "UpdateLifeosState.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed");\n`);
		symlinkSync(externalTools, join(configRoot, "LIFEOS", "TOOLS"), process.platform === "win32" ? "junction" : "dir");
		const child = Bun.spawn([process.execPath, join(lifeosRoot, "Tools", "SeedPulse.ts"), "--config-root", configRoot, "--config-dir", join(root, "data"), "--apply", "--allow-dev"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await child.exited).not.toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	test("service uninstall aggregation preserves every nonzero and timeout", () => {
		const outcomes = [
			{ code: 0, out: "", timedOut: false },
			{ code: 7, out: "failed", timedOut: false },
			{ code: 124, out: "timed out", timedOut: true },
		];
		const results = runServiceUninstallCommands(
			[{ label: "one", uninstall: "one" }, { label: "two", uninstall: "two" }, { label: "three", uninstall: "three" }],
			() => outcomes.shift()!,
		);
		expect(results).toHaveLength(3);
		expect(serviceCommandExitCode(results)).toBe(1);
	});

	test("service uninstall quotes hostile plist paths and only deletes after bootout", () => {
		const plist = "/tmp/$$(touch SHOULD_NOT_RUN)-`touch SHOULD_NOT_RUN`.plist".replace("$$", "$");
		const uninstall = `launchctl bootout gui/42/com.lifeos.fixture && rm -f ${shellQuote(plist)}`;
		let command = "";
		const results = runServiceUninstallCommands([{ label: "fixture", uninstall }], (value) => {
			command = value;
			return { code: 1, out: "bootout failed", timedOut: false };
		});
		expect(command).toBe(`launchctl bootout gui/42/com.lifeos.fixture && rm -f '${plist}'`);
		expect(command).toContain("&& rm -f");
		expect(serviceCommandExitCode(results)).toBe(1);
	});

	test("POSIX service quoting preserves shell metacharacters as literal path bytes", () => {
		expect(shellQuote("/tmp/$$(touch pwned)-`touch pwned`-'quote'".replace("$$", "$"))).toBe("'/tmp/$(touch pwned)-`touch pwned`-'\"'\"'quote'\"'\"''");
	});
});

	test("custom config roots drive LifeOS service paths", () => {
		const root = temp("uai-services-root-");
		const roots = resolveServiceRoots({ USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, "custom") }, "ignored");
		expect(roots.configRoot).toBe(join(root, "custom"));
		expect(roots.lifeosDir).toBe(join(root, "custom", "LIFEOS"));
		expect(roots.launchAgentsDir).toBe(join(root, "Library", "LaunchAgents"));
	});
	test("failed and timed-out service commands produce a nonzero install result", () => {
		const timedOut = runBoundedServiceCommand([
			process.execPath,
			"--eval",
			"Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)",
		], 20);
		expect(timedOut).toMatchObject({ code: 124, timedOut: true });
		expect(serviceCommandExitCode([{ code: 0, out: "", timedOut: false }, timedOut])).toBe(1);

		const recovered = runBoundedServiceCommand([process.execPath, "--eval", "console.log('ok')"], 1_000);
		expect(recovered).toMatchObject({ code: 0, timedOut: false });
		expect(serviceCommandExitCode([recovered])).toBe(0);
	});


	test("launchd mechanics are gated by the universal service plan", () => {
		const mac = servicePlatformSupport("darwin");
		expect(mac).toMatchObject({ supported: true, backend: "launchd" });
		expect(mac.plan).toMatchObject({ backend: "launchd", supported: true, dryRun: true });

		const windows = servicePlatformSupport("win32");
		expect(windows).toMatchObject({ supported: false, backend: "foreground" });
		expect(windows.plan).toMatchObject({
			backend: "foreground",
			supported: true,
			dryRun: true,
			losses: ["no autostart; process must be supervised externally"],
		});
	});
});


describe("component deployment lifecycle", () => {
	test("failed agent deployment rolls back every lifecycle mutation", async () => {
		const root = temp("uai-components-rollback-");
		const skillRoot = join(root, "skill");
		const configRoot = join(root, "profile");
		mkdirSync(join(skillRoot, "install", "agents"), { recursive: true });
		writeFileSync(join(skillRoot, "install", "agents", "fixture.md"), "fixture\n");
		const child = Bun.spawn([
			process.execPath,
			join(lifeosRoot, "Tools", "DeployComponents.ts"),
			"--skill-root", skillRoot,
			"--config-root", configRoot,
			"--components", "agents",
			"--apply",
		], {
			env: fixtureEnv(root, { LIFEOS_TEST_FAIL_DEPLOY_COMPONENT: "agents" }),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(1);
		expect(existsSync(join(configRoot, "agents", "fixture.md"))).toBe(false);
	});

	test("native Windows statusline declines without leaving settings wiring", async () => {
		if (process.platform !== "win32") return;
		const root = temp("uai-components-statusline-");
		const skillRoot = join(root, "skill");
		const configRoot = join(root, "profile");
		mkdirSync(join(skillRoot, "install", "LIFEOS"), { recursive: true });
		writeFileSync(join(skillRoot, "install", "LIFEOS", "LIFEOS_StatusLine.sh"), "#!/bin/sh\n");
		const child = Bun.spawn([
			process.execPath,
			join(lifeosRoot, "Tools", "DeployComponents.ts"),
			"--skill-root", skillRoot,
			"--config-root", configRoot,
			"--components", "statusline",
			"--apply",
		], { env: fixtureEnv(root), stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
		expect(exitCode).toBe(1);
		expect(stdout).toContain("unsupported on native Windows");
		expect(existsSync(join(configRoot, "settings.json"))).toBe(false);
		expect(existsSync(join(configRoot, "LIFEOS", "LIFEOS_StatusLine.sh"))).toBe(false);
	});
});

describe("hook process timeouts", () => {
	test("awaited child is terminated at timeout and the next hook can run", async () => {
		const slow = await runProcessWithTimeout(process.execPath, ["--eval", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)"], "", 40, process.env);
		expect(slow.timedOut).toBe(true);
		const fast = await runProcessWithTimeout(process.execPath, ["--eval", "console.log('recovered')"], "", 1000, process.env);
		expect(fast.stdout.trim()).toBe("recovered");

	});

	test("detached child is also terminated at timeout", async () => {
		const control = startDetachedProcess(process.execPath, ["--eval", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)"], "", 40, process.env);
		const result = await control.exited;
		expect(result.timedOut).toBe(true);
		expect(result.status).not.toBe(0);
	});
});

describe("OMP inference preference ownership", () => {
	test("custom data roots are canonical and foreign preferences are never deleted", async () => {
		const home = temp("uai-omp-inference-");
		const dataRoot = join(home, "selected-data");
		const env = fixtureEnv(home, { UAI_DATA_DIR: dataRoot, PAI_DATA_DIR: dataRoot });
		const managePath = join(sourceOmp, "manage.ts");
		const set = Bun.spawnSync([process.execPath, managePath, "inference", "omp"], { env, stdout: "pipe", stderr: "pipe" });
		expect(set.exitCode, set.stderr.toString()).toBe(0);
		const preference = join(dataRoot, "USER", "CONFIG", "inference-backend");
		expect(readFileSync(preference, "utf8")).toBe("omp\n");
		expect(existsSync(join(home, ".claude", "LIFEOS", "USER", "CONFIG", "inference-backend"))).toBe(false);

		writeFileSync(preference, "foreign-provider\n");
		const remove = Bun.spawnSync([process.execPath, managePath, "inference", "default"], { env, stdout: "pipe", stderr: "pipe" });
		expect(remove.exitCode).toBe(1);
		expect(readFileSync(preference, "utf8")).toBe("foreign-provider\n");
	});
});

describe("installer physical-path regressions", () => {
	test("USER migration rejects a linked destination before moving live data or touching the victim", () => {
		const root = temp("uai-user-link-");
		const configRoot = join(root, "config");
		const dataRoot = join(root, "data");
		const victim = join(root, "victim.txt");
		const live = join(configRoot, "LIFEOS", "USER", "note.txt");
		const destination = join(dataRoot, "USER", "note.txt");
		mkdirSync(dirname(live), { recursive: true });
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(live, "LIVE");
		writeFileSync(victim, "VICTIM");
		symlinkSync(victim, destination, "file");

		const result = setupUserSeparation(configRoot, dataRoot);
		expect(result.error).toContain("links are not allowed");
		expect(readFileSync(victim, "utf8")).toBe("VICTIM");
		expect(readFileSync(live, "utf8")).toBe("LIVE");
		expect(lstatSync(join(configRoot, "LIFEOS", "USER")).isDirectory()).toBe(true);
	});

	test("copyMissing reports a linked source root instead of a false successful scaffold", () => {
		const root = temp("uai-copy-root-link-");
		const external = join(root, "external");
		const source = join(root, "source");
		const destination = join(root, "destination");
		mkdirSync(external, { recursive: true });
		symlinkSync(external, source, process.platform === "win32" ? "junction" : "dir");
		const result = copyMissing(source, destination);
		expect(result.copied).toBe(0);
		expect(result.failures.join("\n")).toContain("payload link is not allowed");
		expect(existsSync(destination)).toBe(false);
	});
});

test("validation workflow covers installer manifest and entry scripts", () => {
	const workflow = readFileSync(join(lifeosRoot, "..", ".github", "workflows", "pai-codex-validation.yml"), "utf8");
	expect((workflow.match(/LifeOS\/install\/package\.json/g) ?? []).length).toBeGreaterThanOrEqual(2);
	expect((workflow.match(/LifeOS\/install\/install\.ps1/g) ?? []).length).toBeGreaterThanOrEqual(2);
	expect((workflow.match(/LifeOS\/install\/install\.sh/g) ?? []).length).toBeGreaterThanOrEqual(2);
});
