# One-shot switch script: stop OLD instance (D:\AI\DSH) -> clean old dir -> start NEW instance (D:\AI\DSHarness)
#
# Why: the current session's dsh web backend is hosted by the OLD instance
#      (D:\AI\DSH\artifacts\...). Stopping it drops the chat UI.
#      This script therefore runs as an independent process (detached from the
#      caller's process tree) and waits START_DELAY_SEC before acting, so the
#      explanation message is delivered first.
#
# Run manually if needed:
#   powershell -NoProfile -ExecutionPolicy Bypass -File switch-to-new-instance.ps1

$ErrorActionPreference = 'Continue'
$LOG = 'D:\AI\DSHarness\switch-to-new-instance.log'
$OLD_ROOT = 'D:\AI\DSH'
$NEW_EXE = 'D:\AI\DSHarness\artifacts\dsh-desktop-build-a\win-unpacked\DeepSeek Harness Desktop.exe'
$START_DELAY_SEC = 15

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $LOG -Value $line -Encoding UTF8 } catch { }
}

Write-Log '=== switch start (old instance -> new) ==='
Write-Log ("waiting {0}s for the chat message to arrive..." -f $START_DELAY_SEC)
Start-Sleep -Seconds $START_DELAY_SEC

# ---- 1. stop OLD instance (whole tree, including its dsh web backend) ----
Write-Log '[1/4] stopping old instance...'
$oldProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'DeepSeek Harness Desktop.exe' -and $_.ExecutablePath -like "$OLD_ROOT*" })
if ($oldProcs.Count -eq 0) {
  Write-Log '  no running old instance found'
} else {
  foreach ($p in $oldProcs) {
    Write-Log ("  killing PID {0}" -f $p.ProcessId)
    try { & taskkill.exe /pid $p.ProcessId /T /F 2>&1 | Out-Null } catch { }
  }
  $gone = $false
  for ($i = 0; $i -lt 30; $i++) {
    $left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -like "$OLD_ROOT*" })
    if ($left.Count -eq 0) { $gone = $true; break }
    Start-Sleep -Seconds 1
  }
  if ($gone) { Write-Log '  old instance fully stopped' }
  else { Write-Log '  WARN: some old processes still alive' }
}

# ---- 2. delete OLD directory (retry: file handles release with a delay) ----
Write-Log '[2/4] deleting old project directory...'
if (-not (Test-Path $OLD_ROOT)) {
  Write-Log '  old directory not present, skipped'
} else {
  for ($i = 1; $i -le 5; $i++) {
    try {
      Remove-Item $OLD_ROOT -Recurse -Force -ErrorAction Stop
      break
    } catch {
      Write-Log ("  delete attempt {0} failed: {1}" -f $i, $_.Exception.Message)
      Start-Sleep -Seconds 3
    }
  }
  if (Test-Path $OLD_ROOT) {
    Write-Log ("  WARN: could not fully delete {0} (files may be locked; delete manually later)" -f $OLD_ROOT)
  } else {
    Write-Log ("  old directory deleted: {0}" -f $OLD_ROOT)
  }
}

# ---- 3. start NEW instance ----
Write-Log '[3/4] starting new instance...'
if (Test-Path $NEW_EXE) {
  try {
    Start-Process -FilePath $NEW_EXE
    Write-Log ("  started: {0}" -f $NEW_EXE)
    Start-Sleep -Seconds 6
    $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -like 'D:\AI\DSHarness\artifacts*' })
    Write-Log ("  new instance process count: {0}" -f $running.Count)
  } catch {
    Write-Log ("  start failed: {0}" -f $_.Exception.Message)
  }
} else {
  Write-Log ("  NEW exe not found: {0}" -f $NEW_EXE)
}

# ---- 4. ensure desktop shortcut points to NEW ----
Write-Log '[4/4] ensuring desktop shortcut...'
try {
  $ws = New-Object -ComObject WScript.Shell
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnkPath = Join-Path $desktop 'DeepSeek Harness Desktop.lnk'
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = $NEW_EXE
  $lnk.WorkingDirectory = Split-Path $NEW_EXE -Parent
  $lnk.Save()
  Write-Log ("  shortcut -> {0}" -f $NEW_EXE)
} catch {
  Write-Log ("  shortcut update failed: {0}" -f $_.Exception.Message)
}

Write-Log '=== switch done. Use the NEW window to continue (the old Web UI exited with the old instance) ==='
Start-Sleep -Seconds 3
