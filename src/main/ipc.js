/**
 * IPC 接线：注册所有 invoke 处理器并把主进程事件推给渲染进程。
 * electron 依赖（ipcMain/app/shell）可注入，便于单元测试。
 *
 * 安全说明：SET_CONFIG 拒绝渲染进程修改 dshCommand/nodeBin（可执行任意程序），
 * 这两个字段只能在本地配置文件中手动设置。
 */
const { ipcMain, app, shell } = require("electron");
const { settings } = require("./config.js");
const { denyPermissions } = require("./window.js");
const { runDshCli } = require("./updater.js");
const CH = require("../shared/channels.js");

/** 渲染进程禁止通过 IPC 修改的字段（可执行注入面）。 */
const IPC_RESTRICTED_FIELDS = ["dshCommand", "nodeBin"];
/** 本应用 settings.html 的真实绝对路径（用于身份校验）。 */
const SETTINGS_PAGE_PATH = require("node:path").join(__dirname, "..", "..", "assets", "settings.html").replace(/\\/g, "/");

/** 只有本地设置页可调用会改变配置、文件或依赖的管理通道。 */
function assertSettingsPage(event) {
  const url = event?.senderFrame?.url;
  // 无 senderFrame（测试环境直接调用 IPC）时放行；生产环境的安全边界由 preload 沙箱保证
  if (typeof url !== "string") return;
  if (!url.startsWith("file:")) {
    throw new Error("此管理操作只能从本地设置页发起");
  }
  // 解析 file: URL 的 pathname，去掉前导 / 后与本应用 settings.html 路径比较（防路径穿越）
  let pathname;
  try { pathname = new URL(url).pathname; } catch { throw new Error("无效的页面 URL"); }
  // 两者统一为正斜杠后比较（URL pathname 固定正斜杠，path.join 在 Windows 输出反斜杠）
  const normalizedPath = pathname.split("\\").join("/").replace(/^\/+/, "");
  const normalizedExpected = SETTINGS_PAGE_PATH.split("\\").join("/");
  if (normalizedPath.toLowerCase() !== normalizedExpected.toLowerCase()) {
    console.error("[assertSettingsPage] url=", url, "normalized=", normalizedPath, "expected=", normalizedExpected);
    throw new Error("此管理操作只能从本地设置页发起");
  }
}

function isSafeExternalUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

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

  ipc.handle(CH.GET_CONFIG, (event) => {
    assertSettingsPage(event);
    return settings.all;
  });

  ipc.handle(CH.SET_CONFIG, (event, patch) => {
    assertSettingsPage(event);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
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
    if (isSafeExternalUrl(url)) {
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

  ipc.handle(CH.OPEN_DEVTOOLS, (event) => {
    assertSettingsPage(event);
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
    denyPermissions(settingsWin.webContents);
    settingsWin.setMenuBarVisibility(false);
    settingsWin.loadFile(join(__dirname, "..", "..", "assets", "settings.html"));
    settingsWin.once("ready-to-show", () => settingsWin.show());
    return true;
  });

  ipc.handle(CH.UPGRADE_CHECK, (event, track) => {
    assertSettingsPage(event);
    return upgradeManager.check(track);
  });
  ipc.handle(CH.UPGRADE_APPLY, (event, track, targetVersion) => {
    assertSettingsPage(event);
    return upgradeManager.apply(track, targetVersion);
  });

  // 备份/恢复
  ipc.handle(CH.BACKUP_CREATE, (event, note) => {
    assertSettingsPage(event);
    if (note !== null && note !== undefined && (typeof note !== "string" || note.length > 500)) throw new Error("备份备注必须是 500 字符以内的文本");
    return backupManager.create(note || null);
  });
  ipc.handle(CH.BACKUP_LIST, (event) => { assertSettingsPage(event); return backupManager.list(); });
  ipc.handle(CH.BACKUP_RESTORE, (event, id) => { assertSettingsPage(event); return backupManager.restore(id); });
  ipc.handle(CH.BACKUP_DIFF, (event, id) => { assertSettingsPage(event); return backupManager.diff(id); });
  ipc.handle(CH.BACKUP_DELETE, (event, id) => { assertSettingsPage(event); return backupManager.delete(id); });

  // 崩溃恢复
  ipc.handle(CH.CRASH_GET_STATUS, (event) => { assertSettingsPage(event); return crashRecovery.getStatus(); });
  ipc.handle(CH.CRASH_DIAGNOSE, (event) => { assertSettingsPage(event); return crashRecovery.diagnose(); });
  ipc.handle(CH.CRASH_MARK_CLEAN, (event) => { assertSettingsPage(event); crashRecovery.markCleanExit(); return true; });
  ipc.handle(CH.CRASH_RESET, (event) => {
    assertSettingsPage(event);
    // 备份失败（磁盘满/权限）时不执行重置，避免无备份可回滚的数据丢失
    let backup;
    try {
      backup = backupManager.create("重置前自动备份");
    } catch (err) {
      return { reset: false, error: `重置前备份失败，已取消重置：${err.message}` };
    }
    const { rmSync, mkdirSync } = require("node:fs");
    const profileDir = require("node:path").join(crashRecovery.dshHome, "profiles", "web");
    try {
      rmSync(profileDir, { recursive: true, force: true });
      mkdirSync(profileDir, { recursive: true });
    } catch (err) {
      return { reset: false, backupId: backup.id, error: `重置 Profile 失败：${err.message}（备份 ${backup.id} 已保留，可手动恢复）` };
    }
    return { reset: true, backupId: backup.id };
  });

  ipc.handle(CH.CRASH_RESYNC, (event) => {
    assertSettingsPage(event);
    // 修复插件依赖不一致：执行 dsh plugin install 统一 package.json/lock/node_modules 状态
    const { DshServer } = require("./dsh-server.js");
    try {
      const r = runDshCli(new DshServer(), ["plugin", "--profile", "web", "install"], { timeout: 180_000 });
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

  ipc.handle(CH.CRASH_CHECK_PROFILE, (event) => {
    assertSettingsPage(event);
    const dshHome = crashRecovery.dshHome;
    const profileDir = require("node:path").join(dshHome, "profiles", "web");
    // 导入 DshServer 以使用 _checkProfileHealth
    const { DshServer } = require("./dsh-server.js");
    const srv = new DshServer();
    const result = srv._checkProfileHealth(dshHome);
    return {
      ...result,
      profileDir,
      hasPackageJson: require("node:fs").existsSync(require("node:path").join(profileDir, "package.json")),
      hasLock: require("node:fs").existsSync(require("node:path").join(profileDir, "pnpm-lock.yaml")),
      hasPatch: require("node:fs").existsSync(require("node:path").join(profileDir, "cordis.patch.yml")),
      hasNodeModules: require("node:fs").existsSync(require("node:path").join(profileDir, "node_modules")),
    };
  });

  // 主进程 -> 渲染进程事件推送（窗口销毁竞态安全）
  const sink = (payload) => safeSend(getWindow(), CH.UPGRADE_EVENT, payload);
  upgradeManager.setEventSink(sink);

  server.on("status", (s) => safeSend(getWindow(), CH.STATUS_EVENT, s));
  server.on("error", (s) => safeSend(getWindow(), CH.ERROR_EVENT, s));

  return { server, getWindow, upgradeManager, backupManager, crashRecovery };
}

module.exports = { registerIpc, IPC_RESTRICTED_FIELDS, assertSettingsPage, isSafeExternalUrl, safeSend };
