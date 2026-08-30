# Product Requirements: UAI Universal Runtime

- **Status:** implemented additive kernel and current LifeOS/OMP integration; C3 and hosted cross-OS execution evidence remain unavailable
- **Product:** LifeOS
- **Public interoperability contract:** `uai.adapter.v1`
- **Compatibility namespace:** UAI and PAI environment aliases; durable data defaults to `~/.pai`
- **Audience:** LifeOS maintainers, harness-adapter authors, release engineers, security reviewers

## 1. Problem

LifeOS has useful Claude, OMP, Codex, and OpenCode integration knowledge, but that knowledge is distributed across installer generations and harness-specific bridges. Presence-based status can overstate enforcement, installer writes are not uniformly reversible, Windows and isolated-profile behavior are inconsistent, and new harnesses would otherwise duplicate lifecycle, session, transcript, policy, and evidence logic.

Developers need one small kernel that can answer four different questions without conflating them:

1. Was a harness discovered?
2. Was an integration written and wired?
3. Was behavior observed?
4. Was the declared contract certified by same-version evidence?

The kernel must be portable, additive, credential-free in CI, and incapable of turning configuration presence into a critical-control claim.

## 2. Users

### 2.1 LifeOS runtime maintainer

Needs stable boundaries for platform facts, install transactions, canonical events, sessions, transcripts, policy decisions, and evidence so business logic is not forked per harness.

### 2.2 First-party adapter maintainer

Needs deterministic fixtures for Claude, OMP, Codex, and OpenCode, native event normalization, result lowering, declared losses, and a certification runner that refuses unearned levels.

### 2.3 External adapter developer

Needs a versioned SDK/template, discovery and reversible instruction bootstrap, fixture packs, environment scrubbing, and C0/C1 evidence without a core source change.

### 2.4 Release and security reviewer

Needs blocking Windows/macOS/Linux fixture CI, negative controls, byte-preserving rollback evidence, provenance, and generated claims whose evidence tuple is inspectable.

### 2.5 LifeOS operator

Needs shared durable USER/MEMORY data, isolated harness profiles and sessions, reversibility, honest degradation, and no mutation of an unrelated live profile.

## 3. Goals

- Publish one versioned `uai.adapter.v1` contract with TypeScript types, JSON Schema, validators, and representative fixtures.
- Keep LifeOS as the runtime and `~/.pai` as the default durable data root, with `UAI_*` taking precedence over `PAI_*` compatibility aliases.
- Make platform, command, link, service, and statusline decisions pure and deterministic before mutation.
- Plan every current LifeOS/OMP install mutation without writes; apply file mutations atomically with byte snapshots, journal state, ownership, rollback, recovery, dry-run, and manifest-keyed uninstall.
- Normalize first-party native event/tool/result/session/transcript data into canonical records and lower decisions back to native shapes with explicit losses.
- Preserve stable unique UAI session identity, native IDs, profile binding, transcript provenance, malformed-line counts, and redacted audit evidence.
- Keep MCP as the tool plane only; it must not imply lifecycle, identity, transcript, policy, or certification parity.
- Certify critical behavior only from deterministic positive and negative probes carrying a complete evidence tuple.
- Enable `external:test` to reach C0 and C1 using the adapter SDK without modifying registry or core policy.
- Generate overlays and support reports from evidence and reject guarded claim vocabulary when evidence is incomplete.
- Block relevant changes on credential-free current-layout Bun jobs on Windows, macOS, and Linux.

## 4. Non-goals

- Moving the durable data default from `~/.pai` to `~/.uai`.
- Claiming identical prompt authority or behavior across harnesses.
- Certifying unknown future CLIs beyond discovery without adapter-owned probes.
- Calling context-file loading system-prompt equivalence.
- Calling external-content taint deterministic injection prevention.
- Treating MCP registration as lifecycle, security, session, or transcript parity.
- Rolling back service-manager operations or dependency installation before undo semantics exist.
- Mutating current Claude, OMP, Codex, OpenCode, USER, or MEMORY profiles from tests.
- Replacing retained legacy installer generations outside the current LifeOS tools repaired by this stream.
- Promising Windows desktop audio, toast, or voice without executable smoke evidence.

