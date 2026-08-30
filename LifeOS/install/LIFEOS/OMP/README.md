# LifeOS ↔ OMP (Oh My Pi) Integration

Adds LifeOS surfaces to the [Oh My Pi](https://github.com/) harness (`omp`)
through OMP's public extension API without forking either system. This is an
additive adapter: checked-in fixtures prove isolated wiring and loadability,
not Claude parity or live C3 enforcement.

No Claude CLI, Anthropic account, or Claude subscription is required. The deployed
LifeOS source may live under a selected harness configuration root, while canonical
durable USER/MEMORY data defaults to `~/.pai` and honors `UAI_DATA_DIR`/`PAI_DATA_DIR`.

## What it provides

| Piece | Mechanism |
|---|---|
| **Constitution** | `APPEND_SYSTEM.md` → `~/.omp/agent/APPEND_SYSTEM.md` symlink. One unified response format (upstream 7.0.0 retired the mode system). For byte-exact stock behavior, point the symlink at the deployed `LIFEOS/LIFEOS_SYSTEM_PROMPT.md`. |
| **Memory** | `extensions/lifeos-memory` — injects the hot-layer `<pai-memory>` block + prompt-keyed KNOWLEDGE retrieval each turn (ports `LoadMemory` + `MemoryRetriever`). |
| **Safety** | `extensions/lifeos-safety` — in-process OMP safety policy for mapped tool calls. Its wiring is bounded-load tested; behavioral certification still requires trusted live evidence. |
| **Hook adapter** | `extensions/lifeos-hooks` — runs selected shared LifeOS hooks against mapped OMP events with a CC-shape stdin/stdout adapter, tool-name mapping, deadlines, and Pulse degradation reporting. |
| **Observability** | `extensions/lifeos-observability` — additive tool/failure audit rows and compact OMP status. The Bash panel runs only where Bash is available; Windows and headless sessions emit a visible advisory plus durable degraded evidence instead of claiming a panel. |
| **Commands** | `extensions/lifeos-commands` — compatible `/e1`–`/e5`, `/interview`, `/cs`, `/context-search`, and `/pu` surfaces where OMP exposes the required API. |

Identity, TELOS, skills, and MCP servers already flow into OMP via its `claude` discovery
provider. That provider only reads compatible local files; it does not invoke or authenticate
the Claude CLI. This subsystem supplies the constitution, hooks, and memory injection.

Per-hook accounting, including unsupported gaps, is documented in [PARITY.md](./PARITY.md). The filename is historical; it is not a parity claim.

## Install / uninstall

Deploy the current LifeOS runtime and approved hook set first. The OMP manager
refuses a core-only/partial source before touching the selected OMP profile.

```bash
bun LIFEOS/OMP/manage.ts install
bun LIFEOS/OMP/manage.ts status
bun LIFEOS/OMP/manage.ts uninstall
```

The TypeScript manager runs without an implicit Bash dependency and respects
`PI_CODING_AGENT_DIR`. Installation parses YAML, performs bounded extension and
hook load probes, writes through the ownership-aware lifecycle, and uses a
constitution link or copy fallback. Uninstall removes only unchanged owned
entries; conflicts retain ownership metadata for retry.

`status` reports wiring and source loadability. The repository fixture suite
keeps certification at C0; copied files and fixture probes never mean a control
is live or C3-enforced.

Inference backend: `bun LIFEOS/OMP/manage.ts inference default|claude|omp|auto|status`.
With no override, OMP hook subprocesses automatically use bare `omp` on **OMP's own default
model/auth**, so a fresh OMP user gets the complete intelligence layer without Claude.
`claude` is an explicit opt-in; `auto` tries Claude first and retries once through OMP;
`default` removes an override and restores the Claude-free OMP default. Environment variables
`LIFEOS_INFERENCE_BACKEND` and `LIFEOS_OMP_INFERENCE_MODEL` override per invocation. Pin models
with a fully-qualified `provider/model` ID to avoid resolving an unauthenticated provider copy.

## CC→OMP event map (adapter)

`SessionStart→session_start` · `UserPromptSubmit→before_agent_start` · `PreToolUse→tool_call` ·
`PostToolUse→tool_result` · `Stop→session_stop` · `SessionEnd→session_shutdown`.

Bridged hooks are curated for safety: Pulse-coupled hooks are gated behind a liveness probe.
StopGates (FormatGate + VerificationGate + WritingGate) records format/claim telemetry on every
stop. Stop-hook stdout is informational only —
the adapter continues a turn ONLY on an explicit `decision:block`. Hooks with no OMP analog
(terminal tabs, CC settings sync) and the hooks not wired in Claude Code's own
`settings.json` are intentionally not bridged.

## Three additive tool patches (harness-agnostic, CC-safe)

- `LIFEOS/TOOLS/MemoryReviewer.ts` — reviews the Stop hook's exact
  `transcript_path`; only a caller with no explicit input falls back to the
  newest transcript across Claude and OMP stores.
- `LIFEOS/TOOLS/TranscriptParser.ts` — `textMessageFromEntry()`/`isRealUserPrompt()` read OMP's
  nested `type:"message"` `{ message: { role, content } }` line shape alongside Claude Code's
  `type:"assistant"`, Codex's `response_item`, and OpenCode's top-level `type:"message"`.
- `LIFEOS/TOOLS/Inference.ts` — harness-aware backend selection: OMP-launched consumers default
  to `omp`; non-OMP Claude Code/Codex behavior remains unchanged unless explicitly overridden.

All are additive; Claude Code behavior is unchanged.

## Design notes

- **Adapter over rewrite** — the adapter runs the real hook files, so logic stays
  single-sourced with Claude Code and does not drift.
- **Fail-open** — any adapter/hook error contributes nothing; the turn is only ever blocked
  by an explicit hook `decision:block`.
- **No private data** — every file resolves paths via `homedir()`/env; nothing principal-
  specific is baked in.

## Verifying (fresh system)

Per LifeOS's contributing guidance ("test in a fresh system"). Requires a LifeOS install,
`omp`, and `bun`.

1. `bun LIFEOS/OMP/manage.ts install` → wires the 5 extensions + constitution symlink.
2. `bun LIFEOS/OMP/manage.ts status` → all five extensions and the symlink show ✓; source
   check reports the constitution, extensions, and both tool patches present.
3. Open a fresh `omp` session (or `omp --print "hi"`). Confirm:
   - a `<pai-memory>` block is in context (the `## PRINCIPAL MEMORY [N/48 …]` header);
   - the constitution loaded (asked to emit `════ MODE ════` banners, it declines — not required in OMP).
4. Safety: ask it to run `chmod -R 777 /tmp/nonexistent` → blocked with
   `LifeOS Safety blocked Bash: dangerous-shape …`; a benign `echo` passes.
5. `bun LIFEOS/OMP/manage.ts uninstall` → wiring removed; other `config.yml` keys intact;
   stock OMP restored.
