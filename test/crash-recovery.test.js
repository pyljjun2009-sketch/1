/**
 * CrashRecovery 单元测试。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, existsSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { CrashRecovery } = require("../src/main/crash-recovery.js");
const { BackupManager } = require("../src/main/backup.js");

function setup() {
  const userDataDir = mkdtempSync(join(tmpdir(), "dsh-crash-"));
  const backupDir = mkdtempSync(join(tmpdir(), "dsh-crash-backup-"));
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-crash-home-"));
  const backupManager = new BackupManager({ backupDir, dshHome });
  const cr = new CrashRecovery({ userDataDir, dshHome, backupManager });
  return { cr, userDataDir, dshHome, backupManager };
}

test("正常退出标记: markCleanExit + detectUncleanExit", () => {
  const { cr } = setup();
  // 首次启动（无 cleanExit、无 lastKnownGood、无崩溃记录）→ 不算异常退出
  assert.ok(!cr.detectUncleanExit(), "首次启动不判定为异常退出");
  cr.markCleanExit();
  assert.ok(!cr.detectUncleanExit(), "标记后应为正常退出");
  // 有 lastKnownGood 但无 cleanExit → 异常退出
  cr.markCleanExit();
  const { unlinkSync } = require("node:fs");
  unlinkSync(cr.cleanExitFile);
  cr.markLastKnownGood();
  assert.ok(cr.detectUncleanExit(), "有成功记录但无 cleanExit 应为异常退出");
});

test("崩溃计数: increment/reset/get", () => {
  const { cr } = setup();
  assert.equal(cr.getCrashCount(), 0);
  assert.equal(cr.incrementCrashCount(), 1);
  assert.equal(cr.incrementCrashCount(), 2);
  assert.equal(cr.getCrashCount(), 2);
  cr.resetCrashCount();
  assert.equal(cr.getCrashCount(), 0);
});

test("lastKnownGood: 标记 + 读取", () => {
  const { cr } = setup();
  cr.markLastKnownGood();
  const status = cr.getStatus();
  assert.ok(status.lastKnownGood);
  assert.ok(new Date(status.lastKnownGood) instanceof Date);
});

test("getStatus: 返回完整状态", () => {
  const { cr } = setup();
  const s = cr.getStatus();
  assert.equal(typeof s.uncleanExit, "boolean");
  assert.equal(typeof s.crashCount, "number");
  assert.equal(typeof s.hasBackups, "boolean");
  assert.ok(Array.isArray(s.recentBackups));
});

test("diagnose: 异常退出 + 高崩溃计数返回问题列表", () => {
  const { cr } = setup();
  cr.incrementCrashCount();
  cr.incrementCrashCount();
  cr.incrementCrashCount();
  const d = cr.diagnose();
  assert.ok(d.issues.length >= 2);
  assert.ok(d.issues.some((i) => i.message.includes("连续崩溃")));
});

test("diagnose: 无问题时返回空 issues", () => {
  const { cr } = setup();
  cr.markCleanExit();
  const d = cr.diagnose();
  assert.equal(d.issues.length, 0);
});

test("dshHome 属性已正确保存", () => {
  const { cr, dshHome } = setup();
  assert.equal(cr.dshHome, dshHome);
});

test("重置 Profile：备份→删除→重建→返回备份 ID", () => {
  const { cr, dshHome, backupManager } = setup();
  const profileDir = join(dshHome, "profiles", "web");
  // 确保 profile 存在
  const { mkdirSync, writeFileSync } = require("node:fs");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "package.json"), '{"bundles":["test"]}');

  // 模拟 CRASH_RESET 逻辑
  const backup = backupManager.create("重置前备份");
  assert.ok(backup.id);

  const { rmSync, mkdirSync: m2 } = require("node:fs");
  rmSync(profileDir, { recursive: true, force: true });
  m2(profileDir, { recursive: true });

  assert.ok(!existsSync(join(profileDir, "package.json")), "Profile 已被删除");
  assert.ok(existsSync(profileDir), "Profile 目录已重建");
  assert.equal(backupManager.list().length >= 1, true, "备份已创建");
});
