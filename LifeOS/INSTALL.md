# Install LifeOS

**The primary way to install LifeOS is to give this document to your AI and say "install this."**

LifeOS is AI-native, so the install is too. You hand this file (or its link) to whatever AI assistant you already use, and it does the whole install for you — on your OS, on your harness, with your permission at every step. You can also read it yourself and follow along; it's the same document either way.

---

## For the human

Give this checked-out file to an AI assistant with filesystem and command access:

> **Read `LifeOS/INSTALL.md` from this checkout and install this LifeOS/UAI runtime for me.**

There is no hosted UAI one-line installer. The upstream `ourlifeos.ai` script and
the retired `Releases/v5.0.0` bundle do not deploy this repository's current
runtime or OMP integration. Clone the current repository and use the Bun tools
below on macOS, Linux, or native Windows.

---

## For the AI assistant — read this fully before you touch anything

You are installing LifeOS for your human. The install is **additive**: you touch only LifeOS's own files until they explicitly say yes to an integration step. Work through the phases in order. Before any change that modifies their machine, show exactly what will change and wait for a yes.

### 0. Capability gate — stop here if you fail it

You need to be able to (1) read and write files on this machine, and (2) run shell commands. If you cannot do both — for example you're a chat-only assistant with no filesystem or command execution — **stop now** and tell your human:

> "I can't install LifeOS from here — I don't have file and command access on your machine. Run this from a coding harness like Claude Code, Cursor, Cline, Codex, or Gemini CLI, or use the terminal shortcut on the install page."

Do not begin a partial install you can't finish.

### 1. Prerequisites

