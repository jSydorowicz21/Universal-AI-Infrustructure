#!/usr/bin/env bun
/** Additively installs LifeOS hooks as one rollback-safe settings/files transaction. */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { detectDevTree, mergeHooks, resolveInstallRoots, resolveSelectedHarness, validateHooksMap } from "./InstallEngine";

interface Args { configRoot: string; skillRoot: string; apply: boolean; allowDev: boolean; }

function parseArgs(): Args {
	const argv = process.argv.slice(2);
	const value = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : undefined;
	};
	const roots = resolveInstallRoots();
	return {
		configRoot: value("--config-root") || roots.configRoot,
		skillRoot: value("--skill-root") || join(import.meta.dir, ".."),
		apply: argv.includes("--apply"),
		allowDev: argv.includes("--allow-dev"),
	};
}

function filesRec(dir: string, root = dir): Array<{ source: string; relative: string; mode: number }> {
	const files: Array<{ source: string; relative: string; mode: number }> = [];
	if (!existsSync(dir)) return files;
	const canonicalRoot = realpathSync(root);
	const rootMetadata = lstatSync(root);
	if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error(`payload root must be a physical directory: ${root}`);
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const metadata = lstatSync(path);
		if (metadata.isSymbolicLink()) throw new Error(`payload links are not allowed: ${path}`);
		const physical = realpathSync(path);
		const delta = relative(canonicalRoot, physical);
		if (delta.startsWith("..") || isAbsolute(delta)) throw new Error(`payload path escapes source root: ${path}`);
		if (metadata.isDirectory()) files.push(...filesRec(path, root));
		else if (metadata.isFile()) files.push({ source: path, relative: relative(root, path), mode: metadata.mode & 0o777 });
		else throw new Error(`unsupported payload artifact: ${path}`);
	}
	return files;
}

function lifecycleModulePath(): string {
	const candidates = [
		join(import.meta.dir, "..", "UNIVERSAL", "lifecycle.ts"),
		join(import.meta.dir, "..", "install", "LIFEOS", "UNIVERSAL", "lifecycle.ts"),
		join(import.meta.dir, "..", "..", "..", "LIFEOS", "UNIVERSAL", "lifecycle.ts"),
	];
	const path = candidates.find((candidate) => existsSync(candidate));
	if (!path) throw new Error(`universal lifecycle module not found from ${import.meta.dir}`);
	return path;
}

async function loadLifecycle() {
	return import(pathToFileURL(lifecycleModulePath()).href);
}
function parseObjectJson(path: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`JSON root must be an object: ${path}`);
	}
	return parsed as Record<string, unknown>;
}

function requirePhysicalSettings(path: string): void {
	if (!existsSync(path)) return;
	const metadata = lstatSync(path);
	if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`settings.json must be a physical regular file: ${path}`);
}


function readPayloadFile(path: string, root: string): Buffer {
	const metadata = lstatSync(path);
	if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`payload file must be a physical regular file: ${path}`);
	const delta = relative(realpathSync(root), realpathSync(path));
	if (delta.startsWith("..") || isAbsolute(delta)) throw new Error(`payload file escapes source root: ${path}`);
	return readFileSync(path);
}