## 5. Product taxonomy

### 5.1 Capability states

`unsupported`, `detected`, `installed`, `wired`, `active`, `degraded`, `failed`, and `declined` are distinct. `active` for a critical capability requires adapter version, CLI version, OS/profile, probe ID, observation timestamp, and evidence URI. Unsupported capabilities are absent by default; adapters add explicit `unsupported` or `degraded` records only when communicating a known surface or loss.

### 5.2 Registry states

- **discovery:** read-only identification and roots.
- **wired:** a native event reached the adapter.
- **observed:** a probe produced an observable outcome.
- **certified:** all requirements for a declared certification level passed.

These states are not aliases for capability states and do not advance automatically.

### 5.3 Platform tiers

- **P1:** macOS desktop.
- **P2:** Linux desktop/headless and WSL-as-Linux core.
- **P3:** native Windows core.
- **P4:** SSH/container/headless core.
- **P5:** future or unknown environment, discovery only.

### 5.4 Adapter classes

`native`, `compatibility`, `wrapper-proxy`, `discovery-only`, and `unsupported`. A wrapper/proxy cannot earn native C3 from process control alone.

### 5.5 Certification levels

- **C0 Discovery:** CLI/version/root/config-shape detection with redaction.
- **C1 Reversible bootstrap:** additive instruction installation, observed sentinel, and byte-preserving uninstall.
- **C2 Tool/headless interoperability:** fake MCP/tool, headless transcript, explicit model/provider availability and losses.
- **C2-W:** wrapper/proxy tool interoperability without native lifecycle equivalence.
- **C3 Critical controls:** unique sessions, profile isolation, blocking, SYSTEM/USER boundary, route ceiling, external taint, and fail-visible audit evidence.
- **C4 Session portability:** provenance-rich import/export with malformed accounting.
- **C5 Packaged adapter:** update, rollback, uninstall, packaging, and declared OS-tier evidence.

## 6. Functional requirements

### UR-001 — Contract integrity

The contract package shall export `uai.adapter.v1` types and a matching draft-2020-12 JSON Schema. It shall import no harness implementation. Claude, OMP, Codex, OpenCode, unknown, and `external:test` descriptors shall validate. A critical `active` record without the complete evidence tuple shall fail validation.

### UR-002 — Portable roots and platform facts

Home resolution shall use `HOME`, then `USERPROFILE`, then `homedir()`. Data-root resolution shall use `UAI_DATA_DIR`, then `PAI_DATA_DIR`, then `<home>/.pai`. Facts shall distinguish Windows, macOS, Linux, WSL, container, and headless operation. Fixtures shall be deterministic.

### UR-003 — Pure command, process, and link planning

Executable candidates shall honor Windows `PATHEXT`. Spawn plans shall use argument arrays with `shell: false`. Hook renderers shall quote PowerShell and POSIX commands explicitly. Windows directory links shall plan junctions; POSIX shall plan symlinks. No native Windows critical path may require implicit Bash.

### UR-004 — Read-only lifecycle planning

`createInstallPlan` shall snapshot existing file bytes/mode and link kind/target, validate structured config, reject duplicate mutation IDs, classify ownership, evaluate gates, and perform zero writes. `foreign` and `user-data` mutations shall be refused. Historical uncertainty shall be `adopted` or `unknown`, never silently `owned`.

### UR-005 — Journaled apply, recovery, and uninstall

