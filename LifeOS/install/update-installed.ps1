<#
PAI Installed Hotfix Updater

Fetches a PAI release bundle, reads hotfix-manifest.json, and overlays only the
managed files listed there into an existing framework install. It intentionally
does not touch USER, MEMORY, settings.json, config.toml, auth, env files, or
hook trust state.
#>

[CmdletBinding()]
param(
  [string]$RepoUrl = "https://github.com/haydencj/Personal_AI_Infrastructure.git",
  [string]$Branch = "pai-codex-flawless-runtime",
  [string]$Framework = "",
  [string]$InstallRoot = "",
  [string]$AgentsSkillsRoot = "",
  [string]$SourceDir = "",
  [string]$ManifestPath = "",
  [switch]$DryRun,
  [switch]$NoPull,
  [switch]$KeepTemp
)

$ErrorActionPreference = "Stop"

function Info($Message) { Write-Host "  [INFO] $Message" -ForegroundColor Cyan }
function Success($Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Warn($Message) { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
function Fail($Message) { Write-Host "  [ERROR] $Message" -ForegroundColor Red }

function Resolve-AbsolutePath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Path))
}

$EffectiveHome = if ($env:HOME) { Resolve-AbsolutePath $env:HOME } else { Resolve-AbsolutePath $HOME }

function Read-FrameworkState {
  $statePath = Join-Path $EffectiveHome ".pai\framework.json"
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  try {
    return Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  } catch {
    Warn "Could not read ${statePath}: $($_.Exception.Message)"
    return $null
  }
}

function Read-FrameworkStateAt([string]$DataDir) {
  $statePath = Join-Path $DataDir "framework.json"
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  try {
    return Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  } catch {
    Warn "Could not read ${statePath}: $($_.Exception.Message)"
    return $null
  }
}

function Test-FrameworkStateUsable($State) {
  if (-not $State) { return $false }
  if ($State.root) {
    $root = Resolve-AbsolutePath $State.root
    if (-not (Test-Path -LiteralPath $root)) { return $false }
  }
  return $true
}

function Test-StaleFrameworkEnvironment {
  if ($env:PAI_FRAMEWORK_DIR) {
    $frameworkRoot = Resolve-AbsolutePath $env:PAI_FRAMEWORK_DIR
    if (-not (Test-Path -LiteralPath $frameworkRoot)) { return $true }
  }
  if ($env:PAI_DIR) {
    $paiRoot = Resolve-AbsolutePath $env:PAI_DIR
    if (-not (Test-Path -LiteralPath $paiRoot)) { return $true }
  }
  return $false
}

function Resolve-PaiDataDir {
  $defaultDataDir = Join-Path $EffectiveHome ".pai"
  $state = Read-FrameworkState
  if ($env:PAI_DATA_DIR) {
    $envDataDir = Resolve-AbsolutePath $env:PAI_DATA_DIR
    if (Test-Path -LiteralPath $envDataDir) {
      $envState = Read-FrameworkStateAt $envDataDir
      if ((-not $envState) -and ((-not (Test-FrameworkStateUsable $state)) -or (-not (Test-StaleFrameworkEnvironment)))) {
        return $envDataDir
      }
      if (Test-FrameworkStateUsable $envState) {
        return $envDataDir
      }
    }
  }

  if ((Test-FrameworkStateUsable $state) -and $state.dataDir) {
    return (Resolve-AbsolutePath $state.dataDir)
  }

  return $defaultDataDir
}

function Resolve-PaiConfigDir {
  if ($env:PAI_CONFIG_DIR) {
    $envConfigDir = Resolve-AbsolutePath $env:PAI_CONFIG_DIR
    if (Test-Path -LiteralPath $envConfigDir) { return $envConfigDir }
  }
  return (Join-Path $EffectiveHome ".config\PAI")
}

function Set-PaiUserEnvironment([string]$InstallRoot, [string]$Framework) {
  $dataDir = Resolve-PaiDataDir
  $paiDir = Join-Path $InstallRoot "PAI"
  $configDir = Resolve-PaiConfigDir

  $values = @{
    PAI_DIR = $paiDir
    PAI_FRAMEWORK_DIR = $InstallRoot
    PAI_FRAMEWORK = $Framework
    PAI_DATA_DIR = $dataDir
    PAI_CONFIG_DIR = $configDir
  }

  foreach ($key in $values.Keys) {
    Set-Item -Path "Env:$key" -Value $values[$key]
  }

  if ($env:PAI_SKIP_USER_ENV_UPDATE -eq "1") {
    Info "Skipped Windows user environment update by request."
    return
  }

  $target = if ($env:PAI_USER_ENV_TARGET -eq "Process") { "Process" } else { "User" }
  foreach ($key in $values.Keys) {
    [Environment]::SetEnvironmentVariable($key, $values[$key], $target)
  }
  if ($target -eq "User") {
    try {
      Add-Type -Namespace Pai.Native -Name User32 -MemberDefinition @"
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
"@ -ErrorAction SilentlyContinue
      $result = [UIntPtr]::Zero
      [Pai.Native.User32]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result) | Out-Null
      Info "Broadcast Windows environment change for new terminals."
    } catch {
      Warn "Could not broadcast Windows environment change: $($_.Exception.Message)"
    }
  }
  Success "Updated PAI environment variables at ${target} scope."
}

