---
task: "Stabilize PR #1 and implement the universal UAI runtime roadmap"
slug: 20260716-uai-universal-runtime
project: Universal AI Infrastructure
effort: comprehensive
effort_source: explicit
phase: verify
progress: 17/18
mode: parallel
started: 2026-07-16T00:00:00Z
updated: 2026-07-16T00:00:00Z
---

## Problem

PR #1 merges current LifeOS upstream and adds an OMP integration, but targeted review found false-green installation, shared OMP session identity, Windows/profile path defects, non-transactional mutation, stale install guidance, missing transcript provenance, dependency merge gaps, and missing blocking CI. The repository also lacks the stable platform/harness contracts needed to add coding-agent runtimes without duplicating installer, lifecycle, event, session, security, and capability logic.

## Vision

The PR branch becomes a safe base for UAI: its authored OMP integration installs reversibly and behaves correctly on supported profiles, while a small universal runtime kernel gives Claude, OMP, Codex, and OpenCode explicit adapter and capability boundaries. Support claims are generated from executable evidence rather than wiring or documentation.

## Out of Scope

- No claim of behavioral parity where a harness cannot expose the required lifecycle or blocking surface.
- No undocumented or speculative adapters for unknown future CLIs.
- No compatibility shims that preserve known-broken installer paths or hardcoded session identities.
- No unrelated redesign of LifeOS skills, Pulse UI, or upstream application behavior.
- No mutation of a maintainer's live harness profile during tests.

## Principles

- Correctness and reversibility precede breadth.
- Shared contracts stay small; harness-specific lowering remains in adapters.
- Durable USER and MEMORY data are independent of harness configuration homes.
- Installation status reports observed behavior, not copied files.
- Every support level is bound to adapter version, CLI version, OS/profile, and evidence.
- Tests use isolated homes and negative controls.

## Constraints

- TypeScript and Bun only for repository runtime and tests.
- Preserve the true-merge ancestry of PR #1 and all intentional UAI-authored assets.
- Use native cross-platform path/process primitives; no shell-only core lifecycle path.
- Parse and validate existing user configuration before any mutation.
- Install/update/uninstall operations must be journaled, ownership-aware, and reversible.
- Critical security controls fail visibly when the harness cannot enforce them.
- Existing unrelated worktree deletion under `Packs/Security/.../ToolInventory.md` is not touched.

## Goal

Deliver two reviewed PRDs plus an implementation on a branch based on PR #1 that fixes the identified authored regressions and establishes the dependency-ordered universal runtime foundation and first-party adapters described by `plans/uai-universal-runtime-roadmap.md`; targeted Windows/POSIX fixture tests, isolated lifecycle scenarios, adapter conformance tests, and CI must prove the delivered contracts.

## Criteria

- [x] ISC-1: Stabilization PRD names every confirmed PR #1 defect, user impact, acceptance criterion, dependency, rollout, and verification probe.
- [x] ISC-2: Universality PRD defines scope, personas, requirements, capability/certification taxonomy, milestones, non-goals, and executable acceptance gates.
- [x] ISC-3: OMP install fails before mutation when required hooks/classifier dependencies are absent.
- [x] ISC-4: Concurrent OMP sessions receive stable distinct IDs propagated through hooks, observability, ISA, cleanup, and memory review.
- [x] ISC-5: Installer and runtime path/process handling works with native Windows profiles where `HOME` is unset and with POSIX profiles.
- [x] ISC-6: OMP tests isolate `HOME`, `USERPROFILE`, harness roots, backend state, and fake executables; no live profile file changes.
- [x] ISC-7: Memory review consumes the stopping transcript explicitly and does not block the OMP event loop.
- [x] ISC-8: Existing runtime dependencies and harness settings are parsed, merged, verified, and restored transactionally.
- [x] ISC-9: Lifecycle hooks enforce declared timeouts and recover from transient Pulse unavailability.
- [x] ISC-10: Platform/path/process/link primitives expose deterministic Windows, macOS, Linux, WSL, and headless/container fixtures.
- [x] ISC-11: `uai.adapter.v1` defines discovery, capability negotiation, event/session/transcript normalization, lowering, lifecycle, and evidence interfaces.
- [x] ISC-12: A registry reports discovery-only, wired, observed, and certified status without conflating them.
- [x] ISC-13: Lifecycle planner, journal, ownership manifest, rollback executor, and crash recovery are used by supported adapters.
- [x] ISC-14: Claude, OMP, Codex, and OpenCode adapters lower supported hooks/tools/commands/prompts/agents and report unsupported capabilities explicitly.
- [x] ISC-15: Critical-control conformance runs positive and negative probes for blocking, external-content labeling, session isolation, transcript provenance, and rollback.
- [ ] ISC-16: The workflow defines Windows, macOS, and Linux compile/unit/fixture/lifecycle/conformance gates; local Bash and PowerShell probes pass, but hosted macOS/Linux execution was not observed in this worktree.
- [x] ISC-17: Generated support evidence identifies adapter/CLI/OS versions, probe results, degraded capabilities, and hard blockers.
- [x] ISC-18: Anti: no test or installer mutates an actual user profile, no support badge is emitted from configuration presence alone, and no failed install leaves active partial wiring.

