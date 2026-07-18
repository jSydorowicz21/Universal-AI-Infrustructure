import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type DataClass = "PUBLIC" | "INTERNAL" | "SENSITIVE" | "RESTRICTED";
export interface PolicyDecision { action: "allow" | "block" | "taint" | "advisory"; reason: string; dataClass?: DataClass; provenance?: { sourceUri: string; tool: string; tainted: true } }

const DATA_CLASS_RANK: Record<DataClass, number> = { PUBLIC: 0, INTERNAL: 1, SENSITIVE: 2, RESTRICTED: 3 };
const DESTRUCTIVE_OR_SECRET_COMMANDS = [
  /(?:^|\s)(?:[A-Za-z]:[\\/][^\s]*[\\/]|\/[^\s/]+\/)*(?:rm|rm\.exe)\s+(?=[^\r\n]*(?:-[^\s]*r[^\s]*\s|--recursive))(?=[^\r\n]*(?:-[^\s]*f[^\s]*\s|--force))(?:[^\r\n]*\s)?(?:--\s+)?(?:\/|~|[A-Za-z]:\\)(?:\s|$)/i,
  /(?:^|\s)(?:remove-item|ri)\b(?=[^\r\n]*(?:-recurse\b|-r\b))(?=[^\r\n]*(?:-force\b|-fo\b))[^\r\n]*(?:[A-Za-z]:\\|\/|~)/i,
  /(?:^|\s)(?:curl|curl\.exe|wget|invoke-webrequest|iwr)\b[^\r\n]*(?:authorization|api[-_]?key|x-api-key|bearer\s+|\$(?:env:)?(?:token|secret|password|api_key))/i,
  /(?:^|\s)(?:format|diskpart)(?:\s|$)/i,
  /(?:^|\s)(?:del|erase)\s+(?=[^\r\n]*(?:\/s|-s))(?=[^\r\n]*(?:\/q|-q))[^\r\n]*[A-Za-z]:\\/i,
  /(?:^|\s)(?:rd|rmdir)\s+(?=[^\r\n]*(?:\/s|-s))(?=[^\r\n]*(?:\/q|-q))[^\r\n]*[A-Za-z]:\\/i,
  /(?:^|\s)(?:rm|del)\b(?=[^\r\n]*(?:-recurse\b|-r\b))(?=[^\r\n]*(?:-force\b|-f\b))[^\r\n]*[A-Za-z]:\\/i,
  /(?:^|\s)(?:curl|curl\.exe|wget|invoke-webrequest|iwr)\b[^\r\n]*(?:-f|--form|--data-binary|--post-file|--upload-file|-infile|-t)[^\r\n]*(?:@)?(?:~\/\.ssh|\.env\b|id_rsa|credential)/i,
] as const;
const SAFE_COMMAND = /^(?:echo(?:\s+[A-Za-z0-9._:/@+-]+)*|printf\s+['"]?[A-Za-z0-9 ._:/@%+-]+['"]?|pwd|whoami|[A-Za-z0-9._-]+\s+--version)$/;

export function evaluateCommand(command: string): PolicyDecision {
  const trimmed = command.trim();
  if (!trimmed) return { action: "advisory", reason: "empty command has no proven safe semantics" };
  if (DESTRUCTIVE_OR_SECRET_COMMANDS.some((pattern) => pattern.test(trimmed))) {
    return { action: "block", reason: "forbidden destructive or secret-bearing command" };
  }
  if (SAFE_COMMAND.test(trimmed)) return { action: "allow", reason: "command matched the narrow non-mutating allowlist" };
  return { action: "advisory", reason: "command syntax is unparsed or outside the narrow safe allowlist" };
}

function within(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  const delta = relative(normalizedRoot, normalizedPath);
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function nearestExisting(path: string): string {
  let cursor = resolve(path);
  while (true) {
    try {
      lstatSync(cursor);
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = resolve(cursor, "..");
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

function physicallyWithin(path: string, root: string): boolean {
  if (!within(path, root)) return false;
  try {
    const rootPath = resolve(root);
    try {
      if (lstatSync(rootPath).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const rootAnchor = nearestExisting(rootPath);
    const pathAnchor = nearestExisting(resolve(path));
    const physicalRootAnchor = realpathSync(rootAnchor);
    const physicalPathAnchor = realpathSync(pathAnchor);
    return within(physicalPathAnchor, physicalRootAnchor);
  } catch {
    return false;
  }
}

export function evaluateWrite(path: string, roots: { systemRoot: string; userRoot: string }): PolicyDecision {
  if (within(path, roots.systemRoot)) return { action: "block", reason: "SYSTEM boundary is immutable during tool execution" };
  if (physicallyWithin(path, roots.userRoot)) return { action: "allow", reason: "USER boundary allows physically contained user-owned writes" };
  return { action: "block", reason: "write falls outside or crosses a linked declared profile root" };
}

export function taintExternalContent(input: { output: unknown; sourceUri: string; tool: string }): { output: unknown; policy: PolicyDecision } {
  if (!input.sourceUri) throw new Error("External content requires a source URI");
  return { output: input.output, policy: { action: "taint", reason: "external content carries provenance; no prevention claim", provenance: { sourceUri: input.sourceUri, tool: input.tool, tainted: true } } };
}

export function evaluateRoute(input: { dataClass: DataClass; route?: { id: string; maximumDataClass: DataClass } }): PolicyDecision {
  if (!input.route) return input.dataClass === "PUBLIC"
    ? { action: "allow", reason: "unknown route defaults to PUBLIC ceiling", dataClass: input.dataClass }
    : { action: "block", reason: "unknown route has PUBLIC ceiling", dataClass: input.dataClass };
  if (DATA_CLASS_RANK[input.dataClass] > DATA_CLASS_RANK[input.route.maximumDataClass]) return { action: "block", reason: `route ${input.route.id} ceiling is ${input.route.maximumDataClass}`, dataClass: input.dataClass };
  return { action: "allow", reason: `route ${input.route.id} permits ${input.dataClass}`, dataClass: input.dataClass };
}
