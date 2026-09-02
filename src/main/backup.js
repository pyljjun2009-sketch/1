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
  writeFileSync, rmSync, renameSync,
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
    return createHash("sha256").update(content).digest("hex");
  }

  /** 生成 manifest 元数据。 */
  _manifest(id, note, snap = this._snapshot()) {
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
      // manifest 必须与刚刚写入磁盘的同一份快照一致，不能再次读取实时文件。
      manifest = this._manifest(id, note, snap);
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
      .filter((e) => validateId(e))
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

  /** 恢复备份（完整性校验 → 自动快照 → 同卷暂存 → 目录切换；失败自动回滚）。 */
  restore(id) {
    if (!validateId(id)) throw new Error(`无效的备份 ID: ${id}`);
    const srcDir = join(this.backupDir, id);
    if (!existsSync(srcDir)) throw new Error(`备份 ${id} 不存在`);

    // 先校验并把源备份内容完整读入内存——因为下面的 create() 会触发 _cleanup()，
    // 当备份数达到上限且恢复的是最旧备份时，源目录可能被清理删除。
    // 先快照可避免"源备份被删 + restore 静默失败"的数据丢失竞态。
    const snapshot = this._readBackupSnapshot(srcDir);

    // 恢复前自动备份（_cleanup 可能在此删除最旧备份，包括 srcDir；但内容已在 snapshot 中）
    const beforeManifest = this.create(`恢复前自动备份（恢复目标: ${id}）`);

    const profileParent = dirname(this.profilesDir);
    mkdirSync(profileParent, { recursive: true });
    const opId = uniqueStamp();
    const stageDir = join(profileParent, `.web-restore-${opId}`);
    const rollbackDir = join(profileParent, `.web-rollback-${opId}`);
    const settingsPath = join(this.dshHome, "settings.yaml");
    const settingsTemp = `${settingsPath}.restore-${opId}.tmp`;
    const settingsBeforeExists = existsSync(settingsPath);
    const settingsBefore = settingsBeforeExists ? readFileSync(settingsPath, "utf8") : null;
    let movedOriginal = false;
    let installedStage = false;

    try {
      // 先在同一磁盘卷内完整生成目标目录；真正切换只需要 rename，避免半写入状态。
      mkdirSync(stageDir, { recursive: true });
      for (const [relPath, content] of Object.entries(snapshot.profilesWeb)) {
        const target = join(stageDir, relPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
      }

      if (existsSync(this.profilesDir)) {
        renameSync(this.profilesDir, rollbackDir);
        movedOriginal = true;
      }
      renameSync(stageDir, this.profilesDir);
      installedStage = true;

      // settings.yaml 也恢复为备份时的精确状态：备份中不存在时删除当前新增文件。
      if (snapshot.settingsYaml === null) {
        rmSync(settingsPath, { force: true });
      } else {
        writeFileSync(settingsTemp, snapshot.settingsYaml, "utf8");
        rmSync(settingsPath, { force: true });
        renameSync(settingsTemp, settingsPath);
      }
    } catch (err) {
      // 任一步失败都尽最大努力恢复原 Profile 与全局设置。
      try {
        if (installedStage && existsSync(this.profilesDir)) rmSync(this.profilesDir, { recursive: true, force: true });
        if (movedOriginal && existsSync(rollbackDir)) renameSync(rollbackDir, this.profilesDir);
        if (settingsBeforeExists) writeFileSync(settingsPath, settingsBefore, "utf8");
        else rmSync(settingsPath, { force: true });
      } catch { /* 原始错误更重要；恢复前自动备份仍可手工回滚 */ }
      try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      try { rmSync(settingsTemp, { force: true }); } catch { /* 忽略 */ }
      throw new Error(`备份恢复失败，已尝试回滚当前状态：${err.message}（恢复前备份: ${beforeManifest.id}）`);
    }

    // 切换成功后再清理旧目录；失败也不影响已恢复的新目录。
    if (existsSync(rollbackDir)) rmSync(rollbackDir, { recursive: true, force: true });

    this.emit("restored", { id, beforeBackupId: beforeManifest.id });
    return { restored: id, beforeBackupId: beforeManifest.id };
  }

  /** 读取备份目录内容到内存（restore 前调用，防 _cleanup 竞态）。 */
  _readBackupSnapshot(srcDir) {
    const manifestPath = join(srcDir, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      throw new Error(`备份清单无法读取：${err.message}`);
    }
    if (!manifest || !Array.isArray(manifest.files) || !manifest.hashes || typeof manifest.hashes !== "object") {
      throw new Error("备份清单格式无效，拒绝恢复");
    }

    const allowed = new Set([...this._keyFiles(), ".settings.yaml"]);
    const snap = { profilesWeb: {}, settingsYaml: null, manifest };
    for (const rel of manifest.files) {
      if (!allowed.has(rel)) throw new Error(`备份清单包含不受支持的路径：${rel}`);
      const source = rel.startsWith(".") ? join(srcDir, rel) : join(srcDir, "profiles-web", rel);
      if (!existsSync(source) || !statSync(source).isFile()) {
        throw new Error(`备份文件缺失：${rel}`);
      }
      const content = readFileSync(source, "utf8");
      const expectedHash = manifest.hashes[rel];
      const actualHash = this._hash(content);
      // 兼容旧版 12 位短摘要；新备份使用完整 SHA-256。
      if (typeof expectedHash !== "string" || actualHash.slice(0, expectedHash.length) !== expectedHash) {
        throw new Error(`备份完整性校验失败：${rel}`);
      }
      if (rel === ".settings.yaml") snap.settingsYaml = content;
      else snap.profilesWeb[rel] = content;
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
    const files = [...new Set([
      ...this._keyFiles(),
      ".settings.yaml",
      ...(Array.isArray(manifest?.files) ? manifest.files : []),
    ])];
    const allowed = new Set([...this._keyFiles(), ".settings.yaml"]);
    for (const rel of files) {
      if (!allowed.has(rel)) throw new Error(`备份清单包含不受支持的路径：${rel}`);
      // 备份内路径：profiles-web/<file>，或根目录的 .settings.yaml
      const backupPath = rel.startsWith(".")
        ? join(srcDir, rel)
        : join(srcDir, "profiles-web", rel);
      const backupContent = existsSync(backupPath) ? readFileSync(backupPath, "utf8") : null;
      const currentContent = Object.prototype.hasOwnProperty.call(current, rel) ? current[rel] : null;
      if (backupContent !== currentContent) {
        diffs[rel] = {
          changed: true,
          backupHash: backupContent !== null ? this._hash(backupContent) : null,
          currentHash: currentContent !== null ? this._hash(currentContent) : null,
          backupSize: backupContent !== null ? backupContent.length : 0,
          currentSize: currentContent !== null ? currentContent.length : 0,
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
