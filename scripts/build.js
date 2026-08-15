/**
 * electron-builder 包装：构建输出目录可指定，避免写入 OneDrive 同步目录被锁。
 *
 * 用法：
 *   node scripts/build.js --win            # 等价 npm run dist
 *   node scripts/build.js --win portable
 *   node scripts/build.js --dir
 *
 * 输出目录：$DSH_DESKTOP_BUILD_DIR（默认 dist）。建议：
 *   set DSH_DESKTOP_BUILD_DIR=%LOCALAPPDATA%\dsh-desktop-build
 */
const { spawnSync } = require("node:child_process");

const outDir = process.env.DSH_DESKTOP_BUILD_DIR || "dist";
const args = process.argv.slice(2);
const cli = require.resolve("electron-builder/cli.js");

console.log(`[build] electron-builder ${args.join(" ")} -> ${outDir}/`);
const r = spawnSync(
  process.execPath,
  [cli, ...args, `--config.directories.output=${outDir}`],
  { stdio: "inherit", windowsHide: true }
);
process.exit(r.status === null ? 1 : r.status);