The executor shall atomically persist and fsync journal state before and after each mutation, re-snapshot immediately before mutation and abort without erasing intervening edits on drift, use same-directory temporary files with preserved adopted-file mode (and explicit safe mode for new owned files), restore exact prior files or links in reverse order on failure, treat pending crash entries as maybe-applied, and recover idempotently. The ownership manifest shall be durably persisted before the journal can become `committed`; a crash at that boundary remains recoverable. Recovery shall restore a pending/applied mutation only when current state equals the expected applied identity, treat already-before state as rolled back without a write, and persist an explicit `rollback-conflict` without mutating any third state. Generic uninstall may restore only when current artifact identity still matches the manifest's applied hash/type/mode/link; later foreign edits produce a visible preservation conflict. Adapters may provide a path-scoped semantic reverse plan, executed through the journal, to remove owned config entries without erasing foreign keys. USER data shall be retained.

### UR-006 — Registry precedence and unknown behavior

Explicit selection shall outrank UAI/PAI environment selection, observed runtime evidence, binary discovery, and config leftovers. Clean machines shall have no selected harness. Unknown/external adapters shall begin at discovery-only C0 and emit read-only mutation candidates only.

### UR-007 — Canonical runtime records

The kernel shall define canonical event, tool, result, decision, session, transcript, provenance, and audit schemas. Equivalent first-party pre-tool fixtures shall normalize to the same canonical tool call. Block decisions shall lower to Claude exit 2, OMP native block, Codex deny JSON, and OpenCode permission deny forms.

### UR-008 — Sessions, transcripts, and audit

Each session/profile/root binding shall receive a stable unique `uai_session_id`, preserving a native ID when available. Transcript rows shall carry URI, parser version, source line, source event ID, source URI/taint where present, and fallback reason where needed. Malformed lines shall increment a count and warning rather than disappear. Critical JSON shall use atomic replace. Audit rows shall be bounded and redact secret-bearing keys.

### UR-009 — First-party adapter truth

Claude, OMP, Codex, and OpenCode descriptors shall expose only observed or explicitly degraded capabilities. Lowerers shall record authority, lifecycle, approval, model/reasoning, tool-filter, and event-surface losses. Descriptor wiring alone shall remain C0 unless evidence raises certification. Claude, Codex, and OpenCode shall expose explicit-selection C0 discovery plus reversible C1 instruction-bootstrap providers for their currently documented user instruction files (`CLAUDE.md`, `AGENTS.md`, and `AGENTS.md`, respectively). Each provider shall bind a successfully observed CLI version, versioned instruction/config paths, source-document URLs, and last-verified date; mutate only the instruction file; preserve foreign instruction/config bytes on uninstall; and state that C1 proves neither hooks nor blocking. OMP production bootstrap remains owned by its existing manager.

### UR-010 — Tool and intent plane

ToolProvider/MCP manifests shall define command, tools, authentication, environment allowlist, approval, sandbox, and tool filters. Rejected environment values shall be redacted from audit. The fake `uai_echo` provider shall execute credential-free. Command, agent, and prompt intents shall lower only across proven surfaces and preserve losses.

### UR-011 — Canonical policy probes

The package shall provide single-sourced command safety, SYSTEM/USER write-boundary, external-content taint/provenance, data-class, and provider-route-ceiling decisions. An unknown provider route shall have a PUBLIC ceiling. Fail-visible outcomes shall not be relabeled as prevention or enforcement.

### UR-012 — Deterministic conformance

The kernel runner shall execute credential-free self-tests for instruction sentinel; forbidden/benign command; SYSTEM/USER boundary; missing hook; external taint/provenance; route ceiling; session/profile isolation; invalid config/atomic state; install/uninstall preservation; and failure-injection rollback. The rollback probe shall apply multiple file/link mutations, inject failure, verify exact prior bytes/mode/link and absence of new owned state, then exercise manifest-before-commit crash recovery through its journal. Kernel-scope evidence is health evidence only. Adapter mapping conformance shall run every probe through the selected versioned adapter's normalize/lower surfaces and a fixture executor, attaching adapter-bound provenance, but is capped at observed/C2.

