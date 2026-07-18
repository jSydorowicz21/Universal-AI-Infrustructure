import { randomUUID } from "node:crypto";
import { basename, normalize, resolve } from "node:path";
import { createSessionIdentity } from "../UNIVERSAL/canonical";

export interface OmpSessionManagerLike {
	getSessionFile?: () => string | undefined;
}

export interface OmpSessionContextLike {
	cwd?: string;
	sessionManager?: OmpSessionManagerLike;
}

export interface OmpSessionIdentity {
	uaiSessionId: string;
	nativeSessionId: string;
	profileRoot: string;
	transcriptPath?: string;
}

let anonymousManagers = new WeakMap<object, string>();
let anonymousContexts = new WeakMap<object, string>();

function normalizedAbsolute(path: string): string {
	return normalize(resolve(path));
}

function anonymousNativeId(ctx: OmpSessionContextLike): string {
	const manager = ctx.sessionManager;
	if (manager && typeof manager === "object") {
		const existing = anonymousManagers.get(manager);
		if (existing) return existing;
		const created = randomUUID();
		anonymousManagers.set(manager, created);
		return created;
	}
	if (ctx && typeof ctx === "object") {
		const existing = anonymousContexts.get(ctx);
		if (existing) return existing;
		const created = randomUUID();
		anonymousContexts.set(ctx, created);
		return created;
	}
	return randomUUID();
}

export function getOmpSessionIdentity(ctx: OmpSessionContextLike, profileRoot: string): OmpSessionIdentity {
	const rawTranscript = ctx.sessionManager?.getSessionFile?.();
	const transcriptPath = typeof rawTranscript === "string" && rawTranscript.trim().length > 0
		? normalizedAbsolute(rawTranscript)
		: undefined;
	const nativeSessionId = transcriptPath
		? basename(transcriptPath).replace(/\.(jsonl|json)$/i, "")
		: anonymousNativeId(ctx);
	const normalizedRoot = normalizedAbsolute(profileRoot);
	const canonical = createSessionIdentity({
		adapterId: "omp",
		profileRoot: normalizedRoot,
		nativeSessionId,
		entropy: transcriptPath ?? nativeSessionId,
	});
	return {
		uaiSessionId: canonical.uaiSessionId,
		nativeSessionId,
		profileRoot: canonical.profileRoot,
		transcriptPath,
	};
}

export function resetOmpSessionIdentitiesForTests(): void {
	anonymousManagers = new WeakMap<object, string>();
	anonymousContexts = new WeakMap<object, string>();
}
