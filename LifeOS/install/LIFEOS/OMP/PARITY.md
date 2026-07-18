# Parity Accounting — LifeOS on OMP vs Claude Code Native

> The complete disposition of every Claude Code integration surface: what's ported, how,
> what isn't, why, and what "full possible parity" means. Source classification: all 61
> `hooks/*.hook.ts` files + 2 Pulse HTTP routes + the `settings.json` hook bindings,
> audited 2026-07-08; manifest current as of 2026-07-11.

## The parity claim, precisely

**Parity = reproduce what Claude Code actually runs** (the hooks wired in `settings.json`,
the constitution, memory, commands), **not what merely exists on disk.** Under that
definition this integration is at *full possible parity*: every portable behavior is
ported, and the remaining delta is exactly (a) four documented OMP architectural walls and
(b) terminal cosmetics with no OMP analog. Nothing portable is left unported.

## Subsystem parity table

| Subsystem | CC native | OMP | Mechanism |
|---|---|---|---|
| Constitution | `--append-system-prompt` | ✅ | `APPEND_SYSTEM.md` symlink |
| Identity / TELOS / skills / MCP | `@`-imports + skills dir | ✅ | OMP `claude` discovery provider reads compatible local files; it does not invoke Claude or require Anthropic authentication |
| Format regime | 7.x: ONE unified format (modes/tiers retired 2026-07-11, "Bitter Pill") | ✅ | The constitution carries the unified-format contract; StopGates/FormatGate records compliance telemetry. (The pre-7.x mode system is gone — no banners toggle, nothing to classify.) |
| Memory injection | LoadMemory hook | ✅ | native `lifeos-memory` (+ prompt-keyed retrieval) |
| Autonomic memory loop | MemoryReviewFire → Reviewer (cadence consolidated upstream 2026-07) | ✅ | adapter + Reviewer patched to read OMP sessions |
| Safety | Safety.hook.ts (PermissionRequest + PostToolUse) | ✅ deny-half | native `lifeos-safety`; allow-half = wall #1 |
| Work/ISA sync → Pulse | ISASync, work.json | ✅ | adapter; Pulse reads shared state |
| Observability → Pulse | ToolActivity/FailureTracker | ✅ | native `lifeos-observability`, same jsonl schemas |
| Effort levers | /e1–/e5 effort routing | ✅ | commands ext → native `setThinkingLevel` |
| Slash commands | commands/*.md | ✅ | /interview /cs /context-search /pu |
| Voice on completion | VoiceCompletion → ElevenLabs | ✅ gated | Pulse-liveness gate |
| Statusline | LIFEOS_StatusLine.sh | ✅ full | The REAL script, spawned per turn with synthesized CC-shape stdin; `setWidget` panel (10-line distilled) + compact `setStatus` line with session-scoped `DIRECT` / `ALGO <phase> <effort>` depth. `/statusline on\|off\|refresh` |
| Install lifecycle | settings.json managed by CC | ✅ | manage.ts install/uninstall/status/inference; OMP-launched inference defaults to bare `omp`, with Claude available only by explicit override |

## Hook-by-hook disposition

### Bridged through the adapter (real hook files execute; CC stdin/stdout protocol)
| CC event → OMP event | Hooks |
|---|---|
| UserPromptSubmit → before_agent_start | MemoryDeltaSurface, SatisfactionCapture, ReminderRouter |
| SessionStart → before_agent_start (once) | LoadContext |
| PreToolUse → tool_call | SystemFileGuard (exit-2 block honored), AgentGuard Pulse HTTP route (task calls) |
| PostToolUse → tool_result | ISASync, CheckpointPerISC |
| Stop → session_stop | MemoryReviewFire, MemoryHealthGate, DocIntegrity, ISARenderOnStop, VoiceCompletion (Pulse-gated), StopGates (FormatGate + VerificationGate + WritingGate — successors of OutputFormatGate/SuccessClaimGate) |
| SessionEnd → session_shutdown | UpdateCounts, WorkCompletionLearning, SessionCleanup, IntegrityCheck |

Retired upstream (2026-07 hooks consolidation), intentionally absent here: TheRouter,
OutputFormatGate→StopGates, SuccessClaimGate→StopGates, MemoryReviewTrigger→MemoryReviewFire,
TelosSummarySync, RelationshipMemory, ArtWorkflowGuard.

Adapter fidelity guards (each closed a real silent-failure found in testing): `CLAUDE_*` env shim (PROJECT_DIR/PLUGIN_ROOT/EFFORT), OMP→CC
tool-name map, tool-INPUT normalization (OMP `path` → CC `tool_input.file_path` — without it every path-gated hook (SystemFileGuard, ISASync, CheckpointPerISC) silently no-op'd; ISASync now verified end-to-end: OMP ISA.md write → work.json updated), `transcript_path` + `last_assistant_message` fed to Stop/SessionEnd hooks,
Pulse liveness gate, subagent + once guards, CC `async: true` parity (SatisfactionCapture / ReminderRouter run detached fire-and-forget, never blocking the turn — matching their settings.json flags), fail-open (only an explicit `decision:block`
ever affects the turn — Stop-hook stdout is informational, matching CC).

### Ported natively (in-process — these fire per tool call; subprocess latency unacceptable)
- **Safety** (`lifeos-safety`) — imports the real `hooks/lib/safety-classifier`; dangerous-shape/injection/credential blocking + external-content data-framing.
- **ToolActivityTracker + ToolFailureTracker** (`lifeos-observability`) — byte-compatible jsonl schemas.
- **LoadMemory + MemoryRetriever** (`lifeos-memory`) — supersedes the adapter path to avoid double-injection.

### Not ported — with reasons
| Group | Hooks | Reason |
|---|---|---|
| CC settings/self-management | HookHealer, IdentityToSettingsSync, SettingsBackport, MergeSettings, FreshnessCache | Manage Claude Code's own settings.json/exec bits; OMP manages its own config |
| Terminal (kitty) cosmetics | KittyEnvPersist, SetQuestionTab, QuestionAnswered, ResponseTabReset | No OMP analog; OMP owns its terminal UI |
| CC-only events | TaskGovernance (TaskCreated), ConfigAudit (ConfigChange), StopFailureHandler (StopFailure), InstructionsLoadedHandler (InstructionsLoaded), ToolFailureTracker's CC event (superseded by native port) | Events OMP does not emit — wall #4 |
| CC transcript/meta | LastResponseCache, AgentInvocation | CC-specific transcript/subagent metadata; activity covered by native observability |
| Pulse session naming/voice ping | PromptProcessing | OMP names its own sessions; per-turn voice ping was the CC NATIVE-mode curl |
| SkillGuard Pulse route | (http route) | OMP has no `Skill` tool — skills load via `read`, so the matcher surface doesn't exist |
| **UNBOUND in CC itself (20)** | RepeatDetection, EgressClassGuard, SkillExecutionLog, DriftReminder, LoopDetector, SkillSurface, CommunicationSkillGuard, WritingGate, SkillVoiceNotify, ElicitationHandler, SmartApprover, FileChanged, PreCompact, ContainmentGuard, TeammateIdle, KVSync, RestoreContext, SecurityPipeline, ContentScanner, PromptGuard | Not wired in Claude Code's `settings.json` — porting them would ADD behavior, not reach parity |

## The four architectural walls (impossible in current OMP, per its extension contract)

1. **Granting permissions / auto-approve.** OMP extensions can *deny* (`tool_call` block) but
   cannot *grant* — approval resolution isn't exposed (`tool_approval_*` events are
   observability-only). CC's Safety allow-cache and SmartApprover's grant-half cannot exist.
   Mitigation: OMP's own allowlists / approval settings.
2. **Rewriting tool inputs in-flight.** OMP: "cannot mutate raw tool input parameters
   in-place (only block/allow)." CC's `updatedInput` has no OMP path. Currently moot — no
   wired LifeOS hook rewrites inputs.
3. **MCP elicitation interception.** No extension surface (ElicitationHandler was UNBOUND
   in CC anyway).
4. **Harness-introspection events.** ConfigChange / InstructionsLoaded / StopFailure have no
   OMP equivalents; only approximable by polling.

Partial: **subagent granularity** — CC tags subagents via env (`CLAUDE_CODE_SUBAGENT_*`);
OMP doesn't expose equivalents to hook subprocesses. Best-effort guard + OMP's own boundary
(session_stop/shutdown never fire for task subagents) backstop it.

## Why this is "full possible parity"

Every surface falls into exactly one of: **ported** (bridged or native),
**intentionally excluded because CC itself doesn't run it** (the 20 unbound hooks), or
**impossible under OMP's published extension contract** (the 4 walls + cosmetics). There is
no fourth bucket — no portable, CC-active behavior is left out. Closing the walls requires
OMP API changes (approval resolution being the plausible next one), not more porting work.

## Verifying the claim

- `bun LIFEOS/OMP/manage.ts status` — wiring state
- Any prompt renders the unified format (banner → answer → 🧠 MEMORY when delta present → 🗣️
  closer); StopGates telemetry lands in `MEMORY/OBSERVABILITY/`
- Dangerous bash (`chmod -R 777 /tmp/x`) → blocked with `LifeOS Safety blocked Bash: …`
- Tool runs append to `MEMORY/OBSERVABILITY/tool-activity.jsonl` (CC schema)
- Session end → reviewer spawn logged in `reviewer-fires.jsonl`