## Test Strategy

```yaml
- isc: ISC-1
  type: document-contract
  check: stabilization PRD coverage matrix
  threshold: every confirmed defect maps to acceptance and probe
  tool: Bun PRD validator
- isc: ISC-2
  type: document-contract
  check: universality PRD required sections and roadmap package traceability
  threshold: all required sections and 14 roadmap packages mapped
  tool: Bun PRD validator
- isc: ISC-3
  type: isolated-install-negative-control
  check: missing safety dependency
  threshold: non-zero exit and zero profile mutations
  tool: bun test targeted OMP lifecycle suite
- isc: ISC-4
  type: concurrency
  check: two simultaneous fake OMP sessions
  threshold: distinct stable IDs and no state cross-talk
  tool: bun test targeted session suite
- isc: ISC-5
  type: platform-fixture
  check: HOME-unset Windows plus POSIX roots
  threshold: expected absolute paths and executable resolution
  tool: bun test platform fixtures
- isc: ISC-8
  type: transaction
  check: valid config, malformed config, injected crash, uninstall
  threshold: exact pre-install bytes restored after failure/uninstall
  tool: bun test lifecycle fixtures
- isc: ISC-11
  type: type-contract
  check: adapter schema and compatibility fixture
  threshold: v1 fixtures compile and validate
  tool: bun test adapter contract
- isc: ISC-15
  type: conformance
  check: critical positive and negative controls
  threshold: unsupported controls fail visibly; supported controls prove enforcement
  tool: bun test conformance harness
- isc: ISC-16
  type: CI
  check: OS matrix workflow
  threshold: all required jobs pass
  tool: GitHub Actions matrix
- isc: ISC-18
  type: anti-probe
  check: profile sentinel hashes before/after all suites
  threshold: no changes outside temporary fixture roots
  tool: isolated smoke harness
```

## Features

```yaml
- name: StabilizationRequirements
  description: Product contract for repairing PR #1 authored regressions
  satisfies: [ISC-1]
  depends_on: []
  parallelizable: true
- name: UniversalityRequirements
  description: Product contract for universal runtime and adapter certification
  satisfies: [ISC-2]
  depends_on: []
  parallelizable: true
- name: OmpStabilization
  description: Session, install, path, transcript, timeout, dependency, configuration, and isolation repairs
  satisfies: [ISC-3, ISC-4, ISC-5, ISC-6, ISC-7, ISC-8, ISC-9, ISC-18]
  depends_on: [StabilizationRequirements]
  parallelizable: true
- name: RuntimeKernel
  description: Platform primitives, adapter contract, registry, canonical schemas, lifecycle journal, and rollback
  satisfies: [ISC-10, ISC-11, ISC-12, ISC-13]
  depends_on: [UniversalityRequirements]
  parallelizable: true
- name: FirstPartyAdapters
  description: Claude, OMP, Codex, and OpenCode lowerers with explicit degradation
  satisfies: [ISC-14]
  depends_on: [RuntimeKernel, OmpStabilization]
  parallelizable: false
- name: CertificationAndCI
  description: Negative-control conformance, generated support evidence, and blocking OS matrix
  satisfies: [ISC-15, ISC-16, ISC-17, ISC-18]
  depends_on: [FirstPartyAdapters]
  parallelizable: false
```

