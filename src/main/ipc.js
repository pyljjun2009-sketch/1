/**
 * IPC 接线：注册所有 invoke 处理器并把主进程事件推给渲染进程。
 * electron 依赖（ipcMain/app/shell）可注入，便于单元测试。
 *
 * 安全说明：SET_CONFIG 拒绝渲染进程修改 dshCommand/nodeBin（可执行任意程序），
 * 这两个字段只能在本地配置文件中手动设置。
 */
const { ipcMain, app, shell } = require("electron");
const { settings } = require("./config.js");
const CH = require("../shared/channels.js");

/** 渲染进程禁止通过 IPC 修改的字段（可执行注入面）。 */
const IPC_RESTRICTED_FIELDS = ["dshCommand", "nodeBin"];

function safeSend(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  } catch {
    /* 窗口/渲染帧关闭期间的竞态，吞掉 */
  }
}

function registerIpc({ server, getWindow, upgradeManager, backupManager, crashRecovery, ipc = ipcMain, appApi = app, shellApi = shell }) {
  ipc.handle(CH.STATUS, () => server.status());

  ipc.handle(CH.RESTART, async () => {
    const status = await server.restart();
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      // 若后端已在运行，重新加载页面
      if (status.state === "running" && status.url) {
        win.loadURL(status.url);
      }
    }
    return status;
  });

  ipc.handle(CH.GET_CONFIG, () => settings.all);

  ipc.handle(CH.SET_CONFIG, (event, patch) => {
    if (!patch || typeof patch !== "object") {
      throw new Error("配置补丁必须是对象");
    }
    const restricted = Object.keys(patch).filter((k) => IPC_RESTRICTED_FIELDS.includes(k));
    if (restricted.length > 0) {
      throw new Error(
        `配置字段 ${restricted.join("、")} 不允许通过界面修改（安全限制），请直接编辑配置文件: ${settings.file ?? "settings.json"}`
      );
    }
    // settings.set 对非法值抛错，错误经 invoke rejection 返回给调用方
    settings.set(patch);
    if (appApi && appApi.setLoginItemSettings) {
      appApi.setLoginItemSettings({ openAtLogin: Boolean(settings.get("launchAtLogin")) });
    }
    return settings.all;
  });

  ipc.handle(CH.OPEN_EXTERNAL, async (event, url) => {
    if (typeof url === "string" && /^https?:/i.test(url)) {
      await shellApi.openExternal(url);
      return { ok: true };
    }
    return { ok: false, reason: "仅允许打开 http(s) 链接" };
  });

  ipc.handle(CH.VERSIONS, () => ({
    app: appApi ? appApi.getVersion() : null,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dsh: server.version,
  }));

  ipc.handle(CH.OPEN_DEVTOOLS, () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.openDevTools({ mode: "detach" });
    return true;
  });

  ipc.handle(CH.RELOAD_WINDOW, () => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.reload();
    return true;
  });

  ipc.handle(CH.OPEN_SETTINGS, () => {
    // 打开设置面板（独立窗口或弹窗）
    const { BrowserWindow } = require("electron");
    const { join } = require("node:path");
    const existing = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "设置");
    if (existing) { existing.focus(); return true; }
    const settingsWin = new BrowserWindow({
      width: 700, height: 600, title: "设置",
      parent: getWindow(), modal: true, show: false,
      webPreferences: { preload: join(__dirname, "..", "preload", "preload-settings.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    settingsWin.setMenuBarVisibility(false);
    settingsWin.loadFile(join(__dirname, "..", "..", "assets", "settings.html"));
    settingsWin.once("ready-to-show", () => settingsWin.show());
    return true;
  });

  ipc.handle(CH.UPGRADE_CHECK, (event, track) => upgradeManager.check(track));
  ipc.handle(CH.UPGRADE_APPLY, (event, track, targetVersion) =>
    upgradeManager.apply(track, targetVersion)
  );

  // 备份/恢复
  ipc.handle(CH.BACKUP_CREATE, (event, note) => backupManager.create(note));
  ipc.handle(CH.BACKUP_LIST, () => backupManager.list());
  ipc.handle(CH.BACKUP_RESTORE, (event, id) => backupManager.restore(id));
  ipc.handle(CH.BACKUP_DIFF, (event, id) => backupManager.diff(id));
  ipc.handle(CH.BACKUP_DELETE, (event, id) => backupManager.delete(id));

  // 崩溃恢复
  ipc.handle(CH.CRASH_GET_STATUS, () => crashRecovery.getStatus());
  ipc.handle(CH.CRASH_DIAGNOSE, () => crashRecovery.diagnose());
  ipc.handle(CH.CRASH_MARK_CLEAN, () => { crashRecovery.markCleanExit(); return true; });
  ipc.handle(CH.CRASH_RESET, () => {
    const backup = backupManager.create("重置前自动备份");
    const { rmSync, mkdirSync } = require("node:fs");
    const profileDir = require("node:path").join(crashRecovery.dshHome, "profiles", "web");
    rmSync(profileDir, { recursive: true, force: true });
    mkdirSync(profileDir, { recursive: true });
    return { reset: true, backupId: backup.id };
  });

  ipc.handle(CH.CRASH_RESYNC, () => {
    // 修复插件依赖不一致：执行 dsh plugin install 统一 package.json/lock/node_modules 状态
    const { spawnSync } = require("node:child_process");
    try {
      const r = spawnSync("dsh", ["plugin", "--profile", "web", "install"], {
        encoding: "utf8", timeout: 180_000, windowsHide: true, shell: process.platform === "win32",
      });
      const success = r.status === 0;
      return {
        resync: success,
        output: (r.stdout || "") + (r.stderr || ""),
        message: success ? "插件依赖已同步" : "同步失败，请查看输出",
      };
    } catch (err) {
      return { resync: false, output: "", message: `执行失败: ${err.message}` };
    }
  });

  // 主进程 -> 渲染进程事件推送（窗口销毁竞态安全）
  const sink = (payload) => safeSend(getWindow(), CH.UPGRADE_EVENT, payload);
  upgradeManager.setEventSink(sink);

  server.on("status", (s) => safeSend(getWindow(), CH.STATUS_EVENT, s));
  server.on("error", (s) => safeSend(getWindow(), CH.ERROR_EVENT, s));

  return { server, getWindow, upgradeManager, backupManager, crashRecovery };
}

module.exports = { registerIpc, IPC_RESTRICTED_FIELDS, safeSend };
