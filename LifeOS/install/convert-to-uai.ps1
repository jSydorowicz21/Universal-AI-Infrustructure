<#
Convert an existing PAI install to UAI (Universal AI Infrastructure).

Thin wrapper over update-installed.ps1: overlays the UAI release's managed files
onto the framework install recorded in ~/.pai/framework.json, then writes a UAI
distribution marker (~/.pai/distribution.json). Preserves USER, MEMORY, settings,
config, auth, env files, and hook trust state exactly as the updater does.

Examples:
  # Convert using the UAI content bundled in this clone (offline, deterministic):
  powershell -ExecutionPolicy Bypass -File .\convert-to-uai.ps1

  # Preview without changing anything:
  powershell -ExecutionPolicy Bypass -File .\convert-to-uai.ps1 -DryRun

  # Pull the UAI repo fresh before overlaying:
  powershell -ExecutionPolicy Bypass -File .\convert-to-uai.ps1 -Fetch
#>
[CmdletBinding()]
param(
  [string]$Framework = "",
  [string]$SourceDir = "",
  [string]$RepoUrl = "https://github.com/jSydorowicz21/Universal-AI-Infrustructure.git",
  [string]$Branch = "main",
  [switch]$Fetch,
  [switch]$NoPull,
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"

function Info($Message) { Write-Host "  [INFO] $Message" -ForegroundColor Cyan }
function Success($Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Warn($Message) { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$updater = Join-Path $scriptDir "update-installed.ps1"
if (-not (Test-Path -LiteralPath $updater)) {
  throw "update-installed.ps1 not found next to this script: $updater"
}

Write-Host ""
Write-Host "UAI | Convert PAI install -> Universal AI Infrastructure" -ForegroundColor Cyan
Write-Host ""
Info "Source: $(if ($SourceDir) { $SourceDir } elseif ($Fetch) { "$RepoUrl ($Branch)" } else { 'bundled UAI content in this clone' })"
Info "Overlays UAI managed files onto the install in ~/.pai/framework.json."
Info "Does NOT touch USER, MEMORY, settings, config, auth, env, or hook trust state."

if (-not $Yes -and -not $DryRun) {
  $reply = Read-Host "Proceed with conversion? [y/N]"
  if ($reply -notmatch '^(y|yes)$') { Warn "Aborted; nothing changed."; return }
}

$updaterArgs = @{}
if ($Framework) { $updaterArgs["Framework"] = $Framework }
if ($DryRun)    { $updaterArgs["DryRun"] = $true }
if ($SourceDir) {
  $updaterArgs["SourceDir"] = $SourceDir
  if ($NoPull) { $updaterArgs["NoPull"] = $true }
} elseif ($Fetch) {
  $updaterArgs["RepoUrl"] = $RepoUrl
  $updaterArgs["Branch"]  = $Branch
} else {
  # No source and no fetch: use the UAI content bundled alongside this script.
  $updaterArgs["NoPull"] = $true
}

Info "Running updater: $updater"
& $updater @updaterArgs

if ($DryRun) {
  Info "Dry run complete. No files changed and no distribution marker written."
  return
}

$dataDir = if ($env:PAI_DATA_DIR) { $env:PAI_DATA_DIR } else { Join-Path $HOME ".pai" }
if (-not (Test-Path -LiteralPath $dataDir)) {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}
$markerPath = Join-Path $dataDir "distribution.json"
$marker = [ordered]@{
  name        = "UAI"
  fullName    = "Universal AI Infrastructure"
  upstream    = "Personal AI Infrastructure (PAI) by Daniel Miessler"
  repo        = "https://github.com/jSydorowicz21/Universal-AI-Infrustructure"
  branch      = $Branch
  convertedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
}
($marker | ConvertTo-Json) | Set-Content -LiteralPath $markerPath -Encoding UTF8
Success "Wrote UAI distribution marker: $markerPath"
Success "Conversion complete. Restart your agent session so instructions reload."