## Decisions

- 2026-07-16: Preserve PR #1 merge ancestry and implement from head `9a2cba4f`; do not recreate the merge.
- 2026-07-16: Split work initially into independent stabilization and runtime-kernel streams; join only at first-party adapter conformance.
- 2026-07-16: Use OMP as the second proving harness, then add Codex and OpenCode through the same contract.
- 2026-07-16: Treat discovery, wiring, observed behavior, and certification as separate states.
- 2026-07-16: The active framework Algorithm pointer was absent at its required user-framework path; the already-active Algorithm workflow continued without resolving a repository-local fallback.
- 2026-07-16: Fixture and kernel evidence cannot earn C3; OMP remains C0/wired until a repository-owned staged/live executor proves the complete critical probe set.
- 2026-07-16: Current core runtime is dependency-free through `Bun.YAML`; future unresolved external dependencies block before mutation until every package-manager artifact is lifecycle-planned.

## Changelog

- conjectured: PR #1 plus a universal roadmap could be implemented safely by adding adapters directly; refuted by: review evidence showing installer/session/state invariants are already broken and adapters would duplicate them; learned: stabilization and a lifecycle kernel must precede breadth; criterion now: ISC-3 through ISC-13 gate first-party adapter completion.
- 2026-07-16 self-audit: adversarial reruns found remaining ancestor-junction reads, shell double-quote expansion, inherited data-root test leakage, and ambiguous crash-journal recovery; the release gate now rejects those paths before read/exec/mutation and proves hostile environment precedence explicitly.

## Verification

- PRD structure: both developer PRDs exist and trace stabilization defects plus roadmap R1-R14 to acceptance and executable probes.
- OMP gate: `85 pass`, `0 fail`, `318` assertions across stabilization, hook-adapter, and observability suites under hostile inherited data-root environment variables.
- Universal gate: `66 pass`, `0 fail`, `363` assertions; `87.68%` functions and `92.78%` lines.
- Compile: universal `index.ts` and `run-conformance.ts` no-bundle builds passed; all changed installer, OMP, memory, proposal, service, policy, bootstrap, SDK, and shipped-mirror entry points built independently with no generated repository artifacts.
- Kernel conformance: all `11` required probes passed, including generated failure-injection rollback evidence. Scope remains kernel/non-certifying.
- Isolated fresh-install smoke: DetectEnv selected the declared temp Claude root; current core (`952` skills and `675` runtime files), settings, USER scaffold/link, and `82` hook files installed; OMP install/status/uninstall exited `0`; status was wired/loadable, `active: false`, and `C0`; uninstall removed owned OMP wiring. The durable USER link was observed before cleanup.
- Selected-root follow-up: isolated Codex and OMP detection bound config and skills coordinates to the declared root; a real-Bun custom-root install created the durable USER link, rebased LifeOS environment and hook commands, reported OMP `wired: true` / `active: false`, uninstalled owned wiring, and removed its sandbox.
- Cadence concurrency: the fresh-lease regression passed, focused two-process contention passed `200/200`, and stale recovery remains age/lease-based with explicit ownership-loss failures.
- Core update smoke: a second deployment updated only changed owned payload (`1` skill and `3` runtime files), refused drifted ownership in regression coverage, and retained the original uninstall baseline. The dependency-free payload created no `node_modules` side effect.
- CI contract: YAML parsed with blocking `compile`, `unit`, `fixtures`, and `conformance` jobs across Windows, macOS, and Linux; checked-in probes passed under local Bash and PowerShell on Windows. Hosted macOS/Linux execution remains unobserved.
- Repository guard: `bun Tools/validate-protected.ts` validated all six protected files.
- Final isolated install smoke: settings, USER scaffold/link, hooks, OMP install/status/uninstall all exited `0`; the USER target was a symlink; OMP reported `wired: true`, `loadable: true`, `active: false`, and `C0`; the temporary sandbox was removed.
- Cleanup: generated `.build` output removed; the pre-existing unrelated `ToolInventory.md` deletion was not touched.