function Write-FrameworkSwitchAudit([string]$DataDir, [string]$Framework, [string]$InstallRoot, $PreviousState) {
  try {
    $auditDir = Join-Path $DataDir "MEMORY\OBSERVABILITY"
    New-Item -ItemType Directory -Force -Path $auditDir | Out-Null
    $entry = [ordered]@{
      timestamp = (Get-Date).ToUniversalTime().ToString("o")
      source = "update-installed.ps1"
      active = $Framework
      root = $InstallRoot
      dataDir = $DataDir
      previousActive = if ($PreviousState -and $PreviousState.active) { [string]$PreviousState.active } else { $null }
      previousRoot = if ($PreviousState -and $PreviousState.root) { [string]$PreviousState.root } else { $null }
      cwd = (Get-Location).Path
      argv = $MyInvocation.Line
    }
    Add-Content -LiteralPath (Join-Path $auditDir "framework-switches.jsonl") -Value (($entry | ConvertTo-Json -Compress) + "`n")
  } catch {
    Warn "Could not write framework switch audit: $($_.Exception.Message)"
  }
}

function Write-PaiFrameworkState([string]$InstallRoot, [string]$Framework) {
  $dataDir = Resolve-PaiDataDir
  $statePath = Join-Path $dataDir "framework.json"
  $previous = Read-FrameworkStateAt $dataDir
  $frameworkName = switch ($Framework) {
    "codex" { "Codex" }
    "opencode" { "OpenCode" }
    default { "Claude Code" }
  }
  $state = [ordered]@{
    active = $Framework
    frameworkName = $frameworkName
    root = $InstallRoot
    dataDir = $dataDir
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  Set-Content -LiteralPath $statePath -Value (($state | ConvertTo-Json -Depth 4) + "`n") -NoNewline
  Write-FrameworkSwitchAudit $dataDir $Framework $InstallRoot $previous
  Success "Synchronized active framework state at $statePath."
}

function Normalize-Framework([string]$Value) {
  $v = ($Value | ForEach-Object { "$_".Trim().ToLowerInvariant() }) -replace "[\s_-]+", ""
  switch ($v) {
    "claude" { return "claude" }
    "claudecode" { return "claude" }
    "codex" { return "codex" }
    "openai" { return "codex" }
    "openaicodex" { return "codex" }
    "opencode" { return "opencode" }
    default { return "" }
  }
}

function Resolve-Target {
  $state = Read-FrameworkState
  $fw = Normalize-Framework $Framework
  if (-not $fw -and $env:PAI_FRAMEWORK) { $fw = Normalize-Framework $env:PAI_FRAMEWORK }
  if (-not $fw -and $state -and $state.active) { $fw = Normalize-Framework $state.active }
  if (-not $fw) {
    if ($env:CODEX_HOME -or (Test-Path -LiteralPath (Join-Path $EffectiveHome ".codex"))) { $fw = "codex" }
    elseif ($env:CLAUDE_HOME -or (Test-Path -LiteralPath (Join-Path $EffectiveHome ".claude"))) { $fw = "claude" }
    elseif ($env:OPENCODE_CONFIG_DIR -or (Test-Path -LiteralPath (Join-Path $EffectiveHome ".config\opencode"))) { $fw = "opencode" }
  }
  if (-not $fw) { throw "Could not determine framework. Pass -Framework codex|claude|opencode." }

  $root = $InstallRoot
  if (-not $root -and $state -and $state.active -and (Normalize-Framework $state.active) -eq $fw -and $state.root) {
    $root = $state.root
  }
  if (-not $root) {
    switch ($fw) {
      "codex" { $root = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $EffectiveHome ".codex" } }
      "claude" { $root = if ($env:CLAUDE_HOME) { $env:CLAUDE_HOME } else { Join-Path $EffectiveHome ".claude" } }
      "opencode" { $root = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $EffectiveHome ".config\opencode" } }
    }
  }

  $root = Resolve-AbsolutePath $root
  if (-not (Test-Path -LiteralPath $root)) { throw "Install root does not exist: $root" }
  return [pscustomobject]@{ Framework = $fw; Root = $root }
}

function Resolve-ReleaseRoot([string]$Path) {
  $pathAbs = Resolve-AbsolutePath $Path
  if ((Test-Path -LiteralPath (Join-Path $pathAbs "CLAUDE.md")) -and (Test-Path -LiteralPath (Join-Path $pathAbs "PAI"))) {
    return $pathAbs
  }
  $candidate = Join-Path $pathAbs "Releases\v5.0.0\.claude"
  if ((Test-Path -LiteralPath (Join-Path $candidate "CLAUDE.md")) -and (Test-Path -LiteralPath (Join-Path $candidate "PAI"))) {
    return (Resolve-AbsolutePath $candidate)
  }
  throw "Could not locate release root under $pathAbs"
}

