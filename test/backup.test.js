/**
 * BackupManager 单元测试。
 */
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { BackupManager } = require("../src/main/backup.js");

function setup() {
  const backupDir = mkdtempSync(join(tmpdir(), "dsh-backup-"));
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-home-"));
  const profilesDir = join(dshHome, "profiles", "web");
  mkdirSync(profilesDir, { recursive: true });
  // 写入测试用 profile 文件
  writeFileSync(join(profilesDir, "package.json"), JSON.stringify({ "dsh.profile.bundles": ["base"] }));
  writeFileSync(join(profilesDir, "cordis.patch.yml"), "plugins: []");
  writeFileSync(join(profilesDir, "cordis.yml"), "# auto-generated");
  writeFileSync(join(dshHome, "settings.yaml"), "key: value");
  return { backupDir, dshHome };
}

let created;

test("create: 创建备份包含所有关键文件", () => {
  const { backupDir, dshHome } = setup();
  const bm = new BackupManager({ backupDir, dshHome });
  const m = bm.create("测试备份");
  assert.ok(m.id);
  assert.equal(m.note, "测试备份");
  assert.ok(m.files.includes("package.json"));
  assert.ok(m.files.includes("cordis.patch.yml"));
  assert.ok(existsSync(join(backupDir, m.id, "manifest.json")));
  assert.ok(existsSync(join(backupDir, m.id, "profiles-web", "package.json")));
});

test("list: 返回备份列表（按时间倒序）", () => {
  const { backupDir, dshHome } = setup();
  const bm = new BackupManager({ backupDir, dshHome });
  bm.create("first");
  bm.create("second");
  const list = bm.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].note, "second"); // 倒序
  assert.equal(list[1].note, "first");
});

test("restore: 恢复备份覆盖目标文件 + 自动备份", () => {
  const { backupDir, dshHome } = setup();
  const bm = new BackupManager({ backupDir, dshHome });
  const m = bm.create("before-change");
  // 修改当前文件
  writeFileSync(join(dshHome, "profiles", "web", "package.json"), '{"changed": true}');
  // 恢复
  const r = bm.restore(m.id);
  assert.ok(r.restored);
  assert.ok(r.beforeBackupId);
  const restored = JSON.parse(readFileSync(join(dshHome, "profiles", "web", "package.json"), "utf8"));
  assert.deepEqual(restored, { "dsh.profile.bundles": ["base"] });
  // 验证恢复前自动备份
  assert.equal(bm.list().length, 2); // original + auto-backup
});

test("diff: 对比当前与备份", () => {
  const { backupDir, dshHome } = setup();
  const bm = new BackupManager({ backupDir, dshHome });
  const m = bm.create("baseline");
  // 无变化
  const d1 = bm.diff(m.id);
  assert.ok(d1.identical);
  // 修改
  writeFileSync(join(dshHome, "profiles", "web", "package.json"), '{"changed": true}');
  const d2 = bm.diff(m.id);
  assert.ok(!d2.identical);
  assert.ok(d2.diffs["package.json"]);
});

test("delete: 删除备份", () => {
  const { backupDir, dshHome } = setup();
  const bm = new BackupManager({ backupDir, dshHome });
  const m = bm.create("to-delete");
  bm.delete(m.id);
  assert.equal(bm.list().length, 0);
  assert.ok(!existsSync(join(backupDir, m.id)));
});

test("cleanup: 超过 MAX_BACKUPS 自动清理最旧", () => {
  const { backupDir, dshHome } = setup();
  const bm = new BackupManager({ backupDir, dshHome });
  for (let i = 0; i < 12; i++) bm.create(`backup-${i}`);
  assert.equal(bm.list().length, 10); // 10 保留
});

test("创建无 profiles/web 目录时仍能创建备份", () => {
  const backupDir = mkdtempSync(join(tmpdir(), "dsh-backup-noprof-"));
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-home-noprof-"));
  // profiles/web 不存在
  const bm = new BackupManager({ backupDir, dshHome });
  const m = bm.create("no-profile");
  assert.ok(m.id);
  assert.equal(bm.list().length, 1);
  rmSync(backupDir, { recursive: true, force: true });
  rmSync(dshHome, { recursive: true, force: true });
});
