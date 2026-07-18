#!/usr/bin/env bun
/** Transactional install, uninstall, status, and inference controls for LifeOS on OMP. */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertAdapterDescriptor, type AdapterDescriptor } from "../UNIVERSAL/contract";
import { certifyFromEvidence, type ConformanceEvidence } from "../UNIVERSAL/conformance";
import { platformFacts, resolveConfigRoot, resolveDataRoot } from "../UNIVERSAL/platform";
import {
	applyInstallPlan,
	createInstallPlan,
	planSemanticUninstall,
	uninstallOwned,
	recoverJournal,
	type MutationInput,
	type OwnershipManifest as UniversalOwnershipManifest,
} from "../UNIVERSAL/lifecycle";

export const OMP_EXTENSION_NAMES = ["lifeos-memory", "lifeos-commands", "lifeos-safety", "lifeos-hooks", "lifeos-observability"] as const;
export const OMP_CERTIFICATION_EXECUTOR_ID = "omp-native-staged@1";
export const REQUIRED_OMP_HOOKS = [
	"LoadContext.hook.ts",
	"MemoryDeltaSurface.hook.ts",
	"SatisfactionCapture.hook.ts",
	"ReminderRouter.hook.ts",
	"ISASync.hook.ts",
	"CheckpointPerISC.hook.ts",
	"SystemFileGuard.hook.ts",
	"MemoryReviewFire.hook.ts",
	"MemoryHealthGate.hook.ts",
	"DocIntegrity.hook.ts",
	"ISARenderOnStop.hook.ts",
	"VoiceCompletion.hook.ts",
	"StopGates.hook.ts",
	"UpdateCounts.hook.ts",
	"WorkCompletionLearning.hook.ts",
	"SessionCleanup.hook.ts",
	"IntegrityCheck.hook.ts",
] as const;


export interface OmpManagerOptions {
	home?: string;
	agentDir?: string;
	hooksDir?: string;
	sourceDir?: string;
	lifeosDir?: string;
	injectFailureAt?: "after-link" | "after-config";
	probeExecutable?: string | null;
}

export interface OmpControlEvidence {
	adapterVersion: "uai.adapter.v1";
	cliVersion: string;
	osProfile: string;
	probeId: string;
	timestamp: string;
	evidenceUri: string;
	blocked: true;
}

export interface OmpInstallResult {
	ok: boolean;
	problems: string[];
	added: number;
	rolledBack?: boolean;
}

export interface OmpStatusResult {
	ok: boolean;
	wired: boolean;
	loadable: boolean;
	active: boolean;
	evidence?: OmpControlEvidence;
	descriptor: AdapterDescriptor;
	problems: string[];
	agentDir: string;
	evidenceUri?: string;
}

export interface OmpManager {
	install(): Promise<OmpInstallResult>;
	uninstall(): Promise<OmpInstallResult>;
	status(): OmpStatusResult;
	paths: {
		agentDir: string;
		configPath: string;
		appendLink: string;
		manifestPath: string;
	};
}

function configuredHome(): string {
	return normalize(process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir());
}



function atomicWrite(path: string, bytes: string | Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${randomUUID()}.uai-tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} catch (error) {
		if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best effort */ }
		try { unlinkSync(temporary); } catch { /* only our temporary */ }
		throw error;
	}
}

function requirePhysicalRegularFile(path: string, root: string, label: string): void {
	const absolutePath = resolve(path);
	const absoluteRoot = resolve(root);
	const delta = relative(absoluteRoot, absolutePath);
	if (!delta || delta.startsWith("..") || isAbsolute(delta)) throw new Error(`${label} escapes its trusted root: ${path}`);
	const rootMetadata = lstatSync(absoluteRoot);
	if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new Error(`${label} trusted root must be a physical directory: ${absoluteRoot}`);
	let cursor = dirname(absolutePath);
	while (cursor !== absoluteRoot) {
		const metadata = lstatSync(cursor);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`${label} crosses an untrusted parent: ${cursor}`);
		cursor = dirname(cursor);
	}
	const metadata = lstatSync(absolutePath);
	if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a physical regular file: ${path}`);
}

function parseYamlObject(bytes: string, path: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(bytes);
	} catch (error) {
		throw new Error(`invalid YAML at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`config root must be a YAML object: ${path}`);
	const record = parsed as Record<string, unknown>;
	if (record.extensions !== undefined && (!Array.isArray(record.extensions) || record.extensions.some((entry) => typeof entry !== "string"))) {
		throw new Error(`config.extensions must be an array of strings: ${path}`);
	}
	return record;
}