function Get-ScriptRoot {
  if ($PSScriptRoot) { return (Resolve-AbsolutePath $PSScriptRoot) }
  if ($PSCommandPath) { return (Resolve-AbsolutePath (Split-Path -Parent $PSCommandPath)) }
  if ($MyInvocation.MyCommand.Path) { return (Resolve-AbsolutePath (Split-Path -Parent $MyInvocation.MyCommand.Path)) }
  return (Resolve-AbsolutePath (Get-Location).Path)
}

function Get-ReleaseRoot {
  if ($SourceDir) {
    $sourceAbs = Resolve-AbsolutePath $SourceDir
    Info "Using local source: $sourceAbs"
    if (-not $NoPull -and (Test-Path -LiteralPath (Join-Path $sourceAbs ".git"))) {
      if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git is required to update local source. Install Git or pass -NoPull."
      }
      Info "Updating local source with git fetch + pull --ff-only"
      git -C $sourceAbs fetch --prune | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
      git -C $sourceAbs pull --ff-only | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed" }
    }
    return [pscustomobject]@{ Root = Resolve-ReleaseRoot $sourceAbs; Temp = "" }
  }

  if ($NoPull) {
    $scriptRoot = Get-ScriptRoot
    Info "Using bundled source because -NoPull was passed without -SourceDir: $scriptRoot"
    return [pscustomobject]@{ Root = Resolve-ReleaseRoot $scriptRoot; Temp = "" }
  }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required for fetching hotfixes. Install Git or pass -SourceDir."
  }

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pai-hotfix-" + [guid]::NewGuid().ToString("N"))
  Info "Fetching $RepoUrl ($Branch) into $tempRoot"
  git clone --depth 1 --branch $Branch $RepoUrl $tempRoot | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
  return [pscustomobject]@{ Root = Resolve-ReleaseRoot $tempRoot; Temp = $tempRoot }
}

