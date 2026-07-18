import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createWorkState(): { lifeosDir: string; workJson: string } {
	const lifeosDir = mkdtempSync(join(tmpdir(), "lifeos-observability-"));
	tempDirs.push(lifeosDir);
	const stateDir = join(lifeosDir, "MEMORY", "STATE");
	mkdirSync(stateDir, { recursive: true });
	const workJson = join(stateDir, "work.json");
	writeFileSync(workJson, JSON.stringify({
		sessions: {
			"current-session": { phase: "execute", effort: "E3", updatedAt: "2020-01-01T00:00:00.000Z" },
			"other-session": { phase: "verify", effort: "E5", updatedAt: "2099-01-01T00:00:00.000Z" },
			"completed-session": { phase: "complete", effort: "E4", updatedAt: "2099-01-01T00:00:00.000Z" },
		},
	}));
	return { lifeosDir, workJson };
}

describe("LifeOS depth indicator", () => {
	test("renders only the current OMP session's Algorithm state", async () => {
		const { lifeosDir, workJson } = createWorkState();
		const previousLifeosDir = process.env.LIFEOS_DIR;
		process.env.LIFEOS_DIR = lifeosDir;
		try {
			// Import after LIFEOS_DIR is isolated; the extension resolves its state path at module load.
			const extension = await import(`./index.ts?test=${Date.now()}`);
			const event = {
				toolName: "edit",
				input: {
					content: "x".repeat(400),
					file_path: "/tmp/MEMORY/WORK/current-session/ISA.md",
				},
			};

			expect(extension.workSlugFromToolEvent(event)).toBe("current-session");
			expect(extension.workSlugFromToolEvent({
				input: { path: "C:\\Users\\test\\MEMORY\\WORK\\windows-session\\ISA.md" },
			})).toBe("windows-session");
			expect(extension.depthTagForSession("current-session", workJson)).toBe(" · ALGO execute E3");
			expect(extension.depthTagForSession("completed-session", workJson)).toBe(" · DIRECT");
			expect(extension.depthTagForSession("", workJson)).toBe(" · DIRECT");

			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			extension.default({
				on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
				setLabel: () => undefined,
				registerCommand: () => undefined,
			});

			let status = "";
			const ctx = {
				hasUI: true,
				ui: {
					setStatus: (_key: string, value: string) => { status = value; },
					setWidget: () => undefined,
					notify: () => undefined,
				},
			};

			handlers.get("session_start")?.({}, ctx);
			expect(status).toBe("LifeOS · 🔧0 · DIRECT");

			await handlers.get("tool_execution_end")?.(event, ctx);
			expect(status).toBe("LifeOS · 🔧1 · ALGO execute E3");
			expect(status).not.toContain("verify");
			expect(status).not.toContain("E5");
		} finally {
			if (previousLifeosDir === undefined) delete process.env.LIFEOS_DIR;
			else process.env.LIFEOS_DIR = previousLifeosDir;
		}
	});

	test("isolates counters and Algorithm state across concurrent OMP sessions", async () => {
		const { lifeosDir } = createWorkState();
		const previousLifeosDir = process.env.LIFEOS_DIR;
		process.env.LIFEOS_DIR = lifeosDir;
		try {
			const extension = await import(`./index.ts?test=isolation-${Date.now()}`);
			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			extension.default({
				on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
				setLabel: () => undefined,
				registerCommand: () => undefined,
			});

			let firstStatus = "";
			let secondStatus = "";
			const firstCtx = {
				hasUI: true,
				sessionManager: { getSessionId: () => "omp-session-one" },
				ui: {
					setStatus: (_key: string, value: string) => { firstStatus = value; },
					setWidget: () => undefined,
				},
			};
			const secondCtx = {
				hasUI: true,
				sessionManager: { getSessionId: () => "omp-session-two" },
				ui: {
					setStatus: (_key: string, value: string) => { secondStatus = value; },
					setWidget: () => undefined,
				},
			};
			const firstEvent = {
				toolName: "edit",
				input: { file_path: "/tmp/MEMORY/WORK/current-session/ISA.md" },
			};
			const secondEvent = {
				toolName: "read",
				input: { path: "/tmp/MEMORY/WORK/other-session/ISA.md" },
			};

			handlers.get("session_start")?.({}, firstCtx);
			handlers.get("session_start")?.({}, secondCtx);
			await handlers.get("tool_execution_end")?.(firstEvent, firstCtx);
			await handlers.get("tool_execution_end")?.(firstEvent, firstCtx);
			await handlers.get("tool_result")?.({
				toolName: "edit",
				isError: true,
				content: [{ text: "first session failure" }],
			}, firstCtx);
			await handlers.get("tool_execution_end")?.(secondEvent, secondCtx);

			expect(firstStatus).toBe("LifeOS · 🔧2 ✗1 · ALGO execute E3");
			expect(secondStatus).toBe("LifeOS · 🔧1 · ALGO verify E5");

			await handlers.get("session_shutdown")?.({}, firstCtx);
			await handlers.get("session_start")?.({}, firstCtx);
			expect(firstStatus).toBe("LifeOS · 🔧0 · DIRECT");
			expect(secondStatus).toBe("LifeOS · 🔧1 · ALGO verify E5");
		} finally {
			if (previousLifeosDir === undefined) delete process.env.LIFEOS_DIR;
			else process.env.LIFEOS_DIR = previousLifeosDir;
		}
	});

	test("degrades the statusline command explicitly when bash is unavailable", async () => {
		const { lifeosDir } = createWorkState();
		const previousLifeosDir = process.env.LIFEOS_DIR;
		process.env.LIFEOS_DIR = lifeosDir;
		try {
			const extension = await import(`./index.ts?test=no-bash-${Date.now()}`);
			const commands = new Map<string, {
				handler: (args: string | undefined, ctx: unknown) => unknown;
			}>();
			extension.default({
				on: () => undefined,
				setLabel: () => undefined,
				registerCommand: (name: string, spec: {
					handler: (args: string | undefined, ctx: unknown) => unknown;
				}) => commands.set(name, spec),
			}, { bash: null });

			let notice = "";
			let level = "";
			let widgetCleared = false;
			commands.get("statusline")?.handler("on", {
				hasUI: true,
				ui: {
					setWidget: (_key: string, value: unknown) => { widgetCleared = value === undefined; },
					notify: (message: string, severity: string) => {
						notice = message;
						level = severity;
					},
				},
			});

			expect(widgetCleared).toBe(true);
			expect(level).toBe("warning");
			expect(notice).toBe("LifeOS statusline unavailable: bash is not installed");
		} finally {
			if (previousLifeosDir === undefined) delete process.env.LIFEOS_DIR;
			else process.env.LIFEOS_DIR = previousLifeosDir;
		}
	});
});
