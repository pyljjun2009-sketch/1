# One-click switch to latest build + cleanup old temp version
# Usage: Close the OLD "DeepSeek Harness Desktop" window first, then run this script.
#   Right-click -> Run with PowerShell; or  powershell -ExecutionPolicy Bypass -File this-script

$ErrorActionPreference = 'Continue'
$oldDir = "$env:LOCALAPPDATA\Temp\dsh-install-test"
$newDir = "$env:LOCALAPPDATA\dsh-desktop-build\win-unpacked"
$lnkPath = "$env:USERPROFILE\Desktop\DeepSeek Harness Desktop.lnk"

Write-Host "=== DSH Desktop switch & cleanup ===" -ForegroundColor Cyan

# 1. Check if OLD version is still running (never auto-kill)
Write-Host "`n[1/4] Check old version process..." -ForegroundColor Yellow
$oldProcs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'DeepSeek Harness Desktop.exe' -and $_.ExecutablePath -like '*dsh-install-test*'
}
if ($oldProcs) {
  Write-Host "  OLD version still running (PID: $($oldProcs.ProcessId -join ', '))" -ForegroundColor Red
  Write-Host "  Please CLOSE the old window normally, then re-run this script." -ForegroundColor Red
  Write-Host "  Do NOT force-kill; it may affect other services." -ForegroundColor Yellow
  exit 1
} else {
  Write-Host "  No old version running" -ForegroundColor Green
}

# 2. Delete temp directory
Write-Host "`n[2/4] Delete old temp directory..." -ForegroundColor Yellow
if (Test-Path $oldDir) {
  try { Remove-Item $oldDir -Recurse -Force -ErrorAction Stop; Write-Host "  Deleted: $oldDir" -ForegroundColor Green }
  catch { Write-Host "  Delete failed (files in use): $($_.Exception.Message)" -ForegroundColor Red }
} else {
  Write-Host "  Temp directory already gone" -ForegroundColor Green
}

# 3. Verify latest build exists
Write-Host "`n[3/4] Verify latest build..." -ForegroundColor Yellow
if (Test-Path "$newDir\DeepSeek Harness Desktop.exe") {
  $ver = (Get-Item "$newDir\DeepSeek Harness Desktop.exe").LastWriteTime
  Write-Host "  Latest build exists: $newDir" -ForegroundColor Green
  Write-Host "  Build time: $ver"
} else {
  Write-Host "  Latest build MISSING! Run first: npm run dist" -ForegroundColor Red
}

# 4. Ensure desktop shortcut points to latest
Write-Host "`n[4/4] Ensure desktop shortcut..." -ForegroundColor Yellow
if (Test-Path "$newDir\DeepSeek Harness Desktop.exe") {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = "$newDir\DeepSeek Harness Desktop.exe"
  $lnk.WorkingDirectory = $newDir
  $lnk.Description = "DeepSeek Harness Desktop (latest)"
  $lnk.Save()
  Write-Host "  Shortcut -> latest: $lnkPath" -ForegroundColor Green
}

Write-Host "`n=== Done. Double-click desktop 'DeepSeek Harness Desktop' to start latest ===" -ForegroundColor Cyan
