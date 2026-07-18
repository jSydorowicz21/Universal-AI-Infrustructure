<#
LifeOS — Windows bootstrap installer

Places the LifeOS skill additively into the selected harness profile, then hands
off to the agentic /lifeos-setup workflow. It never replaces the whole harness.

Local/offline install:
  $env:LIFEOS_SRC = "C:\path\to\release"
  .\install.ps1
#>

$ErrorActionPreference = "Stop"

function Info([string]$Message) { Write-Host "  [INFO] $Message" -ForegroundColor Cyan }
function Success([string]$Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Fail([string]$Message) { Write-Host "  [ERROR] $Message" -ForegroundColor Red }
function Step([string]$Message) { Write-Host "`n> $Message" -ForegroundColor Cyan }

$DryRun = $env:DRY_RUN -eq "1"
$Repo = if ($env:LIFEOS_REPO) { $env:LIFEOS_REPO } else { "danielmiessler/LifeOS" }
$FallbackTag = "v7.1.1"
$Tag = $env:LIFEOS_TAG
if ($env:LIFEOS_VERSION) {
  $Tag = "v$($env:LIFEOS_VERSION.TrimStart('v'))"
} elseif (-not $Tag) {
  try {
    $Latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "LifeOS-Installer" }
    $Tag = $Latest.tag_name
  } catch {
    Warn "Could not resolve the latest release; using $FallbackTag."
    $Tag = $FallbackTag
  }
}
$Version = $Tag.TrimStart("v")

Write-Host "`nLifeOS — the Life Operating System — v$Version bootstrap" -ForegroundColor Cyan
if ($DryRun) { Warn "DRY-RUN mode — no changes will be made." }

Step "1/5 Checking prerequisites"
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  Fail "tar is required. Install a current Windows tar implementation, then rerun."
  exit 1
}

$Bun = Get-Command bun -ErrorAction SilentlyContinue
$BunCurrent = $false
if ($Bun) {
  try { $BunCurrent = ([version]((bun --version).Trim()) -ge [version]"1.2.0") } catch { $BunCurrent = $false }
}
if (-not $BunCurrent) {
  if ($DryRun) {
    Info "Would install or upgrade Bun to >= 1.2.0."
  } elseif ($env:LIFEOS_AUTO_INSTALL_BUN -ne "0") {
    Info "Installing current Bun runtime..."
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://bun.sh/install.ps1 | iex"
    $BunBin = Join-Path $env:USERPROFILE ".bun\bin"
    if (Test-Path $BunBin) { $env:Path = "$BunBin;$env:Path" }
  } else {
    Fail "Bun >= 1.2.0 is required. Install it, then rerun."
    exit 1
  }
}
if (-not $DryRun) {
  $Bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $Bun) { Fail "Bun installation did not produce a usable bun command."; exit 1 }
  try {
    if ([version]((bun --version).Trim()) -lt [version]"1.2.0") {
      Fail "Bun >= 1.2.0 is required; found $(bun --version)."
      exit 1
    }
  } catch {
    Fail "Could not verify the installed Bun version."
    exit 1
  }
  Success "Bun $(bun --version)"
}

Step "2/5 Detecting harness profile"
$Harness = $env:LIFEOS_HARNESS
if (-not $Harness) {
  if (Get-Command claude -ErrorAction SilentlyContinue) { $Harness = "claude-code" }
  elseif (Get-Command omp -ErrorAction SilentlyContinue) { $Harness = "omp" }
  elseif (Get-Command codex -ErrorAction SilentlyContinue) { $Harness = "codex" }
  elseif (Get-Command gemini -ErrorAction SilentlyContinue) { $Harness = "gemini" }
  elseif (Get-Command opencode -ErrorAction SilentlyContinue) { $Harness = "opencode" }
  else { $Harness = "unknown" }
}

