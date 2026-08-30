# RTK - Rust Token Killer (Codex CLI)

**Usage**: Token-optimized CLI proxy for shell commands.

## Installation

PAI expects `rtk` on PATH when command reduction is enabled.

Linux/macOS quick install:

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
```

Homebrew:

```bash
brew install rtk
```

Cargo:

```bash
cargo install --git https://github.com/rtk-ai/rtk
```

Windows:

Download `rtk-x86_64-pc-windows-msvc.zip` from <https://github.com/rtk-ai/rtk/releases>, extract `rtk.exe`, and place it somewhere on PATH such as `%USERPROFILE%\.local\bin`. For WSL-based PAI, install RTK inside WSL with the Linux quick install.

Verify:

```bash
rtk --version
rtk gain
which rtk
```

## Rule

Always prefix shell commands with `rtk`.

Examples:

```bash
rtk git status
rtk cargo test
rtk npm run build
rtk pytest -q
```

## Meta Commands

```bash
rtk gain            # Token savings analytics
rtk gain --history  # Recent command savings history
rtk proxy <cmd>     # Run raw command without filtering
```

## Verification

```bash
rtk --version
rtk gain
which rtk
```
