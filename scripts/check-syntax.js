/**
 * 语法检查：对 src/、test/、scripts/、assets/ 下所有 .js 文件执行 `node --check`。
 * 任一失败即退出码 1。用法：node scripts/check-syntax.js
 */
const { spawnSync } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const { join, relative } = require("node:path");

const ROOTS = ["src", "test", "scripts", "assets"];
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "fixtures") continue;
      walk(full);
    } else if (entry.endsWith(".js")) {
      files.push(full);
    }
  }
}

for (const root of ROOTS) {
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
}

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (res.status !== 0) {
    failed += 1;
    console.error(`[check-syntax] FAIL ${relative(process.cwd(), file)}`);
    if (res.stderr) console.error(res.stderr.trim());
  } else {
    console.log(`[check-syntax] ok   ${relative(process.cwd(), file)}`);
  }
}

console.log(`[check-syntax] ${files.length - failed}/${files.length} passed`);
process.exit(failed === 0 ? 0 : 1);