if ($env:LIFEOS_CONFIG_ROOT) {
  $ConfigRoot = $env:LIFEOS_CONFIG_ROOT
} else {
  switch ($Harness) {
    { $_ -in @("claude", "claude-code", "omp") } { $ConfigRoot = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" } }
    "codex" { $ConfigRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" } }
    "gemini" { $ConfigRoot = if ($env:GEMINI_CONFIG_DIR) { $env:GEMINI_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".gemini" } }
    "opencode" { $ConfigRoot = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".config\opencode" } }
    "unknown" { $ConfigRoot = Join-Path $env:USERPROFILE ".lifeos" }
    default { Fail "Unsupported LIFEOS_HARNESS: $Harness"; exit 1 }
  }
}
$SkillsDir = if ($env:LIFEOS_SKILLS_DIR) { $env:LIFEOS_SKILLS_DIR } else { Join-Path $ConfigRoot "skills" }
$Target = Join-Path $SkillsDir "LifeOS"
Info "Harness: $Harness"
Info "Config root: $ConfigRoot"
Info "Skills directory: $SkillsDir"

if (Test-Path $Target) {
  Warn "Existing LifeOS skill detected — its replacement will be staged before the active copy moves."
} else {
  Success "No existing LifeOS skill — clean drop-in."
}

Step "3/5 Fetching LifeOS $Tag"
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("lifeos-install-" + [guid]::NewGuid().ToString("N"))
try {
  if ($env:LIFEOS_SRC) {
    $SourceSkill = Join-Path $env:LIFEOS_SRC "LifeOS"
    Info "Local source: $($env:LIFEOS_SRC)"
  } elseif ($DryRun) {
    $SourceSkill = Join-Path $TempRoot "LifeOS"
    Info "Would download https://github.com/$Repo/archive/refs/tags/$Tag.tar.gz"
  } else {
    New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
    $Archive = Join-Path $TempRoot "lifeos.tar.gz"
    $Url = if ($env:LIFEOS_TARBALL_URL) { $env:LIFEOS_TARBALL_URL } else { "https://github.com/$Repo/archive/refs/tags/$Tag.tar.gz" }
    Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing
    & tar -xzf $Archive -C $TempRoot
    if ($LASTEXITCODE -ne 0) { throw "tar extraction failed with exit code $LASTEXITCODE" }
    $Extracted = Get-ChildItem -Path $TempRoot -Directory | Select-Object -First 1
    if (-not $Extracted) { throw "release archive contained no root directory" }
    $SourceSkill = Join-Path $Extracted.FullName "LifeOS"
  }

  if (-not $DryRun -and -not (Test-Path (Join-Path $SourceSkill "SKILL.md"))) {
    Fail "LifeOS skill not found at $SourceSkill."
    exit 1
  }
  Success "Release source ready."

  Step "4/5 Installing the LifeOS skill transactionally"
  if ($DryRun) {
    Info "Would stage $SourceSkill beside $Target, then atomically replace the active skill."
  } else {
    New-Item -ItemType Directory -Path $SkillsDir -Force | Out-Null
    $TransactionId = [guid]::NewGuid().ToString("N")
    $StagedTarget = "$Target.staging-$TransactionId"
    $Backup = $null
    try {
      Copy-Item -LiteralPath $SourceSkill -Destination $StagedTarget -Recurse
      if (Test-Path $Target) {
        $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $Backup = "$Target.backup-$Stamp-$TransactionId"
        Move-Item -LiteralPath $Target -Destination $Backup
      }
      try {
        Move-Item -LiteralPath $StagedTarget -Destination $Target
      } catch {
        if ($Backup -and (Test-Path $Backup) -and -not (Test-Path $Target)) {
          Move-Item -LiteralPath $Backup -Destination $Target
        }
        throw
      }
    } finally {
      if (Test-Path $StagedTarget) {
        Remove-Item -LiteralPath $StagedTarget -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  }
  Success "LifeOS skill placed at $Target"
} finally {
  if (Test-Path $TempRoot) { Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Step "5/5 Onboarding"
if ($DryRun) { Info "Would launch /lifeos-setup."; exit 0 }
Success "LifeOS is installed. The setup conversation detects conflicts and asks before wiring hooks."

if ($Harness -in @("claude", "claude-code") -and (Get-Command claude -ErrorAction SilentlyContinue) -and -not $env:CLAUDECODE) {
  Info "Launching /lifeos-setup in Claude Code..."
  & claude "/lifeos-setup"
  exit $LASTEXITCODE
}
if ($Harness -eq "omp" -and (Get-Command omp -ErrorAction SilentlyContinue)) {
  Info "Launching /lifeos-setup in OMP..."
  & omp "/lifeos-setup"
  exit $LASTEXITCODE
}

Write-Host "`nOpen $Harness and run: /lifeos-setup`n" -ForegroundColor Cyan
