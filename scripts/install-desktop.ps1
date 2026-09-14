# One-shot installer script: install the built DSH Desktop (v0.1.2 NSIS) and start installed app.
#
# Why delayed + detached: the current chat session's dsh web backend is hosted by the
# RUNNING dev instance (project artifacts\win-unpacked). Installing requires that instance
# to be stopped, which drops the chat UI. This script therefore runs as an independent
# process (detached from the caller's tree) and waits START_DELAY_SEC first, so the
# explanation message is delivered before the session ends.
#
# Run manually if needed:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-desktop.ps1

$ErrorActionPreference = 'Continue'
$LOG = 'D:\AI\DSHarness\install-desktop.log'
$INSTALLER = 'D:\AI\DSHarness\release\DeepSeek-Harness-Desktop-0.1.2-x64.exe'
$INSTALL_DIR = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness Desktop'
$INSTALLED_EXE = Join-Path $INSTALL_DIR 'DeepSeek Harness Desktop.exe'
$START_DELAY_SEC = 15

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $LOG -Value $line -Encoding UTF8 } catch { }
}

Write-Log '=== DSH Desktop install start (v0.1.2 NSIS) ==='

if (-not (Test-Path $INSTALLER)) {
  Write-Log ("FATAL: installer not found: {0}" -f $INSTALLER)
  exit 1
}
Write-Log ("installer: {0} ({1:N1} MB)" -f $INSTALLER, ((Get-Item $INSTALLER).Length / 1MB))

Write-Log ("waiting {0}s for the chat message to arrive..." -f $START_DELAY_SEC)
Start-Sleep -Seconds $START_DELAY_SEC

# ---- 1. stop running instances (dev instance hosts the current session's backend) ----
Write-Log '[1/5] stopping running instances...'
$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'DeepSeek Harness Desktop.exe' })
if ($procs.Count -eq 0) {
  Write-Log '  no running instance'
} else {
  foreach ($p in $procs) {
    Write-Log ("  killing PID {0} ({1})" -f $p.ProcessId, (Split-Path $p.ExecutablePath -Parent))
    try { & taskkill.exe /pid $p.ProcessId /T /F 2>&1 | Out-Null } catch { }
  }
  for ($i = 0; $i -lt 30; $i++) {
    $left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'DeepSeek Harness Desktop.exe' })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Seconds 1
  }
  $left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'DeepSeek Harness Desktop.exe' })
  if ($left.Count -eq 0) { Write-Log '  all instances stopped' } else { Write-Log ("  WARN: {0} process(es) still alive" -f $left.Count) }
}

# ---- 2. silent install (NSIS /S; per-user install, no admin needed) ----
Write-Log '[2/5] installing silently (/S)...'
try {
  $inst = Start-Process -FilePath $INSTALLER -ArgumentList '/S' -PassThru -Wait
  Write-Log ("  installer exit code: {0}" -f $inst.ExitCode)
} catch {
  Write-Log ("  install failed: {0}" -f $_.Exception.Message)
}
Start-Sleep -Seconds 5

# ---- 3. verify installation ----
Write-Log '[3/5] verifying installation...'
$ok = Test-Path $INSTALLED_EXE
if ($ok) {
  $ver = (Get-Item $INSTALLED_EXE).VersionInfo
  Write-Log ("  installed: {0}" -f $INSTALLED_EXE)
  Write-Log ("  file version: {0}" -f $ver.FileVersion)
  $verJson = Join-Path $INSTALL_DIR 'resources\app-update.yml'
  Write-Log ("  app-update.yml present: {0}" -f (Test-Path $verJson))
} else {
  Write-Log ("  WARN: installed exe not found at expected path: {0}" -f $INSTALLED_EXE)
  # try common alternative
  $alt = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Recurse -Filter 'DeepSeek Harness Desktop.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($alt) { Write-Log ("  found alternative: {0}" -f $alt.FullName); $INSTALLED_EXE = $alt.FullName; $ok = $true }
}

# ---- 4. start installed app ----
Write-Log '[4/5] starting installed app...'
if ($ok -and (Test-Path $INSTALLED_EXE)) {
  try {
    Start-Process -FilePath $INSTALLED_EXE
    Write-Log ("  started: {0}" -f $INSTALLED_EXE)
    Start-Sleep -Seconds 8
    $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -like "$INSTALL_DIR*" })
    Write-Log ("  installed instance process count: {0}" -f $running.Count)
  } catch {
    Write-Log ("  start failed: {0}" -f $_.Exception.Message)
  }
} else {
  Write-Log '  skipped (installation not verified)'
}

# ---- 5. report shortcuts ----
Write-Log '[5/5] checking shortcuts...'
try {
  $ws = New-Object -ComObject WScript.Shell
  foreach ($p in @(
      (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness Desktop.lnk'),
      (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk')
    )) {
    if (Test-Path $p) {
      $t = $ws.CreateShortcut($p).TargetPath
      Write-Log ("  {0} -> {1}" -f (Split-Path $p -Leaf), $t)
    } else {
      Write-Log ("  {0}: not found" -f (Split-Path $p -Leaf))
    }
  }
} catch {
  Write-Log ("  shortcut check failed: {0}" -f $_.Exception.Message)
}

Write-Log '=== install done. Use the installed app window to continue (old dev instance exited) ==='
Start-Sleep -Seconds 3
