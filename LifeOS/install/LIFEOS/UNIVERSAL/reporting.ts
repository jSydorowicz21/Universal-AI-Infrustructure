import { createHash } from "node:crypto";
import {
  certifyFromEvidence,
  validateConformanceEvidence,
  verifyEvidenceIntegrity,
  type CertificationExpectation,
  type CertificationResult,
  type ConformanceEvidence,
} from "./conformance";

export interface SupportEvidence {
  evidence: ConformanceEvidence;
  expected: CertificationExpectation;
  sourceDocs: readonly string[];
  degradedFeatures: readonly string[];
  now?: () => string;
  maxAgeMs?: number;
}

interface DerivedSupportEvidence {
  raw: ConformanceEvidence;
  certification: CertificationResult;
  displayClass: string;
  sourceDocs: readonly string[];
  degradedFeatures: readonly string[];
}

const GUARDED_CLAIMS = ["full", "native", "active", "enforced", "parity", "supported"] as const;

function deriveSupportEvidence(value: SupportEvidence): DerivedSupportEvidence {
  if (!value || !Array.isArray(value.sourceDocs) || value.sourceDocs.length === 0 || value.sourceDocs.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("Support evidence requires source documentation");
  }
  if (!Array.isArray(value.degradedFeatures) || value.degradedFeatures.some((entry) => typeof entry !== "string")) {
    throw new Error("Support evidence degraded features must be strings");
  }
  const validation = validateConformanceEvidence(value.evidence);
  if (!validation.ok || !validation.evidence) throw new Error(`Invalid support evidence: ${validation.blockers.join("; ")}`);
  const raw = validation.evidence;
  if (raw.scope !== "adapter" || raw.suiteId !== "uai-adapter-critical-suite") throw new Error("Support reporting requires adapter-scoped critical evidence");
  if (!verifyEvidenceIntegrity(raw)) throw new Error("Support evidence integrity mismatch");
  if (raw.adapterId !== value.expected.adapterId
    || raw.adapterVersion !== value.expected.adapterVersion
    || raw.cliVersion !== value.expected.cliVersion
    || raw.osProfile !== value.expected.osProfile) {
    throw new Error("Support report subject does not match evidence coordinates");
  }
  const certification = certifyFromEvidence({
    wired: true,
    evidence: raw,
    expected: value.expected,
    now: value.now,
    maxAgeMs: value.maxAgeMs,
  });
  const fatalBlockers = certification.blockers.filter((blocker) =>
    /integrity|timestamp|future|stale|identity mismatch|version mismatch|OS profile mismatch|invalid adapter|failed or missing probe|invalid adapter-bound|mismatched executor|missing executor provenance/i.test(blocker));
  if (fatalBlockers.length) throw new Error(`Support evidence is not reportable: ${fatalBlockers.join("; ")}`);
  const displayClass = certification.state === "active" && certification.certification === "C3" && certification.blockers.length === 0
    ? raw.adapterClass
    : "unverified-class";
  return { raw, certification, displayClass, sourceDocs: value.sourceDocs, degradedFeatures: value.degradedFeatures };
}

function activeAuthority(value: DerivedSupportEvidence): boolean {
  return value.certification.state === "active"
    && value.certification.certification === "C3"
    && value.certification.blockers.length === 0
    && Boolean(value.certification.evidence)
    && value.certification.evidence?.adapterVersion === value.raw.adapterVersion
    && value.certification.evidence.cliVersion === value.raw.cliVersion
    && value.certification.evidence.observedAt === value.raw.observedAt
    && value.certification.evidence.evidenceUri === value.raw.evidenceUri;
}

export function assertEvidenceClaims(text: string, evidence: readonly SupportEvidence[]): void {
  const claims = GUARDED_CLAIMS.filter((claim) => new RegExp(`\\b${claim}\\b`, "i").test(text));
  if (!claims.length) return;
  const derived = evidence.map(deriveSupportEvidence);
  for (const claim of claims) {
    const proven = derived.some((entry) => {
      if (!activeAuthority(entry)) return false;
      if (claim === "native") return entry.raw.adapterClass === "native";
      if (claim === "active" || claim === "enforced") return true;
      return entry.degradedFeatures.length === 0 && entry.raw.probes.every((probe) => probe.passed);
    });
    if (!proven) throw new Error(`Unproven claim: ${claim}`);
  }
}

export function generateSupportReport(evidence: readonly SupportEvidence[]): string {
  const derived = evidence.map(deriveSupportEvidence);
  const lines = [
    "# UAI Evidence-Derived Support Report",
    "",
    "| Adapter | Platform × class × certification | Versions | Profile | Evidence | Last verified | Degraded features |",
    "|---|---|---|---|---|---|---|",
    ...derived.map((entry) => `| ${entry.raw.adapterId} | ${entry.raw.platformTier} × ${entry.displayClass} × ${entry.certification.certification} | adapter ${entry.raw.adapterVersion}; CLI ${entry.raw.cliVersion} | ${entry.raw.osProfile} | [artifact](${entry.raw.evidenceUri}) | ${entry.raw.observedAt.slice(0, 10)} | ${entry.degradedFeatures.length ? entry.degradedFeatures.join(", ") : "none recorded"} |`),
    "",
    ...derived.flatMap((entry) => [
      `## ${entry.raw.adapterId} probes`,
      ...entry.raw.probes.map((probe) => `- ${probe.passed ? "PASS" : "FAIL"} ${probe.id}${activeAuthority(entry) && probe.details ? ` — ${probe.details}` : ""}`),
      `- Sources: ${entry.sourceDocs.join(", ")}`,
      "",
    ]),
  ];
  const report = lines.join("\n");
  assertEvidenceClaims(report, evidence);
  return report;
}

export function generatePromptOverlay(canonicalPrompt: string, input: { adapterId: string; notices: readonly string[]; evidence: SupportEvidence }): string {
  const entry = deriveSupportEvidence(input.evidence);
  if (input.adapterId !== entry.raw.adapterId) throw new Error("Prompt overlay adapter does not match evidence subject");
  const overlay = [
    canonicalPrompt.trimEnd(),
    "",
    `## UAI adapter overlay: ${entry.raw.adapterId}`,
    "",
    ...input.notices.map((notice) => `- Capability notice: ${notice}`),
    `- Certification: ${entry.raw.platformTier} × ${entry.displayClass} × ${entry.certification.certification}`,
    `- Evidence: ${entry.raw.evidenceUri}`,
    `- Verified: ${entry.raw.observedAt}`,
    "",
  ].join("\n");
  assertEvidenceClaims(overlay, [input.evidence]);
  return overlay;
}

export function promptDigest(canonicalPrompt: string, adapterOverlay: string): string {
  return createHash("sha256").update(canonicalPrompt).update("\0").update(adapterOverlay).digest("hex");
}

export function assertPromptDrift(input: { canonicalPrompt: string; adapterOverlay: string; expectedDigest: string }): void {
  const actual = promptDigest(input.canonicalPrompt, input.adapterOverlay);
  if (actual !== input.expectedDigest) throw new Error(`Prompt overlay drift: expected ${input.expectedDigest}, received ${actual}`);
}