function Convert-InstructionContent([string]$Text, [string]$Framework) {
  if ($Framework -eq "claude") { return $Text }
  $name = if ($Framework -eq "codex") { "Codex" } else { "OpenCode" }
  $converted = $Text `
    -replace "\bCLAUDE\.md\b", "AGENTS.md" `
    -replace "\bClaude Code\b", $name `
    -replace "~\/\.claude\/PAI", '$PAI_DIR' `
    -replace "~\/\.claude", '$PAI_FRAMEWORK_DIR' `
    -replace "\$PAI_FRAMEWORK_DIR\/PAI", '$PAI_DIR'
  return ($converted -replace "(?m)^#\s*AGENTS\.md\b.*$", "# AGENTS.md")
}

function Copy-DirectoryContents([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  }
  $destinationFull = [System.IO.Path]::GetFullPath($Destination).TrimEnd("\", "/")
  foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
    $target = Join-Path $Destination $item.Name
    $itemFull = [System.IO.Path]::GetFullPath($item.FullName)
    if ($destinationFull.StartsWith($itemFull.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
      Warn "Skipped recursive copy source nested under destination: $($item.FullName)"
      continue
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Warn "Skipped reparse point while copying: $($item.FullName)"
      continue
    }
    if ($item.PSIsContainer) {
      Copy-DirectoryContents $item.FullName $target
    } else {
      try {
        Copy-Item -LiteralPath $item.FullName -Destination $target -Force
      } catch {
        Warn "Could not update locked file ${target}: $($_.Exception.Message)"
      }
    }
  }
}

function Test-SameFileContent([string]$Source, [string]$Target) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return $false }
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { return $false }
  try {
    $sourceHash = Get-FileHash -Algorithm SHA256 -LiteralPath $Source
    $targetHash = Get-FileHash -Algorithm SHA256 -LiteralPath $Target
    return $sourceHash.Hash -eq $targetHash.Hash
  } catch {
    return $false
  }
}

function Remove-ExistingPathSafely([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Remove-Item -LiteralPath $Path -Force
    return
  }
  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Test-IsReparsePoint([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

# Returns the one-hop reparse target of a path, or "" when it is not a link.
# Works on both PowerShell 7 (FileSystemInfo.ResolveLinkTarget) and Windows
# PowerShell 5.1 (where that method is absent and .Target carries the target).
function Get-LinkTargetSafe([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  try {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { return "" }
    if ($item.PSObject.Methods.Name -contains "ResolveLinkTarget") {
      $resolved = $item.ResolveLinkTarget($false)
      if ($resolved) { return [string]$resolved.FullName }
    }
    $target = $item.Target
    if ($target) {
      if ($target -is [array]) { return [string]$target[0] }
      return [string]$target
    }
  } catch {
    # Inaccessible/unsupported reparse points fall through to "" (treated literal).
  }
  return ""
}

# Resolve a path to its canonical on-disk location, following reparse points
# (symlinks/junctions) on every existing ancestor as well as the leaf. Unlike
# [System.IO.Path]::GetFullPath this honours junctions in the middle of the path.
function Resolve-RealPath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $parent = Split-Path -Parent $full
  if (-not $parent -or $parent -eq $full) { return $full }
  $leaf = Split-Path -Leaf $full
  $realParent = Resolve-RealPath $parent
  $candidate = Join-Path $realParent $leaf
  $linkTarget = Get-LinkTargetSafe $candidate
  if ($linkTarget) {
    return (Resolve-RealPath $linkTarget)
  }
  return $candidate
}

# Returns the reparse-point ancestor of $Path that lives strictly below
# $InstallRoot (the leaf itself is excluded), or "" when none exists. This is
# the guard the old updater lacked: a destination can be a plain directory yet
# still resolve through a junctioned parent into the source tree.
function Get-ReparseAncestorBelowRoot([string]$InstallRoot, [string]$Path) {
  $rootFull = ([System.IO.Path]::GetFullPath($InstallRoot)).TrimEnd("\", "/")
  $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
  $found = ""
  while ($parent) {
    $parentTrim = $parent.TrimEnd("\", "/")
    if ($parentTrim.Length -le $rootFull.Length) { break }
    if (Test-IsReparsePoint $parent) { $found = $parent }
    $next = Split-Path -Parent $parent
    if (-not $next -or $next -eq $parent) { break }
    $parent = $next
  }
  return $found
}

# Decides what to do with a destination that sits under a reparse-point ancestor:
#   normal -> no reparse ancestor, behave exactly as before
#   skip   -> destination already resolves to the managed source (dev junction);
#             it is already current, so do not delete/recopy through it
#   fail   -> destination resolves somewhere else through the reparse ancestor;
#             refuse rather than delete/copy through it
function Resolve-ReparseTargetAction([string]$InstallRoot, [string]$Target, [string]$Source) {
  $ancestor = Get-ReparseAncestorBelowRoot $InstallRoot $Target
  if (-not $ancestor) { return [pscustomobject]@{ Action = "normal"; Ancestor = ""; RealTarget = "" } }
  $realTarget = (Resolve-RealPath $Target).TrimEnd("\", "/")
  $realSource = (Resolve-RealPath $Source).TrimEnd("\", "/")
  if ([string]::Equals($realTarget, $realSource, [System.StringComparison]::OrdinalIgnoreCase)) {
    return [pscustomobject]@{ Action = "skip"; Ancestor = $ancestor; RealTarget = $realTarget }
  }
  return [pscustomobject]@{ Action = "fail"; Ancestor = $ancestor; RealTarget = $realTarget }
}

# Replace a directory destination with the managed source, but never recursively
# delete through a reparse-point ancestor. Returns "skipped" when a dev junction
# already resolves to the source (already current) and "updated" otherwise.
function Update-DirectoryTarget([string]$Root, [string]$Target, [string]$Source) {
  if (Test-Path -LiteralPath $Target) {
    if (Test-IsReparsePoint $Target) {
      # The destination leaf itself is a symlink/junction (the ancestor scan in
      # Resolve-ReparseTargetAction deliberately excludes the leaf). Same-source ->
      # already current, skip. Foreign -> refuse rather than copy through the link
      # into an unmanaged tree.
      $leafReal = (Resolve-RealPath $Target).TrimEnd("\", "/")
      $sourceReal = (Resolve-RealPath $Source).TrimEnd("\", "/")
      if ([string]::Equals($leafReal, $sourceReal, [System.StringComparison]::OrdinalIgnoreCase)) {
        return "skipped"
      }
      throw "Refusing to copy into reparse-point leaf '$Target' (resolves to '$leafReal', not the managed source '$Source'). Replace the junction/symlink before updating."
    }
    $reparse = Resolve-ReparseTargetAction $Root $Target $Source
    if ($reparse.Action -eq "skip") { return "skipped" }
    if ($reparse.Action -eq "fail") {
      throw "Refusing to recursively delete '$Target' through reparse-point ancestor '$($reparse.Ancestor)' (resolves to '$($reparse.RealTarget)', not the managed source '$Source'). Replace the junction/symlink before updating."
    }
    Remove-ExistingPathSafely $Target
  }
  Copy-DirectoryContents $Source $Target
  return "updated"
}

function Get-BackupRelativePath([string]$InstallRoot, [string]$Path) {
  $rootFull = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd("\", "/")
  $pathFull = [System.IO.Path]::GetFullPath($Path)
  $comparison = [System.StringComparison]::OrdinalIgnoreCase

  if ([string]::Equals($rootFull, $pathFull.TrimEnd("\", "/"), $comparison)) {
    return (Split-Path -Leaf $pathFull)
  }

  $rootPrefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
  if ($pathFull.StartsWith($rootPrefix, $comparison)) {
    return $pathFull.Substring($rootPrefix.Length)
  }

  return ($pathFull -replace "[:\\\/]+", "_")
}

function Backup-Existing([string]$InstallRoot, [string]$Path, [string]$BackupRoot) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  $relative = Get-BackupRelativePath $InstallRoot $Path
  $backupPath = Join-Path $BackupRoot $relative
  $backupDir = Split-Path -Parent $backupPath
  if ($backupDir) { New-Item -ItemType Directory -Force -Path $backupDir | Out-Null }
  try {
    Copy-Item -LiteralPath $Path -Destination $backupPath -Recurse -Force
    return $backupPath
  } catch {
    Warn "Could not fully back up ${Path}: $($_.Exception.Message)"
    return ""
  }
}

function Get-EntryTarget($Entry, [string]$Framework) {
  if ($Entry.targets) {
    $value = $Entry.targets.$Framework
    if (-not $value) { return "" }
    return "$value"
  }
  if ($Entry.target) { return "$($Entry.target)" }
  return "$($Entry.source)"
}

function Apply-Entry($Entry, [string]$ReleaseRoot, [string]$InstallRoot, [string]$Framework, [string]$BackupRoot) {
  $sourceRel = "$($Entry.source)" -replace "/", "\"
  $source = Join-Path $ReleaseRoot $sourceRel
  $targetRel = Get-EntryTarget $Entry $Framework
  if (-not $targetRel) { return [pscustomobject]@{ Status = "skipped"; Detail = "No target for $Framework"; Target = "" } }
  $targetRel = $targetRel -replace "/", "\"
  $target = Join-Path $InstallRoot $targetRel

  if ($Entry.transformInstructions -and $Framework -ne "claude") {
    $frameworkNativeSource = Join-Path $ReleaseRoot $targetRel
    if (Test-Path -LiteralPath $frameworkNativeSource) {
      $sourceRel = $targetRel
      $source = $frameworkNativeSource
    }
  }

  if (-not (Test-Path -LiteralPath $source)) {
    throw "Manifest source missing: $source"
  }

  $sourceIsDir = Test-Path -LiteralPath $source -PathType Container

  # Dev installs junction managed dirs (e.g. PAI) back into the source tree. When
  # the destination resolves through a reparse-point ancestor to the very source
  # being copied it is already current: skip rather than copy a file/dir onto
  # itself (which would throw or, for files, truncate the source mid-copy). When
  # a destination resolves elsewhere through that ancestor, refuse BEFORE any
  # backup/copy so files are never written and directories are never deleted
  # through an unmanaged reparse point.
  $reparseInfo = Resolve-ReparseTargetAction $InstallRoot $target $source
  if ($reparseInfo.Action -eq "skip") {
    return [pscustomobject]@{ Status = "unchanged"; Detail = "dev junction resolves to managed source ($($reparseInfo.Ancestor))"; Target = $target }
  }
  if ($reparseInfo.Action -eq "fail") {
    throw "Refusing to update '$target' through reparse-point ancestor '$($reparseInfo.Ancestor)' (resolves to '$($reparseInfo.RealTarget)', not the managed source '$source'). Replace the junction/symlink before updating."
  }

  # The destination LEAF itself may be a symlink/junction (the ancestor scan above
  # excludes the leaf). Same-source (any type) -> already current, skip rather than
  # copy onto itself. Foreign leaf -> refuse before any backup/copy so we never
  # write files or dump directories into the link target.
  if (Test-IsReparsePoint $target) {
    $leafReal = (Resolve-RealPath $target).TrimEnd("\", "/")
    $sourceReal = (Resolve-RealPath $source).TrimEnd("\", "/")
    if ([string]::Equals($leafReal, $sourceReal, [System.StringComparison]::OrdinalIgnoreCase)) {
      return [pscustomobject]@{ Status = "unchanged"; Detail = "dev junction leaf resolves to managed source"; Target = $target }
    }
    throw "Refusing to update reparse-point leaf '$target' (resolves to '$leafReal', not the managed source '$source'). Replace the junction/symlink before updating."
  }

  if ($DryRun) {
    return [pscustomobject]@{ Status = "dry-run"; Detail = "$sourceRel -> $targetRel"; Target = $target }
  }

  $backup = Backup-Existing $InstallRoot $target $BackupRoot
  $parent = Split-Path -Parent $target
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

  $sourceItem = Get-Item -LiteralPath $source -Force
  if ($sourceItem.PSIsContainer) {
    if ((Update-DirectoryTarget $InstallRoot $target $source) -eq "skipped") {
      return [pscustomobject]@{ Status = "unchanged"; Detail = "dev junction resolves to managed source"; Target = $target }
    }
  } elseif ($Entry.transformInstructions) {
    $text = Get-Content -Raw -LiteralPath $source
    $text = Convert-InstructionContent $text $Framework
    try {
      Set-Content -LiteralPath $target -Value $text -NoNewline
    } catch {
      if ((Test-Path -LiteralPath $target -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $target) -eq $text)) {
        return [pscustomobject]@{ Status = "unchanged"; Detail = "locked identical file"; Target = $target }
      }
      throw
    }
  } else {
    try {
      Copy-Item -LiteralPath $source -Destination $target -Force
    } catch {
      if (Test-SameFileContent $source $target) {
        return [pscustomobject]@{ Status = "unchanged"; Detail = "locked identical file"; Target = $target }
      }
      throw
    }
  }

  if ($Framework -eq "codex" -and $Entry.mirrorToCodexAgentsSkills -and $targetRel.StartsWith("skills\")) {
    $skillName = Split-Path -Leaf $targetRel
    $agentsSkillRoot = if ($AgentsSkillsRoot) { Resolve-AbsolutePath $AgentsSkillsRoot } else { Join-Path $EffectiveHome ".agents\skills" }
    $agentsTarget = Join-Path $agentsSkillRoot $skillName
    Backup-Existing $InstallRoot $agentsTarget $BackupRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $agentsSkillRoot | Out-Null
    Update-DirectoryTarget $agentsSkillRoot $agentsTarget $source | Out-Null
  }

  $detail = if ($backup) { "backup: $backup" } else { "new file/dir" }
  return [pscustomobject]@{ Status = "updated"; Detail = $detail; Target = $target }
}

function Verify-Install([string]$InstallRoot, [string]$Framework) {
  $paiDir = Join-Path $InstallRoot "PAI"
  $latestPath = Join-Path $paiDir "ALGORITHM\LATEST"
  if (Test-Path -LiteralPath $latestPath) {
    $latest = (Get-Content -Raw -LiteralPath $latestPath).Trim()
    $normalized = if ($latest.StartsWith("v")) { $latest } else { "v$latest" }
    $algoPath = Join-Path $paiDir "ALGORITHM\$normalized.md"
    if (-not (Test-Path -LiteralPath $algoPath)) { throw "Algorithm path does not resolve: $algoPath" }
    Success "Algorithm path resolves: $algoPath"
  }

  $instruction = if ($Framework -eq "claude") { Join-Path $InstallRoot "CLAUDE.md" } else { Join-Path $InstallRoot "AGENTS.md" }
  if (Test-Path -LiteralPath $instruction) {
    $text = Get-Content -Raw -LiteralPath $instruction
    if ($text -notmatch '\$PAI_DIR/ALGORITHM/LATEST') {
      if ($Framework -eq "codex") {
        throw "Instruction file does not mention `$PAI_DIR/ALGORITHM/LATEST: $instruction"
      }
      Warn "Instruction file does not mention `$PAI_DIR/ALGORITHM/LATEST: $instruction"
    } else {
      Success "Instruction file points at `$PAI_DIR/ALGORITHM/LATEST."
    }
  }
}