function rebaseHookCommands(value: unknown, configRoot: string): void {
	if (Array.isArray(value)) {
		for (const item of value) rebaseHookCommands(item, configRoot);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (typeof record.command === "string") {
		record.command = record.command.replace(/\$HOME\/\.claude(?:\/[^\s;]+)?/g, (token) => {
			const suffix = token.slice("$HOME/.claude".length).replace(/^[/\\]+/, "");
			const selected = suffix ? join(configRoot, ...suffix.split(/[\\/]+/)) : configRoot;
			return `"${selected.replace(/"/g, '\\"')}"`;
		});
	}
	for (const child of Object.values(record)) rebaseHookCommands(child, configRoot);
}

function referencedHookFiles(hooks: Record<string, unknown>): string[] {
	const files = new Set<string>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		if (typeof record.command === "string") {
			const match = record.command.match(/hooks[\\/]([^\s"'`]+)/i);
			if (match?.[1]) files.add(match[1].replace(/\\/g, "/"));
		}
		for (const child of Object.values(record)) visit(child);
	};
	visit(hooks);
	return [...files];
}

export async function runInstallHooks(args = parseArgs()): Promise<{ ok: boolean; error?: string; added?: number; skipped?: number; hookFilesCopied?: number }> {
	const harness = resolveSelectedHarness(args.configRoot);
	if (harness === "codex" || harness === "opencode") {
		return { ok: false, error: `${harness} does not consume Claude hooks; use its native compatible context surface instead` };
	}
	if (detectDevTree(args.configRoot) && !args.allowDev) return { ok: false, error: "dev tree detected — refusing to mutate" };
	const hooksPayloadDir = join(args.skillRoot, "install", "hooks");
	const hooksJsonPath = join(hooksPayloadDir, "hooks.json");
	const hooksDestDir = join(args.configRoot, "hooks");
	const settingsPath = join(args.configRoot, "settings.json");
	if (!existsSync(hooksJsonPath)) return { ok: false, error: `payload hooks.json not found at ${hooksJsonPath}` };
	const payloadMetadata = lstatSync(hooksPayloadDir);
	if (payloadMetadata.isSymbolicLink() || !payloadMetadata.isDirectory()) {
		return { ok: false, error: `payload hooks directory must be a physical directory: ${hooksPayloadDir}` };
	}
	const manifestMetadata = lstatSync(hooksJsonPath);
	if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
		return { ok: false, error: `payload hooks.json must be a physical regular file: ${hooksJsonPath}` };
	}

	let settings: Record<string, unknown>;
	let incoming: Record<string, unknown>;
	try {
		const hookManifest = parseObjectJson(hooksJsonPath);
		if (hookManifest.hooks === null || typeof hookManifest.hooks !== "object" || Array.isArray(hookManifest.hooks)) {
			throw new Error(`hooks must be an object: ${hooksJsonPath}`);
		}
		incoming = hookManifest.hooks as Record<string, unknown>;
		rebaseHookCommands(incoming, args.configRoot);
		requirePhysicalSettings(settingsPath);
		settings = existsSync(settingsPath) ? parseObjectJson(settingsPath) : {};
		if (settings.hooks !== undefined && (settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
			throw new Error(`settings.hooks must be an object when defined: ${settingsPath}`);
		}
		validateHooksMap(incoming, "incoming payload");
		if (settings.hooks !== undefined) validateHooksMap(settings.hooks, "existing settings");
		for (const relativeFile of referencedHookFiles(incoming)) {
			const referenced = join(hooksPayloadDir, relativeFile);
			if (!existsSync(referenced)) throw new Error(`referenced hook is not loadable from payload: ${relativeFile}`);
			readPayloadFile(referenced, hooksPayloadDir);
		}
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}

	const existingHooks = settings.hooks === undefined ? {} as never : settings.hooks as never;
	const { merged, added, skipped } = mergeHooks(existingHooks, incoming as never);
	if (!args.apply) return { ok: true, added, skipped, hookFilesCopied: 0 };

	try {
		const lifecycle = await loadLifecycle();
		const journalDirectory = join(args.configRoot, ".uai-journal");
		if (existsSync(journalDirectory)) {
			const journalMetadata = lstatSync(journalDirectory);
			if (journalMetadata.isSymbolicLink() || !journalMetadata.isDirectory()) {
				throw new Error(`hook install journal directory must be a physical directory: ${journalDirectory}`);
			}
			const journals = readdirSync(journalDirectory).filter((name) => name.startsWith("claude-install-hooks-") && name.endsWith(".json")).sort();
			if (journals.length > 1) throw new Error(`hook install recovery is ambiguous across journals: ${journals.join(", ")}`);
			for (const file of journals) {
				const journal = join(journalDirectory, file);
				const metadata = lstatSync(journal);
				if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`hook install journal must be a physical regular file: ${journal}`);
				const recovery = await lifecycle.recoverJournal(journal);
				if (recovery.status === "rollback-conflict") throw new Error(`hook install recovery conflict: ${recovery.conflicts.map((item) => item.path).join(", ")}`);
			}
		}
		settings.hooks = merged;
		const payloadFiles = filesRec(hooksPayloadDir);
		const hookMutations = payloadFiles.map((file) => ({
			id: `hook-file:${file.relative.replace(/\\/g, "/")}`,
			kind: "write" as const,
			path: join(hooksDestDir, file.relative),
			bytes: readPayloadFile(file.source, hooksPayloadDir),
			mode: file.mode,
			ownership: "owned" as const,
		}));
		const settingsMode = existsSync(settingsPath) ? statSync(settingsPath).mode & 0o777 : undefined;
		const backupMutation = existsSync(settingsPath) ? [{
			id: "settings-backup",
			kind: "write" as const,
			path: `${settingsPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
			bytes: readFileSync(settingsPath),
			mode: settingsMode,
			ownership: "owned" as const,
			structured: "json" as const,
		}] : [];
		const settingsMutation = {
			id: "settings-hooks",
			kind: "write" as const,
			path: settingsPath,
			bytes: Buffer.from(`${JSON.stringify(settings, null, 2)}\n`),
			mode: settingsMode,
			ownership: "adopted" as const,
			structured: "json" as const,
		};
		const plan = await lifecycle.createInstallPlan({
			id: "claude-install-hooks",
			root: args.configRoot,
			mutations: [...hookMutations, ...backupMutation, settingsMutation],
		});
		if (process.env.LIFEOS_TEST_DRIFT_INSTALL_HOOKS === "1" && hookMutations[0]) {
			writeFileSync(hookMutations[0].path, "foreign drift\n");
		}
		const injectFailureAfter = process.env.LIFEOS_TEST_FAIL_INSTALL_HOOKS === "after-hooks"
			? hookMutations.length
			: process.env.LIFEOS_TEST_FAIL_INSTALL_HOOKS === "after-settings"
				? plan.mutations.length
				: undefined;
		await lifecycle.applyInstallPlan(plan, { injectFailureAfter });
		return { ok: true, added, skipped, hookFilesCopied: payloadFiles.length };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

if (import.meta.main) {
	const report = await runInstallHooks();
	console.log(JSON.stringify(report, null, 2));
	process.exit(report.ok ? 0 : 1);
}
