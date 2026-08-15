/**
 * 冒烟测试初始化：向隔离 userData 目录写入 settings.json，
 * 将 dshCommand 指向内置假 DSH fixture，使冒烟不依赖本机全局 @deepseek-ai/dsh。
 *
 * 用法（由 npm run test:smoke:fixture 调用）：
 *   需先设置 DSH_DESKTOP_USER_DATA（隔离目录），脚本会创建并写入。
 */
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const userData = resolve(process.env.DSH_DESKTOP_USER_DATA || join(process.env.TEMP || ".", "dsh-desktop-smoke"));
const fixture = join(__dirname, "..", "test", "fixtures", "fake-dsh.js");

mkdirSync(userData, { recursive: true });
const settingsFile = join(userData, "settings.json");
const payload = {
  dshCommand: [process.execPath, fixture, "web"],
  host: "127.0.0.1",
  port: 0,
  autoRestartOnCrash: false,
};
writeFileSync(settingsFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`[smoke-fixture] 已写入 ${settingsFile}`);
console.log(`[smoke-fixture] dshCommand=${payload.dshCommand.join(" ")}`);
