#!/usr/bin/env bun

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { detectDevTree, resolveInstallRoots, type IdentityPlaceholderVerification, type TemplateVars } from "./InstallEngine";

type JsonRecord = Record<string, unknown>;

const IDENTITY_TOKENS = [
  "{{DA_NAME}}",
  "{{DA_FULL_NAME}}",
  "{{PRINCIPAL_NAME}}",
  "{{PRINCIPAL_FULL_NAME}}",
  "{{PRIMARY_VOICE_ID}}",
  "{{SECONDARY_VOICE_ID}}",
  "{{LIFEOS_VERSION}}",
] as const;
const SKIP_SOURCE_DIRS = new Set(["node_modules", ".git", "install", "USER", "MEMORY", "LIFEOS_INSTALL"]);
const CONTROL_FILES = new Set(["InstallEngine.ts", "RenderIdentity.ts", "RenderIdentity.test.ts"]);
const TEMPLATE_EXTENSIONS = new Set([".md", ".json", ".txt", ".ts", ".toml", ".yaml", ".yml", ".sh", ".tsx", ".jsx", ".js", ".css"]);
const MANIFEST_NAME = ".uai-identity-render.json";
const TEMPLATE_CACHE_NAME = ".uai-identity-templates";

export interface RenderIdentityArgs {
  configRoot: string;
  dataRoot: string;
  apply: boolean;
  allowDev?: boolean;
  templateRoot?: string;
}

export interface RenderIdentityResult {
  ok: boolean;
  dryRun: boolean;
  variables: TemplateVars;
  substitution?: { scanned: number; modified: number; applied: number };
  verification: IdentityPlaceholderVerification;
  skippedModified?: string[];
  refused?: "dev-tree";
}

interface RenderTarget {
  source: string;
  target: string;
}
const sourceTargetCaches = new Map<string, RenderTarget[]>();

