# PRD: PR #1 Stabilization

- **Status:** implemented and locally verified; cross-OS hosted-runner execution remains unobserved
- **Audience:** LifeOS/UAI maintainers, adapter authors, release engineers
- **Public adapter contract:** `uai.adapter.v1`
- **Runtime name:** LifeOS
- **Default durable data root:** `~/.pai` (`UAI_DATA_DIR` and `PAI_DATA_DIR` are compatible overrides)

## Problem

PR #1 introduced a useful OMP adapter but made installation and runtime claims that configuration presence could not prove. A partial source tree could report hooks and safety as installed, native sessions shared the literal ID `omp`, Windows profiles depended on POSIX assumptions, and configuration writes were not a reversible transaction. Memory review could inspect a different session's transcript, detached hooks ignored their timeout, launchd was treated as universal, runtime dependencies could be skipped, and the documented fresh-install path deployed an obsolete release.

Those defects are release blockers because they can silently remove security controls, mix session state, mutate a real profile during tests, or leave a user's configuration partially rewritten.

## Users

- **LifeOS operator:** needs installation to be additive, profile-isolated, honest, and reversible.
- **OMP user:** needs each native session to retain its own identity, state, audit rows, and transcript provenance.
- **Installer maintainer:** needs deterministic Windows/macOS/Linux behavior and actionable preflight failures.
- **Adapter author:** needs stabilization behavior that can later be expressed through `uai.adapter.v1` without OMP-only policy forks.
- **Release engineer:** needs focused negative controls that fail a release when safety, rollback, or isolation regresses.

## Goals

1. Fail before profile mutation when OMP safety, hooks, classifiers, parsers, or extension manifests are not loadable.
2. Separate installed, wired, loadable, observed, and active claims; presence alone never means active.
3. Bind a stable, unique UAI session ID to the native session, profile root, and transcript.
4. Run correctly on Windows profiles with `HOME` absent, PATHEXT executables, normalized separators, and link fallback.
5. Make JSON/YAML mutations parse-first, staged, atomic, ownership-aware, and reversible.
6. Pass the stopping transcript directly to bounded, off-loop review work.
7. Enforce hook deadlines for awaited and fire-and-forget children and recover after transient Pulse downtime.
8. Deploy current LifeOS and OMP runtime from a fresh checkout.

## Non-goals

- Claiming OMP behavioral parity with Claude Code where OMP exposes no equivalent primitive.
- Moving the default durable data root from `~/.pai` to `~/.uai`.
- Implementing universal TOML lifecycle mutation in an OMP-specific stabilizer; that belongs to the shared lifecycle/adapter layer.
- Adding non-macOS service-manager claims before a systemd-user or Windows Scheduled Task adapter has executable evidence.
- Migrating or deleting USER data during uninstall.

## Requirements and defect traceability

