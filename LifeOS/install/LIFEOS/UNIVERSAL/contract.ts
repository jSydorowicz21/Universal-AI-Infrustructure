export const ADAPTER_CONTRACT = "uai.adapter.v1" as const;

export const EXTERNAL_ADAPTER_ID_REGEX = /^external:[a-z0-9][a-z0-9._-]*$/;
export const EXTERNAL_ADAPTER_ID_PATTERN = EXTERNAL_ADAPTER_ID_REGEX.source;
export type ExternalAdapterId = `external:${string}`;
export function isExternalAdapterId(value: unknown): value is ExternalAdapterId {
  return typeof value === "string" && EXTERNAL_ADAPTER_ID_REGEX.test(value);
}
export function isAdapterId(value: unknown): value is AdapterId {
  return value === "claude" || value === "omp" || value === "codex" || value === "opencode" || value === "unknown" || isExternalAdapterId(value);
}

export type AdapterId = "claude" | "omp" | "codex" | "opencode" | ExternalAdapterId | "unknown";
export type AdapterClass = "native" | "compatibility" | "wrapper-proxy" | "discovery-only" | "unsupported";
export type CapabilityState = "unsupported" | "detected" | "installed" | "wired" | "active" | "degraded" | "failed" | "declined";
export type CertificationLevel = "C0" | "C1" | "C2" | "C2-W" | "C3" | "C4" | "C5";
export type FailMode = "fail-closed" | "fail-visible-open" | "advisory" | "unsupported";

export interface EvidenceTuple {
  adapterVersion: string;
  cliVersion: string;
  platform: { os: string; profile: string };
  probeId: string;
  observedAt: string;
  evidenceUri: string;
}

export interface CapabilityRecord {
  critical?: boolean;
  state: CapabilityState;
  failMode?: FailMode;
  evidence?: EvidenceTuple;
  losses?: string[];
}

export interface AdapterDescriptor {
  contract: typeof ADAPTER_CONTRACT;
  adapter: { id: AdapterId; version: string; class: AdapterClass };
  discovery: { state: "detected" | "unsupported"; confidence: number; roots?: string[]; cliVersion?: string };
  capabilities?: Record<string, CapabilityRecord>;
  certification?: CertificationLevel;
  losses?: string[];
}

export interface ValidationResult { ok: boolean; errors: string[] }

