/**
 * 升级接口—— 三条升级轨道，结果一律带显式状态枚举：
 *
 *  track = "app"      桌面应用自升级（electron-updater）。
 *                      已内置 electron-updater 依赖；当且仅当打包产物配置了
 *                      发布源（electron-builder 的 publish 配置生成 app-update.yml）
 *                      时才真正生效，否则返回 status:"not-configured" 与原因。
 *  track = "backend"  DSH 后端（npm 包 @deepseek-ai/dsh）升级。
 *                      check() 已实现：对比本地版本与 npm registry 最新版。
 *                      apply() 已实现安全升级：备份、安装、校验、同步依赖并重启。
 *  track = "profile"  Profile bundle 依赖检查与更新；成功后自动重启后端。
 *
 * 状态枚举（status）：
 *   not-configured    接口可用但未配置（无发布源 / electron-updater 不可用）
 *   up-to-date        已是最新
 *   update-available  发现新版本（尚未下载）
 *   update-downloaded 新版本已下载（重启应用后安装）
 *   error             检查/执行失败（reason 含原因）
 *
 * 对外事件通过 onEvent(cb) 订阅，由 ipc.js 转发到渲染进程。
 */
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");
const semver = require("semver");

/** 只把更高的合法语义版本视为更新，绝不把旧发布当成升级。 */
function isNewerVersion(latest, current) {
  return Boolean(semver.valid(latest) && semver.valid(current) && semver.gt(latest, current));
}

const NPM_REGISTRY = "https://registry.npmjs.org/@deepseek-ai/dsh/latest";
const BACKEND_PACKAGE = "@deepseek-ai/dsh";

/** npm registry 返回的版本号，或设置页显式指定的安全 semver 版本。 */
function isSafeVersion(version) {
  return typeof version === "string"
    && version.length <= 128
    && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

/**
 * 校验 npm 包名（bundles 声明）：只允许官方包名格式。
 * 用于防止 profile package.json 被污染后，把恶意字符串拼进
 * registry URL / CLI 参数（纵深防御；正常 profile 均为合法包名）。
 * 规则：@scope/name 或 name；每段只含 [a-zA-Z0-9._-]，
 * 且不能以 . 或 _ 开头（npm 规范），长度 ≤ 214。
 */
function isSafePackageName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 214) return false;
  let parts;
  if (name.startsWith("@")) {
    const idx = name.indexOf("/");
    if (idx <= 1 || idx === name.length - 1) return false;
    // scope 段去掉前导 @ 后按普通名称校验（npm 规范：scope 本身是合法名称）
    parts = [name.slice(1, idx), name.slice(idx + 1)];
  } else {
    parts = [name];
  }
  for (const part of parts) {
    if (!/^[a-zA-Z0-9._-]+$/.test(part)) return false;
    if (part.startsWith(".") || part.startsWith("_")) return false;
  }
  return true;
}

/**
 * 用后端已验证的 node + DSH CLI 路径执行子命令。
 * 不经 cmd.exe / shell，避免 PATH/命令行解释器改变参数含义。
 */
function runDshCli(server, args, options = {}) {
  if (!server || typeof server._resolveLaunch !== "function") {
    throw new Error("无法解析 DSH CLI：后端启动器不可用");
  }
  const launch = server._resolveLaunch();
  if (!launch || !Array.isArray(launch.argv) || launch.argv.length < 2 || launch.argv.at(-1) !== "web") {
    throw new Error("无法解析 DSH CLI：启动命令格式不受支持");
  }
  const [command, ...launchArgs] = launch.argv;
  return spawnSync(command, [...launchArgs.slice(0, -1), ...args], {
    encoding: "utf8",
    windowsHide: true,
    ...options,
    shell: false,
  });
}

/**
 * 后端升级器：将官方 @deepseek-ai/dsh 升级到目标版本。
 *
 * 流程（每步失败都有明确回滚/提示）：
 *   1. 备份 profile 关键文件（package.json / pnpm-lock.yaml / cordis.patch.yml）
 *   2. npm install -g @deepseek-ai/dsh@<target>（锁定版本，不顺带升级其他包）
 *   3. 校验：新版本号 + yaml 运行库完整性
 *   4. 若检测到 profile bundle 不一致 → 自动执行 dsh plugin install 修复
 *   5. 重启后端
 */