### UR-013 — Evidence-bound certification

Doctor-like consumers shall accept conformance artifacts; they shall not infer critical `active` from discovery, installation, wiring, kernel-only self-tests, adapter mapping, caller-supplied CLI labels, or nominal trust labels. C3 requires native adapter class, every adapter-bound critical probe, verified integrity digest, exact adapter/version/observed-CLI/OS-profile match, a non-future fresh timestamp, a complete evidence tuple, and a repository-owned certifying executor identity. That executor must actually invoke a staged-native/live installed hook or CLI, observe its version, and record version-bound outcomes plus install-manifest evidence. Fixture executors are always non-certifying. This additive package registers no repository-owned certifying executor, so C3 remains deliberately unearned pending first-party integration. Wrapper/proxy evidence is capped at C2-W unless a future native contract is independently proven.

### UR-014 — Narrow platform runtime

Pure service plans shall model launchd, systemd-user, Windows Scheduled Task, foreground, and unsupported. Missing managers shall return foreground/unsupported rather than throw. Pulse audio and notification booleans shall remain false until observed. A minimal TypeScript statusline shall run without HOME when USERPROFILE is available in the caller environment.

### UR-015 — External SDK

The SDK shall validate `external:<id>`, expose a discovery callback, require a profile-relative instruction path and sentinel, install through the lifecycle executor, verify the sentinel, and return a cleanup function that preserves prior bytes. The fixture pack shall name required discovery, bootstrap, transcript, hook-fail-mode, and MCP scrub probes. Optional capabilities shall remain absent.

### UR-016 — Evidence-derived output

Prompt overlays shall combine canonical prompt text, adapter notices, certification coordinates, evidence URI, and verification time. A digest shall fail drift checks after canonical or overlay changes. Support reports shall print platform tier × adapter class × certification and include adapter/CLI versions, OS/profile, evidence URI, date, source documents, probes, and degraded features.

### UR-017 — Claim vocabulary guard

The words `full`, `native`, `active`, `enforced`, `parity`, and `supported` shall not be emitted as claims without complete matching evidence. `native` requires native-class evidence; `active`/`enforced` require passing C3+ probe evidence; `full`/`parity`/`supported` require all probes passing and no degraded feature.

### UR-018 — Blocking current-layout CI

Credential-free Bun jobs shall run unit, fixture, and conformance entry points plus `bun build --no-bundle` against `LifeOS/install/LIFEOS/UNIVERSAL` on Windows, macOS, and Linux. Jobs shall use temporary profile/data roots and fail normally. Optional live vendor probes shall be opt-in, non-blocking, and limited to connectivity/observed behavior.

## 7. User journeys

### Journey A — Maintainer evaluates a clean machine

1. The registry receives no explicit selection, environment selection, observed runtime, binary, or config.
2. Discovery returns no selected harness.
3. No plan is applied and no Claude default is inferred.
4. The support report remains empty rather than claiming support.

### Journey B — Operator previews an installation

1. Adapter discovery requires an explicit adapter selection and a successful executable/version probe; it returns C0 only.
2. The first-party provider identifies its versioned, source-documented instruction and config paths, but plans a mutation only for the instruction file the CLI currently reads.
3. The lifecycle planner snapshots existing instruction bytes/mode, classifies the mutation, and dry-run lists the journal and ownership manifest without writes.
4. Apply observes the installed sentinel and may emit C1; uninstall restores exact foreign instruction bytes while leaving config bytes untouched.
5. Missing binaries, failed version probes, unsupported lifecycle controls, or unknown surfaces remain C0 with an exact blocker.

### Journey C — Apply fails after one mutation

1. The executor records pending state before the first mutation and applied state afterward.
2. An injected failure occurs before the next mutation.
3. Rollback restores exact prior bytes and removes newly owned files.
4. Re-running crash recovery reads a rolled-back journal and makes no further change.