- **bun** runs the install tools (they're TypeScript). Check `bun --version`. If it's missing, install it and re-check:
  - macOS / Linux: `curl -fsSL https://bun.sh/install | bash`
  - Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`
- **git** and a network connection, to fetch the release. (Or use a local release directory if your human already has one.)

### 2. Get the current checkout and detect the environment

Clone the current UAI repository (or use the local checkout your human supplied).
From its `LifeOS/` directory, run:

```
bun Tools/DetectEnv.ts
```

Read its output. It reports the OS (macOS / Linux / Windows), the detected harness (Claude Code / OMP / Codex / OpenCode / Hermes / Cursor / OpenClaw, or unknown), the config root, and whether LifeOS is already present. Unsupported adapters remain adapter-dependent. **Every path below comes from this — don't assume `~/.claude` or any single harness.**

### 3. Scan for conflicts (read-only)

```
bun Tools/ScanConflicts.ts
```

Surfaces anything already sitting in the target directories. Show your human. Nothing has changed yet.

### 4. Deploy the skill, runtime, settings, and USER scaffold

Use the config root reported by `DetectEnv`; never infer one from the current
shell. Preview first, then rerun with `--apply` after permission:

```
bun Tools/DeployCore.ts --skill-root . --config-root <configRoot>
bun Tools/DeployCore.ts --skill-root . --config-root <configRoot> --apply
bun Tools/InstallSettings.ts --skill-root . --config-root <configRoot>
bun Tools/InstallSettings.ts --skill-root . --config-root <configRoot> --apply
bun Tools/ScaffoldUser.ts --skill-root . --config-root <configRoot> --config-dir <dataRoot>
bun Tools/ScaffoldUser.ts --skill-root . --config-root <configRoot> --config-dir <dataRoot> --apply
bun Tools/LinkUser.ts --config-root <configRoot> --config-dir <dataRoot>
bun Tools/LinkUser.ts --config-root <configRoot> --config-dir <dataRoot> --apply
```

PowerShell uses the same preview/apply sequence; quote concrete paths rather
than angle-bracket placeholders:

```powershell
$configRoot = Join-Path $env:USERPROFILE ".claude"
$dataRoot = Join-Path $env:USERPROFILE ".pai"
bun .\Tools\ScaffoldUser.ts --skill-root . --config-root $configRoot --config-dir $dataRoot
bun .\Tools\ScaffoldUser.ts --skill-root . --config-root $configRoot --config-dir $dataRoot --apply
bun .\Tools\LinkUser.ts --config-root $configRoot --config-dir $dataRoot
bun .\Tools\LinkUser.ts --config-root $configRoot --config-dir $dataRoot --apply
```

`<dataRoot>` defaults to `~/.pai`; `UAI_DATA_DIR` and `PAI_DATA_DIR` are
compatible overrides. Existing files are preserved. Invalid JSON or an
incomplete payload blocks before mutation.

### 6. Wire the integration — HARNESS-SPECIFIC, WITH PERMISSION

This is the one place harnesses genuinely differ. Show the exact change and get a yes.

- **Claude Code** — preview `bun Tools/InstallHooks.ts --skill-root . --config-root <configRoot>`, then rerun with `--apply` only after approval. It stages and verifies the approved hook tree before atomically merging `settings.json`. Run `bun Tools/ActivateImports.ts` only after its own preview and approval.

- **OMP** — first complete the full hook deployment above, because the OMP
  adapter executes the canonical shared hooks and classifier. Then run:
  `bun <configRoot>/LIFEOS/OMP/manage.ts install` and
  `bun <configRoot>/LIFEOS/OMP/manage.ts status`. Installation fails before
  profile mutation when any dependency is absent. `wired`/`loadable` are not
  certification; the repository fixture gate remains C0.

- **Other harnesses without a certified adapter** — install only the compatible
  context/tool surfaces the harness can actually load. Do not write Claude hook
  configuration into another harness and do not claim always-on parity from
  file presence. Report unsupported capabilities explicitly.

### 7. Wire the launch command — HOW LifeOS actually turns on (WITH PERMISSION)

This is the step that makes LifeOS *load*. The constitutional layer — the response format, verification doctrine, security protocol, the whole operating contract — lives in `install/LIFEOS/LIFEOS_SYSTEM_PROMPT.md` and is **NOT** loaded by a plain `claude` session. It loads only when the harness is launched with that file appended to its system prompt. So installed LifeOS needs its own launch command; running vanilla `claude` gives you CLAUDE.md but **not** the constitution.

The payload ships the launcher — `install/LIFEOS/TOOLS/lifeos.ts` — which spawns Claude with `--append-system-prompt-file <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md` (plus the banner and MCP-profile handling). Wire a `lifeos` command that calls it into your human's shell. **Show the exact line, back up the rc file first, wait for a yes.** Use the real `<configRoot>` from `DetectEnv` (e.g. `~/.claude`) — never hardcode a home path.

- **Claude Code (zsh / bash)** — append to `~/.zshrc` (or `~/.bashrc`):
  ```
  alias lifeos='bun <configRoot>/LIFEOS/TOOLS/lifeos.ts -s <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md'
  ```
  fish: `alias lifeos "bun <configRoot>/LIFEOS/TOOLS/lifeos.ts -s <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md"; funcsave lifeos`. After this, **`lifeos` launches Claude WITH the constitution**; plain `claude` stays vanilla (which is fine — the user opts in by launching `lifeos`).

- **Any other harness** — use that harness's own system-prompt flag against the same file. e.g. pi: `pi --append-system-prompt <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md`. If a harness has no system-prompt flag, load `LIFEOS_SYSTEM_PROMPT.md` through its context file (AGENTS.md / rules) as the closest equivalent, and tell your human plainly that the constitution is loading as context, not as a true system-prompt layer.

If your human declines the shell edit, give them the one-line launch command to run by hand so the constitution still loads:
```
bun <configRoot>/LIFEOS/TOOLS/lifeos.ts -s <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md
```

### 8. Choose the components — install all, or pick a subset (WITH PERMISSION)

LifeOS installs in **two layers**, and you present them that way.

**Core** (steps 4–7, always together) IS LifeOS: the skill + the full **skill library** + the LIFEOS runtime (Algorithm, docs, tools, statusline binary, version) + the USER tree + the system prompt and its `lifeos` launch command. One consent installs all of Core; declining means not installing LifeOS.

**Enhancements** are **à la carte** — offer them and let your human pick some, all, or none. Each is independently installed, idempotent, and reversible:

| Component | What it adds | Default |
|---|---|---|
| **hooks** | skill routing, the memory loop, voice, per-turn context injection — most behavior needs these (this is step 6) | **recommended** |
| **statusline** | the LifeOS status line in your prompt — set `preferences.temperatureUnit` in `settings.json` to match your human's locale (payload default is `celsius`; suggest `fahrenheit` for US locales/timezones) | optional |
| **tooltips** | custom Claude Code spinner tips | optional |
| **spinner verbs** | custom spinner verbs | optional |
| **agents** | the named agent library | optional |
| **Pulse** | the Life Dashboard — menu-bar app + `launchd` service on `:31337` | optional |
| **worksweep / derivedsync** | background `launchd` jobs (work capture, derived-file sync) | optional |

The `launchd` components (Pulse, worksweep, derivedsync) are macOS-only — skip them cleanly on Linux/Windows. Show your human this menu, take their picks, and deploy only those. The **Setup** workflow (step 9) drives the actual deployment of the chosen set and verifies each with real evidence (e.g. Pulse → `curl :31337/healthz` = 200). Everything ships in the payload; nothing activates without its matching yes.

### 8.5 Capability check — probe what doctrine assumes (Doctor)

LifeOS doctrine leans on a few **external tools** the core install does not ship: a cross-vendor audit CLI (`codex`), a real browser for web verification (Interceptor), Cloudflare/wrangler for scheduled cloud flows, ElevenLabs for voice. Nothing above installed them, and the features that depend on them must degrade *loudly*, not silently. After Core lands, run the doctor:

```
bun <configRoot>/LIFEOS/TOOLS/Doctor.ts
```

It prints one line per capability — live ✅, broken ❌ (each with its own copy-paste fix command), or off ⏸ — and writes an advisory manifest the runtime uses to flag degraded output. Then ask your human, per broken capability: **set it up now, later, or never?**

- **Now** → run the fix command shown, re-run Doctor. With their permission, add `--network` to verify auth end-to-end — network probes only ever touch capabilities they have already configured.
- **Later** → leave it. The runtime will surface it the moment a degraded capability is actually invoked, fix command included.
- **Never** → `bun <configRoot>/LIFEOS/TOOLS/Doctor.ts decline <name>`. Declined is a clean, permanent, silent OFF — no warnings, no red marks, no nagging, ever. Declining is a legitimate way to run LifeOS, not a defect.

Deeper walkthroughs per tool (what it's for, install, auth, verify it's live): `GETTING-STARTED.md`, shipped next to this file. Your human can re-run the doctor any time something feels off: `lifeos doctor` territory — it's the same command.

### 9. Run Setup, then Interview

Run the **Setup** workflow (`Workflows/Setup.md`) to finish integration and verify with real evidence, then the **Interview** workflow (`Workflows/Interview.md`): name the assistant, capture identity and TELOS (current state → ideal state), pull in any sources your human offers, and seed Pulse. By the end, the config tree is populated and Pulse shows real data.

---

## What you get on each setup (be honest about this)

| Harness / OS | Skill + USER data + Pulse | Always-on behavior (response format, memory loop, context injection) |
|---|---|---|
| **Claude Code — macOS / Linux** | ✅ additive install | Hook behavior depends on successful bounded load probes and the selected profile |
| **Claude Code — Windows** | ✅ additive install (copy fallback where links need privilege) | Hook behavior depends on successful bounded load probes and the selected profile |
| **OMP** | ✅ additive wiring | Isolated gates prove wired/loadable behavior; live C3 is unavailable |
| **Cursor / Cline / Codex / Gemini / other** | Adapter-dependent | Compatible context can be additive; always-on controls are unsupported unless executable evidence says otherwise |
| **Chat-only assistants (no files / no commands)** | ❌ | Unsupported — installation stops at the capability gate |

Doctrine features may also depend on external tools from step 8.5. Missing
tools are reported as degraded or unsupported; file presence is never treated
as behavioral certification.

## Rules you must follow

- **Additive, never clobbering.** Only add what's missing; never overwrite or delete a populated dir or a file you didn't create.
- **Permission before every mutation.** Show the exact change; back up `settings.json` before editing it; wait for a yes.
- **Never write a harness's config that it won't read.** Honest degrade beats an inert install.
- **The launch command loads the constitution — don't skip it.** A plain `claude` session gets CLAUDE.md but not `LIFEOS_SYSTEM_PROMPT.md`. The `lifeos` command (step 7), or the harness's system-prompt flag, is what turns the operating contract on. Wire it, or the install is missing its whole constitutional layer.
- **Refuse to run inside the LifeOS source repo** (detected via source-repo markers). Never mutate a maintainer's live system.
