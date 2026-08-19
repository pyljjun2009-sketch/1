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
  const cr = new CrashRecovery({ userDataDir, backupManager });
  return { cr, userDataDir, dshHome };
}

test("正常退出标记: markCleanExit + detectUncleanExit", () => {
  const { cr } = setup();
  assert.ok(cr.detectUncleanExit(), "首次应为异常退出");
  cr.markCleanExit();
  assert.ok(!cr.detectUncleanExit(), "标记后应为正常退出");
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