### Journey D — Adapter normalizes a tool call

1. A Claude, OMP, Codex, or OpenCode native pre-tool payload enters its adapter.
2. The adapter emits one canonical `tool.before` record.
3. Canonical policy returns a decision.
4. The adapter lowers it to the harness-native block/allow/update shape, including losses where the public surface is weaker.

### Journey E — Reviewer evaluates critical certification

1. The credential-free runner creates isolated temp profile and data roots.
2. Positive and negative probes execute and write only inside those roots.
3. The artifact records versions, platform/profile, timestamp, probe rows, and evidence URI.
4. The certification consumer emits `active` only when all C3 probes and tuple fields exist; wiring alone remains `wired`/C0.

### Journey F — External developer adds `external:test`

1. The developer supplies an SDK template with ID, version, discovery callback, instruction path, and sentinel.
2. The adapter is C0 after read-only discovery.
3. Bootstrap uses the lifecycle executor in an isolated profile, observes the sentinel, and earns fixture C1.
4. Cleanup restores or removes only manifest-owned bytes; no core registry source changes.

## 8. Acceptance gates

### Contract gate

- All six adapter fixtures validate.
- Invalid critical `active` fixtures identify every missing tuple field.
- The contract module has no adapter import.
- Unsupported capabilities remain absent unless intentionally declared.

### Platform gate

- Windows USERPROFILE-only, PATHEXT/`.cmd`, PowerShell quoting, and junction plans pass.
- macOS and Linux symlink/service facts pass.
- WSL and container/headless facts are distinct and do not leak homes.
- Process plans never require a shell.

### Lifecycle gate

- Plan generation writes zero bytes.
- Invalid existing JSON/YAML/TOML aborts unchanged.
- Injected failure restores exact bytes and removes newly created files.
- Uninstall preserves foreign keys and USER data.
- Recovery is deterministic and idempotent.
- Duplicate mutation IDs and pre-apply drift abort before profile mutation.
- Pre-existing symlinks/junctions restore as links with their original targets.
- Post-install foreign config edits are preserved as conflicts until a journaled semantic reverse plan removes only owned entries.
- Restrictive adopted-file modes survive apply, rollback, and uninstall on POSIX; Windows assertions account for its limited chmod semantics.
- Crash recovery preserves and reports any third-party state that matches neither the before snapshot nor expected applied identity.
- An injected crash after durable ownership-manifest persistence but before the committed marker recovers to exact prior state.

### Runtime gate

- Equivalent native calls normalize identically.
- Native block shapes match each first-party surface.
- Two sessions and two roots are distinct.
- Transcript provenance survives valid rows around malformed rows with warnings.
- Critical state is valid old or new JSON, never a truncated document.

### Certification gate

- Every required probe has a passing and meaningful assertion.
- Generated evidence includes a passing `failure-injection-rollback` row; unit-only rollback coverage is insufficient.
- Missing hooks and unknown routes fail visibly.
- Evidence contains the full tuple and no secret.
- Wiring cannot produce critical `active`.
- Wrapper/proxy cannot earn native C3.
- Kernel-scope, fixture-executor, forged, stale, future, fake-adapter, version/profile-mismatched, and untrusted/mismatched-executor evidence cannot produce critical `active`.
- Every C3 probe contains matching trusted staged-native/live executor provenance and an executor-observed CLI version.

### Release gate

- Windows, macOS, and Linux matrix jobs block on compile/unit/fixture/conformance failure.
- CI references the current `LifeOS/install/LIFEOS/UNIVERSAL` layout.
- Live vendor checks remain opt-in and non-blocking.
- Existing installer integration is complete before claiming production C1+ for an installed first-party profile.

## 9. Architecture impact

The additive tree `LifeOS/install/LIFEOS/UNIVERSAL` introduces the following boundaries:

- `contract.ts` and `schemas/`: public contract, evidence-bearing capability records, JSON Schema validation.
- `platform.ts`: OS facts and pure root/executable/process/hook/link plans.
- `lifecycle.ts`: read-only plans, byte snapshots, atomic executor, journal, ownership, recovery, uninstall.
- `registry.ts`: precedence-aware discovery and distinct registry states.
- `canonical.ts`: event/tool/result/session/transcript/provenance/audit schemas and atomic critical JSON.
- `policy.ts`: shared command, write-boundary, taint, data-class, and route decisions.
- `adapters.ts`: first-party descriptors, hook requirements, native normalization and decision lowering.
- `bootstrap.ts`: explicit-selection Claude/Codex/OpenCode C0 discovery and reversible, source-documented C1 instruction plans; OMP remains manager-owned.
- `capabilities.ts`: MCP/tool manifests plus command, agent, and prompt intent lowering.
- `services.ts`: dry-run service, statusline, and optional Pulse capability models.
- `conformance.ts`: isolated critical probe execution and evidence-consuming certification.
- `sdk.ts`: external adapter template and fixture pack.
- `reporting.ts`: overlays, drift digest, evidence-derived reports, and claim guard.

The contract layer imports no harness implementation. Policy and lifecycle remain adapter-independent. Adapters consume canonical boundaries and do not own durable identity, policy, or transaction semantics.

## 10. Dependencies and integration items

### Runtime dependencies

- Bun runtime and test runner.
- TypeScript source consumed directly by Bun.
- Node-compatible standard library only; no vendor credentials or harness package is required.

### Explicit cross-owner integration items

1. Existing LifeOS installers must call `createInstallPlan`/`applyInstallPlan` rather than duplicating writes.
2. Existing Claude/OMP apply and uninstall paths must provide accurate `owned`/`adopted` classifications, stage hooks before config references, and supply semantic reverse mutations for shared JSON/YAML entries when whole-file restoration conflicts.
3. Existing OMP hooks must replace shared fallback session IDs with `createSessionIdentity` and bind canonical data/profile roots.
4. Existing transcript consumers must pass the stopping transcript URI/parser metadata into canonical parsing.
5. Existing Doctor/status commands must consume adapter-scope `ConformanceEvidence` through `certifyFromEvidence` with exact expected adapter/version/observed-CLI/OS-profile/executor values. A first-party integration must add a repository-owned certifying executor that actually spawns the staged installed hook/CLI, verifies the install manifest, and records version-bound native outcomes; until then, wiring, kernel health, fixture mapping, and nominal trust labels remain below critical `active`.
6. Existing service and Pulse mechanics must consume pure plans before any service-manager side effect.
7. Existing install documentation must point to the current LifeOS distribution path after stabilization.

These items are release gates, not hidden claims in this additive package. They are intentionally reported to the stabilization/integration owner rather than edited here.

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Vendor event schemas change | One adapter mis-normalizes or blocks incorrectly | Version adapter evidence and fixtures; invalidate only the affected adapter/CLI pair |
| Presence is mistaken for enforcement | False security claim | Separate states; full evidence tuple; required negative controls; claim guard |
| Config mutation destroys customization | User profile loss | Parse before plan, duplicate-ID/drift gates, link-aware snapshots, applied identity checks, conflict-preserving uninstall, semantic reverse plans, and failure injection |
| Windows path/shell assumptions return | Install fails or invokes wrong command | USERPROFILE fallback, PATHEXT candidates, PowerShell renderer, shell-free process plan, Windows CI |
| Cross-session/profile leakage | Privacy or correctness failure | Root-bound unique IDs, temp-root probes, two-session and two-profile gates |
| Transcript corruption hides provenance | Incorrect memory/audit | Source URI/line/event/parser fields plus malformed warnings/counts |
| MCP is overclaimed | Tool wiring presented as lifecycle parity | Evidence scope is `tool-plane-only`; descriptors record loss |
| External SDK or kernel smoke certifies too much | Untrusted adapter receives support badge | SDK provides C0/C1 only; kernel evidence is capped; C3 requires native adapter-bound integrity-verified evidence |
| Service actions are not reversible | Partial system wiring | Keep service mechanics dry-run; foreground/unsupported fallback; no rollback claim |
| Claim guard matches prose unexpectedly | Report generation fails | Guard only bounded claim vocabulary and require evidence; tests cover permitted and rejected output |

