/**
 * electron-builder 包装：A/B 双目录交替构建，避免"运行中的 exe 占用导致 EBUSY"。
 *
 * 策略：
 *   - 两个构建目录：%LOCALAPPDATA%\dsh-desktop-build-a 和 -b
 *   - 构建前检查哪个目录的 win-unpacked exe 未被占用（或目录尚不存在），构建到空闲的那个
 *   - 构建后记录 current.txt（当前构建目录），并更新桌面快捷方式指向最新版
 *   - 运行中的实例在 A，构建到 B；下次运行 B（占用 B），构建回 A —— 永不冲突
 *
 * 用法：
 *   node scripts/build.js --win            # 等价 npm run dist
 *   node scripts/build.js --win portable
 *   node scripts/build.js --dir
 *
 * 可用 $DSH_DESKTOP_BUILD_DIR 显式指定单目录（跳过 A/B 逻辑）。
 */
const { spawnSync } = require("node:child_process");
const { existsSync, writeFileSync, openSync, closeSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const EXE_NAME = "DeepSeek Harness Desktop.exe";
const BASE = join(process.env.LOCALAPPDATA || os.tmpdir(), "dsh-desktop-build");
const BUILD_DIRS = [`${BASE}-a`, `${BASE}-b`];
const CURRENT_FILE = join(BASE, "current.txt");
const LNK_NAME = "DeepSeek Harness Desktop.lnk";

/** exe 是否被占用（尝试独占打开判断）。目录不存在视为空闲。 */
function isExeLocked(dir) {
  const exe = join(dir, "win-unpacked", EXE_NAME);
  if (!existsSync(exe)) return false;
  try {
    const fd = openSync(exe, "r+");
    closeSync(fd);
    return false;
  } catch {
    return true;
  }
}

/** 选择构建目录：优先未被占用的那个（A -> B）。 */
function pickOutputDir() {
  if (process.env.DSH_DESKTOP_BUILD_DIR) return process.env.DSH_DESKTOP_BUILD_DIR;

  const lockedA = isExeLocked(BUILD_DIRS[0]);
  const lockedB = isExeLocked(BUILD_DIRS[1]);

  if (!lockedA) {
    console.log(`[build] 目录 A 空闲，输出到: ${BUILD_DIRS[0]}`);
    return BUILD_DIRS[0];
  }
  if (!lockedB) {
    console.log(`[build] 目录 A 被占用（有实例在运行），改用目录 B: ${BUILD_DIRS[1]}`);
    return BUILD_DIRS[1];
  }
  console.error(
    `[build] 两个构建目录都被运行中的实例占用（A 和 B 各有一个 DeepSeek Harness Desktop 在运行）。` +
    `请至少关闭一个实例后重试。`
  );
  process.exit(1);
}

/** 构建后：记录当前目录 + 更新桌面快捷方式指向最新版。 */
function recordAndUpdateShortcut(outDir) {
  try {
    mkdirSync(BASE, { recursive: true });
    writeFileSync(CURRENT_FILE, outDir, "utf8");
  } catch { /* 忽略 */ }
  const exe = join(outDir, "win-unpacked", EXE_NAME);
  if (!existsSync(exe)) return;
  // Windows 的“桌面”可能被 OneDrive 重定向，不能假定它是 %USERPROFILE%\\Desktop。
  // 使用系统已知文件夹，确保构建后真正更新用户双击的快捷方式。
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell",
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    `$lnk = $ws.CreateShortcut((Join-Path $desktop '${LNK_NAME}'))`,
    `$lnk.TargetPath = "${exe.replace(/'/g, "''")}"`,
    `$lnk.WorkingDirectory = "${join(outDir, "win-unpacked").replace(/'/g, "''")}"`,
    "$lnk.Save()",
  ].join("; ");
  spawnSync("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, stdio: "ignore" });
  console.log(`[build] 桌面快捷方式已指向: ${exe}`);
}

const outDir = pickOutputDir();
const args = process.argv.slice(2);
const cli = require.resolve("electron-builder/cli.js");

console.log(`[build] electron-builder ${args.join(" ")} -> ${outDir}/`);
const r = spawnSync(
  process.execPath,
  [cli, ...args, `--config.directories.output=${outDir}`],
  { stdio: "inherit", windowsHide: true }
);
if (r.status === 0) {
  recordAndUpdateShortcut(outDir);
}
process.exit(r.status === null ? 1 : r.status);