interface RenderManifest {
  variables?: TemplateVars;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function nestedString(value: unknown, ...keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readJson(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8"))) ?? {};
  } catch {
    return {};
  }
}

function readToml(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  try {
    return asRecord(Bun.TOML.parse(readFileSync(path, "utf8"))) ?? {};
  } catch {
    return {};
  }
}

function frontmatter(text: string): JsonRecord {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  try {
    return asRecord(Bun.YAML.parse(match[1])) ?? {};
  } catch {
    return {};
  }
}

function markdownField(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`-?\\s*\\*\\*${escaped}:\\*\\*\\s*([^|\\r\\n]+)`, "i"))?.[1]?.trim();
}
function headingName(text: string, kind: "DA" | "Principal"): string | undefined {
  return text.match(new RegExp("^#\\s+" + kind + " Identity\\s+[—-]\\s+(.+)$", "mi"))?.[1]?.trim();
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value?.trim()))?.trim();
}
function markdownVoiceId(text: string, label: string): string | undefined {
  const value = markdownField(text, label);
  if (!value) return undefined;
  return value.match(/`([^`]+)`/)?.[1] ?? value.split(/\s+/, 1)[0];
}

function identityVariables(configRoot: string, dataRoot: string): TemplateVars {
  const settings = readJson(join(configRoot, "settings.json"));
  const daSettings = asRecord(settings.daidentity) ?? {};
  const identityConfigPath = join(dataRoot, "USER", "CONFIG", "LIFEOS_CONFIG.toml");
  const identityConfigText = readText(identityConfigPath);
  const identityConfig = identityConfigText ? readToml(identityConfigPath) : {};
  const daConfig = asRecord(identityConfig.da) ?? {};
  const principalConfig = asRecord(identityConfig.principal) ?? {};
  const daText = readText(join(dataRoot, "USER", "DIGITAL_ASSISTANT", "DA_IDENTITY.md"));
  const principalText = readText(join(dataRoot, "USER", "PRINCIPAL", "PRINCIPAL_IDENTITY.md"));
  const daFrontmatter = frontmatter(daText);
  const principalFrontmatter = frontmatter(principalText);
  const bootstrapConfig = identityConfigText.includes("Bootstrap default")
    && nestedString(principalConfig, "name") === "Your Name"
    && nestedString(daConfig, "name") === "Aria";
  const configValue = (record: JsonRecord, ...keys: string[]): string | undefined =>
    bootstrapConfig ? undefined : nestedString(record, ...keys);

  const daName = first(
    configValue(daConfig, "name"),
    nestedString(daFrontmatter, "core", "name"),
    markdownField(daText, "Name"),
    headingName(daText, "DA"),
    nestedString(daSettings, "name"),
    "LifeOS",
  )!;
  const principalName = first(
    configValue(principalConfig, "name"),
    nestedString(principalFrontmatter, "core", "name"),
    markdownField(principalText, "Name"),
    headingName(principalText, "Principal"),
    "User",
  )!;
  return {
    "{{DA_NAME}}": daName,
    "{{DA_FULL_NAME}}": first(
      configValue(daConfig, "full_name"),
      configValue(daConfig, "display_name"),
      nestedString(daFrontmatter, "core", "full_name"),
      markdownField(daText, "Full Name"),
      nestedString(daSettings, "fullName"),
      daName,
    )!,
    "{{PRINCIPAL_NAME}}": principalName,
    "{{PRINCIPAL_FULL_NAME}}": first(
      configValue(principalConfig, "full_name"),
      nestedString(principalFrontmatter, "core", "full_name"),
      markdownField(principalText, "Full Name"),
      principalName,
    )!,
    "{{PRIMARY_VOICE_ID}}": first(
      configValue(daConfig, "voices", "main", "voice_id"),
      markdownVoiceId(daText, "Voice (main)"),
      nestedString(daSettings, "voices", "main", "voiceId"),
      "21m00Tcm4TlvDq8ikWAM",
    )!,
    "{{SECONDARY_VOICE_ID}}": first(
      configValue(daConfig, "voices", "algorithm", "voice_id"),
      markdownVoiceId(daText, "Voice (algorithm)"),
      nestedString(daSettings, "voices", "algorithm", "voiceId"),
      "pNInz6obpgDQGcFmaJgB",
    )!,
    "{{LIFEOS_VERSION}}": readText(join(configRoot, "LIFEOS", "VERSION")).trim() || "unknown",
  };
}

function hasIdentityToken(text: string): boolean {
  return IDENTITY_TOKENS.some((token) => text.includes(token));
}

function renderTemplate(template: string, variables: TemplateVars): string {
  let rendered = template;
  for (const token of IDENTITY_TOKENS) rendered = rendered.split(token).join(variables[token] ?? token);
  return rendered;
}

function collectTargets(sourceRoot: string, targetRoot: string, targets: RenderTarget[]): void {
  if (!existsSync(sourceRoot)) return;
  const entries = readdirSync(sourceRoot, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.includes(".test.") || !TEMPLATE_EXTENSIONS.has(extname(entry.name).toLowerCase()) || CONTROL_FILES.has(entry.name)) continue;
    const source = join(entry.parentPath, entry.name);
    const relativePath = relative(sourceRoot, source);
    if (relativePath.split(/[\\/]/).some((segment) => SKIP_SOURCE_DIRS.has(segment))) continue;
    const sourceText = readFileSync(source, "utf8");
    if (hasIdentityToken(sourceText)) targets.push({ source, target: join(targetRoot, relativePath) });
  }
}
function cachedTargets(configRoot: string): RenderTarget[] {
  const cacheRoot = join(configRoot, TEMPLATE_CACHE_NAME);
  if (!existsSync(cacheRoot)) return [];
  const targets: RenderTarget[] = [];
  for (const entry of readdirSync(cacheRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = join(entry.parentPath, entry.name);
    targets.push({ source, target: join(configRoot, relative(cacheRoot, source)) });
  }
  return targets;
}

function ownedTargets(configRoot: string, templateRoot = join(import.meta.dir, "..", "install")): RenderTarget[] {
  const cacheKey = resolve(templateRoot);
  let sourceTargets = sourceTargetCaches.get(cacheKey);
  if (!sourceTargets) {
    const relativeTargets: RenderTarget[] = [];
    for (const [source, target] of [
      [join(templateRoot, "hooks"), "hooks"],
      [join(templateRoot, "agents"), "agents"],
      [join(templateRoot, "skills"), "skills"],
      [join(templateRoot, "LIFEOS"), "LIFEOS"],
    ] as const) collectTargets(source, target, relativeTargets);
    const byRelativeTarget = new Map<string, RenderTarget>();
    for (const target of relativeTargets) byRelativeTarget.set(target.target, target);
    sourceTargets = [...byRelativeTarget.values()];
    sourceTargetCaches.set(cacheKey, sourceTargets);
  }
  const byTarget = new Map<string, RenderTarget>();
  for (const target of cachedTargets(configRoot)) byTarget.set(resolve(target.target), target);
  for (const { source, target } of sourceTargets) {
    const absoluteTarget = join(configRoot, target);
    byTarget.set(resolve(absoluteTarget), { source, target: absoluteTarget });
  }
  return [...byTarget.values()].sort((a, b) => a.target.localeCompare(b.target));
}

function verifyTargets(targets: RenderTarget[], projected = new Map<string, string>()): IdentityPlaceholderVerification {
  const files: IdentityPlaceholderVerification["files"] = [];
  for (const { target } of targets) {
    if (!existsSync(target)) continue;
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
    const text = projected.get(resolve(target)) ?? readFileSync(target, "utf8");
    for (const token of IDENTITY_TOKENS) {
      const count = text.split(token).length - 1;
      if (count > 0) files.push({ file: target, placeholder: token, count });
    }
  }
  return { passed: files.length === 0, files, total: files.reduce((sum, file) => sum + file.count, 0) };
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600;
  const temporary = `${path}.uai-render-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

