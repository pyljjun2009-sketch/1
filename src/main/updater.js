/**
 * 升级接口（预留）—— 两条升级轨道，结果一律带显式状态枚举：
 *
 *  track = "app"      桌面应用自升级（electron-updater）。
 *                      已内置 electron-updater 依赖；当且仅当打包产物配置了
 *                      发布源（electron-builder 的 publish 配置生成 app-update.yml）
 *                      时才真正生效，否则返回 status:"not-configured" 与原因。
 *  track = "backend"  DSH 后端（npm 包 @deepseek-ai/dsh）升级。
 *                      check() 已实现：对比本地版本与 npm registry 最新版。
 *                      apply() 为预留 stub（status:"stub"）：替换 BACKEND_UPGRADER
 *                      钩子即可接入真实升级流程（见 UPGRADE.md）。
 *
 * 状态枚举（status）：
 *   not-configured    接口可用但未配置（无发布源 / electron-updater 不可用）
 *   up-to-date        已是最新
 *   update-available  发现新版本（尚未下载）
 *   update-downloaded 新版本已下载（重启应用后安装）
 *   stub              接口预留但未实现（后端自动升级）
 *   error             检查/执行失败（reason 含原因）
 *
 * 对外事件通过 onEvent(cb) 订阅，由 ipc.js 转发到渲染进程。
 */
const { EventEmitter } = require("node:events");

const NPM_REGISTRY = "https://registry.npmjs.org/@deepseek-ai/dsh/latest";
const BACKEND_PACKAGE = "@deepseek-ai/dsh";

/**
 * 预留的后端升级器实现点。
 * 当前为 stub；将来接入真实升级时，实现本对象并替换 `apply`：
 *   1. 用 npm/pnpm 把 BACKEND_PACKAGE 升级到目标版本
 *   2. 校验新版本号（server.detectVersion() 或 package.json）
 *   3. 重启后端（server.restart()）
 * 实现后请返回 { applied: true, version: <新版本> }。
 */
const BACKEND_UPGRADER = {
  async apply({ server, targetVersion }) {
    void server;
    void targetVersion;
    return {
      applied: false,
      status: "stub",
      reason: "后端自动升级尚未实现（预留接口）",
      hint: `请在终端执行: npm i -g ${BACKEND_PACKAGE}@latest，然后从桌面端重启后端（或重启应用）`,
    };
  },
};

class UpgradeManager extends EventEmitter {
  constructor({ server, appUpdaterLoader } = {}) {
    super();
    this.server = server;
    this._appUpdaterEventsWired = false;
    // 可注入的 appUpdater 加载器（测试用）；默认动态导入 electron-updater
    this._appUpdaterLoader =
      appUpdaterLoader || (async () => (await import("electron-updater")).autoUpdater);
  }

  /** 主进程需要把事件推给渲染进程时设置此回调。 */
  setEventSink(fn) {
    this._sink = fn;
  }

  _emit(type, payload) {
    if (this._sink) this._sink({ type, ...payload });
    this.emit(type, payload);
  }

  async check(track) {
    if (track === "backend") return this._checkBackend();
    if (track === "app") return this._checkApp();
    if (track === "profile") return this._checkProfile();
    return { track, status: "error", supported: false, reason: `未知升级轨道: ${track}` };
  }

  async apply(track, targetVersion) {
    if (track === "backend") return this._applyBackend(targetVersion);
    if (track === "app") return this._applyApp();
    if (track === "profile") return this._applyProfile(targetVersion);
    return { track, status: "error", applied: false, reason: `未知升级轨道: ${track}` };
  }

  // ---- 后端轨道 --------------------------------------------------------

