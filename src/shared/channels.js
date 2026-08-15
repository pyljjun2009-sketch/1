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
  RELOAD_WINDOW: "window:reload",
  UPGRADE_CHECK: "upgrade:check",
  UPGRADE_APPLY: "upgrade:apply",

  /** 主进程 -> 渲染进程（send） */
  STATUS_EVENT: "dsh:status-event",
  ERROR_EVENT: "dsh:error-event",
  UPGRADE_EVENT: "upgrade:event",
};
