/**
 * electron-builder 包装：A/B 双目录交替构建，避免"运行中的 exe 占用导致 EBUSY"。
 *
 * 策略：
 *   - 两个构建目录：<项目根目录>\artifacts\dsh-desktop-build-a 和 -b
 *   - 构建前检查哪个目录的 win-unpacked exe 未被占用（或目录尚不存在），构建到空闲的那个
 *   - 构建后记录 current.txt（当前构建目录），更新桌面快捷方式，并把发布文件汇总到 release/
 *   - 运行中的实例在 A，构建到 B；下次运行 B（占用 B），构建回 A —— 永不冲突
 *
 * 用法：
 *   node scripts/build.js --win            # 等价 npm run dist
 *   node scripts/build.js --win portable
 *   node scripts/build.js --dir
 *
 * 可用 $DSH_DESKTOP_BUILD_DIR 显式指定单目录（跳过 A/B 逻辑）。
 * 测试构建可设置 $DSH_DESKTOP_SKIP_SHORTCUT=1，避免覆盖用户桌面快捷方式。
 */
const { spawnSync } = require("node:child_process");
const {
  existsSync,
  writeFileSync,
  openSync,
  closeSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
} = require("node:fs");
const { join, resolve } = require("node:path");

const EXE_NAME = "DeepSeek Harness Desktop.exe";
const PROJECT_ROOT = resolve(__dirname, "..");
const APP_VERSION = require(join(PROJECT_ROOT, "package.json")).version;
const BASE = join(PROJECT_ROOT, "artifacts", "dsh-desktop-build");
const BUILD_DIRS = [`${BASE}-a`, `${BASE}-b`];
const CURRENT_FILE = join(BASE, "current.txt");
const RELEASE_DIR = join(PROJECT_ROOT, "release");
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
  if (process.env.DSH_DESKTOP_BUILD_DIR) {
    return resolve(PROJECT_ROOT, process.env.DSH_DESKTOP_BUILD_DIR);
  }

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
  if (process.env.DSH_DESKTOP_SKIP_SHORTCUT === "1") {
    console.log("[build] 已跳过桌面快捷方式更新（测试构建）");
    return;
  }
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

/** 将可分发文件复制到项目内固定的 release/ 目录，方便查找和归档。 */
function collectReleaseFiles(outDir) {
  if (!existsSync(outDir)) return;
  mkdirSync(RELEASE_DIR, { recursive: true });
  const releaseNames = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      if (name === "latest.yml") return true;
      if (!name.startsWith(`DeepSeek-Harness-Desktop-${APP_VERSION}-`)) return false;
      return name.endsWith(".exe") || name.endsWith(".blockmap");
    });
  for (const name of releaseNames) {
    copyFileSync(join(outDir, name), join(RELEASE_DIR, name));
    console.log(`[build] 发布文件已汇总: ${join(RELEASE_DIR, name)}`);
  }
}

const outDir = pickOutputDir();
const args = process.argv.slice(2);
// 常规本地构建永不隐式发布；公开上传必须另行显式执行。
if (!args.some((arg) => arg === "--publish" || arg.startsWith("--publish="))) args.push("--publish", "never");
// 复用 npm 已安装且版本匹配的 Electron，避免打包器再次下载同一运行时。
const electronDist = join(PROJECT_ROOT, "node_modules", "electron", "dist");
const installedElectron = require(join(PROJECT_ROOT, "node_modules", "electron", "package.json")).version;
try {
  const binaryVersion = require("node:fs").readFileSync(join(electronDist, "version"), "utf8").trim().replace(/^v/, "");
  if (binaryVersion === installedElectron) args.push(`--config.electronDist=${electronDist}`);
} catch { /* 无已安装运行时则让打包器正常下载 */ }
const cli = require.resolve("electron-builder/cli.js");
const requestedAttempts = Number(process.env.DSH_DESKTOP_BUILD_ATTEMPTS || 2);
const maxAttempts = Number.isInteger(requestedAttempts)
  ? Math.min(5, Math.max(1, requestedAttempts))
  : 2;

console.log(`[build] electron-builder ${args.join(" ")} -> ${outDir}/`);
let r = null;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  if (attempt > 1) {
    console.warn(`[build] 上一次构建失败，开始第 ${attempt}/${maxAttempts} 次尝试（下载缓存会复用）`);
  }
  r = spawnSync(
    process.execPath,
    [cli, ...args, `--config.directories.output=${outDir}`],
    { stdio: "inherit", windowsHide: true }
  );
  if (r.status === 0) break;
}
if (r.status === 0) {
  recordAndUpdateShortcut(outDir);
  collectReleaseFiles(outDir);
}
process.exit(r.status === null ? 1 : r.status);
