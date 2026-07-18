# Install LifeOS

**UAI installs LifeOS from this repository's current `LifeOS/` checkout.**

This guide is AI-native: hand the local file to a coding assistant that can read files and run commands. It performs the install for the detected OS and harness, showing every mutation before it applies it.

---

## For you (the human) — 30 seconds

Clone the current UAI checkout:

```bash
git clone https://github.com/jSydorowicz21/Universal-AI-Infrustructure.git
cd Universal-AI-Infrustructure
```

Then tell your coding assistant:

> **Read `LifeOS/INSTALL.md` fully and install LifeOS from this checkout.**

Prefer a terminal? From the repository root, use the matching local bootstrap:

**macOS / Linux**

```bash
LIFEOS_SRC="$PWD" bash LifeOS/install/install.sh
```

**Windows PowerShell**

```powershell
$env:LIFEOS_SRC = (Get-Location).Path
powershell -ExecutionPolicy Bypass -File .\LifeOS\install\install.ps1
```

Do not substitute the retired `Releases/v5.0.0` bundle or an upstream web installer; neither contains this fork's current OMP integration and review fixes.

Everything below is written for the AI doing the install.

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
- **git** and a network connection are needed only when the UAI checkout has not already been cloned.

### 2. Use the current checkout and detect the environment

Stay in the UAI checkout that contains this file. Use its `LifeOS/` directory as the skill root; do not fetch a different release or upstream installer. From `LifeOS/`, run:

```
bun Tools/DetectEnv.ts
```

Read its output. It reports the OS (macOS / Linux / Windows), the harness (Claude Code / OMP / Cursor / Cline / Codex / Gemini / other), the config root, and whether LifeOS is already present. **Every path below comes from this — don't assume `~/.claude` or any single harness.**

### 3. Scan for conflicts (read-only)

```
bun Tools/ScanConflicts.ts
```

Surfaces anything already sitting in the target directories. Show your human. Nothing has changed yet.

### 4. Drop the skill and runtime (additive)

```
bun Tools/DeployCore.ts
```

Copies the LifeOS skill and runtime into the harness's config tree. Existing files are never overwritten — only missing ones are added.

### 5. Scaffold the personal (USER) tree

```
bun Tools/ScaffoldUser.ts
bun Tools/LinkUser.ts
```

Creates the personal config tree from templates and links it in. This is empty structure — no personal content yet. That comes in the interview.

### 6. Wire the integration — HARNESS-SPECIFIC, WITH PERMISSION

This is the one place harnesses genuinely differ. Show the exact change and get a yes.

- **Claude Code** — run `bun Tools/InstallHooks.ts` (merges the hook set into `settings.json`, backing it up first) and `bun Tools/ActivateImports.ts` (turns on the identity context imports). This lights up the LifeOS response format, memory loop, and per-turn context injection.

- **OMP (Oh My Pi)** — after `DeployCore.ts` installs the runtime, run:
  ```
  bun <configRoot>/LIFEOS/OMP/manage.ts install
  ```
  This validates the deployed hook/tool prerequisites, merges all five LifeOS extensions into OMP's `config.yml`, links the adapted constitution as `APPEND_SYSTEM.md`, and keeps inference model-agnostic by default. Run `bun <configRoot>/LIFEOS/OMP/manage.ts status` afterward. Do not write Claude Code hook settings into OMP.

- **Cursor / Cline / Codex / Gemini / other** — if the harness has no native LifeOS adapter:
  1. Write an `AGENTS.md` or the harness's own context file (for example `.cursor/rules`) that points it at the LifeOS tree.
  2. State plainly that context and workflows are available but always-on hooks are not yet wired for that harness.
  3. Do not write Claude hook files or a Claude `settings.json` hooks block into a harness that will ignore them.

### 7. Activate the constitution — HARNESS-SPECIFIC, WITH PERMISSION

The constitutional layer lives in `<configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md`; copying the runtime alone does not load it.

- **Claude Code** — the payload ships `<configRoot>/LIFEOS/TOOLS/lifeos.ts`, which launches Claude with `--append-system-prompt-file`. Wire a `lifeos` shell command only after showing and approving the exact rc-file change:
  ```
  alias lifeos='bun <configRoot>/LIFEOS/TOOLS/lifeos.ts -s <configRoot>/LIFEOS/LIFEOS_SYSTEM_PROMPT.md'
  ```
  If the shell edit is declined, give the same `bun .../lifeos.ts -s .../LIFEOS_SYSTEM_PROMPT.md` command to run manually.

- **OMP** — `manage.ts install` already links the adapted constitution and extensions. Restart OMP, then confirm `manage.ts status` reports the constitution and every extension wired. No Claude launcher or subscription is required.

- **Other harnesses** — use the harness's native system-prompt mechanism when available. Otherwise load `LIFEOS_SYSTEM_PROMPT.md` through its context file and disclose that it is context rather than a true system-prompt layer.

### 8. Choose the components — install all, or pick a subset (WITH PERMISSION)

LifeOS installs in **two layers**, and you present them that way.

**Core** (steps 4–7, always together) IS LifeOS: the skill + the full **skill library** + the LIFEOS runtime (Algorithm, docs, tools, statusline binary, version) + the USER tree + the system prompt and its harness-specific activation. One consent installs all of Core; declining means not installing LifeOS.

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
| **Claude Code — macOS / Linux** | ✅ | ✅ full (native hooks) |
| **Claude Code — Windows** | ✅ (copy fallback where symlinks need admin) | ✅ full |
| **OMP — macOS / Linux / Windows** | ✅ | ✅ full (native OMP extensions + adapted Claude Code hooks) |
| **Cursor / Cline / Codex / Gemini / other** | ✅ | ⚠️ context loads every session; workflows run on request; always-on hooks require a native adapter |
| **Chat-only assistants (no files / no commands)** | ❌ | ❌ — install stops at the capability gate |

Full-doctrine features additionally depend on the external tools in step 8.5 (cross-vendor CLI, browser, Cloudflare, ElevenLabs). Without one, the dependent feature runs degraded **and says so** — it never silently pretends. The Doctor table is the live source of truth.

## Rules you must follow

- **Additive, never clobbering.** Only add what's missing; never overwrite or delete a populated dir or a file you didn't create.
- **Permission before every mutation.** Show the exact change; back up `settings.json` before editing it; wait for a yes.
- **Never write a harness's config that it won't read.** Honest degrade beats an inert install.
- **The harness-specific activation loads the constitution — don't skip it.** Claude Code uses the `lifeos` launcher; OMP uses its managed `APPEND_SYSTEM.md` and extensions; other harnesses use their native system-prompt or context mechanism.
- **Refuse to run inside the LifeOS source repo** (detected via source-repo markers). Never mutate a maintainer's live system.
