# Codex Native Port

This document records what changed to make PAI run natively under OpenAI Codex instead of only under Claude Code. It is intentionally broader than a changelog: each item explains the compatibility gap it closed and why the change was required.

Source range reviewed: `2fde1bb..3e3ca19` on branch `pai-codex-flawless-runtime`.

## Goal

PAI's v5.0.0 release was originally shaped around Claude Code's filesystem, settings, hooks, commands, skills, agents, and transcript conventions. Native Codex support required PAI to become a framework-aware runtime:

- Install into `~/.codex` or `CODEX_HOME`, not only `~/.claude`.
- Use `AGENTS.md`, `config.toml`, `hooks.json`, `prompts/`, and Codex-native agent definitions.
- Preserve shared PAI memory and user data in `~/.pai` so Claude, Codex, and future frameworks can share a Life OS state.
- Adapt Claude-shaped hooks and commands into Codex-shaped hook payloads and slash prompts.
- Keep Pulse, skills, tools, MCP profiles, RTK, security, and doctor validation working after the framework move.
- Prove the port with fresh-install, live-doctor, hook-contract, real-session, rollback, and CI validation.

## Commit Timeline

| Commit | Change | Why It Mattered |
|---|---|---|
| `ec38b23` | Added framework-native Codex installer support. | Established the framework abstraction and made Codex a first-class install target instead of a path-renamed Claude install. |
| `8f30531` | Fixed Codex runtime and Pulse release support. | Closed runtime gaps after first install support: Pulse modules, TOML handling, inference, and hook adapter behavior needed Codex-aware execution. |
| `77e15b5` | Included `RTK.md` in Codex config. | Codex needed RTK as a root fallback document so command-reduction doctrine loads with `AGENTS.md`. |
| `d8761e4` | Fixed Codex installer fallback. | Made installer detection and fallback behavior robust when target framework state or CLI availability was incomplete. |
| `5b0a638` | Fixed Codex RTK install generation. | Ensured `RTK.md` is actually installed and reachable in Codex homes, not only referenced. |
| `3391bfa` | Added PAI memory deletion redaction. | Added a framework-neutral memory deletion tool and smoke test so sensitive memory operations remain safe under Codex. |
| `b4b6a02` | Hardened Codex runtime coverage. | Added security/runtime smoke tests for install commands, shell injection resistance, and framework behavior. |
| `0592c8d` | Fixed Codex Pulse runtime parity. | Made Pulse management and voice behavior work outside Claude-specific assumptions. |
| `d197f32` | Documented Windows WSL Interceptor setup. | Captured the Windows validation path and the WSL browser-interceptor constraints needed by Codex users on Windows. |
| `fc42252` | Packaged Codex MCP profiles. | Added portable MCP profile files and launcher support so Codex could start with the same PAI tool profiles as Claude. |
| `e971edb` | Added Codex PAI doctor checks. | Created the live health gate for Codex installs and added fresh-install/hook-trigger proof. |
| `4095eb6` | Fixed Codex fresh-install RTK coverage. | Added real Codex session hook proof and made fresh installs prove `RTK.md` exists. |
| `6150008` | Added Codex startup self-check. | Made sessions surface actionable diagnostics when a runtime is incomplete. |
| `d0d53cc` | Added Codex branch validation runner. | Created a consolidated pre-merge validation command for the Codex port. |
| `315f82c` | Added PAI Codex validation workflow. | Put Codex validation into CI so regressions are caught outside one local machine. |
| `d7496ac` | Improved doctor discoverability. | Made `k doctor` visible in CLI help and docs so runtime repair is obvious to users. |
| `75d6f92` | Made repeat detection advisory for Codex. | Fixed a hook behavior that was correct as a warning but harmful when it stopped the model from continuing. |
| `3f0baf7` | Added hotfix rollback and hook contract proofs. | Proved update rollback and hook block/advisory contracts, reducing risk of broken hotfixes. |
| `1fbcefc` | Added PAI security audit proof. | Added checks for known PAI security-risk documentation and mitigations. |
| `ac0bd3e` | Prevented fresh install smoke from touching user shell profile. | Ensured tests use isolated temp profiles and cannot corrupt a real user's shell config. |
| `793b6cf` | Defaulted Codex PAI sessions to high reasoning. | Made Codex PAI start at the reasoning level expected for Life OS work without manual `/model` selection. |
| `31b28ae` | Used extra high reasoning for Codex plan mode. | Raised plan-mode depth for complex planning while preserving high as the normal default. |
| `3e3ca19` | Added Codex interview onboarding prompt. | Added a generated `prompts/interview.md` bridge that mentions the `Interview` skill. |
| `current` | Fixed Codex interview skill invocation. | Replaced the unsupported `/prompts:interview` onboarding guidance with direct `$Interview` skill invocation. |

