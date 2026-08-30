# UAI Scoped Rename — Migration Plan

> **Status: PROPOSAL — awaiting approval. No code changes are made by this document.**
> Decision owner: jSydorowicz21. This plan exists so the rename is reviewed before anything is touched.

## 1. Goal

Give UAI a distinct, user-facing identity — its own CLI verb, state directory, brand text, and service label — **without** a blind global `PAI` → `UAI` token rewrite that would destroy mergeability with upstream `danielmiessler/main`.

## 2. Core principle: rename the surface, not the engine

Two layers, treated differently:

| Layer | Examples | Decision |
|-------|----------|----------|
| **Engine (internal)** | `~/.claude/` framework home (owned by Claude Code), the `PAI/` source subtree, `PAI_SYSTEM_PROMPT.md`, internal module names, the 41k-line framework engine's `PAI`/`$PAI_DIR` token usage | **KEEP.** Renaming forks us irreversibly from upstream (every `git merge` conflicts) and breaks framework-dictated paths. |
| **Presentation (user-facing)** | the `pai` CLI verb, the `~/.pai/` state dir, env vars users type, banners/voice/statusline/dashboard brand text, the launchd/systemd service label | **RENAME**, behind compatibility shims. |

## 3. Non-goals (explicit)

- NOT renaming `~/.claude/` — Claude Code owns it.
- NOT renaming the `PAI/` source subtree, `PAI_SYSTEM_PROMPT.md`, or internal `$PAI_DIR` semantics.
- NOT a find/replace of `PAI` → `UAI` across the repo.
- NO change that widens per-merge conflict surface against upstream beyond the files enumerated in §4.

## 4. Surface inventory (what actually changes)

Grounded in the current tree:

### 4.1 CLI verb `pai` → `uai`
- Entry: `PAI/TOOLS/pai.ts` plus the generated `pai` / `pai.cmd` / `bin` shims.
- **Approach:** ship `uai` as the primary verb; keep `pai` as a thin alias that execs the same entrypoint. Both resolve identically — zero breakage for muscle memory, existing docs, or upstream scripts.

### 4.2 State dir `~/.pai/` → `~/.uai/`
- Single source: `getPaiDataDir()` in `PAI/PAI-Install/engine/frameworks.ts:84` (`process.env.PAI_DATA_DIR || ~/.pai`). Mirrored in the updaters' `Resolve-PaiDataDir` (PS) / `resolve_pai_data_dir` (sh).
- **Approach:** default to `~/.uai/`; migration moves `~/.pai` → `~/.uai` and leaves `~/.pai` as a symlink/junction to `~/.uai` for back-compat. Honor `PAI_DATA_DIR`; add `UAI_DATA_DIR` (UAI wins if both set).

### 4.3 Env vars
- Keep `PAI_DIR` / `PAI_DATA_DIR` / `PAI_CONFIG_DIR` populated (compat); add `UAI_*` aliases. The emitted shell-profile block (`Get-PaiPowerShellBlock` / `pai_shell_block` in the updaters) sets both.

### 4.4 Service label `com.pai.pulse` → `com.uai.pulse`
- Files: `PULSE/com.pai.pulse.plist`, `PULSE/manage.sh:10-13`, `PULSE/setup.ts:353-357`, `PAI-Install/engine/actions.ts` (`installPulse` / reload, ~2348-2484), `PAI-Install/engine/validate.ts:534`, `TOOLS/PaiDoctor.ts:159-160` (systemd `com.pai.pulse.service`), MenuBar (`com.pai.pulse-menubar`).
- **Approach:** rename the label; migration unloads the old plist/service and installs the new one. Precedent exists — `PULSE/MenuBar/install.sh:20` already migrates an `OLD_PLIST_LABEL` (`com.pai.monitor-menubar`), so the unload-old/load-new pattern is established.

### 4.5 Brand strings (cosmetic, user-visible)
- Banners `PAI | …` (mode templates in `PAI_SYSTEM_PROMPT.md` / `CLAUDE.md`, updater headers), `statusline-command.sh`, voice prefix, Pulse dashboard title, install-wizard copy.
- **Approach:** swap display text to `UAI`. Leave internal doc prose that describes the upstream architecture untouched.

## 5. Compatibility strategy