function extensionsOf(config: Record<string, unknown>): string[] {
	return Array.isArray(config.extensions) ? config.extensions as string[] : [];
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function resolvedLinkTarget(linkPath: string): string | null {
	try {
		if (!lstatSync(linkPath).isSymbolicLink()) return null;
		const target = readlinkSync(linkPath);
		return normalize(isAbsolute(target) ? target : resolve(dirname(linkPath), target));
	} catch {
		return null;
	}
}


function isOwnedConstitution(source: string, target: string): boolean {
	const linked = resolvedLinkTarget(target);
	if (linked !== null) return linked === normalize(resolve(source));
	try {
		return readFileSync(source).equals(readFileSync(target));
	} catch {
		return false;
	}
}

function missingRelativeImports(
	entrypoint: string,
	lifeosDir?: string,
	visited = new Set<string>(),
): string[] {
	const normalized = normalize(entrypoint);
	if (visited.has(normalized) || !existsSync(normalized)) return [];
	visited.add(normalized);
	const missing: string[] = [];
	const source = readFileSync(normalized, "utf8");
	for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/g)) {
		const specifier = match[1];
		const unresolved = resolve(dirname(normalized), specifier);
		const candidates = [unresolved, `${unresolved}.ts`, `${unresolved}.js`, join(unresolved, "index.ts")];
		const lifeosSuffix = unresolved.match(/[\\/]LIFEOS[\\/](.+)$/)?.[1];
		if (lifeosDir && lifeosSuffix) {
			const remapped = join(lifeosDir, lifeosSuffix);
			candidates.push(remapped, `${remapped}.ts`, `${remapped}.js`, join(remapped, "index.ts"));
		}
		const resolvedImport = candidates.find((candidate) => existsSync(candidate));
		if (!resolvedImport) {
			missing.push(`${normalized} imports missing ${specifier}`);
		} else if (resolvedImport.endsWith(".ts") || resolvedImport.endsWith(".js")) {
			missing.push(...missingRelativeImports(resolvedImport, lifeosDir, visited));
		}
	}
	return missing;
}