function Regenerate-CodexHooksJson([string]$InstallRoot, [string]$BackupRoot) {
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "Bun is required to regenerate Codex hooks.json after hotfix update."
  }

  $scriptPath = Join-Path $BackupRoot "regenerate-codex-hooks.ts"
  $script = @'
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const dataDir = process.argv[3];
const configDir = process.argv[4];

if (!root || !dataDir || !configDir) {
  console.error("Usage: regenerate-codex-hooks.ts <install-root> <data-dir> <config-dir>");
  process.exit(1);
}

const { generateCodexHooksJson } = await import(pathToFileURL(join(root, "PAI", "PAI-Install", "engine", "config-gen.ts")).href);
const config = {
  framework: "codex",
  principalName: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  aiName: "PAI",
  catchphrase: "",
  paiDir: root,
  configDir,
  dataDir,
};

await Bun.write(join(root, "hooks.json"), `${JSON.stringify(generateCodexHooksJson(config), null, 2)}\n`);
'@
  Set-Content -LiteralPath $scriptPath -Value $script -NoNewline

  $dataDir = Resolve-PaiDataDir
  $configDir = Resolve-PaiConfigDir

  Push-Location $InstallRoot
  try {
    & bun $scriptPath $InstallRoot $dataDir $configDir | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Codex hooks.json regeneration failed" }
  } finally {
    Pop-Location
  }
  Success "Regenerated Codex hooks.json from installed generator."
}