## Framework Abstraction

### Added Framework Registry

Files:

- `PAI/PAI-Install/engine/frameworks.ts`
- `PAI/PAI-Install/engine/types.ts`
- `PAI/PAI-Install/engine/detect.ts`
- `PAI/PAI-Install/engine/actions.ts`
- `PAI/TOOLS/pai.ts`

What changed:

- Added `FrameworkId` support for `claude`, `codex`, and `opencode`.
- Added `getFrameworkTarget()` with per-framework install roots, commands, instruction files, settings files, hook support, and skill support.
- Added `normalizeFramework()` so `codex`, `openai`, and `openaicodex` resolve to Codex.
- Added `PAI_FRAMEWORK`, `PAI_FRAMEWORK_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, `CLAUDE_HOME`, and `PAI_DATA_DIR` handling.
- Added framework selection in CLI/web installer flows.
- Added persistent framework state at `~/.pai/framework.json`.

Why necessary:

Claude Code, Codex, and OpenCode do not use the same home directory, instruction filename, config file, command launcher, prompt directory, agent format, or hook config. A path substitution from `~/.claude` to `~/.codex` would have left the install half-native and fragile. The registry gives each framework a canonical install target while keeping the PAI bundle shared.

### Shared Data Directory

Files:

- `PAI/PAI-Install/engine/frameworks.ts`
- `PAI/PAI-Install/engine/actions.ts`
- `PAI/TOOLS/pai.ts`
- `hooks/lib/paths.ts`
- many tools and Pulse modules using `PAI_DATA_DIR`

What changed:

- Introduced `~/.pai` as the shared Life OS data root.
- Linked framework-local `PAI/MEMORY` and `PAI/USER` to shared `~/.pai/MEMORY` and `~/.pai/USER`.
- Made tools and hooks resolve paths through `PAI_DIR`, `PAI_DATA_DIR`, and framework state instead of hardcoded `~/.claude`.

Why necessary:

PAI is a Life OS, not a Claude-only directory. Without shared memory and user state, switching to Codex would fork the user's identity, TELOS, memory, Pulse data, and assistant context. Shared data lets framework runtimes change without changing the user's durable PAI state.

## Installer and Update System

### Codex Install Target

Files:

- `install.sh`
- `install.ps1`
- `update-installed.sh`
- `update-installed.ps1`
- `PAI/PAI-Install/main.ts`
- `PAI/PAI-Install/cli/index.ts`
- `PAI/PAI-Install/web/routes.ts`
- `PAI/PAI-Install/engine/actions.ts`
- `PAI/PAI-Install/engine/config-gen.ts`
- `PAI/PAI-Install/engine/validate.ts`

What changed:

- Added Codex as a selectable install framework.
- Added support for `CODEX_HOME` and default `~/.codex`.
- Added safe backup and reinstall behavior for framework homes.
- Added install preservation for existing Codex config blocks, profiles, providers, and bundled plugins.
- Added PowerShell install/update entrypoints for Windows.
- Added shell aliases/functions for `pai` and `k` that point to the active framework's `PAI/TOOLS/pai.ts`.
- Added test isolation via `PAI_SHELL_PROFILE` and `PAI_POWERSHELL_PROFILE`.

Why necessary:

Codex users need a first-run install that writes Codex-native files without destroying existing Codex configuration. The installer also has to work in temporary fresh-install tests without touching the real shell profile. The Windows scripts were needed because Codex users may install from Windows or WSL paths, and the prior installer was Unix/Claude-biased.

### CLI Install Commands

Files:

- `PAI/PAI-Install/engine/frameworks.ts`
- `PAI/TOOLS/CodexPaiSecuritySmokeTest.ts`

What changed:

- Codex CLI install commands use:
  - `curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh`
  - `bun install -g @openai/codex`
- OpenCode fallback uses `curl -fsSL https://opencode.ai/install | bash` and `bun install -g opencode-ai`.
- Tests assert PAI does not introduce `npm` install commands.

Why necessary:

The project rule is Bun-only. Native Codex support had to install Codex without violating PAI's `bun/bunx always` rule or creating inconsistent package-manager assumptions.

## Codex Configuration

### `config.toml`

Files:

