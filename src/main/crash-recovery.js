/**
 * 崩溃恢复管理器。
 *
 * 状态标记文件：%APPDATA%/dsh-desktop/
 *   - .last-clean-exit    正常退出时写入时间戳；异常退出时不存在或过期
 *   - .crash-count        连续崩溃计数（后端成功启动后归零）
 *   - .last-known-good    上次成功启动后端的时间戳
 *
 * 检测时机：
 *   1. 应用启动：检查 .last-clean-exit 是否存在且新鲜
 *   2. dsh 后端连续崩溃：.crash-count >= 3 时触发恢复建议
 *   3. Profile EPERM：预检阶段已覆盖
 */
const { join } = require("node:path");
const { existsSync, readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const { EventEmitter } = require("node:events");

class CrashRecovery extends EventEmitter {
  constructor({ userDataDir, dshHome, backupManager }) {
    super();
    this.dir = userDataDir;
    this.dshHome = dshHome; // DSH 主目录（~/.dsh）
    this.cleanExitFile = join(userDataDir, ".last-clean-exit");
    this.crashCountFile = join(userDataDir, ".crash-count");
    this.lastGoodFile = join(userDataDir, ".last-known-good");
    this.backupManager = backupManager; // 可选：用于创建恢复前备份
  }

  /** 应用启动时调用：记录退出状态。写入失败不影响应用退出（静默忽略）。 */
  markCleanExit() {
    try { writeFileSync(this.cleanExitFile, new Date().toISOString(), "utf8"); } catch { /* 忽略磁盘错误 */ }
  }

  /** 清除退出标记（应用正常启动后调用，表示已接管）。 */
  clearCleanExit() {
    try { unlinkSync(this.cleanExitFile); } catch { /* 不存在时忽略 */ }
  }

  /** 检查是否为异常退出。全新安装（无 cleanExit、无 lastKnownGood、无崩溃记录）识别为首次启动。 */
  detectUncleanExit() {
    if (existsSync(this.cleanExitFile)) return false; // 正常退出过
    if (this.getCrashCount() > 0) return true; // 有崩溃记录 → 异常退出
    if (existsSync(this.lastGoodFile)) return true; // 有成功记录但无 cleanExit → 异常退出
    // 全部不存在 → 首次启动，非异常
    return false;
  }

  /** 获取崩溃计数。 */
  getCrashCount() {
    try {
      return parseInt(readFileSync(this.crashCountFile, "utf8").trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /** 增加崩溃计数。写入失败时仍返回当前值（内存兜底）。 */
  incrementCrashCount() {
    const count = this.getCrashCount() + 1;
    try { writeFileSync(this.crashCountFile, String(count), "utf8"); } catch { /* 忽略磁盘错误 */ }
    return count;
  }

  /** 重置崩溃计数（后端成功启动后调用）。 */
  resetCrashCount() {
    try { unlinkSync(this.crashCountFile); } catch { /* 不存在时忽略 */ }
  }

  /** 记录后端成功启动时间戳。 */
  markLastKnownGood() {
    writeFileSync(this.lastGoodFile, new Date().toISOString(), "utf8");
  }

  /** 获取完整崩溃状态。 */
  getStatus() {
    return {
      uncleanExit: this.detectUncleanExit(),
      crashCount: this.getCrashCount(),
      lastKnownGood: existsSync(this.lastGoodFile)
        ? readFileSync(this.lastGoodFile, "utf8")
        : null,
      hasBackups: this.backupManager ? this.backupManager.list().length > 0 : false,
      recentBackups: this.backupManager ? this.backupManager.list().slice(0, 3) : [],
    };
  }

  /** 应用启动时综合检查：返回需要告知用户的诊断信息。 */
  diagnose() {
    const status = this.getStatus();
    const issues = [];
    if (status.uncleanExit) {
      issues.push({
        level: "warning",
        message: "上次退出异常（未写入 clean-exit 标记）",
        recoverable: status.hasBackups,
        action: status.hasBackups ? "可恢复到上次正常状态" : "无可用备份",
      });
    }
    if (status.crashCount >= 3) {
      issues.push({
        level: "error",
        message: `DSH 后端已连续崩溃 ${status.crashCount} 次`,
        recoverable: status.hasBackups,
        action: status.hasBackups
          ? "建议恢复到上次正常状态或重置 Profile"
          : "建议检查 ~/.dsh/profiles/web/ 配置",
      });
    }
    return { ...status, issues };
  }
}

module.exports = { CrashRecovery };
