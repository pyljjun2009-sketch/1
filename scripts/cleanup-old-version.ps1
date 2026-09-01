# 一键切换最新版 + 清理旧临时版本（A/B 双目录版）
# 用法：先正常关闭旧的 "DeepSeek Harness Desktop" 窗口，再运行本脚本：
#   右键 -> 使用 PowerShell 运行；或  powershell -ExecutionPolicy Bypass -File 本脚本
#
# 说明：构建体系为 %LOCALAPPDATA%\dsh-desktop-build-a / -b 双目录交替，
#       current.txt 记录当前最新构建目录（由 scripts/build.js 维护）。

$ErrorActionPreference = 'Continue'
$base = Join-Path $env:LOCALAPPDATA 'dsh-desktop-build'
$currentFile = Join-Path $base 'current.txt'
$lnkName = 'DeepSeek Harness Desktop.lnk'
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop $lnkName

Write-Host "=== DSH Desktop switch & cleanup (A/B builds) ===" -ForegroundColor Cyan

# 1. 检查是否有任意构建目录的实例仍在运行（绝不自动杀）
Write-Host "`n[1/5] Check running instances..." -ForegroundColor Yellow
$running = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'DeepSeek Harness Desktop.exe' -and $_.ExecutablePath -like "$base*"
}
if ($running) {
  Write-Host "  Still running (PID: $($running.ProcessId -join ', ')):" -ForegroundColor Red
  $running | ForEach-Object { Write-Host "    $($_.ExecutablePath)" -ForegroundColor Red }
  Write-Host "  Please CLOSE the app window normally, then re-run this script." -ForegroundColor Yellow
  Write-Host "  Do NOT force-kill; it hosts the dsh web backend of this session." -ForegroundColor Yellow
  exit 1
} else {
  Write-Host "  No instance running" -ForegroundColor Green
}

# 2. 确定最新构建目录：优先 current.txt，其次选 exe 更新者
Write-Host "`n[2/5] Locate latest build..." -ForegroundColor Yellow
$newDir = $null
if (Test-Path $currentFile) {
  $cand = (Get-Content $currentFile -Raw).Trim()
  if (Test-Path (Join-Path $cand "win-unpacked\DeepSeek Harness Desktop.exe")) {
    $newDir = $cand
  }
}
if (-not $newDir) {
  $cands = @("$base-a", "$base-b") | Where-Object {
    Test-Path (Join-Path $_ "win-unpacked\DeepSeek Harness Desktop.exe")
  }
  if ($cands.Count -gt 0) {
    $newDir = $cands | Sort-Object { (Get-Item (Join-Path $_ "win-unpacked\DeepSeek Harness Desktop.exe")).LastWriteTime } -Descending | Select-Object -First 1
  }
}
if (-not $newDir) {
  Write-Host "  No build found under $base-a / $base-b. Run first: npm run pack" -ForegroundColor Red
  exit 1
}
$newUnpacked = Join-Path $newDir 'win-unpacked'
$newExe = Join-Path $newUnpacked 'DeepSeek Harness Desktop.exe'
$ver = (Get-Item $newExe).LastWriteTime
Write-Host "  Latest build: $newExe" -ForegroundColor Green
Write-Host "  Build time : $ver"

# 3. 清理旧的临时构建目录（Temp 下 dsh-* 开头的旧产物，非正在运行的）
Write-Host "`n[3/5] Clean old temp builds..." -ForegroundColor Yellow
$tmpOld = @(
  (Join-Path $env:LOCALAPPDATA 'Temp\dsh-install-test'),
  (Join-Path $env:LOCALAPPDATA 'Temp\dsh-desktop-startup-fix-*')
)
foreach ($pat in $tmpOld) {
  $hits = Get-ChildItem (Split-Path $pat) -Directory -Filter (Split-Path $pat -Leaf) -ErrorAction SilentlyContinue
  foreach ($h in $hits) {
    $inUse = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$($h.FullName)*" }
    if ($inUse) { Write-Host "  Skip (in use): $($h.FullName)" -ForegroundColor Yellow; continue }
    try { Remove-Item $h.FullName -Recurse -Force -ErrorAction Stop; Write-Host "  Deleted: $($h.FullName)" -ForegroundColor Green }
    catch { Write-Host "  Delete failed: $($_.Exception.Message)" -ForegroundColor Red }
  }
}

# 4. 删除非当前构建目录（另一个 A/B 目录）中未被占用的旧构建，释放空间
Write-Host "`n[4/5] Prune stale A/B sibling..." -ForegroundColor Yellow
foreach ($c in @("$base-a", "$base-b")) {
  if ($c -eq $newDir) { continue }
  if (-not (Test-Path (Join-Path $c 'win-unpacked'))) { continue }
  $inUse = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$c*" }
  if ($inUse) { Write-Host "  Keep (in use): $c" -ForegroundColor Yellow; continue }
  try { Remove-Item $c -Recurse -Force -ErrorAction Stop; Write-Host "  Pruned: $c" -ForegroundColor Green }
  catch { Write-Host "  Prune failed: $($_.Exception.Message)" -ForegroundColor Red }
}

# 5. 确保桌面快捷方式指向最新构建
Write-Host "`n[5/5] Ensure desktop shortcut..." -ForegroundColor Yellow
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $newExe
$lnk.WorkingDirectory = $newUnpacked
$lnk.Description = "DeepSeek Harness Desktop (latest)"
$lnk.Save()
Write-Host "  Shortcut -> $newExe" -ForegroundColor Green

Write-Host "`n=== Done. Double-click desktop 'DeepSeek Harness Desktop' to start latest ===" -ForegroundColor Cyan