- `PAI/PAI-Install/engine/config-gen.ts`
- `PAI/PAI-Install/engine/actions.ts`
- `PAI/TOOLS/pai.ts`
- `PAI/TOOLS/FrameworkSmokeTest.ts`
- `PAI/TOOLS/InstallerCodexSmokeTest.ts`

What changed:

- Generated a PAI-managed root config block for Codex:
  - `project_doc_fallback_filenames = ["AGENTS.md", "RTK.md", "CLAUDE.md"]`
  - `project_doc_max_bytes = 65536`
- Added merge behavior that preserves existing Codex TOML tables.
- Added managed MCP config support.
- Added default Codex model/reasoning:
  - `model = "gpt-5.5"`
  - `model_reasoning_effort = "high"`
  - `plan_mode_reasoning_effort = "xhigh"`

Why necessary:

Codex reads `config.toml`, not Claude's `settings.json`. PAI needed a managed block that does not overwrite user profiles, providers, or plugins. The fallback docs ensure Codex loads PAI's operational instructions and RTK command-reduction doctrine. Reasoning defaults were added because Life OS, research, and development work require deeper reasoning than Codex's medium default.

### `AGENTS.md`

Files:

- `PAI/PAI-Install/engine/actions.ts`
- `PAI/TOOLS/pai.ts`
- generated framework instruction files

What changed:

- Converts `CLAUDE.md` into Codex-native `AGENTS.md`.
- Rewrites framework references:
  - `CLAUDE.md` to `AGENTS.md`
  - `Claude Code` to `Codex`
  - `~/.claude/PAI` to `$PAI_DIR`
  - `~/.claude` to `$PAI_FRAMEWORK_DIR`

Why necessary:

Codex loads `AGENTS.md` for instructions. Reusing the Claude file verbatim would leave Codex with wrong filenames, wrong paths, and wrong framework terminology.

### `RTK.md`

Files:

- `RTK.md`
- `PAI/PAI-Install/engine/actions.ts`
- `PAI/PAI-Install/engine/config-gen.ts`
- `PAI/TOOLS/CodexFreshInstallSmokeTest.ts`
- `PAI/TOOLS/InstallerCodexSmokeTest.ts`
- `PAI/TOOLS/PaiDoctor.ts`

What changed:

- Added top-level `RTK.md`.
- Installed it into Codex/OpenCode framework homes.
- Added it to Codex project doc fallback configuration.
- Added doctor and fresh-install checks that fail if it is missing.

Why necessary:

RTK carries command-reduction doctrine and context-efficiency instructions. Codex would not load that doctrine unless it was present as a root doc fallback file.

## Codex Hooks

### `hooks.json`

Files:

- `PAI/PAI-Install/engine/config-gen.ts`
- `PAI/PAI-Install/engine/actions.ts`
- `PAI/TOOLS/pai.ts`
- `PAI/TOOLS/InstallerCodexSmokeTest.ts`
- `PAI/TOOLS/CodexFreshInstallSmokeTest.ts`

What changed:

- Generated Codex `hooks.json`.
- Mapped Codex hook events to command hooks through `FrameworkHookAdapter.ts`.
- Added command entries for compatible PAI hooks.
- Added Windows hook commands via `commandWindows`.
- Embedded active `PAI_DIR`, `PAI_DATA_DIR`, `PAI_FRAMEWORK`, `PAI_FRAMEWORK_DIR`, `PAI_SETTINGS_PATH`, and `PAI_CONFIG_DIR` directly in generated hook commands.
- On Windows, invoke quoted Bun paths with PowerShell's `&` call operator instead of relying on a leading quoted string to execute.
- Added startup self-check to the generated hook set.

Why necessary:

Claude's hook settings are not Codex's hook settings. PAI's hook implementation could be reused only if Codex was given a native `hooks.json` that runs adapters as command hooks.

The explicit environment assignments make each hook self-contained. A Codex session launched from a stale terminal, child process, or provider wrapper should still resolve the active PAI subsystem and shared memory data root. The Windows call operator is required because PowerShell treats a leading quoted path as a string expression, not as a command invocation.

### Framework Hook Adapter

Files:

- `hooks/FrameworkHookAdapter.ts`
- `hooks/lib/session.ts`
- `hooks/lib/paths.ts`
- most existing `hooks/*.hook.ts`

What changed:

- Added a command adapter that reads Codex/OpenCode hook JSON from stdin.
- Normalizes event names, tool names, tool inputs, tool results, prompt text, CWD, transcript path, session id, and last assistant message into the Claude-shaped fields PAI hooks already expect.
- Supports shell hooks when Bash exists and no-ops optional shell hooks on Windows if Bash is unavailable.
- Marks subagent sessions via `PAI_IS_SUBAGENT`.
- Provides `PAI_PROJECT_DIR` from normalized CWD.

