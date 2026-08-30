import { isAdapterId, isExternalAdapterId, type AdapterClass, type AdapterId, type CertificationLevel, type EvidenceTuple } from "./contract";
import { certifyFromEvidence, type CertificationExpectation, type ConformanceEvidence } from "./conformance";
import { firstPartyBootstrapProvider, type FirstPartyBootstrapProvider } from "./bootstrap";

export type RegistrationState = "discovery" | "wired" | "observed" | "certified";
export interface HarnessDiscovery {
  id: AdapterId;
  source: "explicit" | "environment" | "observed" | "binary" | "config";
  confidence: number;
  state: RegistrationState;
  certification: CertificationLevel;
  adapterClass: AdapterClass;
  mutationCandidates: readonly { kind: "instruction" | "config" | "plugin"; path: string; dryRun: true }[];
}
export interface DiscoveryInput {
  explicit?: string;
  env?: Record<string, string | undefined>;
  observed?: string[];
  binaries?: string[];
  configs?: string[];
}
export interface HarnessDiscoveryResult {
  selected?: HarnessDiscovery;
  candidates: HarnessDiscovery[];
}
export interface HarnessStatus {
  id: AdapterId;
  adapterClass: AdapterClass;
  version: string;
  state: RegistrationState;
  certification: CertificationLevel;
  observedEvidenceUri?: string;
  evidence?: EvidenceTuple;
}

const KNOWN: Record<string, AdapterClass> = { claude: "native", omp: "native", codex: "compatibility", opencode: "compatibility" };

function normalizeId(raw: string): AdapterId {
  const id = raw.trim().toLowerCase();
  if (id === "claude" || id === "claude-code") return "claude";
  if (id === "omp") return "omp";
  if (id === "codex") return "codex";
  if (id === "opencode" || id === "open-code") return "opencode";
  if (id.startsWith("external:")) {
    if (isExternalAdapterId(id)) return id;
    throw new TypeError(`Invalid external adapter id: ${raw}`);
  }
  if (id === "unknown") return "unknown";
  if (!id) return "unknown";
  const externalId = `external:${id}`;
  if (!isExternalAdapterId(externalId)) throw new TypeError(`Invalid external adapter id: ${raw}`);
  return externalId;
}

function candidate(raw: string, source: HarnessDiscovery["source"], confidence: number): HarnessDiscovery {
  const id = normalizeId(raw);
  return {
    id,
    source,
    confidence,
    state: "discovery",
    certification: "C0",
    adapterClass: KNOWN[id] ?? "discovery-only",
    mutationCandidates: [],
  };
}

export function discoverHarness(input: DiscoveryInput): HarnessDiscoveryResult {
  const envSelection = input.env?.UAI_HARNESS || input.env?.PAI_HARNESS;
  const groups: readonly [HarnessDiscovery["source"], number, readonly string[]][] = [
    ["explicit", 1, input.explicit ? [input.explicit] : []],
    ["environment", 0.95, envSelection ? [envSelection] : []],
    ["observed", 0.85, input.observed ?? []],
    ["binary", 0.65, input.binaries ?? []],
    ["config", 0.45, input.configs ?? []],
  ];
  const candidates: HarnessDiscovery[] = [];
  const seen = new Set<string>();
  for (const [source, confidence, values] of groups) {
    for (const value of values) {
      const discovery = candidate(value, source, confidence);
      if (seen.has(discovery.id)) continue;
      seen.add(discovery.id);
      candidates.push(discovery);
    }
  }
  return { selected: candidates[0], candidates };
}

export class HarnessRegistry {
  readonly #adapters = new Map<AdapterId, HarnessStatus>();

  register(id: AdapterId, adapterClass: AdapterClass, version: string): void {
    if (!isAdapterId(id)) throw new TypeError(`Invalid adapter id: ${id}`);
    if (this.#adapters.has(id)) throw new Error(`Adapter already registered: ${id}`);
    this.#adapters.set(id, { id, adapterClass, version, state: "discovery", certification: "C0" });
  }

  get(id: AdapterId): HarnessStatus | undefined {
    const status = this.#adapters.get(id);
    return status ? { ...status, evidence: status.evidence ? { ...status.evidence, platform: { ...status.evidence.platform } } : undefined } : undefined;
  }

  recordWired(id: AdapterId): HarnessStatus {
    const status = this.#require(id);
    if (status.state === "wired") return this.get(id)!;
    if (status.state !== "discovery") throw new Error(`Adapter ${id} cannot regress from ${status.state} to wired`);
    status.state = "wired";
    return this.get(id)!;
  }

  recordObserved(id: AdapterId, evidenceUri: string): HarnessStatus {
    const status = this.#require(id);
    if (status.state !== "wired" && status.state !== "observed") throw new Error(`Adapter ${id} must be wired before observation`);
    if (!evidenceUri) throw new Error("Observed state requires an evidence URI");
    status.state = "observed";
    status.observedEvidenceUri = evidenceUri;
    return this.get(id)!;
  }

  recordCertified(id: AdapterId, evidence: ConformanceEvidence, expected: CertificationExpectation, now?: () => string): HarnessStatus {
    const status = this.#require(id);
    if (status.state !== "observed") throw new Error(`Adapter ${id} must be observed before certification`);
    if (expected.adapterId !== id || expected.adapterVersion !== status.version) throw new Error("Certification coordinates do not match registry subject");
    const certification = certifyFromEvidence({ wired: true, evidence, expected, now });
    if (certification.state !== "active" || certification.certification !== "C3" || certification.blockers.length || !certification.evidence) {
      throw new Error(`Evidence did not earn active C3 certification: ${certification.blockers.join("; ") || "not active"}`);
    }
    status.state = "certified";
    status.certification = certification.certification;
    status.evidence = certification.evidence;
    return this.get(id)!;
  }

  #require(id: AdapterId): HarnessStatus {
    const status = this.#adapters.get(id);
    if (!status) throw new Error(`Adapter is not registered: ${id}`);
    return status;
  }

  bootstrapProvider(id: AdapterId): FirstPartyBootstrapProvider | undefined {
    return firstPartyBootstrapProvider(id);
  }

  discover(input: DiscoveryInput): HarnessDiscoveryResult {
    return discoverHarness(input);
  }
}
