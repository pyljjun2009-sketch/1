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

test("restore: 恢复最旧备份时不被 _cleanup 竞态删除（数据安全回归）", () => {
  const { backupDir, dshHome } = setup();
  const bm = new BackupManager({ backupDir, dshHome });
  // 填满 MAX_BACKUPS（10 份），记下最旧的一份
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(bm.create(`bk-${i}`).id);
  const oldestId = ids[0];
  // 修改当前文件，然后恢复最旧备份
  writeFileSync(join(dshHome, "profiles", "web", "package.json"), '{"changed": true}');
  const r = bm.restore(oldestId);
  assert.equal(r.restored, oldestId);
  // 关键断言：restore 成功且文件确实被恢复（不再是 v2）
  const restored = JSON.parse(readFileSync(join(dshHome, "profiles", "web", "package.json"), "utf8"));
  assert.deepEqual(restored, { "dsh.profile.bundles": ["base"] });
  // 恢复前自动备份应该存在（backups 保持在 10 份上限）
  assert.equal(bm.list().length, 10);
});

test("restore: 清理 node_modules 残留（bundle 一致性回归）", () => {
  const { backupDir, dshHome } = setup();
  const profiles = join(dshHome, "profiles", "web");
  // 模拟安装了插件依赖目录
  mkdirSync(join(profiles, "node_modules", "plugin-a"), { recursive: true });
  writeFileSync(join(profiles, "node_modules", "plugin-a", "index.js"), "// A");
  const bm = new BackupManager({ backupDir, dshHome });
  const m = bm.create("with-plugins");
  // 恢复后 node_modules 不应残留（依赖重建语义）
  bm.restore(m.id);
  assert.ok(!existsSync(join(profiles, "node_modules")), "恢复后 node_modules 应被清理");
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

test("diff: 全局设置 settings.yaml 变化也能被检测（回归）", () => {
  const { backupDir, dshHome } = setup();
  const bm = new BackupManager({ backupDir, dshHome });
  const m = bm.create("baseline");
  // 仅修改全局设置，profile 文件不变
  writeFileSync(join(dshHome, "settings.yaml"), "key: changed-value");
  const d = bm.diff(m.id);
  assert.ok(!d.identical, "settings.yaml 变化应导致非 identical");
  assert.ok(d.diffs[".settings.yaml"], "应报告 .settings.yaml 差异");
  // 恢复后 settings.yaml 也应被恢复
  bm.restore(m.id);
  const restored = readFileSync(join(dshHome, "settings.yaml"), "utf8");
  assert.equal(restored, "key: value");
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