Why necessary:

PAI had many existing Claude-oriented hooks. Rewriting every hook for Codex would be high risk and duplicated logic. The adapter provides a compatibility membrane: Codex can invoke hooks natively while PAI hooks keep one internal contract.

### Shared Path Refactor

Files:

- `hooks/lib/paths.ts`
- `PAI/TOOLS/lib/paths.ts`
- tools, hooks, and Pulse modules touched across the branch

What changed:

- Added framework-aware path helpers:
  - `getPaiDir()`
  - `getDataDir()`
  - `getFrameworkDir()`
  - `paiPath()`
  - `memoryPath()`
  - `userPath()`
  - `getSettingsPath()`
  - `getHooksDir()`
  - `getSkillsDir()`
- Replaced hardcoded `~/.claude`, `PAI/MEMORY`, and `PAI/USER` assumptions across tools and hooks.

Why necessary:

Native support is impossible if runtime logic keeps reading and writing Claude paths. The path helpers let PAI code resolve active framework files separately from shared user data.

### Hook Behavior Fixes

Files:

- `hooks/RepeatDetection.hook.ts`
- `hooks/StartupSelfCheck.hook.ts`
- `hooks/PromptGuard.hook.ts`
- `hooks/RtkPreToolUse.hook.js`
- `hooks/ToolActivityTracker.hook.ts`
- `hooks/SecurityPipeline.hook.ts`
- `PAI/TOOLS/RepeatDetectionSmokeTest.ts`
- `PAI/TOOLS/StartupSelfCheckSmokeTest.ts`
- `PAI/TOOLS/CodexHookContractSmokeTest.ts`
- `PAI/TOOLS/CodexHookTriggerSmokeTest.ts`
- `PAI/TOOLS/CodexRealSessionHookProof.ts`

What changed:

- Added startup self-check guidance that points users to `k doctor`.
- Made repeat detection advisory in Codex instead of a hard "STOP" instruction.
- Added RTK PreToolUse hook integration.
- Made RTK rewrite acceptance Windows-aware: valid rewrites are still used, but POSIX-escaped rewrites that PowerShell would execute incorrectly are rejected and logged.
- Added hook trigger and contract smoke tests.
- Added a real Codex exec session proof that verifies hook log deltas from actual Codex hook invocation.

Why necessary:

Codex hook messages are injected into the model differently from Claude. A warning that reads like an instruction to stop can prevent the model from doing the user's newest request. Startup self-checks and real hook proof provide direct confidence that hooks are not merely installed but actually executed by Codex.

## Commands and Slash Prompts

Files:

- `commands/context-search.md`
- `commands/cs.md`
- `commands/pu.md`
- `commands/interview.md`
- `PAI/PAI-Install/engine/actions.ts`
- `PAI/TOOLS/pai.ts`
- `PAI/PAI-Install/engine/validate.ts`
- `PAI/TOOLS/PaiDoctor.ts`

What changed:

- Added `syncCodexPrompts()` to generate Codex `prompts/*.md` from shared PAI `commands/*.md`.
- Added `codexPromptContent()` to convert Claude-style skill redirects into Codex prompt syntax:
  - `Skill("ContextSearch", "$ARGUMENTS")` becomes `$ContextSearch $ARGUMENTS`
  - `Skill("Interview", "$ARGUMENTS")` becomes `$Interview $ARGUMENTS`
- Added `commands/interview.md` command source and validation for Codex's generated `prompts/interview.md` compatibility bridge.

Why necessary:

The Codex manual documents custom prompts, but the installed Codex 0.142.0 TUI used for this port did not expose `/prompts:<name>` in the slash command surface. PAI therefore treats direct skill mention syntax as the stable onboarding contract: type `$Interview` in a normal Codex prompt. The generated `prompts/interview.md` remains as a compatibility bridge for runtimes that do load custom prompts.

## Agents and Skills

Files:

- `agents/*.md`
- `PAI/PAI-Install/engine/actions.ts`
- `PAI/TOOLS/pai.ts`
- `skills/**/SKILL.md`
- `PAI/TOOLS/SkillDescriptionSmokeTest.ts`
- `PAI/TOOLS/CompactSkillDescriptions.ts`

What changed:

- Added Codex agent generation from shared agent markdown.
- Rewrites `CLAUDE.md`, `Claude Code`, and `~/.claude` references for Codex.
- Installs/generated Codex-native agent definitions under `agents/`.
- Keeps PAI skills in the active Codex home skill tree to avoid duplicate `$` skill selector entries.
- Compact skill descriptions were added to keep Codex skill context manageable.