| ID | Confirmed defect and user impact | Implementation surface | Acceptance criterion | Executable probe |
|---|---|---|---|---|
| S1 | OMP install was false-green when safety classifiers or shared hooks were absent. Users believed critical controls were active when they could not load. | `LifeOS/install/LIFEOS/OMP/manage.ts`, `LifeOS/Tools/InstallHooks.ts` | Preflight validates constitution, all five extension entries/manifests, required bridged hooks, safety classifier, reviewer, parser, and referenced hook files. A core-only source returns failure and creates no profile path. | `stabilization.test.ts`: **core-only source fails before creating the profile**; **full install preserves foreign settings and hook files**. |
| S2 | Status inferred safety from copied files/configuration. | `LifeOS/install/LIFEOS/OMP/manage.ts` | Status reports `wired`, `loadable`, and `active` separately. `active` additionally requires same-contract evidence with adapter/CLI/OS-profile/probe/timestamp/evidence URI and an observed block. | `stabilization.test.ts`: valid install is wired/loadable but explicitly not active without evidence. |
| S3 | Persisted `session_id: "omp"` mixed concurrent sessions, once-guards, ISA state, cleanup, and audits. | `OMP/session.ts`, `extensions/lifeos-hooks/index.ts`, `extensions/lifeos-observability/index.ts`, `MemoryReviewFire.hook.ts` | ID is stable within a native session and distinct across transcript/profile roots. Hook stdin carries UAI/native/profile identity. Once-guards are session-scoped. State and audit rows retain distinct IDs. | `stabilization.test.ts`: **two native sessions receive distinct stable root-bound identities**, **concurrent sessions retain separate cadence state**; observability test checks distinct audit rows. |
| S4 | Windows resolution assumed `HOME`, POSIX separators, `command -v`, extensionless executables, and privileged symlinks. | `LifeOS/Tools/InstallEngine.ts`, `InstallSettings.ts`, `InstallHooks.ts`, `DeployCore.ts`, `DeployComponents.ts`, `ScaffoldUser.ts`, OMP extensions/manager | `USERPROFILE`/`homedir()` fallback works with `HOME` absent; executable lookup honors PATH/PATHEXT without Bash; paths normalize; Windows directory links use junction semantics and constitution links fall back to copies. POSIX behavior remains executable-bit aware. | `stabilization.test.ts`: **HOME-unset fixture resolves USERPROFILE and PATHEXT command** using a fake `.cmd`. |
| S5 | Tests could touch live profiles and used Unix-only fake binaries. | All OMP focused tests | Every filesystem mutation is under a temp HOME/USERPROFILE/LIFEOS_DIR/agent root; environment is restored in cleanup; Windows fixtures use `.cmd`; sentinels survive install/rollback. | All focused OMP tests plus temp-root sentinel assertions. |
| S6 | Memory review searched globally newest transcript instead of reviewing the session that stopped; synchronous retrieval could stall OMP's event loop. | `MemoryReviewFire.hook.ts`, `MemoryReviewer.ts`, `extensions/lifeos-memory/index.ts`, `extensions/lifeos-hooks/index.ts` | Stop stdin's exact `transcript_path` becomes `MemoryReviewer review --input <path>`. Global newest search is used only when input is absent. OMP retrieval runs asynchronously with a hard deadline and child termination. | `stabilization.test.ts`: **the stopping transcript is passed explicitly to the reviewer** and timeout recovery probes. |
| S7 | YAML/JSON mutation could discard malformed config, partially apply, or destructively uninstall foreign content and prior APPEND_SYSTEM material. | `OMP/manage.ts`, `LifeOS/Tools/InstallHooks.ts`, `InstallSettings.ts`, `DeployCore.ts`, `UNIVERSAL/lifecycle.ts` | Existing YAML/JSON is parsed and shape-checked before writes. OMP, hook, settings, dependency, and core payload writes use canonical `uai.install-plan.v1` plans with byte/mode/link snapshots, durable journals, atomic writes, recovery-before-retry, and rollback-conflict detection. Settings/package manifests are last. Uninstall removes only owned entries and preserves post-install foreign changes. | `stabilization.test.ts`: malformed YAML/JSON, injected failures at hooks/settings/manifest/core boundaries, drift preservation, foreign preservation, exact-byte restoration, and prior-link restoration; universal lifecycle regression tests cover crash recovery and rollback conflict. |
| S8 | Existing `package.json` caused required runtime dependencies to be skipped, while an inline package-manager child could mutate lockfiles and `node_modules` outside the staged plan. | `LifeOS/Tools/DeployCore.ts`, `LifeOS/install/package.json`, core YAML readers under `LIFEOS/TOOLS`, `PULSE/Observability`, and `hooks/lib/identity.ts` | The current core uses built-in `Bun.YAML.parse` and has no external runtime dependency, so a fresh empty profile deploys without `node_modules`. Future source dependencies merge into an existing valid manifest without deleting foreign fields only when every exact import is already resolvable. Malformed manifests and unresolved imports block before target mutation; non-transactional package-manager side effects are refused. | `stabilization.test.ts`: fresh dependency-free DeployCore, isolated resolvable dependency merge, malformed manifest, unresolved-import zero-mutation blocker, injected failure rollback, and plan-drift third-state preservation; full current-payload temp-profile smoke. |
| S9 | Awaited and detached hook children could outlive `timeoutMs`; one Pulse failure was cached forever. | `extensions/lifeos-hooks/index.ts` | Both child modes terminate on deadline (including process tree where supported), resolve failure, and allow the next hook. Positive Pulse state is reusable; negative state expires after a short TTL. | `stabilization.test.ts`: **awaited child is terminated at timeout and the next hook can run**, **detached child is also terminated at timeout**. |
| S10 | Service control invoked launchd/Bash on every OS and ignored custom config roots. | `LifeOS/install/LIFEOS/TOOLS/Services.ts` | Launchd executes only on macOS. Non-macOS status returns explicit foreground/unsupported capability without invoking launchctl/Bash. `LIFEOS_DIR`, `CLAUDE_CONFIG_DIR`, `USERPROFILE`, and `--config-root` determine paths. | `stabilization.test.ts`: custom-root and platform-gate probes. |
| S11 | README instructed fresh users to install a retired release at an old commit. | root `README.md`, `LifeOS/INSTALL.md`, `OMP/README.md` | Instructions start from the current checkout, deploy `LifeOS/install` through current Bun tools, and explicitly wire/verify OMP only after hooks/runtime exist. | Documentation command smoke in an isolated temp profile; path search contains no pinned retired install path in the current-install section. |
| S12 | Runtime import/loadability and release probes were not blocking. | `DeployCore.ts`, OMP manager/status, focused tests; CI integration owned by universal runtime stream | Install verifies dependencies and exact imports; OMP status refuses loadability claims with missing inputs. CI runs the focused stabilization command on its OS matrix. | `bun test LifeOS/install/LIFEOS/OMP/stabilization.test.ts ...`; `bun build --no-bundle` on touched entries. |

