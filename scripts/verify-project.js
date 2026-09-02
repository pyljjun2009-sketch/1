/**
 * 项目一键验收：按固定顺序执行全量单测、语法、依赖审计、冒烟和解包验证。
 *
 * npm run verify        使用内置假 DSH，适合 CI/无全局 DSH 的机器
 * npm run verify:local  额外验证本机全局安装的真实 DSH
 */
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");

const includeRealDsh = process.argv.includes("--real-dsh");
const npmCli = process.env.npm_execpath;

if (!npmCli || !existsSync(npmCli)) {
  console.error("[verify] 无法定位 npm CLI。请通过 npm run verify 或 npm run verify:local 启动。");
  process.exit(2);
}

const stages = [
  { name: "全量单元与进程测试", args: ["test"] },
  { name: "JavaScript 语法检查", args: ["run", "test:syntax"] },
  { name: "依赖安全审计", args: ["audit", "--audit-level=low"] },
  { name: "模拟 DSH 冒烟", args: ["run", "test:smoke:fixture"] },
];
if (includeRealDsh) {
  stages.push({ name: "真实 DSH 冒烟", args: ["run", "test:smoke"] });
}
stages.push({ name: "Electron 解包与 ASAR 完整性", args: ["run", "test:package"] });

const startedAt = Date.now();
for (let index = 0; index < stages.length; index++) {
  const stage = stages[index];
  const stageStartedAt = Date.now();
  console.log(`\n[verify] (${index + 1}/${stages.length}) ${stage.name}`);
  const result = spawnSync(process.execPath, [npmCli, ...stage.args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const seconds = ((Date.now() - stageStartedAt) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(`[verify] FAIL: ${stage.name}（${seconds}s，exit=${result.status}）`);
    process.exit(result.status === null ? 1 : result.status);
  }
  console.log(`[verify] PASS: ${stage.name}（${seconds}s）`);
}

console.log(`\n[verify] ALL PASS（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
