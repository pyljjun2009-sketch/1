/**
 * 清理临时构建产物：dist、dist-test、dist-review、artifacts。
 * release/ 中的安装包归档不会被默认删除。
 * 注意：若文件被进程占用（正在运行的 exe / OneDrive 同步锁），
 * 会跳过并给出提示，不会中断其余清理。
 * 用法：node scripts/clean.js [extraDir...]
 */
const { rmSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const targets = ["dist", "dist-test", "dist-review", "artifacts", ...process.argv.slice(2)];

for (const name of targets) {
  const dir = join(process.cwd(), name);
  if (!existsSync(dir)) continue;
  try {
    rmSync(dir, { recursive: true, force: true });
    console.log(`[clean] removed ${name}/`);
  } catch (err) {
    console.error(`[clean] 无法删除 ${name}/（可能被占用）: ${err.message}`);
  }
}