const ADAPTER_CLASSES: Record<AdapterClass, true> = {
  native: true,
  compatibility: true,
  "wrapper-proxy": true,
  "discovery-only": true,
  unsupported: true,
};
const CAPABILITY_STATES: Record<CapabilityState, true> = {
  unsupported: true,
  detected: true,
  installed: true,
  wired: true,
  active: true,
  degraded: true,
  failed: true,
  declined: true,
};
const CERTIFICATIONS: Record<CertificationLevel, true> = { C0: true, C1: true, C2: true, "C2-W": true, C3: true, C4: true, C5: true };
const FAIL_MODES: Record<FailMode, true> = { "fail-closed": true, "fail-visible-open": true, advisory: true, unsupported: true };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validIsoDate(value: unknown): boolean {
  if (!text(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day)
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59;
}

function rejectAdditionalProperties(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path || "descriptor"}.${key} is not allowed`);
  }
}

function validateStringArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) errors.push(`${path} must be an array of strings`);
}

function validateEvidence(value: unknown, path: string, errors: string[]): void {
  if (!object(value)) { errors.push(`${path} must be an object`); return; }
  rejectAdditionalProperties(value, ["adapterVersion", "cliVersion", "platform", "probeId", "observedAt", "evidenceUri"], path, errors);
  for (const field of ["adapterVersion", "cliVersion", "probeId", "evidenceUri"] as const) {
    if (!text(value[field])) errors.push(`${path}.${field} is required`);
  }
  if (!validIsoDate(value.observedAt)) errors.push(`${path}.observedAt must be an ISO timestamp`);
  if (!object(value.platform)) errors.push(`${path}.platform is required`);
  else {
    rejectAdditionalProperties(value.platform, ["os", "profile"], `${path}.platform`, errors);
    if (!text(value.platform.os)) errors.push(`${path}.platform.os is required`);
    if (!text(value.platform.profile)) errors.push(`${path}.platform.profile is required`);
  }
}

export function validateAdapterDescriptor(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!object(value)) return { ok: false, errors: ["descriptor must be an object"] };
  rejectAdditionalProperties(value, ["contract", "adapter", "discovery", "capabilities", "certification", "losses"], "", errors);
  if (value.contract !== ADAPTER_CONTRACT) errors.push(`contract must equal ${ADAPTER_CONTRACT}`);
  if (!object(value.adapter)) errors.push("adapter is required");
  else {
    rejectAdditionalProperties(value.adapter, ["id", "version", "class"], "adapter", errors);
    const id = value.adapter.id;
    if (!text(id) || !isAdapterId(id)) errors.push("adapter.id is invalid");
    if (!text(value.adapter.version)) errors.push("adapter.version is required");
    if (!text(value.adapter.class) || !ADAPTER_CLASSES[value.adapter.class as AdapterClass]) errors.push("adapter.class is invalid");
  }
  if (!object(value.discovery)) errors.push("discovery is required");
  else {
    rejectAdditionalProperties(value.discovery, ["state", "confidence", "roots", "cliVersion"], "discovery", errors);
    if (value.discovery.state !== "detected" && value.discovery.state !== "unsupported") errors.push("discovery.state is invalid");
    if (typeof value.discovery.confidence !== "number" || !Number.isFinite(value.discovery.confidence) || value.discovery.confidence < 0 || value.discovery.confidence > 1) errors.push("discovery.confidence must be between 0 and 1");
    if (value.discovery.roots !== undefined) validateStringArray(value.discovery.roots, "discovery.roots", errors);
    if (value.discovery.cliVersion !== undefined && typeof value.discovery.cliVersion !== "string") errors.push("discovery.cliVersion must be a string");
  }
  if (value.certification !== undefined && (!text(value.certification) || !CERTIFICATIONS[value.certification as CertificationLevel])) errors.push("certification is invalid");
  if (value.losses !== undefined) validateStringArray(value.losses, "losses", errors);
  if (value.capabilities !== undefined) {
    if (!object(value.capabilities)) errors.push("capabilities must be an object");
    else for (const [name, rawCapability] of Object.entries(value.capabilities)) {
      const path = `capabilities.${name}`;
      if (!object(rawCapability)) { errors.push(`${path} must be an object`); continue; }
      rejectAdditionalProperties(rawCapability, ["critical", "state", "failMode", "evidence", "losses"], path, errors);
      if (rawCapability.critical !== undefined && typeof rawCapability.critical !== "boolean") errors.push(`${path}.critical must be a boolean`);
      if (!text(rawCapability.state) || !CAPABILITY_STATES[rawCapability.state as CapabilityState]) errors.push(`${path}.state is invalid`);
      if (rawCapability.failMode !== undefined && (!text(rawCapability.failMode) || !FAIL_MODES[rawCapability.failMode as FailMode])) errors.push(`${path}.failMode is invalid`);
      if (rawCapability.losses !== undefined) validateStringArray(rawCapability.losses, `${path}.losses`, errors);
      if (rawCapability.evidence !== undefined) validateEvidence(rawCapability.evidence, `${path}.evidence`, errors);
      if (rawCapability.critical === true && rawCapability.state === "active" && rawCapability.evidence === undefined) errors.push(`${path}.evidence is required`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function assertAdapterDescriptor(value: unknown): AdapterDescriptor {
  const result = validateAdapterDescriptor(value);
  if (!result.ok) throw new TypeError(result.errors.join("; "));
  return value as AdapterDescriptor;
}

export const UAI_ADAPTER_V1_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://uai.dev/schema/uai.adapter.v1.json",
  title: "UAI Adapter v1 Descriptor",
  type: "object",
  additionalProperties: false,
  required: ["contract", "adapter", "discovery"],
  properties: {
    contract: { const: ADAPTER_CONTRACT },
    adapter: {
      type: "object", additionalProperties: false, required: ["id", "version", "class"],
      properties: {
        id: { anyOf: [{ enum: ["claude", "omp", "codex", "opencode", "unknown"] }, { type: "string", pattern: EXTERNAL_ADAPTER_ID_PATTERN }] },
        version: { type: "string", minLength: 1 },
        class: { enum: Object.keys(ADAPTER_CLASSES) },
      },
    },
    discovery: {
      type: "object", additionalProperties: false, required: ["state", "confidence"],
      properties: { state: { enum: ["detected", "unsupported"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, roots: { type: "array", items: { type: "string" } }, cliVersion: { type: "string" } },
    },
    capabilities: { type: "object", additionalProperties: { $ref: "#/$defs/capability" } },
    certification: { enum: Object.keys(CERTIFICATIONS) },
    losses: { type: "array", items: { type: "string" } },
  },
  $defs: {
    evidence: {
      type: "object", additionalProperties: false,
      required: ["adapterVersion", "cliVersion", "platform", "probeId", "observedAt", "evidenceUri"],
      properties: {
        adapterVersion: { type: "string", minLength: 1 }, cliVersion: { type: "string", minLength: 1 },
        platform: { type: "object", additionalProperties: false, required: ["os", "profile"], properties: { os: { type: "string", minLength: 1 }, profile: { type: "string", minLength: 1 } } },
        probeId: { type: "string", minLength: 1 }, observedAt: { type: "string", format: "date-time" }, evidenceUri: { type: "string", minLength: 1 },
      },
    },
    capability: {
      type: "object", additionalProperties: false, required: ["state"],
      properties: { critical: { type: "boolean" }, state: { enum: Object.keys(CAPABILITY_STATES) }, failMode: { enum: Object.keys(FAIL_MODES) }, evidence: { $ref: "#/$defs/evidence" }, losses: { type: "array", items: { type: "string" } } },
      allOf: [{ if: { properties: { critical: { const: true }, state: { const: "active" } }, required: ["critical", "state"] }, then: { required: ["evidence"] } }],
    },
  },
} as const;
