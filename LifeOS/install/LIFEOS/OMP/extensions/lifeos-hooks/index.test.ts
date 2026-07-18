import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hookEnv } from "./index";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFakeTool(binDir: string, name: string, body: string): string {
	const path = join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
	if (process.platform === "win32") {
		writeFileSync(path, `@echo off\r\n${body}\r\n`);
	} else {
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
	}
	return path;
}

function stageHooks(home: string): void {
	const source = join(import.meta.dir, "../../../../hooks");
	const destination = join(home, ".claude", "hooks");
	mkdirSync(join(home, ".claude"), { recursive: true });
	cpSync(source, destination, { recursive: true });
}
async function invokeSystemFileGuard(options: {
	hookBody?: string;
	executable?: string;
	timeoutMs?: number;
}): Promise<{ block?: boolean; reason?: string } | null> {
	const home = mkdtempSync(join(tmpdir(), "lifeos-system-guard-"));
	tempDirs.push(home);
	const hooksDir = join(home, "hooks");
	mkdirSync(hooksDir, { recursive: true });
	if (options.hookBody !== undefined) {
		writeFileSync(join(hooksDir, "SystemFileGuard.hook.ts"), options.hookBody);
	}
	const moduleUrl = pathToFileURL(join(import.meta.dir, "index.ts")).href;
	const script = [
		`const module = await import(${JSON.stringify(moduleUrl)});`,
		"const handlers = {};",
		"module.default({ on(name, handler) { handlers[name] = handler; } });",
		`const result = await handlers.tool_call({ toolName: "write", input: { path: ${JSON.stringify(join(home, "profile", "LIFEOS", "SYSTEM", "guarded.md"))} } }, { cwd: ${JSON.stringify(home)} });`,
		"console.log(JSON.stringify(result ?? null));",
	].join("\n");
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			LIFEOS_HOOKS_DIR: hooksDir,
			LIFEOS_HOOK_EXECUTABLE: options.executable ?? process.execPath,
			LIFEOS_HOOK_TIMEOUT_MS: String(options.timeoutMs ?? 10_000),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`guard probe exited ${exitCode}: ${stderr}`);
	return JSON.parse(stdout.trim()) as { block?: boolean; reason?: string } | null;
}

describe("fail-closed SystemFileGuard bridge", () => {
	test("blocks when the guard file is missing", async () => {
		const result = await invokeSystemFileGuard({});
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("missing hook file");
	});

	test("blocks when the hook executable cannot spawn", async () => {
		const result = await invokeSystemFileGuard({
			hookBody: "process.exit(0);",
			executable: join(tmpdir(), "definitely-missing-uai-hook-executable"),
		});
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("could not be spawned");
	});

	test("blocks and kills a timed-out guard", async () => {
		const result = await invokeSystemFileGuard({
			hookBody: "await Bun.sleep(1000);",
			timeoutMs: 30,
		});
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("timed out");
	});

	test("blocks on an unexpected nonzero guard exit", async () => {
		const result = await invokeSystemFileGuard({
			hookBody: "process.stderr.write('guard crashed'); process.exit(1);",
			timeoutMs: 10_000,
		});
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("exited 1");
	}, 15_000);

	test("allows a benign successful guard result", async () => {
		const result = await invokeSystemFileGuard({ hookBody: "process.exit(0);" });
		expect(result).toBeNull();
	});
});
describe("session stop critical path", () => {
	test("memory review launches outside the awaited stop sequence", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-stop-review-"));
		tempDirs.push(home);
		const hooksDir = join(home, "hooks");
		mkdirSync(hooksDir, { recursive: true });
		for (const file of [
			"MemoryHealthGate.hook.ts",
			"DocIntegrity.hook.ts",
			"ISARenderOnStop.hook.ts",
			"VoiceCompletion.hook.ts",
			"StopGates.hook.ts",
		]) writeFileSync(join(hooksDir, file), "process.exit(0);\n");
		// A real child-process delay is intentional: this integration proves OMP returns
		// before the spawned reviewer reaches its completion signal.
		const completed = join(home, "review-completed");
		writeFileSync(
			join(hooksDir, "MemoryReviewFire.hook.ts"),
			`import { writeFileSync } from "node:fs"; await Bun.sleep(1200); writeFileSync(${JSON.stringify(completed)}, "done");\n`,
		);
		const moduleUrl = pathToFileURL(join(import.meta.dir, "index.ts")).href;
		const probe = [
			`const module = await import(${JSON.stringify(moduleUrl)});`,
			"const handlers = {};",
			"module.default({ on(name, handler) { handlers[name] = handler; } });",
			"await handlers.session_stop({}, { cwd: process.cwd(), sessionManager: { getBranch() { return []; } } });",
			`console.log(JSON.stringify({ completed: await Bun.file(${JSON.stringify(completed)}).exists() }));`,
			"process.exit(0);",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", probe], {
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				LIFEOS_HOOKS_DIR: hooksDir,
				LIFEOS_HOOK_EXECUTABLE: process.execPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim()).completed).toBe(false);
	}, 10_000);
});



