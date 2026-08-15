/**
 * 沙箱化 preload：仅暴露白名单 API 到 window.dshDesktop。
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
    onEvent: (cb) => subscribe(CH.UPGRADE_EVENT, cb),
  },
  onStatus: (cb) => subscribe(CH.STATUS_EVENT, cb),
  onError: (cb) => subscribe(CH.ERROR_EVENT, cb),
});
