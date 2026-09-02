/**
 * 沙箱化 preload（DSH Web 页面 / 加载页）：
 * 仅暴露状态查询与重启 API —— 最小权限原则。
 * 不暴露 config/backup/crash/upgrade/settings（仅设置页可用）。
 */
const { contextBridge, ipcRenderer } = require("electron");

const CH = {
  STATUS: "dsh:get-status",
  RESTART: "dsh:restart",
  OPEN_EXTERNAL: "app:open-external",
  VERSIONS: "app:get-versions",
  RELOAD_WINDOW: "window:reload",
  STATUS_EVENT: "dsh:status-event",
  ERROR_EVENT: "dsh:error-event",
};

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("dshDesktop", {
  getStatus: () => ipcRenderer.invoke(CH.STATUS),
  restart: () => ipcRenderer.invoke(CH.RESTART),
  getVersions: () => ipcRenderer.invoke(CH.VERSIONS),
  openExternal: (url) => ipcRenderer.invoke(CH.OPEN_EXTERNAL, url),
  reload: () => ipcRenderer.invoke(CH.RELOAD_WINDOW),
  onStatus: (cb) => subscribe(CH.STATUS_EVENT, cb),
  onError: (cb) => subscribe(CH.ERROR_EVENT, cb),
});
