/**
 * IPC 通道名（主进程侧单一来源）。
 * preload 内嵌同名字符串常量（沙箱化 preload 无法 require 相对模块），
 * 修改此处时请同步修改 src/preload/preload.js 顶部常量。
 */
module.exports = {
  /** 渲染进程 -> 主进程（invoke/handle） */
  STATUS: "dsh:get-status",
  RESTART: "dsh:restart",
  GET_CONFIG: "app:get-config",
  SET_CONFIG: "app:set-config",
  OPEN_EXTERNAL: "app:open-external",
  VERSIONS: "app:get-versions",
  OPEN_DEVTOOLS: "window:open-devtools",
  OPEN_SETTINGS: "window:open-settings",
  RELOAD_WINDOW: "window:reload",
  UPGRADE_CHECK: "upgrade:check",
  UPGRADE_APPLY: "upgrade:apply",

  /** 备份/恢复 */
  BACKUP_CREATE: "backup:create",
  BACKUP_LIST: "backup:list",
  BACKUP_RESTORE: "backup:restore",
  BACKUP_DIFF: "backup:diff",
  BACKUP_DELETE: "backup:delete",

  /** 崩溃恢复 */
  CRASH_GET_STATUS: "crash:get-status",
  CRASH_DIAGNOSE: "crash:diagnose",
  CRASH_MARK_CLEAN: "crash:mark-clean",
  CRASH_RESET: "crash:reset-profile",
  CRASH_RESYNC: "crash:resync-profile",
  CRASH_CHECK_PROFILE: "crash:check-profile",

  /** 主进程 -> 渲染进程（send） */
  STATUS_EVENT: "dsh:status-event",
  ERROR_EVENT: "dsh:error-event",
  UPGRADE_EVENT: "upgrade:event",
};