Why necessary:

Codex and Claude do not share agent/skill discovery mechanics. Native Codex support needed the same PAI specialist surface without manually maintaining a separate Codex-only copy of every agent and skill.

## MCP Profiles

Files:

- `MCPs/Apify-MCP.json`
- `MCPs/Brightdata-MCP.json`
- `MCPs/ClickUp-MCP.json`
- `MCPs/dev-work.mcp.json`
- `MCPs/full.mcp.json`
- `MCPs/minimal.mcp.json`
- `MCPs/none.mcp.json`
- `MCPs/research.mcp.json`
- `MCPs/security.mcp.json`
- `PAI/TOOLS/pai.ts`
- `PAI/TOOLS/PaiDoctor.ts`

What changed:

- Packaged Codex-compatible MCP profile JSON files.
- Added MCP shorthand/profile support in the `pai` launcher.
- Added doctor checks for MCP profile presence.
- Kept optional API-token reminders as warnings rather than critical failures.

Why necessary:

MCP availability is part of PAI's day-to-day research and development surface. Codex needed packaged profiles so users can launch predictable MCP sets without editing config manually. Optional token warnings avoid blocking users who intentionally do not use a provider.

## Launcher and Runtime CLI

Files:

- `PAI/TOOLS/pai.ts`
- shell aliases/functions written by installer
- `PAI/TOOLS/FrameworkSmokeTest.ts`
- `PAI/TOOLS/FrameworkCommandResolutionSmokeTest.ts`
- `PAI/TOOLS/FrameworkLaunchCwdSmokeTest.ts`

What changed:

- Made `pai`/`k` launch the active framework.
- Added `pai framework switch <framework>`.
- Added active framework state loading from `~/.pai/framework.json`.
- Added framework-specific command resolution and Windows `.cmd`/`.bat` handling.
- Added launch CWD preservation checks.
- Added `doctor` as a first-class CLI command and help entry.
- Added MCP profile flags and framework-aware command construction.

Why necessary:

The user should run `k` and get the active PAI runtime, regardless of whether the framework is Claude or Codex. Windows command resolution was needed because `codex.cmd`/batch launch behavior differs from POSIX command spawning.

## Algorithm Native Execution

Files:

- `PAI/TOOLS/algorithm.ts`
- `PAI/TOOLS/lib/framework-agent.ts`
- `PAI/TOOLS/CodexNativeRuntimeSmokeTest.ts`
- `PAI/TOOLS/CodexBranchValidation.ts`

What changed:

- Added a shared framework-agent launcher for edit-capable autonomous work.
- Algorithm loop mode now launches the active framework instead of direct `claude -p`.
- Parallel worker agents now use the same launcher with workspace-write access.
- Sequential iterations removed the old `--bare` path and no longer hardcode Claude.
- Interactive and ideate modes now launch the active framework with the ISA prompt.
- Branch validation now scans for direct Claude subprocess regressions in Algorithm.

Why necessary:

The Algorithm is one of PAI's core products. A Codex install cannot be considered native if autonomous iteration, parallel workers, or interactive ISA sessions still shell out to Claude. The shared launcher keeps Claude compatibility while making Codex execute Algorithm work through `codex exec` with the right project directory and workspace-write permissions.

## Pulse Runtime Parity

Files:

- `PAI/TOOLS/Inference.ts`
- `PAI/TOOLS/lib/framework-agent.ts`
- `PAI/TOOLS/CodexNativeRuntimeSmokeTest.ts`
- `PAI/PULSE/manage.sh`
- `PAI/PULSE/manage.ps1`
- `PAI/PULSE/pulse.ts`
- `PAI/PULSE/pulse-unified.ts`
- `PAI/PULSE/setup.ts`
- `PAI/PULSE/lib.ts`
- `PAI/PULSE/toml.ts`
- `PAI/PULSE/package.json`
- `PAI/PULSE/bun.lock`
- `PAI/PULSE/Assistant/module.ts`
- `PAI/PULSE/Assistant/checks/*.ts`
- `PAI/PULSE/VoiceServer/voice.ts`
- `PAI/PULSE/Observability/**`
- `PAI/PULSE/modules/**`
- `PAI/PULSE/checks/**`

What changed:

