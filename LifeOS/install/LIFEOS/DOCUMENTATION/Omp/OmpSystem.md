# OMP Integration System

> How LifeOS runs inside the **Oh My Pi (`omp`)** harness. LifeOS is harness-agnostic by
> design; this subsystem is the first concrete second-harness adapter, built entirely on
> OMP's public extension API. Source lives under `LIFEOS/OMP/`.

## Overview

LifeOS ships Claude-Code-native: a `--append-system-prompt` constitution, `@`-imported
identity, and `settings.json` hooks. OMP exposes different primitives — an
`APPEND_SYSTEM.md` file, a `claude` discovery provider, and a `pi.on(event, …)` extension
runtime — so the same LifeOS install is made to govern OMP sessions through five extensions,
an adapted constitution, and two additive tool patches. No LifeOS core file is forked; the
adapter runs the **real** Claude Code hook scripts against mapped OMP events.

Identity, TELOS, skills, and MCP servers already reach OMP via its `claude` discovery
provider (it reads `~/.claude/CLAUDE.md` and `~/.claude/skills/`). This subsystem supplies
only what that provider does not: the constitution, memory injection, safety, and the hooks.

## Components (`LIFEOS/OMP/`)

| Component | Type | Role |
|---|---|---|
| `APPEND_SYSTEM.md` | constitution | Portable LifeOS constitution for OMP — identity, verification doctrine, security protocol, prohibitions, privacy, operational rules. Claude-Code-only mode-banner enforcement is rewired to effort guidance. Symlinked to `<agent-dir>/APPEND_SYSTEM.md`. |
| `extensions/lifeos-memory` | extension | `before_agent_start` injects the hot-layer `<pai-memory>` block + prompt-keyed `<pai-knowledge>` retrieval. Ports `LoadMemory.hook.ts` + `MemoryRetriever.ts`. |
| `extensions/lifeos-safety` | extension | Native in-process port of `Safety.hook.ts`, reusing `hooks/lib/safety-classifier`. `tool_call` blocks dangerous-shape/injection/credential ops; `tool_result` tags attacker-writable sources (web/mcp) as data. |
| `extensions/lifeos-hooks` | extension | CC-hook-protocol adapter — runs real `hooks/*.hook.ts` against OMP events. |
| `extensions/lifeos-commands` | extension | `/e1`–`/e5` (native `setThinkingLevel`) and `/interview`. |
| `manage.ts` + `install.sh`/`uninstall.sh` | lifecycle | Idempotent, YAML-safe wiring into the OMP agent dir. |

## The hook adapter

Each bridged hook is invoked as a bun subprocess with the Claude Code stdin/stdout contract
(`{ hook_event_name, tool_name, tool_input, tool_response, prompt, transcript_path, … }` →
`{hookSpecificOutput:{additionalContext}}` | `{decision:"block",reason}` | plain text), then
translated to OMP's return shape. Event map:

| Claude Code | OMP |
|---|---|
| SessionStart | `session_start` |
| UserPromptSubmit | `before_agent_start` |
| PreToolUse | `tool_call` (may block; also honors exit-code-2) |
| PostToolUse | `tool_result` |
| Stop | `session_stop` |
| SessionEnd | `session_shutdown` |

Fidelity guards (why an adapter, not a symlink):

- **`CLAUDE_*` env shim** — hooks read `CLAUDE_PROJECT_DIR` / `CLAUDE_PLUGIN_ROOT` /
  `CLAUDE_EFFORT`, unset under OMP; synthesized per invocation.
- **Tool-name mapping** — OMP `bash`/`write`/`edit` → CC `Bash`/`Write`/`Edit`.
- **Transcript surface** — `session_stop`/`session_shutdown` pass `transcript_path`
  (`ctx.sessionManager.getSessionFile()`) + `last_assistant_message` (from `getBranch()`).
- **Pulse gate** — hooks that fetch `localhost:31337` are skipped when Pulse is down.
- **Subagent + once guards**, and **fail-open**: any error contributes nothing; a turn is
  only ever blocked by an explicit hook `decision:block`.

### What is / isn't bridged

- **Bridged**: memory (MemoryDeltaSurface; LoadMemory is native in `lifeos-memory`), autonomic
  loop (MemoryReviewFire → MemoryReviewer), MemoryHealthGate, LoadContext (once),
  SatisfactionCapture, ReminderRouter, ISASync + CheckpointPerISC (on write/edit),
  SystemFileGuard, the Pulse agent-guard HTTP route (on task calls, Pulse-gated), DocIntegrity,
  ISARenderOnStop, VoiceCompletion (Pulse-gated), StopGates (FormatGate + VerificationGate +
  WritingGate), UpdateCounts, WorkCompletionLearning, SessionCleanup, IntegrityCheck. Safety and
  the activity/failure trackers are native (in-process).
- **Retired upstream** (7.0.0 "Bitter Pill", 2026-07-11 — the ENTIRE mode system went with it:
  modes, tiers, routing, per-mode templates; see `DOCUMENTATION/Router/RouterSystem.md`):
  TheRouter, OutputFormatGate + SuccessClaimGate (→ StopGates), MemoryReviewTrigger
  (→ MemoryReviewFire), TelosSummarySync, RelationshipMemory, ArtWorkflowGuard.
- **N/A** (no OMP analog): terminal-tab hooks, CC settings-sync hooks, the SkillGuard Pulse
  route (OMP has no Skill tool). Hooks not wired in Claude Code's `settings.json` are not
  bridged either. Stop-hook stdout is informational; the adapter continues a turn only on an
  explicit `decision:block`.

## Tool patches (additive, Claude-Code-safe)

- `LIFEOS/TOOLS/MemoryReviewer.ts` — `findMostRecentTranscript()` also scans
  `~/.omp/agent/sessions`, so the autonomic loop reviews OMP sessions.
- `LIFEOS/TOOLS/TranscriptParser.ts` — reads OMP's nested `type:"message"` line shape as well
  as Claude Code's `type:"assistant"`, Codex's `response_item`, and OpenCode's top-level shape.

## Lifecycle

```bash
bun LIFEOS/OMP/manage.ts install     # wire into <agent-dir> (idempotent; backs up config.yml)
bun LIFEOS/OMP/manage.ts status      # report wiring state
bun LIFEOS/OMP/manage.ts uninstall   # remove wiring; leaves the tree
```

`install` merges the five extensions into `<agent-dir>/config.yml` (YAML parse/merge — never
blind append) and symlinks `APPEND_SYSTEM.md`. Respects `PI_CODING_AGENT_DIR` (works under
`omp --profile`). Fully reversible.

## Security & boundary

`LIFEOS/OMP/**` is a SYSTEM zone (not listed in `hooks/lib/containment-zones.ts` private
zones), so it ships with releases. Every file resolves paths via `homedir()`/env — no
principal-specific data is baked in. The adapter never runs hooks with external side effects
unless explicitly opted in, and gates Pulse/network hooks behind a liveness probe.
