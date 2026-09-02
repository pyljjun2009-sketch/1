/**
 * 沙箱化 preload（设置页专用）：
 * 暴露完整的管理 API（config/backup/crash/upgrade/settings）。
 * 仅 settings.html 加载时使用，DSH Web 页面不会加载此 preload。
 *
 * 注意：沙箱化 preload 无法 require 相对模块，通道名在此内嵌，
 * 与 src/shared/channels.js 保持一致（修改时同步两处）。
 */
const { contextBridge, ipcRenderer } = require("electron");

const CH = {
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
  UPGRADE_INSTALL: "upgrade:install-app",
  BACKUP_CREATE: "backup:create",
  BACKUP_LIST: "backup:list",
  BACKUP_RESTORE: "backup:restore",
  BACKUP_DIFF: "backup:diff",
  BACKUP_DELETE: "backup:delete",
  CRASH_GET_STATUS: "crash:get-status",
  CRASH_DIAGNOSE: "crash:diagnose",
  CRASH_MARK_CLEAN: "crash:mark-clean",
  CRASH_RESET: "crash:reset-profile",
  CRASH_RESYNC: "crash:resync-profile",
  CRASH_CHECK_PROFILE: "crash:check-profile",
  STATUS_EVENT: "dsh:status-event",
  ERROR_EVENT: "dsh:error-event",
  UPGRADE_EVENT: "upgrade:event",
};

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("dshDesktop", {
  getStatus: () => ipcRenderer.invoke(CH.STATUS),
  restart: () => ipcRenderer.invoke(CH.RESTART),
  getConfig: () => ipcRenderer.invoke(CH.GET_CONFIG),
  setConfig: (patch) => ipcRenderer.invoke(CH.SET_CONFIG, patch),
  openExternal: (url) => ipcRenderer.invoke(CH.OPEN_EXTERNAL, url),
  getVersions: () => ipcRenderer.invoke(CH.VERSIONS),
  openDevTools: () => ipcRenderer.invoke(CH.OPEN_DEVTOOLS),
  reload: () => ipcRenderer.invoke(CH.RELOAD_WINDOW),
  upgrade: {
    check: (track) => ipcRenderer.invoke(CH.UPGRADE_CHECK, track),
    apply: (track, targetVersion) => ipcRenderer.invoke(CH.UPGRADE_APPLY, track, targetVersion),
    installApp: () => ipcRenderer.invoke(CH.UPGRADE_INSTALL),
    onEvent: (cb) => subscribe(CH.UPGRADE_EVENT, cb),
  },
  backup: {
    create: (note) => ipcRenderer.invoke(CH.BACKUP_CREATE, note),
    list: () => ipcRenderer.invoke(CH.BACKUP_LIST),
    restore: (id) => ipcRenderer.invoke(CH.BACKUP_RESTORE, id),
    diff: (id) => ipcRenderer.invoke(CH.BACKUP_DIFF, id),
    delete: (id) => ipcRenderer.invoke(CH.BACKUP_DELETE, id),
  },
  crash: {
    getStatus: () => ipcRenderer.invoke(CH.CRASH_GET_STATUS),
    diagnose: () => ipcRenderer.invoke(CH.CRASH_DIAGNOSE),
    markClean: () => ipcRenderer.invoke(CH.CRASH_MARK_CLEAN),
    resetProfile: () => ipcRenderer.invoke(CH.CRASH_RESET),
    resyncProfile: () => ipcRenderer.invoke(CH.CRASH_RESYNC),
    checkProfile: () => ipcRenderer.invoke(CH.CRASH_CHECK_PROFILE),
  },
  onStatus: (cb) => subscribe(CH.STATUS_EVENT, cb),
  onError: (cb) => subscribe(CH.ERROR_EVENT, cb),
});
