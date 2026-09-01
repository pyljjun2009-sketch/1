/**
 * 数据备份管理器（V1：明文备份，V2 加 AES 加密）。
 *
 * 备份范围：
 *   - ~/.dsh/profiles/web/package.json          （bundle 清单）
 *   - ~/.dsh/profiles/web/cordis.patch.yml      （用户 patch/插件挂载）
 *   - ~/.dsh/profiles/web/cordis.yml             （自动生成模板）
 *   - ~/.dsh/settings.yaml                      （全局设置）
 *
 * 可选（大文件，默认排除）：
 *   - ~/.dsh/profiles/web/node_modules/         （已安装插件）
 *
 * 存储位置：%APPDATA%/dsh-desktop/backups/<timestamp>/
 * 保留策略：最近 10 份，超出自动清理最旧。
 */
const { join, dirname } = require("node:path");
const { homedir } = require("node:os");
const {
  existsSync, mkdirSync, readdirSync, statSync, readFileSync,
  writeFileSync, rmSync,
} = require("node:fs");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");

const MAX_BACKUPS = 10;

/** 验证备份 ID 格式（防路径穿越）：仅允许字母、数字、短横线、T。 */
function validateId(id) {
  if (!id || typeof id !== "string") return false;
  return /^[a-zA-Z0-9\-T]+$/.test(id);
}

function nowStamp() {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, "-").replace("T", "T").slice(0, 23);
}
/** 确保 ID 唯一（同一毫秒内创建的备份加递增后缀）。 */
const _usedIds = new Set();
function uniqueStamp() {
  let id = nowStamp();
  while (_usedIds.has(id)) id += "-" + Math.random().toString(36).slice(2, 6);
  _usedIds.add(id);
  return id;
}

class BackupManager extends EventEmitter {
  constructor({ backupDir, dshHome }) {
    super();
    this.backupDir = backupDir; // %APPDATA%/dsh-desktop/backups
    this.dshHome = dshHome || join(homedir(), ".dsh");
    this.profilesDir = join(this.dshHome, "profiles", "web");
    mkdirSync(this.backupDir, { recursive: true });
  }

  /** 需要备份的关键文件列表（相对于 profiles/web）。 */
  _keyFiles() {
    return ["package.json", "cordis.patch.yml", "cordis.yml"];
  }

  /** 收集当前 profile 快照。 */
  _snapshot() {
    const snap = {};
    for (const f of this._keyFiles()) {
      const p = join(this.profilesDir, f);
      if (existsSync(p)) {
        snap[f] = readFileSync(p, "utf8");
      }
    }
    // 全局设置
    const settingsPath = join(this.dshHome, "settings.yaml");
    if (existsSync(settingsPath)) {
      snap[".settings.yaml"] = readFileSync(settingsPath, "utf8");
    }
    return snap;
  }

  /** 计算文件内容的 SHA-256 摘要。 */
  _hash(content) {
    return createHash("sha256").update(content).digest("hex").slice(0, 12);
  }