const BACKEND_UPGRADER = {
  async apply({ server, targetVersion, backupManager, dshHome, execNpm, execDsh }) {
    // execNpm 可注入（测试用）；默认用 spawnSync 执行真实 npm
    const runNpm = execNpm || ((pkgSpec) => {
      const { spawnSync } = require("node:child_process");
      return spawnSync(
        process.platform === "win32" ? "cmd.exe" : "npm",
        process.platform === "win32" ? ["/c", "npm", "install", "-g", pkgSpec] : ["install", "-g", pkgSpec],
        { encoding: "utf8", timeout: 600_000, windowsHide: true, stdio: "pipe" }
      );
    });

    if (targetVersion !== undefined && targetVersion !== null && !isSafeVersion(targetVersion)) {
      return { applied: false, status: "error", reason: "目标版本格式非法，只允许标准 semver 版本号" };
    }
    if (typeof server?._resolveLaunch === "function") {
      const launch = server._resolveLaunch();
      if (!launch || !String(launch.source || "").startsWith("npm global")) {
        return { applied: false, status: "error", reason: "当前 DSH 使用自定义启动命令，无法安全地升级 npm 全局安装" };
      }
    }

    // ---- 1. 备份 profile ----
    let backupId = null;
    if (backupManager) {
      try {
        backupId = backupManager.create(`DSH 升级前自动备份（${targetVersion || "latest"}）`).id;
      } catch (e) {
        return { applied: false, status: "error", reason: `升级前备份失败：${e.message}` };
      }
    }

    // ---- 2. 执行升级（锁定版本，避免顺带升级） ----
    const pkgSpec = targetVersion ? `${BACKEND_PACKAGE}@${targetVersion}` : `${BACKEND_PACKAGE}@latest`;
    let installResult;
    try {
      installResult = runNpm(pkgSpec);
    } catch (err) {
      return { applied: false, status: "error", backupId, reason: `npm 执行失败：${err.message}` };
    }
    if (installResult.status !== 0) {
      return {
        applied: false, status: "error", backupId,
        reason: `npm 安装失败（exit=${installResult.status}）`,
        output: ((installResult.stdout || "") + (installResult.stderr || "")).slice(-500),
        hint: `可回滚备份: ${backupId || "无"}（dsh-desktop/backups）`,
      };
    }

    // ---- 3. 校验新版本 + yaml 完整性 ----
    const newVersion = await server._detectVersion();
    const dshRoot = server._binPath ? require("node:path").join(server._binPath, "..", "..") : null;
    const yamlOk = dshRoot
      ? require("node:fs").existsSync(require("node:path").join(dshRoot, "node_modules", "yaml", "dist", "schema", "yaml-1.1", "merge.js"))
      : false;
    if (!yamlOk) {
      return {
        applied: true, status: "error", version: newVersion, backupId,
        reason: "DSH 已升级但 yaml 运行库文件缺失（安装不完整）",
        hint: `请运行 "npm install -g ${BACKEND_PACKAGE}@${newVersion}" 重装，或回滚备份 ${backupId}`,
      };
    }
    if (targetVersion && String(newVersion || "").replace(/^v/, "") !== targetVersion.replace(/^v/, "")) {
      return {
        applied: true, status: "error", version: newVersion, backupId,
        reason: `DSH 安装完成，但实际版本 ${newVersion || "unknown"} 与目标版本 ${targetVersion} 不一致`,
        hint: `请重新安装 ${BACKEND_PACKAGE}@${targetVersion}，或使用备份 ${backupId} 回滚 Profile`,
      };
    }

    // ---- 4. 升级后修复 profile 一致性（防止 bundle 不匹配导致无法启动） ----
    let resynced = null;
    try {
      const fix = execDsh
        ? execDsh(["plugin", "--profile", "web", "install"])
        : runDshCli(server, ["plugin", "--profile", "web", "install"], { timeout: 300_000, stdio: "pipe" });
      resynced = fix.status === 0;
    } catch {
      resynced = false;
    }

    // ---- 5. 重启后端 ----
    try {
      await server.restart();
    } catch (err) {
      return { applied: true, status: "error", version: newVersion, backupId, reason: `升级成功但后端重启失败：${err.message}` };
    }

    return {
      applied: true,
      status: server.state === "running" ? "up-to-date" : "error",
      version: newVersion,
      backupId,
      resynced,
      message: `DSH 已升级到 ${newVersion}，后端已重启${resynced ? "，Profile 依赖已同步" : ""}`,
    };
  },
};

