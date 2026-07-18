import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createPulseAvailabilityProbe, hookEnv, launchFireAndForgetHook } from "./index";

const tempDirs: string[] = [];
function profileEnv(home: string, overrides: Record<string, string> = {}): Record<string, string> {
	return {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		LIFEOS_CONFIG_ROOT: join(home, ".claude"),
		LIFEOS_DIR: join(home, ".claude", "LIFEOS"),
		PI_CODING_AGENT_DIR: join(home, "agent"),
		...overrides,
	} as Record<string, string>;
}

function stubBinary(dir: string, name: string, unixBody: string, windowsBody: string): string {
	const path = join(dir, process.platform === "win32" ? `${name}.cmd` : name);
	writeFileSync(path, process.platform === "win32" ? `@echo off\r\n${windowsBody}\r\n` : `#!/bin/sh\n${unixBody}\n`);
	if (process.platform !== "win32") chmodSync(path, 0o755);
	return path;
}
function stageCorePrerequisites(home: string): void {
	const configRoot = join(home, ".claude");
	const lifeosTools = join(configRoot, "LIFEOS", "TOOLS");
	cpSync(join(import.meta.dir, "../../../../hooks"), join(configRoot, "hooks"), { recursive: true });
	mkdirSync(lifeosTools, { recursive: true });
	for (const file of ["MemoryReviewer.ts", "TranscriptParser.ts"]) {
		copyFileSync(join(import.meta.dir, "../../../TOOLS", file), join(lifeosTools, file));
	}
}



afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Claude-free OMP inference", () => {
	test("marks bridged hook subprocesses as OMP", () => {
		expect(hookEnv({ cwd: "/tmp/project" }).LIFEOS_HARNESS).toBe("omp");
	});
	test("retries Pulse after an initial failed liveness probe", async () => {
		let now = 0;
		let attempts = 0;
		const pulseAvailable = createPulseAvailabilityProbe({
			now: () => now,
			probe: async () => {
				attempts++;
				return attempts > 1;
			},
		});

		expect(await pulseAvailable()).toBe(false);
		expect(attempts).toBe(1);
		expect(await pulseAvailable()).toBe(false);
		expect(attempts).toBe(1);

		now = 5001;
		expect(await pulseAvailable()).toBe(true);
		expect(attempts).toBe(2);
	});
	test("terminates fire-and-forget hooks at their declared timeout", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-omp-hook-timeout-"));
		tempDirs.push(home);
		const hook = join(home, "stalled-hook.ts");
		writeFileSync(hook, "await Bun.sleep(60_000);");

		const startedAt = Date.now();
		const child = launchFireAndForgetHook(hook, "{}", 50, profileEnv(home));
		const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			child.once("close", (code, signal) => resolve({ code, signal }));
		});

		expect(result.code).toBeNull();
		expect(result.signal).toBe("SIGKILL");
		expect(child.killed).toBeTrue();
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});


	test("uses OMP without attempting Claude when no backend is configured", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-omp-backend-"));
		tempDirs.push(home);
		const binDir = join(home, "bin");
		const claudeSentinel = join(home, "claude-called");
		mkdirSync(binDir);

		stubBinary(binDir, "omp", "printf 'OMP_STUB_OK\\n'", "echo OMP_STUB_OK");
		stubBinary(
			binDir,
			"claude",
			`printf called > '${claudeSentinel}'\nprintf 'CLAUDE_STUB\\n'`,
			`echo called>\"${claudeSentinel}\"\r\necho CLAUDE_STUB`,
		);

		const inferencePath = join(import.meta.dir, "../../../TOOLS/Inference.ts");
		const probe = [
			`import { inference } from ${JSON.stringify(inferencePath)};`,
			"const result = await inference({ level: 'low', systemPrompt: 'Return the stub response.', userPrompt: 'probe', timeout: 3000 });",
			"console.log(JSON.stringify(result));",
			"if (!result.success) process.exit(1);",
		].join("\n");
		const childEnv = profileEnv(home, { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`, LIFEOS_HARNESS: "omp" });
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

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim()).output).toBe("OMP_STUB_OK");
		expect(stderr).not.toContain("claude backend");
		expect(existsSync(claudeSentinel)).toBe(false);
	});

	test("supports explicit Claude opt-in and automatic OMP reset", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-manage-backend-"));
		tempDirs.push(home);
		const managePath = join(import.meta.dir, "../../manage.ts");
		const configPath = join(home, ".claude/LIFEOS/USER/CONFIG/inference-backend");
		const runManage = async (...args: string[]) => {
			const child = Bun.spawn([process.execPath, managePath, "inference", ...args], {
				env: profileEnv(home),
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

	test("routes installation and status to the selected OMP profile", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-manage-install-"));
		tempDirs.push(home);
		stageCorePrerequisites(home);
		const agentDir = join(home, "profiles", "work-agent");
		const managePath = join(import.meta.dir, "../../manage.ts");
		const env = profileEnv(home, { PI_CODING_AGENT_DIR: agentDir });

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
		expect(installStdout).toContain("5 added");
		expect(existsSync(join(agentDir, "config.yml"))).toBe(true);
		expect(existsSync(join(agentDir, "APPEND_SYSTEM.md"))).toBe(true);
		expect(existsSync(join(home, "agent", "config.yml"))).toBe(false);
		expect(existsSync(join(home, "agent", "APPEND_SYSTEM.md"))).toBe(false);

		const status = Bun.spawn([process.execPath, managePath, "status"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const statusStdout = await new Response(status.stdout).text();
		expect(await status.exited).toBe(0);
		expect(statusStdout).not.toContain("✗");
		expect(statusStdout).toContain("omp (automatic OMP default) — intelligence layer runs Claude-free");
	});
	test("reviews the transcript belonging to the stopping OMP session", async () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-memory-review-transcript-"));
		tempDirs.push(home);
		stageCorePrerequisites(home);
		const lifeosDir = join(home, ".claude", "LIFEOS");
		const configDir = join(lifeosDir, "USER", "CONFIG");
		const reviewerPath = join(lifeosDir, "TOOLS", "MemoryReviewer.ts");
		const transcriptPath = join(home, "sessions", "session-one.jsonl");
		const argsCapture = join(home, "reviewer-args.json");
		mkdirSync(configDir, { recursive: true });
		mkdirSync(join(home, "sessions"), { recursive: true });
		writeFileSync(join(configDir, "memory-review.json"), JSON.stringify({
			turn_threshold: 1,
			min_minutes_between: 0,
		}));
		writeFileSync(transcriptPath, "{\"type\":\"message\",\"role\":\"user\",\"content\":\"session one\"}\n");
		writeFileSync(
			reviewerPath,
			"await Bun.write(process.env.MEMORY_REVIEW_ARGS!, JSON.stringify(Bun.argv.slice(2)));",
		);

		const indexPath = join(import.meta.dir, "index.ts");
		const probe = [
			`const extension = await import(${JSON.stringify(indexPath)});`,
			"const handlers = new Map();",
			"extension.default({ on: (name, handler) => handlers.set(name, handler), setLabel: () => undefined });",
			"await handlers.get('session_stop')({}, {",
			"  cwd: process.cwd(),",
			"  sessionManager: {",
			"    getSessionId: () => 'omp-session-one',",
			"    getSessionFile: () => process.env.OMP_TEST_TRANSCRIPT,",
			"    getBranch: () => [{ role: 'assistant', content: [{ text: 'different session fallback' }] }],",
			"  },",
			"});",
		].join("\n");
		const env = profileEnv(home, {
			MEMORY_REVIEW_ARGS: argsCapture,
			OMP_TEST_TRANSCRIPT: transcriptPath,
		});
		delete env.CLAUDE_CODE_SUBAGENT_NAME;
		delete env.CLAUDE_CODE_SUBAGENT_TYPE;
		delete env.CLAUDE_AGENT_SDK;
		const child = Bun.spawn([process.execPath, "--eval", probe], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");

		for (let attempt = 0; attempt < 50 && !existsSync(argsCapture); attempt++) {
			await Bun.sleep(20);
		}
		expect(existsSync(argsCapture)).toBe(true);
		expect(JSON.parse(readFileSync(argsCapture, "utf8"))).toEqual([
			"review",
			"--turns",
			"1",
			"--input",
			transcriptPath,
		]);
	});
	test("reports missing hook prerequisites instead of a healthy source", () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-manage-missing-hooks-"));
		tempDirs.push(home);
		const managePath = join(import.meta.dir, "../../manage.ts");
		const env = profileEnv(home);

		const status = Bun.spawnSync([process.execPath, managePath, "status"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(status.exitCode).toBe(0);
		expect(status.stdout.toString()).toContain("source warnings:");
		expect(status.stdout.toString()).toContain("missing bridged hook:");
		expect(status.stdout.toString()).not.toContain("source: ✓");

		const install = Bun.spawnSync([process.execPath, managePath, "install"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(install.exitCode).not.toBe(0);
		expect(existsSync(join(home, "agent", "APPEND_SYSTEM.md"))).toBeFalse();
	});

	test("rejects malformed OMP config before creating integration links", () => {
		const home = mkdtempSync(join(tmpdir(), "lifeos-manage-malformed-"));
		tempDirs.push(home);
		stageCorePrerequisites(home);
		const agentDir = join(home, "agent");
		mkdirSync(agentDir, { recursive: true });
		const configPath = join(agentDir, "config.yml");
		const malformed = "extensions: [\\n";
		writeFileSync(configPath, malformed);

		const managePath = join(import.meta.dir, "../../manage.ts");
		const result = Bun.spawnSync([process.execPath, managePath, "install"], {
			env: profileEnv(home, { PI_CODING_AGENT_DIR: agentDir }),
			stdout: "pipe",
			stderr: "pipe",
		});

		expect(result.exitCode).not.toBe(0);
		expect(readFileSync(configPath, "utf8")).toBe(malformed);
		expect(existsSync(join(agentDir, "APPEND_SYSTEM.md"))).toBe(false);
	});
});