function probeEntrypoints(entrypoints: readonly string[], importable: ReadonlySet<string>, env: Record<string, string | undefined>): string[] {

	const outputDir = join(tmpdir(), `omp-preflight-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(outputDir, { recursive: true });
	const script = `
const entries = ${JSON.stringify(entrypoints)};
const urls = ${JSON.stringify(entrypoints.map((entrypoint) => pathToFileURL(entrypoint).href))};
const importable = new Set(${JSON.stringify([...importable])});
const outputRoot = ${JSON.stringify(outputDir)};
const { existsSync } = await import("node:fs");
const { dirname, join, resolve } = await import("node:path");
const remapPlugin = {
  name: "uai-lifeos-root-remap",
  setup(build) {
    build.onResolve({ filter: /^\\./ }, (args) => {
      const unresolved = resolve(dirname(args.importer), args.path);
      if ([unresolved, unresolved + ".ts", unresolved + ".js", join(unresolved, "index.ts")].some(existsSync)) return;
      const segments = unresolved.split(/[\\\\/]+/);
      const marker = segments.lastIndexOf("LIFEOS");
      if (marker < 0 || !process.env.LIFEOS_DIR) return;
      const remapped = join(process.env.LIFEOS_DIR, ...segments.slice(marker + 1));
      const candidate = [remapped, remapped + ".ts", remapped + ".js", join(remapped, "index.ts")].find(existsSync);
      return candidate ? { path: candidate } : undefined;
    });
  },
};
const errors = [];
for (let index = 0; index < entries.length; index++) {
  try {
    const result = await Bun.build({ entrypoints: [entries[index]], target: "bun", outdir: outputRoot + "/" + index, plugins: [remapPlugin] });
    if (!result.success) {
      errors.push("entrypoint build failed: " + entries[index] + ": " + result.logs.map(String).join("; "));
      continue;
    }
    if (importable.has(entries[index])) {
      try { await import(urls[index] + "?uai-preflight=" + Date.now() + "-" + index); }
      catch (error) { errors.push("entrypoint import failed: " + entries[index] + ": " + (error?.message ?? String(error))); }
    }
  } catch (error) {
    errors.push("entrypoint build failed: " + entries[index] + ": " + (error?.message ?? String(error)));
  }
}
process.stdout.write("\\nUAI_PROBE:" + JSON.stringify(errors));
`;
	let errors: string[];
	try {
		const child = Bun.spawnSync([process.execPath, "--eval", script], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 15_000,
			env,
		});
		if (child.exitCode !== 0) {
			errors = [`entrypoint probe process failed: ${child.stderr.toString().trim() || `exit ${child.exitCode}`}`];
		} else {
			const output = child.stdout.toString();
			const marker = output.lastIndexOf("UAI_PROBE:");
			const parsed = marker >= 0 ? JSON.parse(output.slice(marker + "UAI_PROBE:".length)) as unknown : undefined;
			errors = Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
				? parsed
				: [`entrypoint probe returned malformed output: ${output.slice(-500)} ${child.stderr.toString().slice(-500)}`];
		}
	} finally {
		rmSync(outputDir, { recursive: true, force: true });
	}
	return errors;
}

function validateExtensionManifest(path: string, name: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const omp = parsed.omp as Record<string, unknown> | undefined;
		if (parsed.name !== name || typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(parsed.version)) {
			return [`invalid extension manifest identity/version: ${path}`];
		}
		if (!omp || !Array.isArray(omp.extensions) || omp.extensions.length !== 1 || omp.extensions[0] !== "./index.ts") {
			return [`invalid extension manifest export: ${path}`];
		}
		return [];
	} catch (error) {
		return [`invalid extension manifest: ${path}: ${error instanceof Error ? error.message : String(error)}`];
	}
}

function portablePath(path: string, home: string): string {
	const normalizedPath = normalize(resolve(path));
	const normalizedHome = normalize(resolve(home));
	const rel = relative(normalizedHome, normalizedPath);
	if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return `~/${rel.replace(/\\/g, "/")}`;
	return normalizedPath.replace(/\\/g, "/");
}

function readManifest(path: string, root: string): UniversalOwnershipManifest | null {
	if (!existsSync(path)) return null;
	requirePhysicalRegularFile(path, root, "OMP ownership manifest");
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as UniversalOwnershipManifest;
		return parsed?.schema === "uai.ownership-manifest.v1" ? parsed : null;
	} catch {
		return null;
	}
}

function readConformanceEvidence(path: string, root: string): ConformanceEvidence | undefined {
	if (!existsSync(path)) return undefined;
	requirePhysicalRegularFile(path, root, "OMP conformance evidence");
	try {
		const evidence = JSON.parse(readFileSync(path, "utf8")) as ConformanceEvidence;
		return evidence?.schema === "uai.conformance.v1"
			&& evidence.scope === "adapter"
			&& evidence.adapterId === "omp"
			&& evidence.suiteId === "uai-adapter-critical-suite"
			&& Array.isArray(evidence.probes)
			? evidence
			: undefined;
	} catch {
		return undefined;
	}
}
function runLiveControlProbe(
	sourceDir: string,
	agentDir: string,
	executable: string | null | undefined,
	home: string,
): OmpControlEvidence | undefined {
	if (executable === null) return undefined;
	const ompExecutable = executable || process.env.OMP_EXECUTABLE || "omp";
	let cliVersion = "";
	try {
		const version = Bun.spawnSync([ompExecutable, "--version"], { stdout: "pipe", stderr: "pipe" });
		if (version.exitCode !== 0) return undefined;
		cliVersion = (version.stdout.toString() || version.stderr.toString()).trim();
		if (cliVersion.length === 0) return undefined;
	} catch {
		return undefined;
	}
	// The probe targets the configured adapter source; a static import would bypass sourceDir/profile fixtures.
	const safetyUrl = pathToFileURL(join(sourceDir, "extensions", "lifeos-safety", "index.ts")).href;
	const script = [
		`const module = await import(${JSON.stringify(safetyUrl)});`,
		"let handler;",
		"module.default({ on(name, value) { if (name === 'tool_call') handler = value; }, setLabel() {} });",
		"if (!handler) process.exit(3);",
		"const result = await handler({ toolName: 'bash', input: { command: 'rm -rf ~' } }, {});",
		"console.log(JSON.stringify(result));",
		"if (result?.block !== true) process.exit(4);",
	].join("\n");
	try {
		const probe = Bun.spawnSync([process.execPath, "--eval", script], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: agentDir,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		if (probe.exitCode !== 0) return undefined;
		const output = JSON.parse(probe.stdout.toString().trim()) as { block?: boolean };
		if (output.block !== true) return undefined;
		const timestamp = new Date().toISOString();
		const probeId = "omp-safety-dangerous-command-v1";
		return {
			adapterVersion: "uai.adapter.v1",
			cliVersion,
			osProfile: `${process.platform}:${agentDir}`,
			probeId,
			timestamp,
			evidenceUri: `urn:uai:probe:${probeId}:${encodeURIComponent(timestamp)}`,
			blocked: true,
		};
	} catch {
		return undefined;
	}
}


export function createOmpManager(options: OmpManagerOptions = {}): OmpManager {
	const home = normalize(options.home ?? configuredHome());
	const sourceDir = normalize(options.sourceDir ?? import.meta.dir);
	const lifeosDir = normalize(options.lifeosDir ?? dirname(sourceDir));
	const agentDir = normalize(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent"));
	const hooksDir = normalize(options.hooksDir ?? process.env.LIFEOS_HOOKS_DIR ?? join(resolveConfigRoot(process.env, "claude", () => home), "hooks"));
	const configPath = join(agentDir, "config.yml");
	const appendLink = join(agentDir, "APPEND_SYSTEM.md");
	const appendSource = join(sourceDir, "APPEND_SYSTEM.md");
	const manifestPath = join(agentDir, ".uai-ownership", "omp-adapter-install.json");
	const evidencePath = join(agentDir, ".uai-control-evidence.json");
	const extensionPaths = OMP_EXTENSION_NAMES.map((name) => portablePath(join(sourceDir, "extensions", name), home));
	const probeEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agentDir,
		CLAUDE_CONFIG_DIR: dirname(hooksDir),
		LIFEOS_DIR: lifeosDir,
	};

	const preflight = (): { problems: string[]; config: Record<string, unknown>; configBytes: string | null } => {
		const problems: string[] = [];
		const entrypoints: string[] = [];
		const importable = new Set<string>();
		if (!existsSync(appendSource)) problems.push(`missing constitution: ${appendSource}`);
		for (const name of OMP_EXTENSION_NAMES) {
			const extensionDir = join(sourceDir, "extensions", name);
			const entrypoint = join(extensionDir, "index.ts");
			if (!existsSync(entrypoint)) {
				problems.push(`missing extension: ${name}/index.ts`);
			} else {
				problems.push(...missingRelativeImports(entrypoint, lifeosDir));
				entrypoints.push(entrypoint);
				importable.add(entrypoint);
			}
			const packagePath = join(extensionDir, "package.json");
			if (!existsSync(packagePath)) problems.push(`missing extension manifest: ${name}/package.json`);
			else problems.push(...validateExtensionManifest(packagePath, name));
		}
		for (const hook of REQUIRED_OMP_HOOKS) {
			const entrypoint = join(hooksDir, hook);
			if (!existsSync(entrypoint)) problems.push(`missing required hook: ${entrypoint}`);
			else {
				problems.push(...missingRelativeImports(entrypoint, lifeosDir));
				entrypoints.push(entrypoint);
			}
		}
		if (!existsSync(join(hooksDir, "lib", "safety-classifier.ts"))) problems.push(`missing safety classifier: ${join(hooksDir, "lib", "safety-classifier.ts")}`);
		const reviewer = join(lifeosDir, "TOOLS", "MemoryReviewer.ts");
		if (!existsSync(reviewer)) problems.push(`missing reviewer: ${reviewer}`);
		else {
			problems.push(...missingRelativeImports(reviewer, lifeosDir));
			entrypoints.push(reviewer);
			importable.add(reviewer);
		}
		const parser = join(lifeosDir, "TOOLS", "TranscriptParser.ts");
		if (!existsSync(parser)) problems.push(`missing transcript parser: ${parser}`);
		else {
			problems.push(...missingRelativeImports(parser, lifeosDir));
			entrypoints.push(parser);
			importable.add(parser);
		}
		if (entrypoints.length > 0) problems.push(...probeEntrypoints(entrypoints, importable, probeEnv));
		let config: Record<string, unknown> = {};
		let configBytes: string | null = null;
		if (existsSync(configPath)) {
			try {
				requirePhysicalRegularFile(configPath, agentDir, "OMP config");
				configBytes = readFileSync(configPath, "utf8");
				config = parseYamlObject(configBytes, configPath);
			} catch (error) {
				problems.push(error instanceof Error ? error.message : String(error));
			}
		}
		return { problems, config, configBytes };
	};
	const recover = async (ids: readonly string[]): Promise<void> => {
		const journalDirectory = join(agentDir, ".uai-journal");
		if (!existsSync(journalDirectory)) return;
		for (const id of ids) {
			const journals = readdirSync(journalDirectory).filter((candidate) => candidate.startsWith(`${id}-`) && candidate.endsWith(".json")).sort();
			if (journals.length > 1) throw new Error(`OMP recovery is ambiguous for ${id}: ${journals.join(", ")}`);
			for (const name of journals) {
				const path = join(journalDirectory, name);
				requirePhysicalRegularFile(path, agentDir, "OMP journal");
				const result = await recoverJournal(path);
				if (result.status === "rollback-conflict") {
					throw new Error(`rollback conflict preserved at ${result.conflicts.map((conflict) => conflict.path).join(", ")}`);
				}
			}
		}
	};

	const install = async (): Promise<OmpInstallResult> => {
		try {
			await recover(["omp-adapter-install"]);
		} catch (error) {
			return { ok: false, problems: [`install recovery failed: ${error instanceof Error ? error.message : String(error)}`], added: 0 };
		}
		const checked = preflight();
		if (checked.problems.length > 0) return { ok: false, problems: checked.problems, added: 0 };
		const existingManifest = readManifest(manifestPath, agentDir);
		if (existingManifest) {
			const alreadyWired = extensionPaths.every((entry) => extensionsOf(checked.config).includes(entry))
				&& isOwnedConstitution(appendSource, appendLink);
			return alreadyWired
				? { ok: true, problems: [], added: 0 }
				: { ok: false, problems: ["owned OMP install has drifted; uninstall or recover it before reinstalling"], added: 0 };
		}
		const merged = [...extensionsOf(checked.config)];
		let added = 0;
		for (const extension of extensionPaths) {
			if (!merged.includes(extension)) {
				merged.push(extension);
				added++;
			}
		}
		const nextConfig = `${Bun.YAML.stringify({ ...checked.config, extensions: merged }).trimEnd()}\n`;
		const mutations: MutationInput[] = [
			{
				id: "omp-append-system",
				kind: "write",
				path: appendLink,
				bytes: (() => {
					requirePhysicalRegularFile(appendSource, sourceDir, "OMP constitution source");
					return readFileSync(appendSource);
				})(),
				ownership: "adopted",
			},
			{
				id: "omp-config",
				kind: "write",
				path: configPath,
				bytes: Buffer.from(nextConfig),
				ownership: "adopted",
				structured: "yaml",
			},
		];
		try {
			const plan = await createInstallPlan({
				id: "omp-adapter-install",
				root: agentDir,
				gates: [{ id: "omp-preflight", passed: true, message: "OMP extensions, hooks, imports, and YAML are loadable" }],
				mutations,
			});
			await applyInstallPlan(plan, {
				injectFailureAfter: options.injectFailureAt === "after-link"
					? 1
					: options.injectFailureAt === "after-config" ? 2 : undefined,
			});
			return { ok: true, problems: [], added };
		} catch (error) {
			return {
				ok: false,
				problems: [error instanceof Error ? error.message : String(error)],
				added: 0,
				rolledBack: true,
			};
		}
	};

	const uninstall = async (): Promise<OmpInstallResult> => {
		try {
			await recover(["omp-adapter-install", "omp-adapter-semantic-uninstall", "omp-adapter-manifest-cleanup"]);
		} catch (error) {
			return { ok: false, problems: [`uninstall recovery failed: ${error instanceof Error ? error.message : String(error)}`], added: 0 };
		}
		const ownership = readManifest(manifestPath, agentDir);
		if (!ownership) return { ok: false, problems: ["no valid UAI ownership manifest; refusing destructive uninstall"], added: 0 };
		try {
			const currentBytes = existsSync(configPath) ? (() => { requirePhysicalRegularFile(configPath, agentDir, "OMP config"); return readFileSync(configPath, "utf8"); })() : "";
			const current = currentBytes ? parseYamlObject(currentBytes, configPath) : {};
			const kept = extensionsOf(current).filter((entry) => !extensionPaths.includes(entry as typeof extensionPaths[number]));
			if (kept.length > 0) current.extensions = kept;
			else delete current.extensions;

			const configArtifact = ownership.artifacts.find((artifact) => normalize(artifact.path) === normalize(configPath));
			let desiredConfig: MutationInput | undefined;
			if (configArtifact?.before.kind === "file" && configArtifact.before.bytesBase64) {
				const priorBytes = Buffer.from(configArtifact.before.bytesBase64, "base64");
				const prior = parseYamlObject(priorBytes.toString("utf8"), "ownership snapshot");
				desiredConfig = {
					id: "omp-config-semantic-uninstall",
					kind: "write",
					path: configPath,
					bytes: sameJson(current, prior)
						? priorBytes
						: Buffer.from(`${Bun.YAML.stringify(current).trimEnd()}\n`),
					ownership: "adopted",
					structured: "yaml",
				};
			} else if (configArtifact && !configArtifact.before.existed && Object.keys(current).length === 0) {
				desiredConfig = { id: "omp-config-semantic-uninstall", kind: "delete", path: configPath, ownership: "owned" };
			} else if (configArtifact) {
				desiredConfig = {
					id: "omp-config-semantic-uninstall",
					kind: "write",
					path: configPath,
					bytes: Buffer.from(`${Bun.YAML.stringify(current).trimEnd()}\n`),
					ownership: "adopted",
					structured: "yaml",
				};
			}

			const direct = await uninstallOwned(ownership);
			if (desiredConfig && direct.conflicts.some((conflict) => normalize(conflict.path) === normalize(configPath))) {
				const semanticPlan = await planSemanticUninstall(ownership, {
					id: "omp-adapter-semantic-uninstall",
					mutations: [desiredConfig],
				});
				await applyInstallPlan(semanticPlan);
			}
			const unresolved = direct.conflicts
				.filter((conflict) => normalize(conflict.path) !== normalize(configPath))
				.map((conflict) => `preserved changed artifact: ${conflict.path}`);
			if (unresolved.length > 0) return { ok: false, problems: unresolved, added: 0 };
			const cleanupPlan = await createInstallPlan({
				id: "omp-adapter-manifest-cleanup",
				root: agentDir,
				mutations: [{ id: "omp-ownership-cleanup", kind: "delete", path: manifestPath, ownership: "owned" }],
			});
			await applyInstallPlan(cleanupPlan);
			return { ok: true, problems: [], added: 0 };
		} catch (error) {
			return { ok: false, problems: [error instanceof Error ? error.message : String(error)], added: 0 };
		}
	};

	const status = (): OmpStatusResult => {
		const checked = preflight();
		const configExtensions = new Set(extensionsOf(checked.config));
		const wired = checked.problems.every((problem) => !problem.startsWith("invalid YAML") && !problem.startsWith("config."))
			&& extensionPaths.every((path) => configExtensions.has(path))
			&& isOwnedConstitution(appendSource, appendLink);
		const loadable = checked.problems.length === 0;
		const conformanceEvidence = readConformanceEvidence(evidencePath, agentDir);
		const liveEvidence = wired && loadable
			? runLiveControlProbe(sourceDir, agentDir, options.probeExecutable, home)
			: undefined;
		const facts = platformFacts();
		const certification = certifyFromEvidence({
			wired: wired && loadable,
			evidence: conformanceEvidence,
			expected: {
				adapterId: "omp",
				adapterVersion: "1.0.0",
				cliVersion: liveEvidence?.cliVersion ?? "unobserved",
				osProfile: `${facts.os}:${agentDir}`,
				executorId: OMP_CERTIFICATION_EXECUTOR_ID,
			},
		});
		const descriptor = assertAdapterDescriptor({
			contract: "uai.adapter.v1",
			adapter: { id: "omp", version: "1.0.0", class: "native" },
			discovery: {
				state: "detected",
				confidence: loadable ? 1 : wired ? 0.75 : 0.5,
				roots: [agentDir],
				cliVersion: liveEvidence?.cliVersion ?? conformanceEvidence?.cliVersion,
			},
			capabilities: {
				"critical.system-file-guard": {
					critical: true,
					state: certification.state === "observed" ? "degraded" : certification.state,
					failMode: "fail-closed",
					evidence: certification.evidence,
					losses: liveEvidence ? [] : ["live OMP safety control has not been observed"],
				},
				"agent.pulse-guard": {
					critical: false,
					state: "degraded",
					failMode: "fail-visible-open",
					losses: ["Pulse agent guard is unavailable when Pulse is down; failures are visible but do not block"],
				},
			},
			certification: certification.certification,
			losses: [
				...certification.blockers,
				"Pulse agent guard is fail-visible-open",
				...(facts.os === "unknown" ? ["unsupported operating system"] : []),
			],
		});
		return {
			ok: wired && loadable,
			wired,
			loadable,
			active: certification.state === "active",
			problems: checked.problems,
			agentDir,
			evidenceUri: certification.evidence?.evidenceUri ?? liveEvidence?.evidenceUri,
			evidence: liveEvidence,
			descriptor,
		};
	};
	return { install, uninstall, status, paths: { agentDir, configPath, appendLink, manifestPath } };
}

function inferenceBackend(state: string, env: NodeJS.ProcessEnv = process.env): number {
	const dataRoot = resolveDataRoot(env);
	const path = join(dataRoot, "USER", "CONFIG", "inference-backend");
	const configured = existsSync(path) ? (() => { requirePhysicalRegularFile(path, dataRoot, "inference backend preference"); return readFileSync(path, "utf8"); })() : undefined;
	const recognized = configured === undefined || ["claude\n", "omp\n", "auto\n"].includes(configured);
	if (state === "status" || state === "") {
		if (!recognized) {
			console.error(`inference backend preference contains an unrecognized user-owned value at ${path}; no mutation attempted`);
			return 1;
		}
		console.log(configured ? `inference backend: ${configured.trim()} (explicit override)` : "inference backend: omp (automatic OMP default; Claude-free)");
		return 0;
	}
	if (!["default", "claude", "omp", "auto"].includes(state)) {
		console.error("Usage: bun manage.ts inference {default|claude|omp|auto|status}");
		return 2;
	}
	if (!recognized) {
		console.error(`refusing to overwrite or delete unrecognized user-owned inference preference at ${path}`);
		return 1;
	}
	if (state === "default") {
		if (configured !== undefined) unlinkSync(path);
		console.log("✓ inference backend → omp (automatic OMP default; recognized override removed)");
		return 0;
	}
	mkdirSync(dirname(path), { recursive: true });
	atomicWrite(path, `${state}\n`);
	console.log(`✓ inference backend → ${state} (explicit user-owned override)`);
	if (state === "claude") console.log("Explicit Claude CLI backend selected; working Claude authentication is required.");
	return 0;
}

async function runCli(): Promise<number> {
	const command = process.argv[2];
	if (command === "inference") return inferenceBackend(process.argv[3] ?? "");
	const manager = createOmpManager();
	if (command === "install") {
		const result = await manager.install();
		if (result.ok) console.log(`✓ Installed transactionally: ${result.added} extensions added. Status remains inactive until a control probe records evidence.`);
		else console.error(`✗ Install blocked with zero committed mutations:\n${result.problems.map((problem) => `  - ${problem}`).join("\n")}`);
		return result.ok ? 0 : 1;
	}
	if (command === "uninstall") {
		const result = await manager.uninstall();
		if (result.ok) console.log("✓ Uninstalled owned UAI wiring and restored prior constitution/config bytes where unchanged.");
		else console.error(`✗ Uninstall blocked:\n${result.problems.map((problem) => `  - ${problem}`).join("\n")}`);
		return result.ok ? 0 : 1;
	}
	if (command === "status") {
		const status = manager.status();
		console.log(JSON.stringify(status, null, 2));
		return status.ok ? 0 : 1;
	}
	console.error("Usage: bun manage.ts {install|uninstall|status|inference default|claude|omp|auto|status}");
	return 2;
}

if (import.meta.main) process.exit(await runCli());
