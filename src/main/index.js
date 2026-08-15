/**
 * 应用入口：
 *   1. 早期：userData 覆盖（测试隔离）-> GPU 渲染策略 -> 单实例锁
 *   2. ready：初始化配置 -> 启动后端 -> 建窗 -> 接线 IPC
 *
 * 冒烟模式（DSH_DESKTOP_SMOKE=1）输出机器可读结果并带退出码：
 *   DSH_DESKTOP_SMOKE_OK                                        退出码 0
 *   DSH_DESKTOP_SMOKE_FAIL reason=already-running                1
 *   DSH_DESKTOP_SMOKE_FAIL reason=ready-timeout                  1
 *   DSH_DESKTOP_SMOKE_FAIL reason=backend-start                   1
 *   DSH_DESKTOP_SMOKE_FAIL reason=backend-timeout                 1
 *   DSH_DESKTOP_SMOKE_FAIL reason=page-timeout                    1
 *   FAIL 行附带完整诊断：state/error/cwd/launchCommand/launchSource/binPath/version/lastExit/logTail
 *
 * GPU 渲染策略（解决 GPU 进程崩溃导致应用直接退出，Windows 上已复现）：
 *   优先级：--safe-mode（=inprocess）> --hardware-acceleration（=auto）
 *   > $DSH_DESKTOP_GPU（auto|off|inprocess）> $DSH_DESKTOP_DISABLE_GPU=1（=off）
 *   > settings.json 的 gpuMode / disableHardwareAcceleration=true（=off）
 *   > 平台默认：Windows = "inprocess"（软件渲染并入浏览器进程，规避 GPU 子进程崩溃），
 *     其他平台 = "auto"。
 *   另有 $DSH_DESKTOP_NO_SANDBOX=1 可追加 --no-sandbox（虚拟机/受限环境的最后手段）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { settings } = require("./config.js");
const { DshServer } = require("./dsh-server.js");
const { createMainWindow, buildMenu } = require("./window.js");
const { UpgradeManager } = require("./updater.js");
const { registerIpc } = require("./ipc.js");

const SMOKE_READY_TIMEOUT_MS = 30_000;
const SMOKE_PAGE_TIMEOUT_MS = 60_000;
const SMOKE_BACKEND_TIMEOUT_MS = 90_000;

function dbg(msg) {
  if (process.env.DSH_DESKTOP_DEBUG === "1") console.error(`[dsh-desktop:dbg] ${msg}`);
}

function smokePrint(line) {
  console.log(line);
  process.exitCode = line.startsWith("DSH_DESKTOP_SMOKE_OK") ? 0 : 1;
}

// ---- 1. 早期初始化 ------------------------------------------------------

// 测试隔离：允许覆盖 userData 目录（必须在读取配置之前）
if (process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.DSH_DESKTOP_USER_DATA));
  dbg(`userData overridden: ${app.getPath("userData")}`);
}

// GPU 渲染策略解析
let gpuMode = null;
if (process.argv.includes("--safe-mode")) gpuMode = "inprocess";
else if (process.argv.includes("--hardware-acceleration")) gpuMode = "auto";
else if (process.env.DSH_DESKTOP_GPU) gpuMode = process.env.DSH_DESKTOP_GPU;
else if (process.env.DSH_DESKTOP_DISABLE_GPU === "1") gpuMode = "off";
else {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(app.getPath("userData"), "settings.json"), "utf8")
    );
    if (cfg && typeof cfg === "object") {
      gpuMode = cfg.gpuMode ?? (cfg.disableHardwareAcceleration === true ? "off" : null);
    }
  } catch {
    /* 无配置文件 */
  }
}
if (gpuMode === null) {
  // 平台默认：Windows 上 GPU 进程崩溃高发（远程桌面/虚拟机/驱动），默认 inprocess 保证可启动
  gpuMode = process.platform === "win32" ? "inprocess" : "auto";
}
if (!["auto", "off", "inprocess"].includes(gpuMode)) {
  dbg(`非法 GPU 模式 ${gpuMode}，回退平台默认`);
  gpuMode = process.platform === "win32" ? "inprocess" : "auto";
}
if (gpuMode !== "auto") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  if (gpuMode === "inprocess") app.commandLine.appendSwitch("in-process-gpu");
  dbg(`GPU 渲染策略: ${gpuMode}（软件渲染）`);
} else {
  dbg("GPU 渲染策略: auto（硬件加速）");
}
if (process.env.DSH_DESKTOP_NO_SANDBOX === "1") {
  app.commandLine.appendSwitch("no-sandbox");
  dbg("no-sandbox 已启用");
}

