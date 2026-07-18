/**
 * lifeos-memory — OMP extension that injects LifeOS memory into every turn.
 *
 * Ports two Claude Code mechanisms into OMP's extension runtime:
 *   1. LoadMemory.hook.ts  -> ambient hot-layer memory (PRINCIPAL_MEMORY.md,
 *      DA_MEMORY.md) rendered as a <pai-memory> block on every prompt.
 *   2. MemoryRetriever.ts   -> prompt-keyed BM25 retrieval over the KNOWLEDGE
 *      corpus, rendered as a <pai-knowledge> block when there are hits.
 *
 * Injection point: `before_agent_start` (OMP's analog of Claude Code's
 * UserPromptSubmit additionalContext) returns a message the agent sees.
 *
 * Doctrine: hot-path, fail-open. Any error -> inject nothing, never throw into
 * the agent loop. Retrieval is capped by a hard subprocess timeout.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

// --- Minimal typed surface of the bits of ExtensionAPI we touch -------------

interface ExtensionCtx {
	hasUI?: boolean;
	cwd?: string;
	sessionManager?: { getBranch?: () => unknown[] };
	ui?: { notify?: (message: string, level?: string) => void };
}

interface ExtensionApi {
	on: (event: string, handler: (event: unknown, ctx: ExtensionCtx) => unknown) => void;
	setLabel?: (label: string) => void;
}

interface InjectResult {
	message: {
		customType: string;
		content: Array<{ type: "text"; text: string }>;
		display: boolean;
	};
}

// --- Paths ------------------------------------------------------------------

const HOME = homedir();
const CONFIG_ROOT = process.env.LIFEOS_CONFIG_ROOT || process.env.CLAUDE_CONFIG_DIR || pathResolve(HOME, ".claude");
const LIFEOS_DIR = process.env.LIFEOS_DIR || pathResolve(CONFIG_ROOT, "LIFEOS");
const PRINCIPAL_MEMORY = pathResolve(LIFEOS_DIR, "USER/PRINCIPAL/PRINCIPAL_MEMORY.md");
const DA_MEMORY = pathResolve(LIFEOS_DIR, "USER/DIGITAL_ASSISTANT/DA_MEMORY.md");
const RETRIEVER = process.env.LIFEOS_MEMORY_RETRIEVER || pathResolve(LIFEOS_DIR, "TOOLS/MemoryRetriever.ts");
const BUN = typeof Bun !== "undefined" ? Bun.which("bun") || process.execPath : "bun";
const RETRIEVAL_TIMEOUT_MS = 300;

const ENTRIES_START = "<!-- BEGIN ENTRIES -->";
const ENTRIES_END = "<!-- END ENTRIES -->";

// --- Hot-layer memory (ported from LoadMemory.hook.ts) ----------------------

interface MemoryRead {
	entries: string[];
	count: number;
	charsUsed: number;
}

function readMemory(path: string): MemoryRead {
	if (!existsSync(path)) return { entries: [], count: 0, charsUsed: 0 };
	try {
		const raw = readFileSync(path, "utf8");
		const startIdx = raw.indexOf(ENTRIES_START);
		const endIdx = raw.indexOf(ENTRIES_END);
		if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
			return { entries: [], count: 0, charsUsed: 0 };
		}
		const block = raw.slice(startIdx + ENTRIES_START.length, endIdx).trim();
		if (!block) return { entries: [], count: 0, charsUsed: 0 };
		const entries = block
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		const charsUsed = entries.reduce((sum, entry) => sum + entry.length, 0);
		return { entries, count: entries.length, charsUsed };
	} catch {
		return { entries: [], count: 0, charsUsed: 0 };
	}
}

function renderBlock(title: string, mem: MemoryRead, capEntries = 48, capChars = 12288): string {
	const header = `## ${title} [${mem.count}/${capEntries} entries · ${mem.charsUsed}/${capChars} chars]`;
	if (mem.count === 0) return `${header}\n(no entries yet)`;
	return `${header}\n${mem.entries.join("\n")}`;
}

// --- Prompt-keyed retrieval (wraps MemoryRetriever.ts) ----------------------

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(extractText).filter((s) => s.length > 0).join("\n");
	if (value !== null && typeof value === "object") {
		if ("text" in value && typeof value.text === "string") return value.text;
		if ("content" in value) return extractText(value.content);
	}
	return "";
}

function latestUserText(ctx: ExtensionCtx): string {
	const branch = ctx.sessionManager?.getBranch?.();
	if (!Array.isArray(branch)) return "";
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry !== null && typeof entry === "object" && "role" in entry && entry.role === "user" && "content" in entry) {
			const text = extractText(entry.content).trim();
			if (text.length > 0) return text;
		}
	}
	return "";
}

async function retrieve(query: string): Promise<string> {
	if (query.length < 3 || !existsSync(RETRIEVER)) return "";
	const { promise, resolve } = Promise.withResolvers<string>();
	let stdout = "";
	let settled = false;
	try {
		const child = spawn(BUN, [RETRIEVER, query, "--raw", "--top", "3", "--budget", "600"], {
			env: { ...process.env, LIFEOS_CONFIG_ROOT: CONFIG_ROOT, LIFEOS_DIR },
			stdio: ["ignore", "pipe", "ignore"],
		});
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			resolve("");
		}, RETRIEVAL_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < 64_000) stdout += chunk.toString();
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const out = stdout.trim();
			resolve(code === 0 && !/\bno (results|matches|hits)\b/i.test(out) ? out : "");
		});
		child.on("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve("");
		});
	} catch {
		resolve("");
	}
	return promise;
}

// --- Factory ----------------------------------------------------------------

export default function lifeosMemory(pi: ExtensionApi): void {
	pi.setLabel?.("LifeOS Memory");

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui?.notify?.("LifeOS memory active (hot-layer + knowledge retrieval)", "info");
	});

	pi.on("before_agent_start", async (event, ctx): Promise<InjectResult | undefined> => {
		try {
			const principal = renderBlock("PRINCIPAL MEMORY", readMemory(PRINCIPAL_MEMORY));
			const da = renderBlock("DA MEMORY", readMemory(DA_MEMORY));
			const parts: string[] = [`<pai-memory>\n${principal}\n\n${da}\n</pai-memory>`];

			const eventPrompt = event !== null && typeof event === "object" && "prompt" in event && typeof event.prompt === "string" ? event.prompt : "";
			const query = eventPrompt.length > 0 ? eventPrompt : latestUserText(ctx);
			const knowledge = await retrieve(query);
			if (knowledge.length > 0) {
				const label = query.slice(0, 80).replace(/"/g, "'");
				parts.push(`<pai-knowledge query="${label}">\n${knowledge}\n</pai-knowledge>`);
			}

			return {
				message: {
					customType: "pai-memory",
					content: [{ type: "text", text: parts.join("\n\n") }],
					display: false,
				},
			};
		} catch {
			return undefined; // fail-open: never block the turn
		}
	});
}