function Migrate-ClaudeSessionEndLifecycle([string]$InstallRoot, [string]$BackupRoot) {
  $settings = Join-Path $InstallRoot "settings.json"
  if (-not (Test-Path -LiteralPath $settings)) { Info "No settings.json to migrate: $settings"; return }
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Warn "Bun not found; skipping SessionEnd lifecycle migration."; return }
  $migrator = Join-Path $InstallRoot "PAI\TOOLS\SessionEndLifecycleMigrate.ts"
  if (-not (Test-Path -LiteralPath $migrator)) { Warn "SessionEnd migrator not found: $migrator"; return }
  Backup-Existing $InstallRoot $settings $BackupRoot | Out-Null
  & bun $migrator --settings $settings | Out-Host
  if ($LASTEXITCODE -ne 0) { Warn "SessionEnd lifecycle migration reported an error (left settings unchanged)." }
  else { Success "SessionEnd lifecycle migration complete." }
}

function Remove-StaleCodexHookRunner([string]$InstallRoot, [string]$BackupRoot) {
  $staleRunner = Join-Path $InstallRoot "hooks\CodexHookRunner.cmd"
  if (-not (Test-Path -LiteralPath $staleRunner)) { return }
  Backup-Existing $InstallRoot $staleRunner $BackupRoot | Out-Null
  Remove-Item -LiteralPath $staleRunner -Force
  Success "Removed stale CodexHookRunner.cmd wrapper."
}

function Invoke-WithTemporaryEnvironment($Values, [scriptblock]$Script) {
  $previous = @{}
  foreach ($key in $Values.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, [string]$Values[$key], "Process")
  }
  try {
    & $Script
  } finally {
    foreach ($key in $Values.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
  }
}