const gotLock = app.requestSingleInstanceLock();
dbg(`singleInstanceLock=${gotLock}`);
if (!gotLock) {
  if (process.env.DSH_DESKTOP_SMOKE === "1") {
    smokePrint("DSH_DESKTOP_SMOKE_FAIL reason=already-running");
    app.exit(1);
  }
  app.quit();
} else {
  let mainWindow = null;
  let server = null;
  let smokeTimer = null;
  let quitting = false;

  // 冒烟：ready 超时守卫
  if (process.env.DSH_DESKTOP_SMOKE === "1") {
    setTimeout(() => {
      if (!app.isReady()) {
        smokePrint("DSH_DESKTOP_SMOKE_FAIL reason=ready-timeout（app ready 未触发，多为 GPU/Chromium 初始化失败）");
        app.exit(1);
      }
    }, SMOKE_READY_TIMEOUT_MS);
  }

  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      // keepBackendRunning 模式下窗口已关，再次启动实例时唤回窗口
      if (server) mainWindow = createMainWindow(server);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    dbg("whenReady: start");
    settings.init(app);
    dbg("whenReady: settings initialized");
    server = new DshServer();
    const upgradeManager = new UpgradeManager({ server });
    dbg("whenReady: server/upgrade created");

    buildMenu({
      restartServer: () => server.restart(),
      openUserDataDir: () => {
        const { shell } = require("electron");
        shell.openPath(app.getPath("userData"));
      },
      checkUpgrades: async () => {
        // 帮助菜单"升级状态"：诚实展示两条轨道的当前能力
        const { dialog } = require("electron");
        const appResult = await upgradeManager.check("app");
        const backendResult = await upgradeManager.check("backend");
        const fmt = (r) =>
          `${r.track === "app" ? "桌面应用" : "DSH 后端"}：${r.status}${
            r.status === "update-available" && r.latest ? `（${r.current} → ${r.latest}）` : ""
          }${r.message ? `\n    ${r.message}` : ""}${r.reason ? `\n    原因: ${r.reason}` : ""}${
            r.hint ? `\n    指引: ${r.hint}` : ""
          }`;
        dialog.showMessageBox({
          type: "info",
          title: "升级状态",
          message: "升级能力状态",
          detail: [fmt(appResult), fmt(backendResult), "", "注意：后端轨道当前仅支持检测，一键升级尚未实现（预留接口）。"].join("\n"),
        });
      },
    });

    registerIpc({ server, getWindow: () => mainWindow, upgradeManager });
    dbg("whenReady: ipc registered");

    mainWindow = createMainWindow(server);
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    dbg("whenReady: window created");

    // 冒烟模式：后端就绪 + 页面加载两个独立断言
    if (process.env.DSH_DESKTOP_SMOKE === "1") {
      let smokeDone = false;
      let pageTimer = null;

      /** FAIL 行附带完整诊断，便于定位（cwd/命令/来源/bin/版本/退出信息/日志）。 */
      const smokeFail = (reason) => {
        if (smokeDone) return;
        smokeDone = true;
        const s = server ? server.status() : {};
        const detail = [
          `reason=${reason}`,
          `state=${s.state ?? "?"}`,
          s.error ? `error=${s.error}` : null,
          s.cwd ? `cwd=${s.cwd}` : null,
          s.launchCommand ? `command=${s.launchCommand.join(" ")}` : null,
          s.launchSource ? `source=${s.launchSource}` : null,
          s.binPath ? `bin=${s.binPath}` : null,
          s.version ? `dsh=${s.version}` : null,
          s.lastExit ? `lastExit=${JSON.stringify(s.lastExit)}` : null,
          (s.logTail && s.logTail.length ? `logTail=${JSON.stringify(s.logTail.slice(-60))}` : null),
        ]
          .filter(Boolean)
          .join(" ");
        smokePrint(`DSH_DESKTOP_SMOKE_FAIL ${detail}`);
      };

      const smokeCleanup = async () => {
        if (pageTimer) clearTimeout(pageTimer);
        if (smokeTimer) clearTimeout(smokeTimer);
        if (server) await server.stop(); // app.exit 不触发 quit 事件，需先确认式清理后端进程树
      };

      // 断言 2/2：真实页面（http://）完成加载
      const checkPage = async () => {
        if (smokeDone) return;
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed() && win.webContents.getURL().startsWith("http://")) {
          if (server.state !== "running") {
            smokeFail(`backend-start（页面已加载但后端未就绪，state=${server.state}）`);
            await smokeCleanup();
            app.exit(1);
            return;
          }
          smokeDone = true;
          if (pageTimer) clearTimeout(pageTimer);
          if (smokeTimer) clearTimeout(smokeTimer);
          console.log(
            `DSH_DESKTOP_SMOKE_OK url=${win.webContents.getURL()} state=${server.state} pid=${server.pid} dsh=${server.version}`
          );
          await smokeCleanup();
          app.exit(0);
        }
      };

      // 断言 1/2：后端就绪（后台断言 + 页面超时守卫）
      const checkBackend = async () => {
        if (smokeDone) return;
        if (server.state === "running") {
          if (pageTimer) clearTimeout(pageTimer);
          pageTimer = setTimeout(() => smokeFail("page-timeout"), SMOKE_PAGE_TIMEOUT_MS);
          checkPage();
        } else if (server.state === "error") {
          smokeFail(`backend-start（后端进入 error 状态）`);
          await smokeCleanup();
          app.exit(1);
        }
      };

      smokeTimer = setTimeout(async () => {
        smokeFail("backend-timeout");
        await smokeCleanup();
        app.exit(1);
      }, SMOKE_BACKEND_TIMEOUT_MS);

      server.on("status", checkBackend);
      mainWindow.webContents.on("did-finish-load", checkPage);
      setTimeout(checkPage, 5000);
    }

    try {
      await server.start();
      dbg(`server.start done: state=${server.state} url=${server.url}`);
    } catch (err) {
      console.error("[dsh-desktop] 后端启动失败:", err);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) {
      mainWindow = createMainWindow(server);
    }
  });

  app.on("window-all-closed", () => {
    if (settings.get("keepBackendRunning")) {
      dbg("窗口已关闭；keepBackendRunning=true，后端保持运行（再次启动应用可唤回窗口）");
      return;
    }
    if (process.platform !== "darwin") app.quit();
  });

  // 退出前确认式停止后端（preventDefault + 完成后放行），避免子进程树残留
  app.on("before-quit", (event) => {
    if (quitting) return;
    if (server && server.state !== "stopped") {
      event.preventDefault();
      dbg("before-quit: 正在确认式停止后端…");
      server
        .stop()
        .then(() => {
          quitting = true;
          app.quit();
        })
        .catch(() => {
          quitting = true;
          app.quit();
        });
    }
  });
}