## User journeys

### Safe fresh OMP install

1. The operator deploys current LifeOS core, settings, dependencies, and the approved required hook set into an isolated harness root.
2. `manage.ts install` parses current OMP YAML and validates every dependency before creating or replacing anything.
3. The manager stages an ownership record, constitution link/copy, and additive extension list, then commits atomically.
4. `status` reports wiring and loadability. It remains inactive until an observed control probe writes complete evidence.
5. If any step fails, prior bytes/link are restored; a previously absent profile remains absent.

### Concurrent OMP sessions

1. OMP exposes each native transcript path.
2. LifeOS derives a stable UAI ID from profile root, native session ID, and transcript path.
3. Hook stdin, once-guards, ISA/cadence state, observability, cleanup, and review use that identity.
4. Two simultaneous sessions produce separate state keys and audit rows and never consume each other's stopping transcript.

### Reversible uninstall

1. Uninstall requires a valid UAI ownership manifest; it refuses guessing.
2. Only manifest-owned extension entries and constitution material are removed.
3. If foreign configuration is unchanged, exact original bytes are restored. If foreign content changed after install, it is preserved while owned entries are removed.
4. USER and MEMORY are retained.

### Windows profile without Bash

1. The installer runs with `HOME` unset and `USERPROFILE` set.
2. Paths resolve without `~` or empty-root artifacts, `.cmd` tools resolve through PATHEXT, and no Bash command is required on the critical path.
3. Directory separation uses a junction; file constitution uses symlink when permitted or a copy fallback.

## Architecture impact