- Added Pulse package metadata and lockfile for repeatable Bun installs.
- Added PowerShell manager for Windows.
- Updated Unix manager behavior.
- Added TOML parser utility for Pulse config.
- Added Pulse Assistant module and checks.
- Replaced Claude-specific paths in Pulse modules with framework/shared-data paths.
- Replaced Pulse cron AI job execution with `spawnAI`, backed by active framework inference.
- Kept `spawnClaude` and `type = "claude"` as compatibility aliases for older configs.
- Changed shipped Pulse config and setup templates to teach `type = "ai"`.
- Replaced GitHub worker direct Claude spawning with the shared framework-agent launcher.
- Replaced Telegram and iMessage Claude Agent SDK sessions with active-framework `Inference.ts` calls.
- Removed the Pulse `@anthropic-ai/claude-agent-sdk` dependency.
- Made Pulse performance cost aggregation discover provider-native transcript roots and parse Codex `token_count` events as subscription token usage instead of defaulting unknown models to Claude/Sonnet pricing.
- Made `k prompt` feed one-shot Codex prompts through `codex exec` stdin.
- Hid Windows child windows for framework AI launchers (`Inference.ts`, Algorithm workers, `k prompt`, and `k` framework launches) so Codex parity checks and runtime paths do not flash `.cmd`/PowerShell windows.
- Updated observability onboarding and static export to show `~/.pai/USER/...`.
- Pinned Pulse Observability's Next tracing root and build id for deterministic static exports.
- Kept `/interview` as the Claude onboarding command and added a Codex `prompts/interview.md` compatibility bridge for runtimes that expose custom prompts.
- Adjusted voice, Telegram, iMessage, syslog, user-index, wiki, and scheduled checks for path/runtime parity.

Why necessary:

Pulse is the Life Dashboard. If Codex PAI launches but Pulse still reads Claude paths, shows Claude onboarding, or sends scheduled AI work through Claude-only subprocesses, the system is not native. Pulse had to read shared PAI data, run chat and cron AI through the active framework, and keep its static dashboard export reproducible from Codex installs.

## Security and Memory Safety

Files:

- `PAI/TOOLS/MemoryDelete.ts`
- `PAI/TOOLS/MemoryDeleteSmokeTest.ts`
- `PAI/TOOLS/CodexPaiSecuritySmokeTest.ts`
- `PAI/TOOLS/PaiSecurityAuditSmokeTest.ts`
- `hooks/SecurityPipeline.hook.ts`
- `hooks/security/inspectors/PatternInspector.ts`
- `hooks/security/inspectors/RulesInspector.ts`
- `hooks/security/logger.ts`
- `PAI/USER/SECURITY/PATTERNS.yaml`

What changed:

- Added memory deletion with redaction and smoke coverage.
- Added install-command security smoke checks.
- Added shell-injection resistance checks for system detection.
- Added Codex hook contract tests proving pipe-to-shell commands hard-block.
- Added security-audit proof that documented browser/session/interceptor risks are present.
- Updated pattern inspection for framework-normalized hook payloads.

Why necessary:

Codex native support increases the number of launch paths, hooks, and config surfaces. The port had to avoid command injection, accidental memory exposure, unsafe installer behavior, and silent security regressions.

## Doctor, Smoke Tests, and CI

Files:

- `PAI/TOOLS/PaiDoctor.ts`
- `PAI/TOOLS/CodexFreshInstallSmokeTest.ts`
- `PAI/TOOLS/InstallerCodexSmokeTest.ts`
- `PAI/TOOLS/CodexHookTriggerSmokeTest.ts`
- `PAI/TOOLS/CodexHookContractSmokeTest.ts`
- `PAI/TOOLS/CodexRealSessionHookProof.ts`
- `PAI/TOOLS/HookSharedPathSmokeTest.ts`
- `PAI/TOOLS/HotfixUpdateRollbackSmokeTest.ts`
- `PAI/TOOLS/StartupSelfCheckSmokeTest.ts`
- `PAI/TOOLS/RepeatDetectionSmokeTest.ts`
- `PAI/TOOLS/PaiSecurityAuditSmokeTest.ts`
- `PAI/TOOLS/CodexNativeRuntimeSmokeTest.ts`
- `PAI/TOOLS/CodexBranchValidation.ts`
- `.github/workflows/pai-codex-validation.yml`

What changed:

- Added `k doctor` for live Codex runtime health.
- Doctor checks active framework, Codex root, `AGENTS.md`, `RTK.md`, config, hook command environment, Windows hook invocation shape, the installed `Interview` skill, MCP profiles, shared data, Pulse health, hook smoke tests, real session hook proof, hotfix rollback, and fresh install.
- Fresh install smoke uses isolated `HOME`, `CODEX_HOME`, `PAI_DATA_DIR`, `PAI_CONFIG_DIR`, and shell profile paths.
- Installer smoke verifies config preservation, hooks, agents, prompts, Pulse modules, backup creation, and Windows manager installation.
- Branch validation runs build, JSON parsing, security, hooks, Codex-targeted framework parity, fresh install, installer smoke, hotfix dry-run, stale URL scan, and doctor docs discovery.
- Native runtime smoke verifies Algorithm, Pulse cron AI, Pulse worker AI, chat routing, and Pulse static export do not regress to Claude-only paths.
- GitHub Actions workflow runs Codex validation in CI.

Why necessary:

The strongest proof of native support is not "files exist"; it is a fresh install plus live doctor plus actual Codex hook invocation. These tests turn the port from a best-effort migration into a repeatable contract.

## Hotfix and Rollback Support

Files:

- `hotfix-manifest.json`
- `update-installed.sh`
- `update-installed.ps1`
- `PAI/TOOLS/HotfixUpdateRollbackSmokeTest.ts`
- `PAI/TOOLS/CodexBranchValidation.ts`

What changed:

- Added hotfix manifest entries for Codex-relevant hooks, docs, config, MCPs, and tools.
- Added update scripts for installed copies.
- Added rollback smoke proof that verifies hotfix rollback restores files.

Why necessary:

Once PAI is installed into a user's Codex home, fixes need to land without requiring a destructive reinstall. Rollback proof matters because hook/config hotfixes can break session startup if applied incorrectly.

## Windows and WSL Work

Files:

- `install.ps1`
- `update-installed.ps1`
- `PAI/PULSE/manage.ps1`
- `PAI/TOOLS/pai.ts`
- `PAI/PAI-Install/engine/actions.ts`
- `PAI/PAI-Install/engine/config-gen.ts`
- `skills/Interceptor/Workflows/SetupWindowsWSL.md`
- `PAI/PAI-Install/README.md`

What changed:

- Added PowerShell install/update/Pulse management scripts.
- Added Windows hook command generation with `commandWindows`.
- Added Windows command resolution for `.cmd`, `.bat`, and `.exe`.
- Documented Windows WSL Interceptor setup.
- Added junction-aware symlink behavior.

Why necessary:

Codex users are likely to run on Windows, WSL, or mixed environments. Native support needed explicit command, path, and browser-interceptor guidance instead of assuming macOS/Linux Claude Code behavior.

## OpenCode Side Effects

Files:

- `plugins/pai-opencode.ts`
- `PAI/PAI-Install/engine/frameworks.ts`
- `PAI/PAI-Install/engine/actions.ts`
- `PAI/PAI-Install/engine/config-gen.ts`
- `PAI/TOOLS/pai.ts`

What changed:

- Added OpenCode as another framework target while building the framework abstraction.
- Added OpenCode agent/command generation and plugin support.

Why necessary:

The clean abstraction for Codex also made OpenCode possible. Keeping Codex changes framework-generic where reasonable prevents another hardcoded one-framework architecture.

## Documentation Updates

Files:

- `README.md`
- `Releases/v5.0.0/README.md`
- `Releases/v5.0.0/.claude/README.md`
- `PAI/PAI-Install/README.md`
- `PAI/DOCUMENTATION/**/*.md`
- `skills/**/SKILL.md`
- `agents/*.md`
- `PAI/USER/**/README.md`

What changed:

- Updated install docs for Codex/OpenCode framework selection.
- Added doctor discoverability.
- Updated architecture, tools, hooks, memory, skills, agents, security, and Pulse docs to avoid Claude-only assumptions.
- Updated skill and agent docs to use framework-neutral language where possible.
- Added Windows WSL Interceptor documentation.

Why necessary:

Runtime support is incomplete if docs still tell users to edit `~/.claude` or run Claude-only commands. The docs had to become framework-aware so users and future agents do not regress the port.

## Onboarding and Interview

Files:

- `commands/interview.md`
- `PAI/PULSE/Observability/src/components/EmptyStateGuide.tsx`
- `PAI/PULSE/Observability/src/components/TemplateOnboarding.tsx`
- `PAI/PULSE/Observability/out/**`
- `PAI/PAI-Install/engine/validate.ts`
- `PAI/TOOLS/CodexFreshInstallSmokeTest.ts`
- `PAI/TOOLS/InstallerCodexSmokeTest.ts`
- `PAI/TOOLS/PaiDoctor.ts`

What changed:

