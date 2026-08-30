import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(lifeosDir, "profile");
		process.env.LIFEOS_DIR = lifeosDir;
		try {
			// Import after LIFEOS_DIR is isolated; the extension resolves its state path at module load.
			const extension = await import(`./index.ts?test=${Date.now()}`);
			const event = {
				toolName: "edit",
				input: {
					headers: { authorization: "Bearer SECRET_NESTED_123" },
					patch: { new_string: "SECRET_NESTED_123" },
					content: "x".repeat(400),
					file_path: "/tmp/MEMORY/WORK/current-session/ISA.md",
				},
			};

			expect(extension.workSlugFromToolEvent(event)).toBe("current-session");
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
				sessionManager: { getSessionFile: () => join(lifeosDir, "profile", "sessions", "native-a.jsonl") },
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

			const secondCtx = {
				...ctx,
				sessionManager: { getSessionFile: () => join(lifeosDir, "profile", "sessions", "native-b.jsonl") },
			};
			await handlers.get("tool_execution_end")?.(event, secondCtx);
			const activityRaw = readFileSync(join(lifeosDir, "MEMORY", "OBSERVABILITY", "tool-activity.jsonl"), "utf8");
			expect(activityRaw).not.toContain("SECRET_NESTED_123");
			expect(activityRaw).toContain("[REDACTED]");
			const activity = readFileSync(join(lifeosDir, "MEMORY", "OBSERVABILITY", "tool-activity.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { session_id: string; native_session_id: string });
			expect(activity.map((row) => row.native_session_id)).toEqual(["native-a", "native-b"]);
			expect(activity[0].session_id).not.toBe(activity[1].session_id);
		} finally {
			if (previousLifeosDir === undefined) delete process.env.LIFEOS_DIR;
			else process.env.LIFEOS_DIR = previousLifeosDir;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});