describe("Claude-free OMP inference", () => {
	test("marks bridged hook subprocesses as OMP", () => {
		expect(hookEnv({ cwd: "/tmp/project" }).LIFEOS_HARNESS).toBe("omp");
	});

	test("uses OMP without attempting Claude when no backend is configured", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-omp-backend-"));
		tempDirs.push(home);
		const binDir = join(home, "bin");
		const claudeSentinel = join(home, "claude-called");
		mkdirSync(binDir);

		writeFakeTool(binDir, "omp", "echo OMP_STUB_OK");

		writeFakeTool(binDir, "claude", `echo called>\"${claudeSentinel}\"\r\necho CLAUDE_STUB`);

		const inferencePath = join(import.meta.dir, "../../../TOOLS/Inference.ts");
		const probe = [
			`import { inference } from ${JSON.stringify(inferencePath)};`,
			"const result = await inference({ level: 'low', systemPrompt: 'Return the stub response.', userPrompt: 'probe', timeout: 10000 });",
			"console.log(JSON.stringify(result));",
			"if (!result.success) process.exit(1);",
		].join("\n");
		const childEnv: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "path") delete childEnv[key];
		Object.assign(childEnv, {
			HOME: home,
			USERPROFILE: home,
			UAI_DATA_DIR: join(home, ".pai"),
			PAI_DATA_DIR: join(home, ".pai"),
			PATH: binDir,
			PATHEXT: ".COM;.EXE;.BAT;.CMD",
			LIFEOS_HARNESS: "omp",
		});
		delete childEnv.LIFEOS_INFERENCE_BACKEND;
		delete childEnv.LIFEOS_OMP_INFERENCE_MODEL;
		const child = Bun.spawn([process.execPath, "--eval", probe], {
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
		expect(JSON.parse(stdout.trim()).output).toBe("OMP_STUB_OK");
		expect(stderr).not.toContain("claude backend");
		expect(existsSync(claudeSentinel)).toBe(false);
	}, 15_000);

	test("supports explicit Claude opt-in and automatic OMP reset", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-manage-backend-"));
		tempDirs.push(home);
		const managePath = join(import.meta.dir, "../../manage.ts");
		const configPath = join(home, ".pai/USER/CONFIG/inference-backend");
		const runManage = async (...args: string[]) => {
			const child = Bun.spawn([process.execPath, managePath, "inference", ...args], {
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					UAI_DATA_DIR: join(home, ".pai"),
					PAI_DATA_DIR: join(home, ".pai"),
					PI_CODING_AGENT_DIR: join(home, "agent"),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, exitCode };
		};

		const initial = await runManage("status");
		expect(initial.exitCode).toBe(0);
		expect(initial.stdout).toContain("omp (automatic OMP default; Claude-free)");

		const claude = await runManage("claude");
		expect(claude.exitCode).toBe(0);
		expect(claude.stdout).toContain("Explicit Claude CLI backend selected");
		expect(existsSync(configPath)).toBe(true);
		expect((await runManage("status")).stdout).toContain("claude (explicit override)");

		const reset = await runManage("default");
		expect(reset.exitCode).toBe(0);
		expect(reset.stdout).toContain("omp (automatic OMP default");
		expect(existsSync(configPath)).toBe(false);
	});

	test("installs into a missing OMP agent directory", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-manage-install-"));
		tempDirs.push(home);
		stageHooks(home);
		const binDir = join(home, "bin");
		mkdirSync(binDir);
		const ompExecutable = writeFakeTool(binDir, "omp", "echo omp 1.2.3");
		const agentDir = join(home, ".omp/agent");
		const managePath = join(import.meta.dir, "../../manage.ts");
		const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, OMP_EXECUTABLE: ompExecutable };

		const install = Bun.spawn([process.execPath, managePath, "install"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [installStdout, installStderr, installExitCode] = await Promise.all([
			new Response(install.stdout).text(),
			new Response(install.stderr).text(),
			install.exited,
		]);

		expect(installExitCode).toBe(0);
		expect(installStderr).toBe("");
		expect(installStdout).toContain("5 extensions added");
		expect(existsSync(join(agentDir, "config.yml"))).toBe(true);
		expect(existsSync(join(agentDir, "APPEND_SYSTEM.md"))).toBe(true);

		const status = Bun.spawn([process.execPath, managePath, "status"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const statusStdout = await new Response(status.stdout).text();
		expect(await status.exited).toBe(0);
		expect(statusStdout).toContain("\"wired\": true");
		expect(statusStdout).toContain("\"active\": false");
		expect(statusStdout).toContain("\"probeId\": \"omp-safety-dangerous-command-v1\"");
		expect(statusStdout).toContain("\"certification\": \"C0\"");
	});
});