class UpgradeManager extends EventEmitter {
  constructor({ server, appUpdaterLoader, backupManager, dshHome, dshCliRunner, prepareAppInstall, canInstallApp = true, isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR) } = {}) {
    super();
    this.server = server;
    this.backupManager = backupManager;
    this.dshHome = dshHome;
    this._appUpdaterEventsWired = false;
    this._inFlightTracks = new Set();
    this._runDshCli = dshCliRunner || runDshCli;
    this._prepareAppInstall = prepareAppInstall;
    this._isPortable = isPortable;
    this._canInstallApp = canInstallApp;
    this._appDownload = null;
    this._appCheckPromise = null;
    this._installing = false;
    // 可注入的 appUpdater 加载器（测试用）；默认动态导入 electron-updater
    this._appUpdaterLoader =
      appUpdaterLoader || (async () => require("electron-updater").autoUpdater);
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
    if (this._installing) return { track, status: "error", applied: false, reason: "桌面应用正在准备安装，请勿执行其他更新" };
    if (!["backend", "app", "profile"].includes(track)) {
      return { track, status: "error", applied: false, reason: `未知升级轨道: ${track}` };
    }
    if (this._inFlightTracks.has(track)) {
      return { track, status: "error", applied: false, reason: `${track} 升级正在进行，请勿重复操作` };
    }
    this._inFlightTracks.add(track);
    try {
      if (track === "backend") return await this._applyBackend(targetVersion);
      if (track === "app") return await this._applyApp();
      return await this._applyProfile(targetVersion);
    } finally {
      this._inFlightTracks.delete(track);
    }
  }

  // ---- 后端轨道 --------------------------------------------------------

  async _checkBackend() {
    const current = this.server.version || (await this.server._detectVersion()) || "unknown";
    try {
      const res = await fetch(NPM_REGISTRY, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
      const meta = await res.json();
      const latest = typeof meta.version === "string" ? meta.version : null;
      if (!latest || !isSafeVersion(latest)) throw new Error("registry 返回了无效版本号");
      if (!semver.valid(current)) throw new Error("当前后端版本无法识别，无法安全比较版本");
      const available = isNewerVersion(latest, current);
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
      backupManager: this.backupManager,
      dshHome: this.dshHome,
    });
    this._emit("backend-apply", { phase: "done", ...result });
    return { track: "backend", ...result };
  }

  // ---- 应用轨道 --------------------------------------------------------

  async _loadAppUpdater() {
    try {
      if (this._appUpdater) return this._appUpdater;
      const autoUpdater = await this._appUpdaterLoader();
      if (!autoUpdater || typeof autoUpdater.checkForUpdates !== "function") return null;
      this._appUpdater = autoUpdater;
      return autoUpdater;
    } catch {
      return null;
    }
  }

  _wireAppUpdater(autoUpdater) {
    if (this._appUpdaterEventsWired) return;
    this._appUpdaterEventsWired = true;
    autoUpdater.autoDownload = false;
    // 使用已安装的 electron-updater 6.x API；只在用户明确确认时安装。
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableWebInstaller = true;
    for (const type of ["checking-for-update", "update-available", "update-not-available", "error", "download-progress", "update-downloaded"]) {
      autoUpdater.on(type, (payload) => {
        if (type === "update-downloaded" && isNewerVersion(payload?.version, autoUpdater.currentVersion?.toString())) {
          this._appDownload = { track: "app", status: "update-downloaded", supported: true, applied: true, current: autoUpdater.currentVersion.toString(), latest: payload.version, message: "更新已下载并校验，请保存工作后点击重启安装" };
        }
        if (type === "error") this._installing = false;
        this._emit("app-event", {
          event: type,
          message: payload?.message ? String(payload.message) : "",
          version: typeof payload?.version === "string" ? payload.version : null,
          percent: Number.isFinite(payload?.percent) ? Math.max(0, Math.min(100, payload.percent)) : null,
        });
      });
    }
  }

  async _checkApp() {
    if (this._isPortable) return { track: "app", status: "not-configured", supported: false, reason: "便携版不支持自动替换，请下载并安装 NSIS 安装版以启用自动升级" };
    if (!this._canInstallApp) return { track: "app", status: "not-configured", supported: false, reason: "当前是开发或解包目录，请先运行 NSIS 安装包；安装版支持后续自动升级" };
    if (this._appDownload) return this._appDownload;
    if (this._appCheckPromise) return this._appCheckPromise;
    this._appCheckPromise = this._checkAppOnce();
    try { return await this._appCheckPromise; } finally { this._appCheckPromise = null; }
  }

  async _checkAppOnce() {
    const autoUpdater = await this._loadAppUpdater();
    if (!autoUpdater) {
      return {
        track: "app",
        status: "not-configured",
        supported: false,
        reason: "electron-updater 不可用或未配置发布源（升级接口已预留）",
      };
    }
    // 每次 check 都重置，避免先前的下载流程改变 autoDownload 后造成静默下载。
    autoUpdater.autoDownload = false;
    this._wireAppUpdater(autoUpdater);
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.updateInfo) return { track: "app", status: "not-configured", supported: false, reason: "开发模式不检查应用更新，请使用正式安装版" };
      const info = result.updateInfo;
      const current = autoUpdater.currentVersion ? autoUpdater.currentVersion.toString() : null;
      const latest = info ? info.version : null;
      if (!semver.valid(latest) || !semver.valid(current)) throw new Error("更新源或当前应用版本号无效");
      const available = isNewerVersion(latest, current) && !semver.prerelease(latest) && result.isUpdateAvailable !== false;
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
      const missingConfig = /not packed|app-update\.yml|dev update config/i.test(err.message);
      const reason = missingConfig
        ? "应用未打包或未配置发布源（publish），应用自升级接口已预留，配置后即生效"
        : err.message;
      return { track: "app", status: missingConfig ? "not-configured" : "error", supported: !missingConfig, reason };
    }
  }

  async _applyApp() {
    if (this._appDownload) return this._appDownload;
    const checked = await this._checkApp();
    if (checked.status !== "update-available") return { ...checked, applied: false };
    const autoUpdater = await this._loadAppUpdater();
    try {
      // 显式下载一次；若 autoDownload=true，checkForUpdates 已会自动下载，随后再调用
      // downloadUpdate 会造成重复下载/竞态。
      autoUpdater.autoDownload = false;
      const { current, latest } = checked;
      if (isNewerVersion(latest, current)) {
        await autoUpdater.downloadUpdate();
        this._appDownload = {
          track: "app",
          status: "update-downloaded",
          applied: true,
          current,
          latest,
          supported: true,
          message: "新版本已下载并校验，请保存工作后点击重启安装",
        };
        return this._appDownload;
      }
      return { track: "app", status: "up-to-date", applied: false, message: "已是最新版本" };
    } catch (err) {
      return { track: "app", status: "error", applied: false, reason: err.message };
    }
  }

  /** 安装前先备份并停止后端；只有本地设置页的明确操作才能调用。 */
  async installApp() {
    if (this._isPortable || !this._canInstallApp || !this._appDownload) return { status: "error", reason: "请先使用安装版下载更新" };
    if (this._installing || this._inFlightTracks.size) return { status: "error", reason: "还有升级操作正在进行，请稍后再试" };
    const autoUpdater = await this._loadAppUpdater();
    if (typeof autoUpdater?.quitAndInstall !== "function" || typeof this._prepareAppInstall !== "function") return { status: "error", reason: "安装准备接口不可用" };
    this._installing = true;
    try {
      await this._prepareAppInstall();
      // 先让 IPC 响应返回，再退出并执行已下载的 NSIS 安装器。
      setImmediate(() => {
        try { autoUpdater.quitAndInstall(false, true); } catch (err) {
          this._installing = false;
          this._emit("app-event", { event: "error", message: err.message });
        }
      });
      return { status: "installing", message: "正在退出并安装更新" };
    } catch (err) {
      this._installing = false;
      return { status: "error", reason: `安装准备失败：${err.message}` };
    }
  }

  // ---- Profile 轨道（bundle 依赖更新检测） -------------------------------

  /** 读取 profile 的 package.json 中声明的 bundles。 */
  _readProfileBundles() {
    const { join } = require("node:path");
    const { homedir } = require("node:os");
    const dshHome = this.dshHome || process.env.DSH_HOME || join(homedir(), ".dsh");
    const pkgPath = join(dshHome, "profiles", "web", "package.json");
    try {
      const pkg = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf8"));
      const rawBundles = pkg["dsh.profile.bundles"] || [];
      if (!Array.isArray(rawBundles)) {
        return { bundles: [], invalidBundles: [rawBundles], deps: {}, dshHome, error: "dsh.profile.bundles 必须是数组" };
      }
      const deps = pkg.dependencies && typeof pkg.dependencies === "object" && !Array.isArray(pkg.dependencies)
        ? pkg.dependencies
        : {};
      const bundles = rawBundles.filter((value) => isSafePackageName(value));
      const invalidBundles = rawBundles.filter((value) => !isSafePackageName(value));
      return { bundles, invalidBundles, deps, dshHome, error: null };
    } catch (err) {
      return { bundles: [], invalidBundles: [], deps: {}, dshHome, error: `Profile package.json 无法读取：${err.message}` };
    }
  }

  /** 检查 profile bundle 是否有可用更新。 */
  async _checkProfile() {
    const { bundles, invalidBundles, deps, error } = this._readProfileBundles();
    if (error || invalidBundles.length > 0) {
      return {
        track: "profile",
        status: "error",
        supported: true,
        bundles: [],
        reason: error || `发现 ${invalidBundles.length} 个非法 bundle 声明，请先修复 package.json`,
      };
    }
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
    // 每批最多 4 个请求：避免逐个等待，又不会对 npm registry 发起无上限并发。
    const BATCH_SIZE = 4;
    for (let offset = 0; offset < bundles.length; offset += BATCH_SIZE) {
      const batch = bundles.slice(offset, offset + BATCH_SIZE);
      const results = await Promise.all(batch.map(async (pkg) => {
        const installed = deps[pkg];
        if (!installed || !isSafePackageName(pkg)) return null;
        try {
          const res = await fetch(
            `https://registry.npmjs.org/${pkg}/latest`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (!res.ok) return null;
          const meta = await res.json();
          const latest = meta.version;
          return latest && latest !== installed ? { name: pkg, current: installed, latest } : null;
        } catch {
          return null; // 无法访问 registry 的包跳过
        }
      }));
      for (const result of results) if (result) updatable.push(result);
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
    const { bundles, invalidBundles, error } = this._readProfileBundles();
    if (error || invalidBundles.length > 0) {
      return {
        track: "profile",
        status: "error",
        applied: false,
        reason: error || `发现 ${invalidBundles.length} 个非法 bundle 声明，已拒绝更新`,
      };
    }
    if (bundles.length === 0) {
      return {
        track: "profile",
        status: "up-to-date",
        applied: false,
        message: "未发现 bundle 依赖",
      };
    }
    if (targetVersion !== undefined && targetVersion !== null) {
      return {
        track: "profile",
        status: "error",
        applied: false,
        reason: "Profile 更新只允许已声明的 bundle，不接受任意目标包",
      };
    }
    try {
      const r = this._runDshCli(this.server, ["plugin", "--profile", "web", "update", ...bundles], { timeout: 120_000 });
      const success = r.status === 0;
      this._emit("profile-update", { success, output: r.stdout + r.stderr });
      if (!success) {
        return {
          track: "profile",
          status: "error",
          applied: false,
          message: `更新失败: ${(r.stderr || r.stdout || `exit=${r.status}`).slice(-200)}`,
        };
      }
      const restarted = await this.server.restart();
      if (!restarted || restarted.state !== "running") {
        return {
          track: "profile",
          status: "error",
          applied: true,
          reason: `Profile bundle 已更新，但后端重启失败：${restarted?.error || restarted?.state || "unknown"}`,
        };
      }
      return {
        track: "profile",
        status: "up-to-date",
        applied: true,
        restarted: true,
        message: "Profile bundle 已更新，DSH 后端已重启",
      };
    } catch (err) {
      return { track: "profile", status: "error", applied: false, reason: err.message };
    }
  }
}

module.exports = { UpgradeManager, BACKEND_UPGRADER, BACKEND_PACKAGE, isSafeVersion, isSafePackageName, isNewerVersion, runDshCli };
