param(
  [ValidateSet("start", "stop", "restart", "status", "install", "uninstall")]
  [string]$Command = "status"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PaiDir = if ($env:PAI_DIR) { $env:PAI_DIR } else { Split-Path -Parent $ScriptDir }
$FrameworkDir = if ($env:PAI_FRAMEWORK_DIR) { $env:PAI_FRAMEWORK_DIR } else { Split-Path -Parent $PaiDir }
$PaiDataDir = if ($env:PAI_DATA_DIR) { $env:PAI_DATA_DIR } else { Join-Path $HOME ".pai" }
$PulseDir = Join-Path $PaiDir "PULSE"
$StateDir = Join-Path $PulseDir "state"
$LogsDir = Join-Path $PulseDir "logs"
$PidFile = Join-Path $StateDir "pulse.pid"
$StdoutLog = Join-Path $LogsDir "pulse-stdout.log"
$StderrLog = Join-Path $LogsDir "pulse-stderr.log"
$TaskName = "PAI Pulse"

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

function Ensure-PulseDeps {
  $packageJson = Join-Path $PulseDir "package.json"
  if (-not (Test-Path -LiteralPath $packageJson)) { return }
  $bun = Get-BunPath
  $previous = Get-Location
  try {
    Set-Location -LiteralPath $PulseDir
    & $bun install
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Pulse dependency install failed with exit code $LASTEXITCODE; continuing with core modules"
    }
  } finally {
    Set-Location $previous
  }
}

function Test-PulseHttp {
  try {
    $res = Invoke-WebRequest -Uri "http://127.0.0.1:31337/healthz" -Method GET -UseBasicParsing -TimeoutSec 2
    return ($res.StatusCode -ge 200 -and $res.StatusCode -lt 500)
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
    Write-Host "PAI Pulse already running on port 31337"
    return $true
  }

  $existing = Get-PulseProcess
  if ($existing) {
    Write-Host "PAI Pulse process exists but health check is not ready (PID $($existing.Id))"
  }

  $env:PAI_DIR = $PaiDir
  $env:PAI_FRAMEWORK_DIR = $FrameworkDir
  $env:PAI_DATA_DIR = $PaiDataDir
  if (-not $env:PAI_FRAMEWORK) { $env:PAI_FRAMEWORK = "codex" }

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
    Write-Host "PAI Pulse started on port 31337 (PID $($proc.Id))"
    return $true
  }

  Write-Host "PAI Pulse was launched but did not respond on port 31337. Check $StderrLog"
  return $false
}

function Stop-Pulse {
  $proc = Get-PulseProcess
  if ($proc) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Host "PAI Pulse stopped (PID $($proc.Id))"
  } else {
    Write-Host "PAI Pulse stopped"
  }
  if (Test-Path -LiteralPath $PidFile) {
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  }
}

function Install-PulseTask {
  Ensure-Dirs
  $script = $MyInvocation.MyCommand.Path
  $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" start"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 365)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "PAI Pulse scheduled task installed"
}

function Uninstall-PulseTask {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "PAI Pulse scheduled task removed"
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
      Write-Host "PAI Pulse: RUNNING ($pidText, port 31337)"
      exit 0
    }
    if ($proc) {
      Write-Host "PAI Pulse: STARTING_OR_UNHEALTHY (PID $($proc.Id))"
      exit 1
    }
    Write-Host "PAI Pulse: NOT RUNNING"
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
        Write-Host "PAI Pulse installed and running"
      } else {
        Write-Host "PAI Pulse running for this session; scheduled startup was not installed"
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