## 12. Rollout and rollback

### Rollout

1. Land R1 contract and schema with fixtures.
2. Land R2/R3/R4 platform, lifecycle, and registry boundaries without production writes.
3. Land R5/R6 event/session/transcript normalization and audit.
4. Integrate canonical roots and lifecycle into stabilized Claude/OMP paths.
5. Run R9 critical conformance before raising any critical state.
6. Add R10/R11 capability and platform-runtime consumers.
7. Deliver explicit-selection, version-bound C0/C1 instruction bootstrap for Claude/Codex/OpenCode through the shared lifecycle, while keeping OMP in its manager and lifecycle blocking degraded.
8. Publish the SDK and validate `external:test` C0/C1.
9. Enable blocking R14 matrix CI and generate reports from evidence.

### Rollback

The universal tree is additive. Before production installer integration, rollback removes its imports and files with no profile mutation. After integration, rollback must first execute ownership-manifest uninstall, retain USER/MEMORY by default, restore adopted bytes, and then remove code. Service actions and dependency installation are excluded until explicit undo exists.

## 13. Metrics and evidence

- **Contract validity:** 100% positive fixtures valid; 100% negative critical-evidence fixtures rejected.
- **Portability:** deterministic Windows/macOS/Linux/WSL/container fact fixtures pass on every matrix run.
- **Reversibility:** sentinel hashes, file modes, link targets/types, and byte buffers match after injected failure, manifest-before-commit boundary crash, pending-after-mutation recovery, and unchanged-artifact uninstall; crash-before-mutation external edits produce visible rollback conflicts and remain untouched.
- **Isolation:** no duplicate UAI IDs; no profile-root cross-read/write in two-session/two-profile probes.
- **Provenance:** every parsed row has transcript URI/parser/source line; malformed count equals rejected line count.
- **Critical controls:** kernel and fixture mapping evidence remain capped; nominal trusted-executor labels, missing repository-owned execution, and any missing, failed, stale, future, forged, or mismatched evidence block C3. A future C3 artifact must bind all eleven probe groups—including generated failure-injection rollback—to a repository-owned staged-native/live executor, install-manifest evidence, integrity, and executor-observed CLI version.
- **Secret hygiene:** conformance audit and MCP registration logs contain no rejected environment values.
- **Claim truth:** guarded vocabulary tests reject evidence-free claims and accept only matching complete evidence.
- **CI health:** compile, unit, fixture, and conformance jobs pass on all three operating systems.

Required public evidence fields are adapter ID/version, CLI version, OS/profile and platform tier, adapter class, certification, probe IDs/results, evidence URI, source documents, observation date, and degraded features.

## 14. Roadmap traceability R1–R14