- Added `commands/interview.md` command source.
- Codex prompt generation now produces `prompts/interview.md` with `$Interview $ARGUMENTS`.
- Doctor verifies the installed `Interview` skill; fresh install smoke and installer smoke verify the prompt bridge stays Codex-shaped.
- Pulse onboarding now points to `~/.pai/USER/...` instead of `~/.claude/PAI/USER/...`.

Why necessary:

Pulse advertised `/interview`, then briefly advertised `/prompts:interview`; both were wrong for the installed Codex 0.142.0 TUI. The fix makes Pulse's onboarding instruction executable in Codex by using direct `$Interview` skill mention syntax.

## Reasoning Defaults

Files:

- `PAI/TOOLS/pai.ts`
- `PAI/TOOLS/FrameworkSmokeTest.ts`

What changed:

- Added Codex config defaults:
  - model: `gpt-5.5`
  - default reasoning: `high`
  - plan mode reasoning: `xhigh`

Why necessary:

PAI's expected use cases include Life OS operation, research, codebase work, architecture, and memory-sensitive planning. Codex's medium default was too shallow for that baseline. The plan-mode setting was raised separately because planning is where deeper reasoning is most valuable.

## What "Native" Means Here

The Codex port is native in the following concrete sense:

- Codex launches from the active PAI `k`/`pai` command.
- Codex owns its framework home at `~/.codex` or `CODEX_HOME`.
- Codex reads `AGENTS.md`, `RTK.md`, and `config.toml`.
- Codex runs `hooks.json` command hooks.
- PAI hooks receive normalized Codex hook payloads through `FrameworkHookAdapter.ts`.
- PAI commands become Codex `prompts/*.md` compatibility bridges where supported.
- PAI agents become Codex-native agent definitions.
- PAI skills are linked into Codex's skill discovery path.
- PAI memory and user data live in shared `~/.pai`, not in a Claude-only tree.
- Pulse reads shared PAI data and serves Codex-correct onboarding.
- MCP profiles are packaged and selectable from the PAI launcher.
- Doctor and branch validation prove fresh install, runtime, Pulse, hooks, security, and onboarding.

## Known Boundaries

- The source release directory is still named `.claude` for v5.0.0 packaging history. Framework-native install logic adapts that shared source into Codex homes.
- Some command definitions intentionally remain shared Claude-style markdown source. Codex receives generated `prompts/*.md` output with Codex-native syntax.
- Optional external integrations remain warnings, not failures, when API tokens are absent.
- Pulse static export was patched to remove stale Claude user paths because the source was already corrected but the checked-in `out/` bundle was stale.

## Verification Commands

These are the proof commands used during the port:

```bash
bun PAI/TOOLS/CodexFreshInstallSmokeTest.ts
bun PAI/TOOLS/InstallerCodexSmokeTest.ts
bun PAI/TOOLS/FrameworkSmokeTest.ts --framework codex
bun PAI/TOOLS/PaiSecurityAuditSmokeTest.ts
bun PAI/TOOLS/CodexBranchValidation.ts
bun ~/.codex/PAI/TOOLS/pai.ts doctor
```

Current local Windows safe validation state:

- Windows `CodexBranchValidation.ts`: 16 safe-mode checks passed, including Codex-targeted framework parity.
- Deep mode keeps child/session/install probes opt-in for runs that intentionally exercise real provider sessions.
- `FrameworkSmokeTest.ts --framework codex`: isolated and shared-sequence switching passed for Codex with shared `PAI_DATA_DIR`; the shared sequence seeds memory/user marker files and verifies Codex sees the same contents through its own `PAI/MEMORY` and `PAI/USER` paths.
- `PaiSecurityAuditSmokeTest.ts`: hotfix manifest avoids protected state/config, all manifest sources exist, and managed TypeScript imports are covered.
- `PaiDoctorSmokeTest.ts`: doctor source guards passed for provider-native checks, AV-safe defaults, and opt-in deep probes.
- `PerformanceCostAggregatorSmokeTest.ts`: synthetic Claude and Codex transcript aggregation passed; Codex rows preserve token totals, cached-token counts, framework metadata, and zero API dollar cost under subscription billing.
- Pulse `/health`: HTTP 200.
- Served Pulse assistant page: shows `$Interview` and `~/.pai/USER/DA/`.

## Cross-Platform Parity Proof

The `PAI Codex Validation` workflow runs `CodexBranchValidation.ts` on `ubuntu-latest`, `macos-latest`, and `windows-latest`. Historical run `27998703578` passed all three jobs on commit `e1eea9572a731744911252f02f37a88955de9c7f`; refresh the workflow after hook-command or validation-entrypoint changes before treating cross-platform proof as current.