- `pai` alias → `uai` (both work; deprecation optional).
- `~/.pai` symlink → `~/.uai`.
- Dual env vars (`PAI_*` and `UAI_*`).
- Distribution marker `~/.pai/distribution.json` (already written by `convert-to-uai.*`); migration reads it.
- Deprecation window: keep all shims for ≥ 2 releases.

## 6. Migration mechanics

Fold into a `uai migrate` subcommand (or extend `convert-to-uai.*`):

1. Back up `framework.json` + the shell-profile block under `~/.uai/BACKUPS/`.
2. `mv ~/.pai ~/.uai`; create `~/.pai` → `~/.uai` link.
3. Rewrite `framework.json` (`dataDir`); regenerate the shell-profile block with dual env.
4. Service: stop/unload `com.pai.pulse`, install/load `com.uai.pulse`.
5. Reinstall the `uai` CLI shim (+ `pai` alias).
6. Verify (extend `validate.ts` / `PaiDoctor.ts` to accept either label during the window).

## 7. Mergeability impact

The scoped change touches ~15–25 enumerated files — the same subsystems the fork already heavily owns (Pulse install, updaters, framework engine). Conflicts against upstream stay confined to those files; the token-sprayed engine and the `PAI/` tree are untouched, so routine `git merge upstream/main` remains sane. This is the entire reason for choosing scoped over global.

## 8. Risks & rollback

- **Stale `com.pai.pulse` left loaded** → two daemons on :31337. Mitigation: explicit unload before load; add a doctor check.
- **Scripts/users referencing `~/.pai` directly.** Mitigation: the symlink.
- **Env duplication confusion.** Mitigation: documented `UAI_*` precedence.
- **Rollback:** reverse the migrate (relink, restore `framework.json` from backup, reload the old plist). Every step is backed up under `~/.uai/BACKUPS/`.

## 9. Phased rollout (each phase independently shippable + reversible)

- **Phase 0 (done):** distribution marker via `convert-to-uai.*`.
- **Phase 1:** `uai` CLI alias + dual env, no data move — lowest risk.
- **Phase 2:** `~/.uai` state dir + `~/.pai` symlink + service relabel.
- **Phase 3:** brand strings (banners, statusline, voice, dashboard).

## 10. Acceptance tests

- `uai` and `pai` both launch the active framework identically.
- Fresh install creates `~/.uai`; an existing install migrates with the `~/.pai` link intact and `MEMORY`/`USER` preserved.
- Exactly one Pulse process on :31337 after migration; `com.uai.pulse` loaded, `com.pai.pulse` gone.
- A synthetic `git merge upstream/main` conflicts only in the §4 files.

## 11. Open decisions (need your call before Phase 1)

- **D1:** Keep the `pai` alias permanently, or deprecate after N releases?
- **D2:** Hard-move `~/.pai` → `~/.uai`, or symlink-only (leave data at `~/.pai`, add `~/.uai` → `~/.pai`)? Symlink-only is lower risk.
- **D3:** Rename the launchd/systemd label now, or defer it (cosmetic, highest breakage)?
- **D4:** Re-brand the Pulse dashboard/voice in Phase 3, or keep the `PAI` engine voice?

## 12. Implementation status (live)

- **Phase 1 — IN PROGRESS.** The `uai` command and dual `UAI_*` env (UAI takes precedence over `PAI_*`) landed in:
  - `PAI/TOOLS/lib/paths.ts` — runtime resolver honors `UAI_*` (verified: `UAI_DATA_DIR` flows to `getPaiDataDir()`).
  - `PAI/PAI-Install/engine/frameworks.ts` — installer resolver honors `UAI_*`.
  - `PAI/PAI-Install/engine/actions.ts` — fresh-install profile generator emits `uai` + `UAI_*` for posix, fish, and PowerShell, with matching cleanup regexes.
  - `update-installed.sh` — non-Windows hotfix-update profile repair emits `uai` + `UAI_*`.
- **Known gap:** `update-installed.ps1` (`Get-PaiPowerShellBlock`) — the Windows hotfix-update profile-repair path — is NOT yet patched. The file was locked by host security (Defender/sandbox) and could not be written from this environment. Fresh Windows installs are unaffected (they use `actions.ts`). To close the gap, apply the same two changes when the file is writable: the `UAI_*` mirror at the end of `Initialize-PAIEnvironment`, and `function uai { Invoke-PAI @args }` placed before `function k`.
- **Phases 2–3** (state dir move, service-label relabel, brand strings) remain gated on decisions D1–D4.