| Package | Requirements | Dependencies | Delivery gate | Verification | Implementation / integration |
|---|---|---|---|---|---|
| **R1 Contract and naming** | UR-001; LifeOS/UAI/PAI naming and `~/.pai` default | None | No adapter wiring or support claim | Contract tests validate six fixtures and reject incomplete critical evidence | `contract.ts`, schema, adapter fixtures |
| **R2 Platform primitives** | UR-002, UR-003 | R1 | No implicit Bash on Windows; facts only | Platform unit/fixture tests for HOME/USERPROFILE, PATHEXT, quoting, links, WSL/container/headless | `platform.ts`; existing setup tools remain integration item |
| **R3 Lifecycle foundation** | UR-004, UR-005 | R1 | Plan before apply; snapshot and drift-check before write; manifest before commit | Dry-run, duplicate ID, invalid config, mode preservation, link replacement, manifest-boundary crash, pending recovery, foreign-edit conflict, semantic uninstall, and failure-injection checks | `lifecycle.ts` |
| **R4 Harness registry** | UR-006 | R1, R2 | Explicit/env precedence; clean machine selects nothing | Registry precedence and unknown C0 tests | `registry.ts` |
| **R5 Event kernel** | UR-007 | R1, R4 | Missing event surfaces degrade visibly | Four pre-tool fixtures and native block lowering assertions | `canonical.ts`, `adapters.ts`, event fixtures |
| **R6 Session/transcript/audit** | UR-008 | R1, R2, R4 | Unique root-bound identity and atomic state before adapter apply | Two sessions, provenance, malformed line, atomic JSON tests | `canonical.ts` |
| **R7 Shared roots/OMP truth** | UR-002, UR-008, UR-009, UR-011 | R2, R5, R6 | No OMP critical claim before canonical roots and probes | Two-profile/root and policy conformance probes | Kernel delivered; existing OMP callsites are explicit integration item |
| **R8 Reversible Claude/OMP install** | UR-004, UR-005, UR-009 | R3, R4, R5, R7 | Every production mutation uses journal/ownership and semantic shared-config reverse | Invalid config, injected failure, link restoration, conflict-preserving uninstall | Executor delivered; existing Claude/OMP installers are explicit integration item |
| **R9 Critical conformance** | UR-011, UR-012, UR-013 | R5, R6, R7, R8 | Adapter-bound negative controls; generated failure rollback; fixture C2 cap; repository-owned staged/live executor plus integrity/freshness/match gates; kernel smoke capped | Required-set and adapter-binding assertions plus fixture/fake/forged/stale/mismatch/nominal-trust refusal tests; C3 remains an explicit integration gate | `policy.ts`, `conformance.ts` |
| **R10 MCP and intent lowerers** | UR-010 | R4, R8 | Environment allowlist and explicit losses; tool plane only | Fake `uai_echo`, secret-redaction, command/agent/prompt tests | `capabilities.ts`, MCP fixture |
| **R11 Services/statusline/Pulse** | UR-014 | R2, R3 | Pure/dry-run mechanics; optional desktop features false absent evidence | Service fallback and statusline unit tests | `services.ts`; production service mechanics remain integration item |
| **R12 Claude/Codex/OpenCode adapters** | UR-007, UR-009, UR-010 | R5, R6, R8, R9, R10 | Explicit selection and observed CLI version; mutate only documented instruction surface; preserve foreign instruction/config bytes; refuse lifecycle/C3 claims | Temp-profile fake-binary C0/C1 plan/apply/uninstall fixtures on all three OSes; exact path/source/last-verified/loss assertions | `adapters.ts`, `bootstrap.ts`, `registry.ts`, `sdk.ts`, `fixtures/bootstrap-surfaces.json` |
| **R13 Adapter SDK** | UR-015 | R9, R10, R12 | Unknown starts C0; reversible sentinel required for C1 | `external:test` discovery/bootstrap/cleanup test | `sdk.ts`, external fixture |
| **R14 Release truth** | UR-016, UR-017, UR-018 | R9, R11, R12, R13 | Public claims derive from evidence; matrix blocks | Overlay/report/claim/drift tests, Bun build, three-OS unit plus first-party bootstrap fixture workflow | `reporting.ts`, `.github/workflows/pai-codex-validation.yml` |

## 15. Definition of done

The universal-runtime stream is complete when focused Bun compile, unit, fixture, conformance, and smoke commands pass; workflow syntax is valid; every R1–R14 row has an implementation or explicit cross-owner integration gate; no test writes to a real profile; and no generated critical claim can exist without complete same-version evidence.