  /** 生成 manifest 元数据。 */
  _manifest(id, note) {
    const snap = this._snapshot();
    // 尝试读取 DSH 版本
    let dshVersion = "unknown";
    try {
      const pkgPath = join(this.dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json");
      dshVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version || dshVersion;
    } catch { /* 忽略 */ }
    return {
      id,
      timestamp: new Date().toISOString(),
      note: note || null,
      dshVersion,
      files: Object.keys(snap),
      hashes: Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, this._hash(v)])),
    };
  }

  /** 创建备份。 */
  create(note) {
    const id = uniqueStamp();
    const dir = join(this.backupDir, id);
    mkdirSync(dir, { recursive: true });

    const snap = this._snapshot();
    let manifest;
    try {
      // 写入关键文件
      for (const [relPath, content] of Object.entries(snap)) {
        const target = relPath.startsWith(".") ? join(dir, relPath) : join(dir, "profiles-web", relPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
      }
      // 写入 manifest
      manifest = this._manifest(id, note);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    } catch (err) {
      // 写入失败时清理已创建的目录，避免留下半完成的备份
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      throw new Error(`备份创建失败（磁盘写入错误）：${err.message}`);
    }

    this.emit("created", { id, note, dir });

    // 清理旧备份
    this._cleanup();

    return manifest;
  }

  /** 列出所有备份（按时间倒序）。 */
  list() {
    if (!existsSync(this.backupDir)) return [];
    const entries = readdirSync(this.backupDir)
      .filter((e) => { try { return statSync(join(this.backupDir, e)).isDirectory(); } catch { return false; } })
      .sort()
      .reverse();
    return entries.map((id) => {
      const mfPath = join(this.backupDir, id, "manifest.json");
      try {
        return JSON.parse(readFileSync(mfPath, "utf8"));
      } catch {
        return { id, timestamp: id, note: null, files: [], hashes: {} };
      }
    });
  }

  /** 恢复备份（先自动快照 → 删当前 → 覆盖 → 原子恢复）。 */
  restore(id) {
    if (!validateId(id)) throw new Error(`无效的备份 ID: ${id}`);
    const srcDir = join(this.backupDir, id);
    if (!existsSync(srcDir)) throw new Error(`备份 ${id} 不存在`);

    // 先把源备份内容完整读入内存——因为下面的 create() 会触发 _cleanup()，
    // 当备份数达到上限且恢复的是最旧备份时，源目录可能被清理删除。
    // 先快照可避免"源备份被删 + restore 静默失败"的数据丢失竞态。
    const snapshot = this._readBackupSnapshot(srcDir);

    // 恢复前自动备份（_cleanup 可能在此删除最旧备份，包括 srcDir；但内容已在 snapshot 中）
    const beforeManifest = this.create(`恢复前自动备份（恢复目标: ${id}）`);

    // 确保目标目录存在
    mkdirSync(this.profilesDir, { recursive: true });

    // 停机：删除当前 profiles/web 中的所有内容（含 node_modules，避免恢复后
    // bundle 声明与已安装插件不一致；备份不含 node_modules，恢复语义=关键文件回滚 + 依赖重建）
    const { rmSync } = require("node:fs");
    if (existsSync(this.profilesDir)) {
      for (const f of readdirSync(this.profilesDir)) {
        try { rmSync(join(this.profilesDir, f), { recursive: true, force: true }); } catch { /* 忽略 */ }
      }
    }

    // 从内存快照恢复 profiles-web 文件（不依赖可能已被清理的 srcDir）
    for (const [relPath, content] of Object.entries(snapshot.profilesWeb)) {
      mkdirSync(dirname(join(this.profilesDir, relPath)), { recursive: true });
      writeFileSync(join(this.profilesDir, relPath), content, "utf8");
    }

    // 恢复全局设置
    if (snapshot.settingsYaml !== null) {
      writeFileSync(join(this.dshHome, "settings.yaml"), snapshot.settingsYaml, "utf8");
    }

    this.emit("restored", { id, beforeBackupId: beforeManifest.id });
    return { restored: id, beforeBackupId: beforeManifest.id };
  }

  /** 读取备份目录内容到内存（restore 前调用，防 _cleanup 竞态）。 */
  _readBackupSnapshot(srcDir) {
    const snap = { profilesWeb: {}, settingsYaml: null };
    const profilesDir = join(srcDir, "profiles-web");
    if (existsSync(profilesDir)) {
      for (const f of readdirSync(profilesDir)) {
        const p = join(profilesDir, f);
        try {
          if (statSync(p).isFile()) snap.profilesWeb[f] = readFileSync(p, "utf8");
        } catch { /* 忽略单个文件读取失败 */ }
      }
    }
    const settingsSrc = join(srcDir, ".settings.yaml");
    if (existsSync(settingsSrc)) {
      try { snap.settingsYaml = readFileSync(settingsSrc, "utf8"); } catch { /* 忽略 */ }
    }
    return snap;
  }

  /** 对比当前与指定备份的差异。 */
  diff(id) {
    if (!validateId(id)) throw new Error(`无效的备份 ID: ${id}`);
    const srcDir = join(this.backupDir, id);
    if (!existsSync(srcDir)) throw new Error(`备份 ${id} 不存在`);

    const manifest = JSON.parse(readFileSync(join(srcDir, "manifest.json"), "utf8"));
    const current = this._snapshot();
    const diffs = {};
    // 对比范围 = 备份 manifest 记录的全部文件（含 .settings.yaml 全局设置），
    // 兜底为关键文件列表（老备份无 manifest 时）
    const files = Array.isArray(manifest?.files) && manifest.files.length > 0
      ? manifest.files
      : this._keyFiles();
    for (const rel of files) {
      // 备份内路径：profiles-web/<file>，或根目录的 .settings.yaml
      const backupPath = rel.startsWith(".")
        ? join(srcDir, rel)
        : join(srcDir, "profiles-web", rel);
      const backupContent = existsSync(backupPath) ? readFileSync(backupPath, "utf8") : null;
      const currentContent = current[rel] || null;
      if (backupContent !== currentContent) {
        diffs[rel] = {
          changed: true,
          backupHash: backupContent ? this._hash(backupContent) : null,
          currentHash: currentContent ? this._hash(currentContent) : null,
          backupSize: backupContent ? backupContent.length : 0,
          currentSize: currentContent ? currentContent.length : 0,
        };
      }
    }
    return { id, manifest, diffs, identical: Object.keys(diffs).length === 0 };
  }

  /** 删除备份。 */
  delete(id) {
    if (!validateId(id)) throw new Error(`无效的备份 ID: ${id}`);
    const dir = join(this.backupDir, id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      this.emit("deleted", { id });
    }
    return { deleted: id };
  }

  /** 清理超出保留数量的旧备份。 */
  _cleanup() {
    const all = this.list();
    if (all.length <= MAX_BACKUPS) return;
    const toDelete = all.slice(MAX_BACKUPS);
    for (const b of toDelete) {
      this.delete(b.id);
    }
  }
}

module.exports = { BackupManager };