function previousVariables(path: string): TemplateVars | undefined {
  const manifest = readJson(path) as RenderManifest;
  const variables = asRecord(manifest.variables);
  return variables ? variables as TemplateVars : undefined;
}
function matchesRenderedTemplate(current: string, sourceTemplate: string): boolean {
  const tokenPattern = /\{\{(?:DA_NAME|DA_FULL_NAME|PRINCIPAL_NAME|PRINCIPAL_FULL_NAME|PRIMARY_VOICE_ID|SECONDARY_VOICE_ID|LIFEOS_VERSION)\}\}/g;
  const literals = sourceTemplate.split(tokenPattern);
  if (literals.length === 1) return current === sourceTemplate;
  const escape = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${literals.map(escape).join("[^\r\n]*")}$`).test(current);
}

export function renderIdentity(args: RenderIdentityArgs): RenderIdentityResult {
  const variables = identityVariables(args.configRoot, args.dataRoot);
  const targets = ownedTargets(args.configRoot, args.templateRoot);
  if (args.apply && detectDevTree(args.configRoot) && !args.allowDev) {
    return {
      ok: false,
      dryRun: false,
      refused: "dev-tree",
      variables,
      verification: verifyTargets(targets),
    };
  }

  const manifestPath = join(args.configRoot, MANIFEST_NAME);
  const priorVariables = previousVariables(manifestPath);
  const projected = new Map<string, string>();
  const skippedModified: string[] = [];
  let scanned = 0;
  let modified = 0;
  for (const { source, target } of targets) {
    if (!existsSync(target)) continue;
    const targetMetadata = lstatSync(target);
    if (targetMetadata.isSymbolicLink() || !targetMetadata.isFile()) {
      skippedModified.push(target);
      continue;
    }
    scanned += 1;
    const sourceTemplate = readFileSync(source, "utf8");
    if (args.apply) {
      const relativeTarget = relative(args.configRoot, target);
      const cacheTarget = join(args.configRoot, TEMPLATE_CACHE_NAME, relativeTarget);
      if (resolve(source) !== resolve(cacheTarget) && (!existsSync(cacheTarget) || readFileSync(cacheTarget, "utf8") !== sourceTemplate)) {
        atomicWrite(cacheTarget, sourceTemplate);
      }
    }
    const current = readFileSync(target, "utf8");
    let next: string | undefined;
    if (current === sourceTemplate) {
      next = renderTemplate(sourceTemplate, variables);
    } else if (priorVariables && current === renderTemplate(sourceTemplate, priorVariables)) {
      next = renderTemplate(sourceTemplate, variables);
    } else if (matchesRenderedTemplate(current, sourceTemplate)) {
      next = renderTemplate(sourceTemplate, variables);
    } else if (hasIdentityToken(current)) {
      skippedModified.push(target);
    }
    if (next !== undefined && next !== current) {
      projected.set(resolve(target), next);
      if (args.apply) atomicWrite(target, next);
      modified += 1;
    }
  }
  if (args.apply) atomicWrite(manifestPath, JSON.stringify({ variables }, null, 2) + "\n");
  const verification = verifyTargets(targets, projected);
  return {
    ok: verification.passed,
    dryRun: !args.apply,
    variables,
    substitution: { scanned, modified, applied: args.apply ? modified : 0 },
    verification,
    skippedModified,
  };
}

function parseArgs(argv = process.argv.slice(2)): RenderIdentityArgs {
  const roots = resolveInstallRoots();
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    configRoot: value("--config-root") || roots.configRoot,
    dataRoot: value("--config-dir") || roots.dataRoot,
    apply: argv.includes("--apply"),
    allowDev: argv.includes("--allow-dev"),
  };
}

if (import.meta.main || import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const result = renderIdentity(parseArgs());
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