- **Identity:** OMP now emits UAI/native/profile/transcript identity instead of a harness-wide constant.
- **Lifecycle:** OMP, required hooks, settings, dependencies, and core payload deployment consume the canonical universal install-plan/journal implementation. Recovery runs before retry; compare-before-apply and compare-before-rollback preserve third-state user edits as visible conflicts.
- **Capability truth:** status distinguishes wiring/loadability from observed active evidence.
- **Configuration:** JSON, YAML, and TOML are parsed and shape-checked before mutation. Settings and package manifests land last in their plans; unresolved package-manager side effects block rather than escaping the journal.
- **Platform:** home, executable, separator, link, and service behavior use explicit platform primitives rather than shell inference.
- **Data:** `~/.pai` remains the durable USER/MEMORY default; runtime configuration roots remain harness-specific.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Windows symlink privilege is unavailable. | Use junctions for directories and copy fallback for the OMP constitution; record ownership for deterministic removal/restoration. |
| Process-tree termination differs by OS. | Use direct child kill plus `taskkill /T` on Windows and process-group kill on POSIX; treat timeout as a failed hook and prove subsequent recovery. |
| A user edits config after install. | Uninstall filters only manifest-owned entries; exact byte restoration occurs only when remaining parsed content equals the original snapshot. |
| Evidence becomes stale or belongs to another adapter/OS. | `active` requires all evidence identity fields and exact adapter contract; release conformance adds version/age policy. |
| OMP API lacks a native session ID. | Transcript filename is the native ID; if unavailable, a process-local UUID is cached to the session manager/context and marked with no-transcript provenance. |
| Concurrent state writers race. | Memory cadence state uses a bounded exclusive lock and atomic rename. Append-only audit files retain session IDs. |
| A file changes after planning or during crash recovery. | Compare the current byte/type/mode/link identity with the planned identity before apply and rollback; preserve mismatched third-state content and return a rollback conflict. |
## Rollout and rollback

1. Ship focused regression tests and stabilization implementation together.
2. Gate the OS matrix on Windows, macOS, and Linux focused tests/builds.
3. Roll out install/status semantics first; do not publish `active` until the observed negative probe produces evidence.
4. For rollback, run ownership-aware OMP uninstall. It restores prior APPEND_SYSTEM and config bytes where unchanged and retains durable USER/MEMORY.
5. If a release is interrupted, rerun the same command. It recovers the durable journal before creating a new plan; invalid ownership or drift fails visibly instead of guessing.

## Metrics and evidence

- Zero mutations for every failed preflight and injected-failure fixture.
- 100% distinct IDs in the two-session concurrency probe.
- Exact stopping transcript path in reviewer args and review result provenance.
- Exact original configuration bytes after rollback and unchanged uninstall.
- No files outside temp roots change during tests (sentinel hashes in CI).
- Hook timeout latency remains bounded and the immediate recovery hook succeeds.
- Support output records adapter version, CLI version, OS/profile, probe ID, timestamp, and evidence URI before `active`.

## Dependencies

- Bun runtime and Bun test/build tooling.
- OMP public extension/session/transcript APIs.
- Full LifeOS hooks payload and the canonical safety classifier.
- Canonical universal-runtime lifecycle journal, structured parser validation, recovery, and rollback-conflict semantics.

## Roadmap traceability

| Roadmap package | Stabilization contribution |
|---|---|
| R2 Platform primitives | Windows home, PATHEXT, normalized paths, junction/copy behavior, service gate. |
| R6 Session/transcript/audit | Stable root-bound IDs, exact transcript provenance, separate audit/state rows. |
| R7 Shared roots and OMP repair | `~/.pai` aliases and repaired OMP runtime assumptions. |
| R8 Reversible Claude/OMP install | Parse-first transactions, ownership snapshot, atomic apply, rollback, uninstall preservation. |
| R9 Critical conformance | False-green negative controls and evidence-gated active state. |
| R11 Services/status/Pulse portability | launchd platform gate, foreground result, expiring Pulse-negative cache. |
| R14 Certification/release CI | Focused OS fixtures and build/test commands ready for blocking matrix integration. |

## Acceptance command

```bash
bun test LifeOS/install/LIFEOS/OMP/stabilization.test.ts \
  LifeOS/install/LIFEOS/OMP/extensions/lifeos-hooks/index.test.ts \
  LifeOS/install/LIFEOS/OMP/extensions/lifeos-observability/index.test.ts
```

Build probes compile each edited TypeScript entry independently with `bun build --no-bundle --target=bun --outfile <temp-file> <entry>`. Do not batch entries under `--outdir`: Bun 1.3.9 on Windows can panic with an internal integer-overflow before compilation. All mutating scenarios must run with temporary HOME, USERPROFILE, harness, data, and LifeOS roots.
