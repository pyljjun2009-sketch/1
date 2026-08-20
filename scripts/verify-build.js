/**
 * 构建后验证脚本：打包完成后检查 ASAR 内容完整性。
 * 用法：node scripts/verify-build.js [dist目录]
 */
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const distDir = process.argv[2] || join(process.cwd(), "dist", "win-unpacked");
const asarPath = join(distDir, "resources", "app.asar");

console.log(`\n[dsh-build-verify] 检查目录: ${distDir}`);

if (!existsSync(distDir)) {
  console.error("[dsh-build-verify] FAIL: 构建目录不存在");
  process.exit(1);
}
if (!existsSync(asarPath)) {
  console.error("[dsh-build-verify] FAIL: app.asar 不存在");
  process.exit(1);
}
console.log("[dsh-build-verify] OK: 构建目录和 asar 存在");

// 直接用 @electron/asar API 读取内容
const asar = require("@electron/asar");
const listArr = asar.listPackage(asarPath); // 返回路径数组
const list = listArr.join("\n"); // 转为字符串以便 includes 查找

const required = [
  "index.js", "dsh-server.js", "config.js", "ipc.js", "window.js",
  "updater.js", "backup.js", "crash-recovery.js",
  "preload.js", "preload-settings.js", "channels.js",
  "loading.html", "settings.html", "icon.png", "package.json",
];

let pass = 0;
let fail = 0;
for (const f of required) {
  if (list.includes(f)) {
    pass++;
  } else {
    console.error(`[dsh-build-verify] FAIL: 缺失 ${f}`);
    fail++;
  }
}

console.log(`[dsh-build-verify] settings.html: ${list.includes("settings.html") ? "OK" : "MISSING"}`);
console.log(`[dsh-build-verify] preload-settings.js: ${list.includes("preload-settings.js") ? "OK" : "MISSING"}`);
console.log(`[dsh-build-verify] 结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) { console.error("[dsh-build-verify] FAIL"); process.exit(1); }
console.log("[dsh-build-verify] PASS");
