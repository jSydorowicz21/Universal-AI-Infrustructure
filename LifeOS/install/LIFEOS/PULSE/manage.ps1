param(
  [ValidateSet("start", "stop", "restart", "status", "install", "uninstall")]
  [string]$Command = "status"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstalledLifeosDir = Split-Path -Parent $ScriptDir

if ($env:LIFEOS_CONFIG_ROOT) {
  $ConfigRoot = $env:LIFEOS_CONFIG_ROOT
} elseif ($env:CLAUDE_CONFIG_DIR) {
  $ConfigRoot = $env:CLAUDE_CONFIG_DIR
} elseif ($env:LIFEOS_DIR) {
  $ConfigRoot = Split-Path -Parent $env:LIFEOS_DIR
} else {
  $ConfigRoot = Split-Path -Parent $InstalledLifeosDir
}

$LifeosDir = if ($env:LIFEOS_DIR) {
  $env:LIFEOS_DIR
} elseif ($env:LIFEOS_CONFIG_ROOT -or $env:CLAUDE_CONFIG_DIR) {
  Join-Path $ConfigRoot "LIFEOS"
} else {
  $InstalledLifeosDir
}
$PulseDir = Join-Path $LifeosDir "PULSE"
$StateDir = Join-Path $PulseDir "state"
$LogsDir = Join-Path $PulseDir "logs"
$PidFile = Join-Path $StateDir "pulse.pid"
$StdoutLog = Join-Path $LogsDir "pulse-stdout.log"
$StderrLog = Join-Path $LogsDir "pulse-stderr.log"
$TaskName = "LifeOS Pulse"

function Ensure-Dirs {
  New-Item -ItemType Directory -Force -Path $StateDir, $LogsDir | Out-Null
}

function Get-BunPath {
  $candidateRoots = @(
    $env:BUN_INSTALL,
    (Join-Path $HOME ".bun"),
    (Join-Path $env:APPDATA "npm\node_modules\bun"),
    (Join-Path $env:LOCALAPPDATA "bun")
  ) | Where-Object { $_ }

  foreach ($root in $candidateRoots) {
    $candidate = Join-Path $root "bin\bun.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  $cmd = Get-Command bun.exe -CommandType Application -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $cmd = Get-Command bun.cmd -CommandType Application -ErrorAction SilentlyContinue
  }
  if (-not $cmd) {
    $cmd = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
  }
  if (-not $cmd) { throw "bun is not on PATH" }
  return $cmd.Source
}

function Get-PulseProcess {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  $raw = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if (-not ($raw -match '^\d+$')) { return $null }
  return Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
}

function Invoke-BunStep {
  param([string]$WorkingDirectory, [string[]]$Arguments, [string]$Label)
  $bun = Get-BunPath
  $previous = Get-Location
  try {
    Set-Location -LiteralPath $WorkingDirectory
    & $bun @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
  } finally {
    Set-Location $previous
  }
}

function Ensure-PulseDeps {
  $packageJson = Join-Path $PulseDir "package.json"
  if (-not (Test-Path -LiteralPath $packageJson)) {
    throw "Pulse package.json is missing at $packageJson"
  }
  Invoke-BunStep -WorkingDirectory $PulseDir -Arguments @("install", "--frozen-lockfile") -Label "Pulse dependency install"

  $dashboard = Join-Path $PulseDir "Observability"
  if (Test-Path -LiteralPath (Join-Path $dashboard "package.json")) {
    Invoke-BunStep -WorkingDirectory $dashboard -Arguments @("install", "--frozen-lockfile") -Label "Pulse dashboard dependency install"
    Invoke-BunStep -WorkingDirectory $dashboard -Arguments @("run", "build") -Label "Pulse dashboard build"
  }
}

function Test-PulseHttp {
  try {
    $res = Invoke-WebRequest -Uri "http://127.0.0.1:31337/healthz" -Method GET -UseBasicParsing -TimeoutSec 2
    return ($res.StatusCode -ge 200 -and $res.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Wait-Pulse {
  param([int]$Seconds = 15)
  for ($i = 0; $i -lt ($Seconds * 2); $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-PulseHttp) { return $true }
  }
  return $false
}

function Start-Pulse {
  Ensure-Dirs
  Ensure-PulseDeps
  if (Test-PulseHttp) {
    Write-Host "LifeOS Pulse already running on port 31337"
    return $true
  }

  $existing = Get-PulseProcess
  if ($existing) {
    Write-Host "LifeOS Pulse process exists but health check is not ready (PID $($existing.Id))"
  }

  $env:LIFEOS_CONFIG_ROOT = $ConfigRoot
  $env:LIFEOS_DIR = $LifeosDir

  $bun = Get-BunPath
  if ($bun.ToLowerInvariant().EndsWith(".cmd")) {
    $filePath = "cmd.exe"
    $arguments = @("/d", "/c", "`"$bun`" run pulse.ts")
  } else {
    $filePath = $bun
    $arguments = @("run", "pulse.ts")
  }

  $proc = Start-Process `
    -FilePath $filePath `
    -ArgumentList $arguments `
    -WorkingDirectory $PulseDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -PassThru
  Set-Content -LiteralPath $PidFile -Value $proc.Id

  if (Wait-Pulse 20) {
    Write-Host "LifeOS Pulse started on port 31337 (PID $($proc.Id))"
    return $true
  }

  Write-Host "LifeOS Pulse was launched but did not respond on port 31337. Check $StderrLog"
  return $false
}

function Stop-Pulse {
  $proc = Get-PulseProcess
  if ($proc) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Host "LifeOS Pulse stopped (PID $($proc.Id))"
  } else {
    Write-Host "LifeOS Pulse stopped"
  }
  if (Test-Path -LiteralPath $PidFile) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  }
}

function Install-PulseTask {
  Ensure-Dirs
  $script = Join-Path $PulseDir "manage.ps1"
  $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" start"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 365)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "LifeOS Pulse scheduled task installed"
}

function Uninstall-PulseTask {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "LifeOS Pulse scheduled task removed"
  }
}

switch ($Command) {
  "start" {
    if (Start-Pulse) { exit 0 }
    exit 1
  }
  "stop" {
    Stop-Pulse
  }
  "restart" {
    Stop-Pulse
    if (Start-Pulse) { exit 0 }
    exit 1
  }
  "status" {
    $proc = Get-PulseProcess
    if (Test-PulseHttp) {
      $pidText = if ($proc) { "PID $($proc.Id)" } else { "PID unknown" }
      Write-Host "LifeOS Pulse: RUNNING ($pidText, port 31337)"
      exit 0
    }
    if ($proc) {
      Write-Host "LifeOS Pulse: STARTING_OR_UNHEALTHY (PID $($proc.Id))"
      exit 1
    }
    Write-Host "LifeOS Pulse: NOT RUNNING"
    exit 1
  }
  "install" {
    $taskInstalled = $true
    try {
      Install-PulseTask
    } catch {
      $taskInstalled = $false
      Write-Host "Could not install scheduled task: $($_.Exception.Message)"
    }

    $started = Start-Pulse
    if ($started) {
      if ($taskInstalled) {
        Write-Host "LifeOS Pulse installed and running"
      } else {
        Write-Host "LifeOS Pulse running for this session; scheduled startup was not installed"
      }
      exit 0
    }
    exit 1
  }
  "uninstall" {
    Uninstall-PulseTask
    Stop-Pulse
  }
}