function Regenerate-OpenCodeNativeArtifacts([string]$InstallRoot, [string]$BackupRoot) {
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "Bun is required to regenerate OpenCode native artifacts after hotfix update."
  }

  $paiCli = Join-Path $InstallRoot "PAI\TOOLS\pai.ts"
  if (-not (Test-Path -LiteralPath $paiCli)) {
    throw "PAI CLI not found for OpenCode native regeneration: $paiCli"
  }

  Backup-Existing $InstallRoot (Join-Path $InstallRoot "opencode.json") $BackupRoot | Out-Null
  Backup-Existing $InstallRoot (Join-Path $InstallRoot "agents") $BackupRoot | Out-Null
  Backup-Existing $InstallRoot (Join-Path $InstallRoot "commands") $BackupRoot | Out-Null

  $dataDir = Resolve-PaiDataDir
  $configDir = Resolve-PaiConfigDir
  $envValues = @{
    HOME = $EffectiveHome
    USERPROFILE = $EffectiveHome
    OPENCODE_CONFIG_DIR = $InstallRoot
    PAI_DATA_DIR = $dataDir
    PAI_CONFIG_DIR = $configDir
    PAI_FRAMEWORK_DIR = $InstallRoot
    PAI_FRAMEWORK = "opencode"
    PAI_SKIP_USER_ENV_UPDATE = "1"
  }

  Push-Location $InstallRoot
  try {
    Invoke-WithTemporaryEnvironment $envValues {
      & bun $paiCli framework switch opencode | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "OpenCode native artifact regeneration failed" }
    }
  } finally {
    Pop-Location
  }
  Success "Regenerated OpenCode opencode.json, agents, and commands from installed PAI CLI."
}

function Get-PowerShellProfileCandidates {
  $items = @()
  if ($env:PAI_POWERSHELL_PROFILE) { $items += (Resolve-AbsolutePath $env:PAI_POWERSHELL_PROFILE) }
  if ($env:OneDrive) {
    $items += (Join-Path $env:OneDrive "Documents\PowerShell\profile.ps1")
    $items += (Join-Path $env:OneDrive "Documents\PowerShell\Microsoft.PowerShell_profile.ps1")
    $items += (Join-Path $env:OneDrive "Documents\WindowsPowerShell\profile.ps1")
    $items += (Join-Path $env:OneDrive "Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1")
  }
  $items += (Join-Path $EffectiveHome "Documents\PowerShell\profile.ps1")
  $items += (Join-Path $EffectiveHome "Documents\PowerShell\Microsoft.PowerShell_profile.ps1")
  $items += (Join-Path $EffectiveHome "Documents\WindowsPowerShell\profile.ps1")
  $items += (Join-Path $EffectiveHome "Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1")
  $items | Where-Object { $_ } | Select-Object -Unique
}

