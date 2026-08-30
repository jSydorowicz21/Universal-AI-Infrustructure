<# 
PAI Installer v5.0 - Windows Bootstrap

Runs the TypeScript installer from the local release bundle. The wizard handles
framework selection, selected CLI installation, configuration, and validation.
#>

$ErrorActionPreference = "Stop"

function Info($Message) { Write-Host "  [INFO] $Message" -ForegroundColor Cyan }
function Success($Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Warn($Message) { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Fail($Message) { Write-Host "  [ERROR] $Message" -ForegroundColor Red }

$ScriptPath = $MyInvocation.MyCommand.Path
if (-not $ScriptPath) { $ScriptPath = $PSCommandPath }
$ScriptDir = Split-Path -Parent $ScriptPath

Write-Host ""
Write-Host "PAI | Personal AI Infrastructure" -ForegroundColor Cyan
Write-Host "Installer v5.0 - Windows bootstrap" -ForegroundColor DarkCyan
Write-Host ""

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Warn "Git not found."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Info "Installing Git via winget..."
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  } else {
    Fail "Git is required. Install Git for Windows, then rerun this script."
    exit 1
  }
}
Success "Git found: $((git --version) -join ' ')"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Info "Installing Bun runtime..."
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
  $BunBin = Join-Path $env:USERPROFILE ".bun\bin"
  if (Test-Path $BunBin) {
    $env:Path = "$BunBin;$env:Path"
  }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Fail "Bun is required and could not be installed automatically."
  exit 1
}
Success "Bun found: $(bun --version)"

switch -Regex ($env:PAI_FRAMEWORK) {
  "^(claude|claude-code)$" {
    if (Get-Command claude -ErrorAction SilentlyContinue) { Success "Claude Code found" } else { Warn "Claude Code not found - wizard will install/check it." }
    break
  }
  "^codex$" {
    if (Get-Command codex -ErrorAction SilentlyContinue) { Success "Codex found" } else { Warn "Codex not found - wizard will install/check it." }
    break
  }
  "^opencode$" {
    if (Get-Command opencode -ErrorAction SilentlyContinue) { Success "OpenCode found" } else { Warn "OpenCode not found - wizard will install/check it." }
    break
  }
  default {
    Info "Agent framework selection deferred to installer wizard."
  }
}

$InstallerDir = Join-Path $ScriptDir "PAI\PAI-Install"
if (-not (Test-Path $InstallerDir)) {
  if (Test-Path (Join-Path $ScriptDir "PAI-Install")) {
    $InstallerDir = Join-Path $ScriptDir "PAI-Install"
  } elseif (Test-Path (Join-Path $ScriptDir "main.ts")) {
    $InstallerDir = $ScriptDir
  } else {
    Fail "Cannot find PAI-Install directory."
    exit 1
  }
}

$env:PAI_BUNDLE_DIR = $ScriptDir

Info "Launching installer..."
Push-Location $InstallerDir
try {
  bun run ".\main.ts" --mode cli
  $InstallExit = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($InstallExit -ne 0) {
  exit $InstallExit
}

Write-Host ""
Info "Launching k..."
if (Test-Path $PROFILE) {
  . $PROFILE
}

if (Get-Command k -ErrorAction SilentlyContinue) {
  k
} elseif (Get-Command pai -ErrorAction SilentlyContinue) {
  pai
} else {
  Info "Install complete. Open a new PowerShell window or run: . `$PROFILE; k"
}
