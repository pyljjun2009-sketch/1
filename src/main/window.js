/**
 * 主窗口：先展示本地加载页，后端就绪后切换到真实 DSH Web UI。
 * 安全策略：contextIsolation + 沙箱化 preload；禁止跳离本地后端，
 * 外部 http(s) 链接一律交给系统浏览器。
 */
const { BrowserWindow, Menu, shell, app } = require("electron");
const { join } = require("node:path");
const { settings } = require("./config.js");

function isServerOrigin(url, serverUrl) {
  try {
    return new URL(url).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

/** DSH Web 与设置页均不需要直接申请操作系统权限，默认一律拒绝。 */
function denyPermissions(webContents) {
  const session = webContents?.session;
  if (!session) return;
  if (typeof session.setPermissionCheckHandler === "function") {
    session.setPermissionCheckHandler(() => false);
  }
  if (typeof session.setPermissionRequestHandler === "function") {
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  }
}

function buildMenu({ restartServer, openUserDataDir, checkUpgrades, openSettings }) {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "文件",
      submenu: [
        { label: "设置", accelerator: "Ctrl+,", click: openSettings },
        { type: "separator" },
        { label: "重新启动 DSH 后端", accelerator: "Ctrl+Shift+R", click: restartServer },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit", label: "退出" },
      ],
    },
    { role: "editMenu", label: "编辑" },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载页面" },
        { role: "forceReload", label: "强制重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "升级状态",
          click: checkUpgrades,
        },
        {
          label: "关于 DeepSeek Harness Desktop",
          click: () => {
            const info = [
              `DeepSeek Harness Desktop ${app.getVersion()}`,
              `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node ${process.versions.node}`,
              "",
              "DSH 本体（@deepseek-ai/dsh）未做任何改动，由本应用作为外部进程托管。",
            ].join("\n");
            void info;
            const { dialog } = require("electron");
            dialog.showMessageBox({ type: "info", title: "关于", message: "DeepSeek Harness Desktop", detail: info });
          },
        },
        { type: "separator" },
        { label: "打开用户数据目录", click: openUserDataDir },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(server) {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "DeepSeek Harness Desktop",
    backgroundColor: "#0b0d12",
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, "..", "..", "assets", "icon.png"),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  denyPermissions(win.webContents);

  // 只允许在本窗口内导航到本地后端同源地址；其余一律交给系统浏览器
  win.webContents.on("will-navigate", (event, url) => {
    if (!server.url || !isServerOrigin(url, server.url)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  // 新窗口一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());

  win.once("ready-to-show", () => win.show());

  // 先加载本地加载页，后端就绪后切换到真实 UI
  win.loadFile(join(__dirname, "..", "..", "assets", "loading.html"));
  let loadedReal = false;

  const onStatus = (s) => {
    if (win.isDestroyed()) return;
    if (s.state === "running" && s.url) {
      const current = win.webContents.getURL();
      if (!current.startsWith(s.url)) {
        win.loadURL(s.url);
      }
      loadedReal = true;
    } else if ((s.state === "starting" || s.state === "restarting" || s.state === "error") && loadedReal) {
      // 后端重启/出错时回到加载页，避免停留在失效页面
      win.loadFile(join(__dirname, "..", "..", "assets", "loading.html"));
    }
  };
  server.on("status", onStatus);

  // 兜底：加载页加载完成时若后端已就绪（但 status 事件可能在订阅前已发出），主动切换
  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    if (server.state === "running" && server.url) {
      const current = win.webContents.getURL();
      if (!current.startsWith(server.url)) {
        win.loadURL(server.url);
      }
      loadedReal = true;
    }
  });

  win.on("closed", () => {
    server.removeListener("status", onStatus);
  });

  if (settings.get("openDevTools")) {
    win.webContents.once("did-finish-load", () => win.webContents.openDevTools({ mode: "detach" }));
  }

  return win;
}

module.exports = { createMainWindow, buildMenu, denyPermissions };