function Get-PaiPowerShellBlock([string]$InstallRoot, [string]$Framework) {
  $dataDir = Resolve-PaiDataDir
  $paiDir = Join-Path $InstallRoot "PAI"
  $configDir = Resolve-PaiConfigDir
  $paiScript = Join-Path $paiDir "TOOLS\pai.ts"
  $qData = $dataDir.Replace("'", "''")
  $qRoot = $InstallRoot.Replace("'", "''")
  $qPai = $paiDir.Replace("'", "''")
  $qFramework = $Framework.Replace("'", "''")
  $qConfig = $configDir.Replace("'", "''")
  $qScript = $paiScript.Replace("'", "''")
@"
# PAI aliases
function Initialize-PAIEnvironment {
  `$defaultPaiDataDir = '$qData'
  if (-not `$env:PAI_DATA_DIR -or -not (Test-Path -LiteralPath (Join-Path `$env:PAI_DATA_DIR 'framework.json'))) { `$env:PAI_DATA_DIR = `$defaultPaiDataDir }
  `$stateUsable = `$false
  `$statePath = Join-Path `$env:PAI_DATA_DIR 'framework.json'
  if (Test-Path -LiteralPath `$statePath) {
    try {
      `$state = Get-Content -Raw -LiteralPath `$statePath | ConvertFrom-Json
      if (`$state.root) {
        `$stateRoot = [string]`$state.root
        if (Test-Path -LiteralPath `$stateRoot) {
          `$env:PAI_FRAMEWORK_DIR = `$stateRoot
          `$env:PAI_DIR = Join-Path `$env:PAI_FRAMEWORK_DIR 'PAI'
          `$stateUsable = `$true
        }
      }
      if (`$state.active) { `$env:PAI_FRAMEWORK = [string]`$state.active }
      if (`$state.dataDir -and `$stateUsable -and (Test-Path -LiteralPath ([string]`$state.dataDir))) { `$env:PAI_DATA_DIR = [string]`$state.dataDir }
    } catch {}
  }
  if (-not `$stateUsable -and (Test-Path -LiteralPath (Join-Path `$defaultPaiDataDir 'framework.json'))) { `$env:PAI_DATA_DIR = `$defaultPaiDataDir }
  if (-not `$env:PAI_FRAMEWORK_DIR -or -not (Test-Path -LiteralPath `$env:PAI_FRAMEWORK_DIR)) { `$env:PAI_FRAMEWORK_DIR = '$qRoot' }
  if (-not `$env:PAI_DIR -or -not (Test-Path -LiteralPath `$env:PAI_DIR)) { `$env:PAI_DIR = '$qPai' }
  if (-not `$env:PAI_FRAMEWORK) { `$env:PAI_FRAMEWORK = '$qFramework' }
  if (-not `$env:PAI_CONFIG_DIR -or -not (Test-Path -LiteralPath `$env:PAI_CONFIG_DIR)) { `$env:PAI_CONFIG_DIR = '$qConfig' }
  `$env:UAI_DIR = `$env:PAI_DIR
  `$env:UAI_DATA_DIR = `$env:PAI_DATA_DIR
  `$env:UAI_CONFIG_DIR = `$env:PAI_CONFIG_DIR
  `$env:UAI_FRAMEWORK_DIR = `$env:PAI_FRAMEWORK_DIR
  `$env:UAI_FRAMEWORK = `$env:PAI_FRAMEWORK
}
Initialize-PAIEnvironment
function Invoke-PAI {
  Initialize-PAIEnvironment
  bun '$qScript' @args
}
function pai {
  Invoke-PAI @args
}
function uai {
  Invoke-PAI @args
}
function k {
  Invoke-PAI @args
}
"@
}

function Repair-PowerShellProfiles([string]$InstallRoot, [string]$Framework, [string]$BackupRoot) {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { return }
  $block = Get-PaiPowerShellBlock $InstallRoot $Framework
  foreach ($profilePath in Get-PowerShellProfileCandidates) {
    if ($DryRun) {
      Info "DRY RUN repair PowerShell profile $profilePath"
      continue
    }
    if (Test-Path -LiteralPath $profilePath) {
      Backup-Existing $InstallRoot $profilePath $BackupRoot | Out-Null
      $content = Get-Content -Raw -LiteralPath $profilePath
      $content = $content -replace "(?ms)^# PAI aliases.*?(?=^# |\z)", ""
      $content = $content -replace "(?ms)^function Initialize-PAIEnvironment \{.*?^function k \{.*?^\}", ""
      $content = $content.TrimEnd() + "`n`n$block`n"
      Set-Content -LiteralPath $profilePath -Value $content -NoNewline
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profilePath) | Out-Null
      Set-Content -LiteralPath $profilePath -Value ($block + "`n") -NoNewline
    }
    Success "Repaired PowerShell PAI bootstrap: $profilePath"
  }
}

Write-Host ""
Write-Host "PAI | Installed Hotfix Updater" -ForegroundColor Cyan
Write-Host ""

$target = Resolve-Target
Info "Framework: $($target.Framework)"
Info "Install root: $($target.Root)"

$fetched = Get-ReleaseRoot
$releaseRoot = $fetched.Root
Info "Release root: $releaseRoot"

try {
  $manifestFile = if ($ManifestPath) { Resolve-AbsolutePath $ManifestPath } else { Join-Path $releaseRoot "hotfix-manifest.json" }
  if (-not (Test-Path -LiteralPath $manifestFile)) { throw "Manifest not found: $manifestFile" }
  $manifest = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
  Info "Manifest: $manifestFile"

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupRoot = Join-Path $EffectiveHome ".pai\BACKUPS\hotfix-$stamp"
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    Info "Backups: $backupRoot"
  }

  $results = @()
  foreach ($entry in $manifest.entries) {
    $results += Apply-Entry $entry $releaseRoot $target.Root $target.Framework $backupRoot
  }

  foreach ($result in $results) {
    if ($result.Status -eq "updated") { Success "$($result.Target) ($($result.Detail))" }
    elseif ($result.Status -eq "dry-run") { Info "DRY RUN $($result.Detail)" }
    else { Warn "$($result.Status): $($result.Detail)" }
  }

  if (-not $DryRun) {
    Remove-StaleCodexHookRunner $target.Root $backupRoot
    if ($target.Framework -eq "codex") {
      Regenerate-CodexHooksJson $target.Root $backupRoot
    } elseif ($target.Framework -eq "opencode") {
      Regenerate-OpenCodeNativeArtifacts $target.Root $backupRoot
    } elseif ($target.Framework -eq "claude") {
      Migrate-ClaudeSessionEndLifecycle $target.Root $backupRoot
    }
    Write-PaiFrameworkState $target.Root $target.Framework
    Set-PaiUserEnvironment $target.Root $target.Framework
    Repair-PowerShellProfiles $target.Root $target.Framework $backupRoot
    Verify-Install $target.Root $target.Framework
    Success "Hotfix update complete. Restart the agent session so instructions reload."
  } else {
    Info "Dry run complete. No files changed."
  }
} finally {
  if ($fetched.Temp -and -not $KeepTemp) {
    $resolved = [System.IO.Path]::GetFullPath($fetched.Temp)
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolved.StartsWith($tempRoot) -and (Split-Path -Leaf $resolved).StartsWith("pai-hotfix-")) {
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
  } elseif ($fetched.Temp) {
    Info "Kept temp checkout: $($fetched.Temp)"
  }
}
