import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a stalled knowledge retrieval cannot block the OMP turn", async () => {
	const root = mkdtempSync(join(tmpdir(), "lifeos-memory-timeout-"));
	const retriever = join(root, "Retriever.ts");
	writeFileSync(retriever, "await Promise.withResolvers<void>().promise;\n");

	const previous = {
		configRoot: process.env.LIFEOS_CONFIG_ROOT,
		lifeosDir: process.env.LIFEOS_DIR,
		retriever: process.env.LIFEOS_MEMORY_RETRIEVER,
	};
	process.env.LIFEOS_CONFIG_ROOT = root;
	process.env.LIFEOS_DIR = join(root, "LIFEOS");
	process.env.LIFEOS_MEMORY_RETRIEVER = retriever;

	try {
		// Dynamic import is intentional: these selected-profile paths are module-load constants.
		const extension = await import(`./index.ts?timeout=${Date.now()}`);
		let beforeAgentStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
		extension.default({
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
			setLabel: () => undefined,
		});
		expect(beforeAgentStart).toBeDefined();

		// This is an integration check of the real subprocess kill timer; fake timers cannot drive
		// the child-process close event that completes the retrieval promise.
		const started = Date.now();
		const result = await beforeAgentStart?.({ prompt: "a retrieval query" }, {});
		expect(Date.now() - started).toBeLessThan(1_500);
		expect(result).toBeDefined();
	} finally {
		if (previous.configRoot === undefined) delete process.env.LIFEOS_CONFIG_ROOT;
		else process.env.LIFEOS_CONFIG_ROOT = previous.configRoot;
		if (previous.lifeosDir === undefined) delete process.env.LIFEOS_DIR;
		else process.env.LIFEOS_DIR = previous.lifeosDir;
		if (previous.retriever === undefined) delete process.env.LIFEOS_MEMORY_RETRIEVER;
		else process.env.LIFEOS_MEMORY_RETRIEVER = previous.retriever;
		rmSync(root, { recursive: true, force: true });
	}
});