  async _checkBackend() {
    const current = this.server.version || (await this.server._detectVersion()) || "unknown";
    try {
      const res = await fetch(NPM_REGISTRY, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
      const meta = await res.json();
      const latest = typeof meta.version === "string" ? meta.version : null;
      const available = Boolean(latest) && latest !== current;
      this._emit("backend-check", { current, latest, available });
      return {
        track: "backend",
        status: available ? "update-available" : "up-to-date",
        supported: true,
        current,
        latest,
        available,
        message: available
          ? `发现 DSH 后端新版本 ${latest}（当前 ${current}）`
          : `当前已是最新版本（${current}）`,
      };
    } catch (err) {
      this._emit("backend-check", { current, latest: null, available: false, error: err.message });
      return {
        track: "backend",
        status: "error",
        supported: true,
        current,
        latest: null,
        available: false,
        message: "无法连接 npm registry 检查后端版本",
        reason: err.message,
      };
    }
  }

  async _applyBackend(targetVersion) {
    this._emit("backend-apply", { phase: "start", targetVersion });
    const result = await BACKEND_UPGRADER.apply({
      server: this.server,
      targetVersion,
    });
    this._emit("backend-apply", { phase: "done", ...result });
    return { track: "backend", ...result };
  }

  // ---- 应用轨道 --------------------------------------------------------

  async _loadAppUpdater() {
    try {
      const autoUpdater = await this._appUpdaterLoader();
      if (!autoUpdater || typeof autoUpdater.checkForUpdates !== "function") return null;
      return autoUpdater;
    } catch {
      return null;
    }
  }

  _wireAppUpdater(autoUpdater) {
    if (this._appUpdaterEventsWired) return;
    this._appUpdaterEventsWired = true;
    autoUpdater.autoDownload = false;
    for (const type of ["checking-for-update", "update-available", "update-not-available", "error", "download-progress", "update-downloaded"]) {
      autoUpdater.on(type, (payload) => {
        this._emit("app-event", { type, payload: payload ? String(payload.message ?? "") : "" });
      });
    }
  }

  async _checkApp() {
    const autoUpdater = await this._loadAppUpdater();
    if (!autoUpdater) {
      return {
        track: "app",
        status: "not-configured",
        supported: false,
        reason: "electron-updater 不可用或未配置发布源（升级接口已预留）",
      };
    }
    this._wireAppUpdater(autoUpdater);
    try {
      const result = await autoUpdater.checkForUpdates();
      const info = result && result.updateInfo;
      const current = autoUpdater.currentVersion ? autoUpdater.currentVersion.toString() : null;
      const latest = info ? info.version : null;
      const available = Boolean(latest) && latest !== current;
      return {
        track: "app",
        status: available ? "update-available" : "up-to-date",
        supported: true,
        current,
        latest,
        available,
        message: available
          ? `发现桌面端新版本 ${latest}（当前 ${current}）`
          : "桌面端已是最新版本",
      };
    } catch (err) {
      const reason = /not packed|app-update\.yml|dev update config/i.test(err.message)
        ? "应用未打包或未配置发布源（publish），应用自升级接口已预留，配置后即生效"
        : err.message;
      return { track: "app", status: "not-configured", supported: false, reason };
    }
  }

  async _applyApp() {
    const autoUpdater = await this._loadAppUpdater();
    if (!autoUpdater) {
      return {
        track: "app",
        status: "not-configured",
        applied: false,
        reason: "electron-updater 不可用或未配置发布源",
      };
    }
    try {
      autoUpdater.autoDownload = true;
      const result = await autoUpdater.checkForUpdates();
      const current = autoUpdater.currentVersion ? autoUpdater.currentVersion.toString() : null;
      const latest = result && result.updateInfo ? result.updateInfo.version : null;
      if (latest && latest !== current) {
        await autoUpdater.downloadUpdate();
        return {
          track: "app",
          status: "update-downloaded",
          applied: true,
          current,
          latest,
          message: "新版本已下载，重启应用后自动安装",
        };
      }
      return { track: "app", status: "up-to-date", applied: false, message: "已是最新版本" };
    } catch (err) {
      return { track: "app", status: "error", applied: false, reason: err.message };
    }
  }

  // ---- Profile 轨道（bundle 依赖更新检测） -------------------------------

  /** 读取 profile 的 package.json 中声明的 bundles。 */
  _readProfileBundles() {
    const { join } = require("node:path");
    const { homedir } = require("node:os");
    const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
    const pkgPath = join(dshHome, "profiles", "web", "package.json");
    try {
      const pkg = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf8"));
      const bundles = pkg["dsh.profile.bundles"] || [];
      const deps = pkg.dependencies || {};
      return { bundles, deps, dshHome };
    } catch {
      return { bundles: [], deps: {}, dshHome };
    }
  }

  /** 检查 profile bundle 是否有可用更新。 */
  async _checkProfile() {
    const { bundles, deps, dshHome } = this._readProfileBundles();
    if (bundles.length === 0) {
      return {
        track: "profile",
        status: "up-to-date",
        supported: true,
        bundles: [],
        message: "未发现 bundle 依赖",
      };
    }

    const updatable = [];
    for (const pkg of bundles) {
      const installed = deps[pkg];
      if (!installed) continue;
      try {
        const res = await fetch(
          `https://registry.npmjs.org/${pkg}/latest`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) continue;
        const meta = await res.json();
        const latest = meta.version;
        if (latest && latest !== installed) {
          updatable.push({ name: pkg, current: installed, latest });
        }
      } catch {
        // 无法访问 registry 的包跳过
      }
    }

    return {
      track: "profile",
      status: updatable.length > 0 ? "update-available" : "up-to-date",
      supported: true,
      bundles: updatable,
      updatableCount: updatable.length,
      totalCount: bundles.length,
      message: updatable.length > 0
        ? `${updatable.length}/${bundles.length} 个 bundle 可更新`
        : `全部 ${bundles.length} 个 bundle 已是最新`,
    };
  }

  /** 执行 profile bundle 更新（通过 dsh plugin update）。 */
  async _applyProfile(targetVersion) {
    const { bundles } = this._readProfileBundles();
    if (bundles.length === 0) {
      return {
        track: "profile",
        status: "up-to-date",
        applied: false,
        message: "未发现 bundle 依赖",
      };
    }
    const { spawnSync } = require("node:child_process");
    const pkg = targetVersion || bundles.join(" ");
    try {
      const r = spawnSync(
        "dsh",
        ["plugin", "--profile", "web", "update", ...pkg.split(" ")],
        { encoding: "utf8", timeout: 120_000, windowsHide: true }
      );
      const success = r.status === 0;
      this._emit("profile-update", { success, output: r.stdout + r.stderr });
      return {
        track: "profile",
        status: success ? "up-to-date" : "error",
        applied: success,
        message: success ? "Profile bundle 已更新（需重启 dsh 后端）" : `更新失败: ${(r.stderr || r.stdout).slice(-200)}`,
      };
    } catch (err) {
      return { track: "profile", status: "error", applied: false, reason: err.message };
    }
  }
}

module.exports = { UpgradeManager, BACKEND_UPGRADER, BACKEND_PACKAGE };
