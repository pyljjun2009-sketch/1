/**
 * electron-builder 包装：构建输出目录智能选择，避免 OneDrive 同步目录被锁。
 *
 * 用法：
 *   node scripts/build.js --win            # 等价 npm run dist
 *   node scripts/build.js --win portable
 *   node scripts/build.js --dir
 *
 * 输出目录选择（优先级）：
 *   1. $DSH_DESKTOP_BUILD_DIR 显式指定
 *   2. 当前目录在 OneDrive 下 -> %LOCALAPPDATA%\dsh-desktop-build（自动，推荐）
 *   3. 否则 -> dist
 *
 * 构建前会检查 win-unpacked 是否被运行中的 exe 占用，并给出提示。
 */
const { spawnSync, execSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join, normalize } = require("node:path");
const os = require("node:os");

function isUnderOneDrive(dir) {
  const d = normalize(dir).toLowerCase();
  return d.includes("onedrive") || d.includes("\\desktop\\") || d.includes("/desktop/");
}

function pickOutputDir() {
  if (process.env.DSH_DESKTOP_BUILD_DIR) return process.env.DSH_DESKTOP_BUILD_DIR;
  const cwd = process.cwd();
  if (isUnderOneDrive(cwd)) {
    const auto = join(process.env.LOCALAPPDATA || os.tmpdir(), "dsh-desktop-build");
    console.log(`[build] 检测到 OneDrive/桌面目录，输出到: ${auto}（避免文件锁）`);
    return auto;
  }
  return "dist";
}

function checkLockedExe(outDir) {
  const winUnpacked = join(outDir, "win-unpacked", "DeepSeek Harness Desktop.exe");
  if (!existsSync(winUnpacked)) return;
  try {
    // 尝试以独占方式打开 exe，判断是否被占用
    const fd = require("node:fs").openSync(winUnpacked, "r+");
    require("node:fs").closeSync(fd);
  } catch {
    console.warn(
      `\n[build] ⚠ 检测到 ${winUnpacked} 正在运行（被占用）。\n` +
      `       构建会失败（EBUSY）。请先关闭正在运行的 DeepSeek Harness Desktop，再重新构建。\n`
    );
    process.exit(1);
  }
}

const outDir = pickOutputDir();
checkLockedExe(outDir);
const args = process.argv.slice(2);
const cli = require.resolve("electron-builder/cli.js");

console.log(`[build] electron-builder ${args.join(" ")} -> ${outDir}/`);
const r = spawnSync(
  process.execPath,
  [cli, ...args, `--config.directories.output=${outDir}`],
  { stdio: "inherit", windowsHide: true }
);
process.exit(r.status === null ? 1 : r.status);
