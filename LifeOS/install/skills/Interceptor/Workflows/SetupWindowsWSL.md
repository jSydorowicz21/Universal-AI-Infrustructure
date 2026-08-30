# Windows + WSL Setup Workflow

## Voice Notification

```bash
curl -s -X POST http://localhost:31337/notify \
  -H "Content-Type: application/json" \
  -d '{"message": "Running the SetupWindowsWSL workflow in the Interceptor skill to configure Windows Chrome and WSL access"}' \
  > /dev/null 2>&1 &
```

Running **SetupWindowsWSL** in **Interceptor**...

---

Use this workflow when Interceptor must run against Windows Chrome/Brave while the agent runs from WSL. This is the preferred path for WSL users because it preserves the real Windows browser profile, cookies, sessions, and extension state instead of trying to copy encrypted Chrome data into Linux.

## When to Use

- User is on WSL and wants PAI/Codex to call `interceptor`.
- `interceptor` works in PowerShell but not in WSL.
- Chrome extension reports `Specified native messaging host not found`.
- Extension console shows `ws://localhost:19222/ ... ERR_CONNECTION_REFUSED`.
- Windows blocks the binary with Smart App Control or "Malicious binary reputation".
- User loaded the wrong folder and Chrome says `Manifest file is missing or unreadable`.

## 1. Install Windows CLI

The release `.exe` is a CLI/install surface, not a GUI app. Double-click may appear to do nothing. Run it from PowerShell:

```powershell
cd "$env:USERPROFILE\Downloads"
.\Interceptor-0.19.1-windows-x64.exe --version
```

Put it on the user PATH:

```powershell
mkdir "$env:USERPROFILE\bin" -Force
Copy-Item "$env:USERPROFILE\Downloads\Interceptor-0.19.1-windows-x64.exe" "$env:USERPROFILE\bin\interceptor.exe" -Force

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$binPath = "$env:USERPROFILE\bin"
if ($userPath -notlike "*$binPath*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$binPath", "User")
}
$env:Path += ";$env:USERPROFILE\bin"
```

Verify:

```powershell
interceptor --version
interceptor status
```

`daemon: not running` is normal before the first browser command.

## 2. Handle Smart App Control

If PowerShell reports:

```text
An Application Control policy has blocked this file. Malicious binary reputation
```

this is Windows Smart App Control / Application Control, not ordinary Defender quarantine. Defender exclusions and `Unblock-File` may not override it.

Practical resolution:

1. Open Windows Security:

   ```powershell
   Start-Process windowsdefender://appbrowser
   ```

2. Go to **App & browser control** -> **Smart App Control settings**.
3. Turn **Smart App Control** off.
4. Keep normal Microsoft Defender Antivirus and Firewall enabled.

Treat this as a real security tradeoff. Some Windows builds make Smart App Control hard to re-enable without reset/reinstall.

## 3. Build or Locate Extension Files

The macOS path `/Library/Application Support/Interceptor/extension/` is not valid on Windows.

For source builds, install prerequisites:

```powershell
winget install -e --id Git.Git
winget install -e --id Oven-sh.Bun
```

Then build:

```powershell
mkdir "$env:USERPROFILE\Projects" -Force
cd "$env:USERPROFILE\Projects"
git clone https://github.com/Hacker-Valley-Media/Interceptor.git
cd Interceptor
bun install
& "C:\Program Files\Git\bin\bash.exe" scripts/build.sh
```

Load this folder in `chrome://extensions` with Developer Mode enabled:

```text
C:\Users\<USER>\Projects\Interceptor\extension\dist
```

Do not load:

```text
C:\Users\<USER>\Projects\Interceptor\dist
```

That is CLI/build output. Chrome will report `Manifest file is missing or unreadable`.

## 4. Register Native Messaging on Windows

If the extension console says:

```text
native host disconnected: Specified native messaging host not found.
```

Chrome cannot find the native host `com.interceptor.host`.

Check registration:

```powershell
Get-ItemProperty "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host" -ErrorAction SilentlyContinue
```

If empty, create a Windows-specific native-host manifest. Git Bash may generate a bad Unix path like `/c/Users/.../interceptor-daemon`; Chrome on Windows needs a Windows `.exe` path.

```powershell
$manifest = "$env:USERPROFILE\Projects\Interceptor\daemon\.generated\com.interceptor.host.windows.json"
$daemon = "$env:USERPROFILE\Projects\Interceptor\daemon\interceptor-daemon.exe"

Test-Path $daemon

@{
  name = "com.interceptor.host"
  description = "Interceptor daemon bridge"
  path = $daemon
  type = "stdio"
  allowed_origins = @(
    "chrome-extension://hkjbaciefhhgekldhncknbjkofbpenng/",
    "chrome-extension://clcflogdlhfnlibdiahigikhpnlmhnpl/",
    "chrome-extension://icbmachoifbaiepkgmkdmiomnhmbgigi/"
  )
} | ConvertTo-Json -Depth 5 | Set-Content $manifest -Encoding ASCII
```

Set the actual default registry value. Use `Set-Item`; `Set-ItemProperty -Name "(default)"` can create the wrong value name.

```powershell
$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host"
New-Item -Path $key -Force
Set-Item -Path $key -Value $manifest
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.interceptor.host" /ve
```

Restart Chrome and reload the extension:

```powershell
taskkill /IM chrome.exe /F
Start-Process chrome.exe "chrome://extensions"
```

Then:

```powershell
interceptor open https://example.com
interceptor status --verbose
```

## 5. Interpret WebSocket Refused

This extension console error is secondary while the daemon/native host is not connected:

```text
WebSocket connection to 'ws://localhost:19222/' failed: net::ERR_CONNECTION_REFUSED
```

Fix native messaging first. Once `interceptor open` starts the daemon and the extension connects, `status --verbose` should report the daemon running and extension reachable.

## 6. Add WSL Shim

After Windows PowerShell works, expose that same binary to WSL:

```bash
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/interceptor" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

exec /mnt/c/Users/<USER>/bin/interceptor.exe "$@"
SH
chmod +x "$HOME/.local/bin/interceptor"
```

Replace `<USER>` with the Windows username, e.g. `hayde`.

Verify from WSL:

```bash
command -v interceptor
rtk which interceptor
interceptor --version
interceptor status --verbose
```

Expected healthy state:

```text
mode: browser-only
daemon: running
transport: tcp:127.0.0.1:19221
extension: reachable
```

## Notes

- Do not copy a Windows Chrome profile into Linux Chrome. Cookies and passwords are protected by Windows DPAPI and will not reliably decrypt in WSL/Linux.
- The WSL shim should call Windows Interceptor so PAI uses the same authenticated Windows Chrome session.
- For Brave, use the Brave native-host registry path and `brave://extensions`; for Chrome, use the Google Chrome path shown above.
