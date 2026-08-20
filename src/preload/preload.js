/**
 * 沙箱化 preload（DSH Web 页面 / 加载页）：
 * 仅暴露状态查询与重启 API —— 最小权限原则。
 * 不暴露 config/backup/crash/upgrade/settings（仅设置页可用）。
 */
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("dshDesktop", {
  getStatus: () => ipcRenderer.invoke("dsh:get-status"),
  restart: () => ipcRenderer.invoke("dsh:restart"),
  getVersions: () => ipcRenderer.invoke("app:get-versions"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  reload: () => ipcRenderer.invoke("window:reload"),
  onStatus: (cb) => subscribe("dsh:status-event", cb),
  onError: (cb) => subscribe("dsh:error-event", cb),
});
