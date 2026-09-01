/**
 * DSH 后端生命周期管理。
 *
 * 职责：
 *  1. 解析 dsh 可执行入口（设置覆盖 -> npm 全局安装 -> PATH 兜底）
 *  2. 固定工作目录：settings.workingDirectory -> $DSH_HOME -> <userData>/workspace
 *  3. 挑选空闲端口并以 `dsh web --host <host> --port <port>` 启动
 *  4. 轮询 HTTP 就绪（2xx/3xx 视为就绪），通知上层进入 running
 *  5. 日志尾部缓冲、异常退出自动重启（指数退避 1s/3s/10s，最多 3 次）、
 *     进程树级清理（Windows 用 taskkill /T）
 *
 * 不修改 DSH 本体任何文件 —— 只作为外部进程的宿主。
 */
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { existsSync, readFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const { settings } = require("./config.js");

const READY_TIMEOUT_MS = 90_000;
const LOG_TAIL_LINES = 200;
const MAX_CRASH_RESTARTS = 3;
/** 指数退避（秒），按第 N 次崩溃取值。 */
const RESTART_BACKOFF_SECONDS = [1, 3, 10];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造 http URL（IPv6 需方括号）。 */
function httpUrl(host, port) {
  const hostDisplay = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostDisplay}:${port}/`;
}

/** 找一个空闲端口：优先使用首选端口，否则由 OS 分配。整体加 10s 超时兜底。 */
function findFreePort(preferred, host) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { srv.close(); } catch { /* 忽略 */ }
      try { srv2.close(); } catch { /* 忽略 */ }
      reject(new Error("端口分配超时"));
    }, 10_000);
    const done = (err, port) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(port);
    };
    const srv = net.createServer();
    srv.unref();
    srv.on("error", () => {
      // 首选端口被占用：让 OS 分配
      const srv2 = net.createServer();
      srv2.unref();
      srv2.on("error", (e) => done(e));
      srv2.listen(0, host, () => {
        const p = srv2.address().port;
        srv2.close(() => done(null, p));
      });
    });
    srv.listen(preferred, host, () => {
      const p = srv.address().port;
      srv.close(() => done(null, p));
    });
  });
}

/** 进程是否存在（Windows 用 tasklist，其他平台用 signal 0）。 */
function pidExists(pid) {
  if (!pid) return false;
  if (process.platform === "win32") {
    try {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 3_000, // tasklist 正常 <500ms；缩短超时减少 stop() 期间阻塞
      });
      // 超时/命令失败（status===null）无法确认进程状态：保守假设存活，
      // 避免 waitPidGone/stop() 误判"已退出"导致假成功
      if (r.status === null) return true;
      return r.status === 0 && r.stdout.includes(`"${pid}"`);
    } catch {
      return true; // 查询失败时保守假设存活
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 枚举某进程的整棵后代树（Windows：wmic -> PowerShell 兜底，尽力而为）。
 * 用于确认 taskkill /T 之后树内没有残留（例如 detached 逃逸的孙进程）。
 */
function listDescendants(rootPid) {
  if (process.platform !== "win32" || !rootPid) return [];
  const rows = readProcessTable();
  const byParent = new Map();
  for (const [pid, ppid] of rows) {
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(pid);
  }
  const found = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const pid of byParent.get(parent) || []) {
      if (!found.has(pid)) {
        found.add(pid);
        queue.push(pid);
      }
    }
  }
  return [...found];
}

/** 读取进程表 [pid, ppid] 列表（wmic 优先，失败用 PowerShell 兜底）。 */
function readProcessTable() {
  // 同步调用会阻塞主进程：wmic 正常 <1s，超时从 15s 缩短到 5s，
  // 兜底 powershell 从 20s 缩短到 8s，尽量缩短 UI 冻结窗口
  const wmic = spawnSync(
    "wmic",
    ["process", "get", "ProcessId,ParentProcessId", "/FORMAT:CSV"],
    { windowsHide: true, encoding: "utf8", timeout: 5_000 }
  );
  if (wmic.status === 0 && wmic.stdout) {
    const rows = [];
    for (const line of wmic.stdout.split(/\r?\n/)) {
      const parts = line.split(",").map((s) => s.trim());
      // CSV 格式: Node,ParentProcessId,ProcessId
      const ppid = Number(parts[1]);
      const pid = Number(parts[2]);
      if (Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid)) rows.push([pid, ppid]);
    }
    if (rows.length > 0) return rows;
  }
  try {
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, encoding: "utf8", timeout: 8_000 }
    );
    if (ps.status === 0 && ps.stdout) {
      const rows = [];
      const arr = JSON.parse(ps.stdout);
      for (const item of Array.isArray(arr) ? arr : [arr]) {
        const pid = Number(item.ProcessId);
        const ppid = Number(item.ParentProcessId);
        if (Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid)) rows.push([pid, ppid]);
      }
      if (rows.length > 0) return rows;
    }
  } catch {
    /* 兜底失败 */
  }
  return [];
}

/** 轮询等待主 pid 消失；超时返回 false。 */
async function waitPidGone(pid, timeoutMs = 5000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return true;
    await sleep(intervalMs);
  }
  return !pidExists(pid);
}

/**
 * 分析 dsh 后端日志，识别已知错误模式并返回针对性诊断信息。
 * 基于用户经验总结中的故障排查文档。
 */
function analyzeDshError(logTail) {
  const arr = Array.isArray(logTail) ? logTail : [];
  const text = arr.map(String).join("\n");
  const patterns = [
    {
      test: /already owned by process (\d+)/,
      msg: (m) => `插件锁冲突：任务看板 (task-board) 的 ledger 已被进程 ${m[1]} 占用。另一个 dsh web 实例正在运行同一 profile。请关闭该实例后重试，或在 settings.json 中设置 reuseExistingDsh: true 复用已有实例。`,
    },
    {
      test: /cannot resolve profile bundle(?:\s+"?([^"\s]+)"?)?/,
      msg: (m) => {
        const bundle = m[1] || "未知";
        return `Profile bundle 解析失败：${bundle} 已声明但未安装（package.json / pnpm-lock.yaml / node_modules 状态不一致）。请运行 "dsh plugin --profile web install" 同步依赖后重启。`;
      },
    },
    {
      test: /Cannot find package/,
      msg: (m) => `插件依赖缺失：${m[0].split("Cannot find package")[1]?.trim() || "未知包"}。请检查 cordis.patch.yml 中的引用是否正确。`,
    },
    {
      test: /Cannot find module.*yaml/,
      msg: () => "DSH 全局运行库损坏：yaml 模块文件缺失。请运行 'npm install -g @deepseek-ai/dsh' 重装全局 DSH（同版本），不要删除 ~/.dsh 目录。",
    },
    {
      test: /Cannot find module/,
      msg: (m) => {
        const mod = m[0].split("Cannot find module")[1]?.trim().replace(/['"]/g, "") || "未知模块";
        if (mod.includes("node_modules") && !mod.startsWith(".")) {
          return `DSH 运行库模块缺失：${mod}。请运行 "npm install -g @deepseek-ai/dsh" 重装全局 DSH。`;
        }
        return `模块缺失：${mod}。如果是 profile 相关模块，请运行 "dsh plugin --profile web install"；如果是 DSH 核心模块，请重装全局 DSH。`;
      },
    },
    {
      test: /without inject/,
      msg: () => "插件缺少依赖注入声明（inject）。请检查插件是否兼容当前 DSH 版本。",
    },
    {
      test: /must declare output/,
      msg: () => "插件使用了旧版工具注册协议。请升级插件到兼容当前 DSH 版本的版本。",
    },
    {
      test: /pending \(waiting for service\)/,
      msg: () => "插件等待了不存在的服务。可能是插件顺序依赖问题或配置错误。",
    },
    {
      test: /EPERM.*operation not permitted/,
      msg: (m) => `目录权限异常（EPERM）。请检查 ~/.dsh/profiles/web/ 的写入权限。`,
    },
  ];
  for (const { test, msg } of patterns) {
    const m = text.match(test);
    if (m) return msg(m);
  }
  return null;
}

class DshServer extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.state = "stopped"; // stopped | starting | running | error
    this.url = null;
    this.port = null;
    this.pid = null;
    this.version = null;
    this.error = null;
    this.cwd = null;
    this.launchCommand = null;
    this.lastExit = null;
    this.logTail = [];
    this.readyTimeoutMs = READY_TIMEOUT_MS;
    this._stopRequested = false;
    this._crashCount = 0;
    this._restartPending = false;
    this._restartTimer = null;
    this._nodeBin = null;
    this._binPath = null;
    this._launchSource = null;
    // 残留检测可注入（单测用）；默认使用模块级实现
    this._pidExists = pidExists;
    this._listDescendants = listDescendants;
  }

  _pushLog(line) {
    this.logTail.push(String(line).replace(/\s+$/, ""));
    if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift();
  }

  _setState(state, extra = {}) {
    this.state = state;
    Object.assign(this, extra);
    this.emit("status", this.status());
  }

  /** 安全发射 error 事件：无监听者时不抛 ERR_UNHANDLED_ERROR（错误已可通过 status() 读取）。 */
  _emitError(status) {
    if (this.listenerCount("error") > 0) this.emit("error", status);
  }

  status() {
    return {
      state: this.state,
      url: this.url,
      port: this.port,
      pid: this.pid,
      version: this.version,
      error: this.error,
      cwd: this.cwd,
      launchCommand: this.launchCommand,
      lastExit: this.lastExit,
      crashCount: this._crashCount,
      logTail: this.logTail.slice(-60),
      nodeBin: this._nodeBin,
      binPath: this._binPath,
      launchSource: this._launchSource,
    };
  }

  /** 解析 npm 全局根目录（Windows 下 npm 是 .cmd，需经 cmd 调用）。 */
  _npmGlobalRoot() {
    try {
      const cmd = process.platform === "win32" ? "cmd.exe" : "npm";
      const args = process.platform === "win32" ? ["/c", "npm", "root", "-g"] : ["root", "-g"];
      const out = execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 20_000 });
      return out.trim();
    } catch {
      return null;
    }
  }

  /**
   * 解析要启动的 argv（不含 --host/--port）。
   * 优先级：settings.dshCommand > 自动探测（npm 全局安装的 @deepseek-ai/dsh） > PATH 中的 dsh。
   */
  _resolveLaunch() {
    const custom = settings.get("dshCommand");
    if (Array.isArray(custom) && custom.length > 0) {
      return { argv: [...custom], source: "settings.dshCommand" };
    }

    const nodeBin = settings.get("nodeBin") || process.env.DSH_DESKTOP_NODE || "node";
    const root = this._npmGlobalRoot();
    if (root) {
      const bin = join(root, "@deepseek-ai", "dsh", "lib", "bin.js");
      if (existsSync(bin)) {
        this._nodeBin = nodeBin;
        this._binPath = bin;
        return { argv: [nodeBin, bin, "web"], source: `npm global (${root})` };
      }
    }
    // 不再通过 shell (cmd.exe/dsh.cmd) 兜底 —— 避免产生 cmd.exe 包装进程，
    // 且 PATH 下的 dsh.cmd 版本与 npm global 版本可能不一致。
    return null; // null = 无法解析启动命令，由 _preflight 生成明确错误
  }

  /**
   * 固定后端工作目录（启动前确保存在）：
   * settings.workingDirectory -> $DSH_HOME -> <userData>/workspace
   */
  _resolveWorkingDir() {
    const configured = settings.get("workingDirectory");
    let dir = null;
    if (typeof configured === "string" && configured.trim()) {
      dir = configured.trim();
    } else if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) {
      dir = process.env.DSH_HOME.trim();
    } else if (settings.userDataDir) {
      dir = join(settings.userDataDir, "workspace");
    } else {
      dir = process.cwd();
    }
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      this._pushLog(`[dsh-desktop] 工作目录创建失败（${dir}）: ${err.message}`);
    }
    return dir;
  }

  /** 检测指定地址是否已有 HTTP 服务运行（如外部脚本启动的 dsh web）。 */
  async _probeUrl(url, timeoutMs = 3000) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      // 消费响应体，释放连接（避免 keep-alive 连接泄漏）
      await res.arrayBuffer().catch(() => {});
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /** 启动前检测端口占用：若已有 dsh web 实例运行在常用端口，输出警告。 */
  async _warnPortOccupied(host) {
    for (const probePort of [3080, 8080]) {
      const probeUrl = httpUrl(host, probePort);
      if (await this._probeUrl(probeUrl)) {
        this._pushLog(
          `[dsh-desktop] ⚠ 检测到端口 ${probePort} 已有服务运行（可能是外部启动的 dsh web）：${probeUrl}。如需复用，在 settings.json 设置 port:${probePort}；如需独立，在 settings.json 设置 port:0`
        );
      }
    }
  }

  /**
   * 复用模式：检测并连接已有的 DSH Web 实例。
   * 验证目标是 DSH（检查页面标题含 "DeepSeek" 或页面内容含 "__DSH_BOOT__"）
   * 后直接挂接，不重新启动后端。
   */
  async _tryReuse(host) {
    const candidates = [Number(settings.get("port")) || 3080, 3080];
    for (const probePort of [...new Set(candidates)]) {
      const probeUrl = httpUrl(host, probePort);
      try {
        const res = await fetch(probeUrl, { signal: AbortSignal.timeout(5000) });
        if (res.status < 400) {
          const html = await res.text();
          // 验证是 DSH Web UI（标题或启动标记）
          const isDsh = /DeepSeek/i.test(html) || /__DSH_BOOT__/i.test(html);
          if (isDsh) {
            this.port = probePort;
            this.url = probeUrl;
            this._launchSource = `reuse (${probeUrl})`;
            this.launchCommand = [];
            this.version = null;
            this.cwd = this._resolveWorkingDir();
            this._setState("running");
            this._pushLog(`[dsh-desktop] 复用已有 DSH 实例: ${probeUrl}`);
            return this.status();
          }
        }
      } catch {
        // 连接失败，跳过
      }
    }
    // DSH 全局安装完整性验证：检查关键运行库文件（防止 yaml 等模块损坏）
    if (this._binPath) {
      const dshRoot = join(this._binPath, "..", "..");
      const yamlMerge = join(dshRoot, "node_modules", "yaml", "dist", "schema", "yaml-1.1", "merge.js");
      if (!existsSync(yamlMerge)) {
        let installedVersion = "unknown";
        try { installedVersion = JSON.parse(readFileSync(join(dshRoot, "package.json"), "utf8")).version; } catch { /* 忽略 */ }
        const msg = (
          `DSH 全局运行库文件损坏：yaml schema 模块缺失（${yamlMerge}）。` +
          `当前版本: ${installedVersion}。请运行 "npm install -g @deepseek-ai/dsh@${installedVersion}" 同版本重装。` +
          `⚠ 不要删除 ~/.dsh 目录（含插件配置和凭据），仅重装全局 DSH 即可。`
        );
        // 统一返回状态对象（与正常复用路径一致），避免 start() 把字符串当状态返回
        this._pushLog(`[dsh-desktop] ${msg}`);
        this._setState("error", { error: msg });
        this._emitError(this.status());
        return this.status();
      }
    }
    return null;
  }

  /**
   * 启动前预检：验证可执行文件、node 与 dsh bin 可用性，失败时给出明确诊断。
   * @returns {string|null} 错误信息；null 表示通过
   */
  _preflight() {
    const exe = this.launchCommand ? this.launchCommand[0] : null;
    // 绝对路径形式的可执行文件必须存在（覆盖自定义 dshCommand 分支）
    if (exe && /[\\/]/.test(exe) && !existsSync(exe)) {
      return `可执行文件不存在: ${exe}（可在 settings.json 的 dshCommand 中修正）`;
    }
    if (this._nodeBin && this._nodeBin !== "node") {
      if (!existsSync(this._nodeBin)) {
        return `Node 可执行文件不存在: ${this._nodeBin}（可在 settings.json 的 nodeBin 中修正）`;
      }
    }
    if (this._nodeBin) {
      try {
        const r = spawnSync(this._nodeBin, ["--version"], {
          windowsHide: true,
          encoding: "utf8",
          timeout: 10_000,
        });
        if (r.status !== 0 || !/^v\d+/.test(String(r.stdout || "").trim())) {
          return `Node 不可用: ${this._nodeBin}（--version 失败，status=${r.status} ${r.stderr?.trim() ?? ""}）`;
        }
      } catch (err) {
        return `Node 不可用: ${this._nodeBin}（${err.message}）`;
      }
    }
    if (this._binPath && !existsSync(this._binPath)) {
      return `未找到 DSH 启动脚本: ${this._binPath}（请确认 npm i -g @deepseek-ai/dsh 已安装）`;
    }
    // Profile 预检：~/.dsh/profiles/web 可写性（最常见启动阻断原因：EPERM）
    const { homedir } = require("node:os");
    const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
    const profileDir = join(dshHome, "profiles", "web");
    if (existsSync(profileDir)) {
      try {
        const testFile = join(profileDir, ".dsh-desktop-preflight-test");
        require("node:fs").writeFileSync(testFile, "ok");
        require("node:fs").unlinkSync(testFile);
      } catch (err) {
        if (err.code === "EPERM") {
          return `DSH profile 目录无法写入: ${profileDir}（EPERM 权限错误）——请检查目录权限或以管理员身份运行`;
        }
      }
      // bundle 存在性验证：package.json 声明的每个 bundle 必须在 node_modules 实际存在
      // （防止 package.json / pnpm-lock.yaml / node_modules 三者状态不一致导致启动失败）
      const missingBundles = this._checkProfileBundles(dshHome);
      if (missingBundles.length > 0) {
        return (
          `DSH profile bundle 安装不完整：${missingBundles.join(", ")} 已声明但 node_modules 中不存在。` +
          `请运行 "dsh plugin --profile web install" 同步依赖后重启`
        );
      }
    }
    return null;
  }

  /** 检查 package.json 声明的 bundles 是否在 node_modules 中实际存在。 */
  _checkProfileBundles(dshHome) {
    const { readFileSync } = require("node:fs");
    const pkgPath = join(dshHome, "profiles", "web", "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const bundles = pkg["dsh.profile.bundles"] || [];
      const missing = [];
      for (const b of bundles) {
        // 官方基础 bundle 从 dsh 安装目录解析，其余从 profile node_modules 解析
        const isOfficial = b.startsWith("@deepseek-ai/dsh-");
        if (isOfficial) continue;
        const dir = join(dshHome, "profiles", "web", "node_modules", ...b.split("/"));
        if (!existsSync(dir)) missing.push(b);
      }
      return missing;
    } catch {
      return [];
    }
  }

  /**
   * 五项一致性检查（section X）：验证 profile 的 package.json、
   * pnpm-lock.yaml、cordis.patch.yml 和 node_modules 四者状态一致。
   * 返回 { healthy, issues[] }
   */
  _checkProfileHealth(dshHome) {
    const fs = require("node:fs");
    const issues = [];
    const profileDir = join(dshHome, "profiles", "web");
    const pkgPath = join(profileDir, "package.json");
    const lockPath = join(profileDir, "pnpm-lock.yaml");
    const patchPath = join(profileDir, "cordis.patch.yml");
    const nmDir = join(profileDir, "node_modules");

    // 1. package.json 存在性
    if (!fs.existsSync(pkgPath)) {
      issues.push({ level: "error", check: "package.json", msg: "package.json 不存在" });
      return { healthy: false, issues, profileDir, hasPackageJson: false, hasLock: false, hasPatch: false, hasNodeModules: false };
    }

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      issues.push({ level: "error", check: "package.json", msg: "package.json 无法解析（JSON 格式错误）" });
      return { healthy: false, issues, profileDir, hasPackageJson: true, hasLock: false, hasPatch: false, hasNodeModules: false };
    }

    const bundles = pkg["dsh.profile.bundles"] || [];
    const deps = pkg.dependencies || {};

    // 2. bundle 声明与 node_modules 一致性
    for (const b of bundles) {
      if (b.startsWith("@deepseek-ai/dsh-")) continue;
      const dir = join(profileDir, "node_modules", ...b.split("/"));
      if (!fs.existsSync(dir)) {
        // 进一步判断：是安装不完整还是卸载不完整
        const inLock = fs.existsSync(lockPath) && fs.readFileSync(lockPath, "utf8").includes(b);
        const inDeps = b in deps;
        if (inLock && inDeps) {
          issues.push({ level: "error", check: "bundle/node_modules", pkg: b, msg: `${b} 已在 lock 和 dependencies 中声明，但 node_modules 目录缺失（安装不完整或依赖损坏）` });
        } else if (inDeps && !inLock) {
          issues.push({ level: "error", check: "bundle/lock", pkg: b, msg: `${b} 仍在 dependencies 中但 lock 已移除（卸载操作未完成，DSH 将无法解析此 bundle）。请重新执行 "dsh plugin --profile web remove ${b}" 完成卸载，或 "dsh plugin --profile web install" 重新安装` });
        } else {
          issues.push({ level: "error", check: "bundle", pkg: b, msg: `${b} 在 bundles 中声明但 node_modules 和 dependencies 均不存在（孤立引用）` });
        }
      }
    }

    // 3. dependencies 中有但 bundles 中没有的包（普通依赖，需在 patch 中挂载才生效）
    // 这不是错误，是信息性提示
    const standaloneDeps = Object.keys(deps).filter(
      (d) => !d.startsWith("@deepseek-ai/dsh-") && !bundles.includes(d) && d !== "pnpm" && d !== "node-addon-api"
    );
    if (standaloneDeps.length > 0) {
      issues.push({ level: "info", check: "standalone-deps", msg: `${standaloneDeps.length} 个依赖未在 bundles 中声明（如需加载，请在 cordis.patch.yml 中挂载）` });
    }

    // 4. cordis.patch.yml 存在性（仅检查是否存在，不解析内容）
    if (fs.existsSync(patchPath)) {
      const content = fs.readFileSync(patchPath, "utf8").trim();
      if (content === "" || content === "[]") {
        issues.push({ level: "info", check: "patch", msg: "cordis.patch.yml 为空（无用户自定义 patch）" });
      }
    }

    return {
      healthy: issues.filter((i) => i.level === "error").length === 0,
      issues,
      profileDir,
      hasPackageJson: fs.existsSync(pkgPath),
      hasLock: fs.existsSync(lockPath),
      hasPatch: fs.existsSync(patchPath),
      hasNodeModules: fs.existsSync(nmDir),
    };
  }

  /** 从 bin.js 同级的 package.json 读取 DSH 版本（不额外启动进程）。 */
  _detectVersion() {
    try {
      if (this._binPath) {
        const pkg = JSON.parse(readFileSync(join(this._binPath, "..", "..", "package.json"), "utf8"));
        if (typeof pkg.version === "string") return pkg.version;
      }
    } catch {
      /* 忽略 */
    }
    // 兜底：探测 dsh --version
    try {
      const cmd = process.platform === "win32" ? "cmd.exe" : "dsh";
      const args = process.platform === "win32" ? ["/c", "dsh", "--version"] : ["--version"];
      const out = execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 20_000 });
      return out.trim().split(/\s+/)[0] || null;
    } catch {
      return null;
    }
  }

  async start() {
    // 已有进行中的启动循环，或存在存活实例时，不重复启动。
    // 注意：stop() 进行中（_stopRequested=true）时不短路——
    // 否则会返回 stop 前的过期 running 快照，调用方误以为后端已启动。
    if (this.state === "starting") return this.status();
    if (this.state === "running" && this.child && !this._stopRequested) return this.status();

    const host = settings.get("host") || "127.0.0.1";
    const preferred = Number(settings.get("port")) || 0;
    this._stopRequested = false;
    this.error = null;
    this.lastExit = null;

    // 安全拦截：非 localhost 地址需要明确授权（支持带/不带方括号的 IPv6）
    const LOCALHOST_RE = /^(127\.\d+\.\d+\.\d+|::1|\[::1\]|localhost)$/i;
    if (!LOCALHOST_RE.test(host) && !settings.get("allowNetworkAccess")) {
      const msg = `安全限制：监听地址 "${host}" 不是 localhost。若需局域网访问，请在 settings.json 中设置 allowNetworkAccess: true（注意：这会暴露 DSH Web 到局域网）。`;
      this._pushLog(`[dsh-desktop] ${msg}`);
      this._setState("error", { error: msg });
      this._emitError(this.status());
      return this.status();
    }

    // 检测外部 dsh 占用（warn 日志，不阻断）
    await this._warnPortOccupied(host);

    // 复用模式：如果已启用且有可用的 DSH 实例，直接连接而非重新启动
    if (settings.get("reuseExistingDsh")) {
      const reused = await this._tryReuse(host);
      if (reused) return reused;
    }

    let port;
    try {
      port = await findFreePort(preferred, host);
    } catch (err) {
      const msg = `端口分配失败：${err.message}`;
      this._pushLog(`[dsh-desktop] ${msg}`);
      this._setState("error", { error: msg });
      this._emitError(this.status());
      return this.status();
    }
    this.port = port;
    this.url = httpUrl(host, port);
    this.cwd = this._resolveWorkingDir();

    const launch = this._resolveLaunch();
    if (!launch) {
      const msg = "未找到 @deepseek-ai/dsh（npm global）：请运行 npm i -g @deepseek-ai/dsh，或在 settings.json 的 nodeBin/dshCommand 中指定路径";
      this._setState("error", { error: msg });
      this._pushLog(`[dsh-desktop] 启动失败: ${msg}`);
      this._emitError(this.status());
      return this.status();
    }
    const { argv, source } = launch;
    this._launchSource = source;
    // --no-open：dsh web 默认会在系统默认浏览器自动打开 Web UI，
    // 桌面版作为宿主时禁止该行为（UI 已在 Electron 窗口内展示）
    this.launchCommand = [...argv, "--host", host, "--port", String(this.port), "--no-open"];
    this._setState("starting", { pid: null, error: null });
    this._pushLog(
      `[dsh-desktop] 启动命令: ${this.launchCommand.join(" ")} (来源: ${source}, cwd: ${this.cwd})`
    );

    // 预检：node/bin/工作目录
    const preflightError = this._preflight();
    if (preflightError) {
      this._setState("error", { error: preflightError });
      this._pushLog(`[dsh-desktop] 预检失败: ${preflightError}`);
      this._emitError(this.status());
      return this.status();
    }

    try {
      this.child = spawn(this.launchCommand[0], this.launchCommand.slice(1), {
        cwd: this.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false, // 始终不用 shell：避免 cmd.exe/powershell.exe 包装进程
        // 非 Windows：独立进程组，stop() 时用负 PID 杀整棵树（含孙进程）
        detached: process.platform !== "win32",
      });
    } catch (err) {
      this._setState("error", {
        error: `无法启动 dsh 进程：${err.message}`,
        launchCommand: this.launchCommand,
      });
      this._pushLog(
        `[dsh-desktop] 启动失败: node=${this._nodeBin ?? "?"} bin=${this._binPath ?? "?"} cwd=${this.cwd} 命令=${this.launchCommand.join(" ")}`
      );
      this._emitError(this.status());
      return this.status();
    }

    this.pid = this.child.pid;
    const spawned = this.child; // 绑定当前子进程，防止迟到事件误伤重启后的新进程
    // 补发一次 status：UI 在 starting 阶段能看到真实 pid
    this.emit("status", this.status());

    // stop() 可能在 spawn 前置段（端口探测/复用检查）期间被调用：
    // 此时 _stopRequested 已置位但 spawn 已发生，必须立即终止并返回 stopped
    if (this._stopRequested) {
      this._killChild();
      this._setState("stopped");
      this._pushLog("[dsh-desktop] spawn 后收到停止请求，已终止新进程");
      return this.status();
    }

    this.child.stdout.on("data", (d) => this._pushLog(d));
    this.child.stderr.on("data", (d) => this._pushLog(d));
    this.child.on("error", (err) => {
      if (this.child !== spawned) return; // 旧进程的迟到错误，忽略
      this._pushLog(`[dsh-desktop] 进程错误: ${err.message}`);
      if (!this._stopRequested && this.state !== "stopped") {
        this._setState("error", { error: `dsh 进程错误：${err.message}` });
        this._emitError(this.status());
      }
    });
    this.child.on("exit", (code, signal) => {
      if (this.child !== spawned) return; // 旧进程的迟到退出事件（restart 竞态），忽略
      this.lastExit = { code, signal, at: new Date().toISOString() };
      this._pushLog(
        `[dsh-desktop] dsh 进程退出 code=${code} signal=${signal} at=${this.lastExit.at} (cwd=${this.cwd})`
      );
      const wasRunning = this.state === "running" || this.state === "starting";
      this.child = null;
      this.pid = null;
      if (this._stopRequested) {
        this._setState("stopped");
        return;
      }
      if (wasRunning) {
        if (settings.get("autoRestartOnCrash") && this._crashCount < MAX_CRASH_RESTARTS) {
          this._crashCount += 1;
          if (this.state === "starting") {
            // 上一个 start() 仍在轮询就绪：标记待重启，其轮询循环会立即退出并续跑
            this._restartPending = true;
            return;
          }
          const delaySec =
            RESTART_BACKOFF_SECONDS[Math.min(this._crashCount, RESTART_BACKOFF_SECONDS.length) - 1];
          this._pushLog(`[dsh-desktop] 自动重启（第 ${this._crashCount} 次，${delaySec}s 后）…`);
          // 显式进入 restarting，UI 可展示过渡状态（start() 守卫不拦截 restarting）
          this._setState("restarting", { pid: null });
          this._scheduleRestart(delaySec * 1000);
          return;
        }
        const logSummary = this.logTail.slice(-30).join("\n");
        const diagnosis = analyzeDshError(logSummary);
        this._setState("error", {
          error: diagnosis || `dsh 后端意外退出（code=${code} signal=${signal}），已尝试 ${MAX_CRASH_RESTARTS} 次重启`,
        });
        this._emitError(this.status());
      }
    });

    // 等待 HTTP 就绪（2xx/3xx 视为就绪）；子进程已退出待重启时立即退出循环
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline && !this._restartPending) {
      if (this._stopRequested) return this.status();
      try {
        const res = await fetch(this.url, { signal: AbortSignal.timeout(3000) });
        if (res.status >= 200 && res.status < 400) {
          this.version = this._detectVersion();
          this._crashCount = 0;
          this._setState("running");
          this._pushLog(`[dsh-desktop] 后端就绪: ${this.url} (dsh ${this.version ?? "?"})`);
          return this.status();
        }
        this._pushLog(`[dsh-desktop] 健康检查收到非预期状态码 ${res.status}，继续等待…`);
      } catch {
        /* 还没就绪，继续轮询 */
      }
      await sleep(500);
    }

    // 若等待期间子进程已退出并请求过重启，则在此续跑（此时不报超时）。
    // 但必须先检查 _stopRequested：用户在崩溃等待窗口点了停止时，续跑会
    // 重新拉起后端（start() 入口又会清掉停止标志）——必须尊重停止意图。
    if (this._restartPending) {
      this._restartPending = false;
      if (this._stopRequested) {
        this._setState("stopped");
        this._pushLog("[dsh-desktop] 崩溃待重启期间收到停止请求，取消自动重启");
        return this.status();
      }
      this.state = "stopped"; // 复位状态，允许 start() 重新进入
      return this.start();
    }
    // 等待期间已进入 error（如崩溃次数耗尽、spawn 失败），保留原错误信息
    if (this.state === "error") return this.status();
    // 超时：终止残余子进程，避免僵尸
    this._killChild();
    this._setState("error", {
      error: `后端启动超时（${Math.round(this.readyTimeoutMs / 1000)}s），请检查 dsh 是否安装正确`,
    });
    this._emitError(this.status());
    return this.status();
  }

  /** 定时重启（指数退避）；stop() 会取消待执行的重启。 */
  _scheduleRestart(delayMs) {
    if (this._restartTimer) clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._stopRequested) return;
      if (this.state === "starting") {
        // 上一个 start() 仍在轮询就绪，标记待重启，由其循环收尾时发起
        this._restartPending = true;
        return;
      }
      this.start();
    }, delayMs);
  }

  /**
   * 停止后端并清理整个进程树（Windows 用 taskkill /T），确认式返回：
   *  - 检查 taskkill 退出状态与输出
   *  - 轮询确认主 PID 消失（5s）
   *  - 枚举后代进程，确认树内无残留（detached 逃逸场景）
   *  - 清理失败返回 error 状态并带诊断日志，而不是伪装成 stopped
   */
  /** 安全终止子进程（超时/预检失败等场景）。不等待确认。 */
  _killChild() {
    const child = this.child;
    if (!child || !child.pid) return;
    if (process.platform === "win32") {
      // /T 杀整棵进程树（与 stop() 一致），防止启动超时后残留 detached 孙进程
      try { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* 忽略 */ }
    } else {
      // 非 Windows：杀进程组（spawn 时 detached）
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* 忽略 */ }
    }
    this.child = null;
    this.pid = null;
  }

  async stop() {
    this._stopRequested = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    const child = this.child;
    const rootPid = child && child.pid ? child.pid : null;
    let killFailed = null;

    if (child && child.pid) {
      if (process.platform === "win32") {
        try {
          const r = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            encoding: "utf8",
            timeout: 15_000,
          });
          const out = String(r.stdout || "") + String(r.stderr || "");
          if (r.status !== 0 && !/没有运行|not found|not running/i.test(out)) {
            killFailed = `taskkill 失败（status=${r.status}）: ${out.trim() || "无输出"}`;
          }
        } catch (err) {
          killFailed = `taskkill 异常: ${err.message}`;
          try {
            child.kill();
          } catch {
            /* 已退出 */
          }
        }
      } else {
        // 非 Windows：子进程已 detached 成独立进程组，负 PID 杀整棵树
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* 已退出 */ }
        setTimeout(() => {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ }
        }, 3000);
      }
    }

    // 轮询确认主进程消失（以及树内无残留）
    const mainGone = rootPid ? await waitPidGone(rootPid, 5000) : true;
    const leftovers = rootPid && mainGone ? this._listDescendants(rootPid).filter((p) => this._pidExists(p)) : [];

    // 只在 child 仍是我们停止的那个进程时清引用——
    // 若 stop() 期间 start() 已 spawn 新进程，不得抹掉新 child（否则变孤儿且无法停止）
    if (this.child === child) {
      this.child = null;
    }
    if (this.pid === rootPid) {
      this.pid = null;
    }

    if (rootPid && (!mainGone || leftovers.length > 0)) {
      const detail =
        !mainGone && leftovers.length > 0
          ? `主进程 ${rootPid} 与后代 ${leftovers.join(", ")} 仍在运行`
          : !mainGone
            ? `主进程 ${rootPid} 5 秒内未能退出`
            : `主进程已退出但后代残留: ${leftovers.join(", ")}`;
      this._setState("error", {
        error: `停止后端失败：${detail}${killFailed ? `（${killFailed}）` : ""}`,
      });
      this._pushLog(
        `[dsh-desktop] 停止后端失败: ${detail}${killFailed ? `（${killFailed}）` : ""} (cwd=${this.cwd}, 命令=${(this.launchCommand ?? []).join(" ")})`
      );
      this._emitError(this.status());
      return this.status();
    }

    // 只在没有新进程接管时置 stopped：
    // stop() 期间若 start() 已 spawn 新 child（并发），不得把新实例的状态覆盖成 stopped
    if (this.child === null &&
        (this.state === "running" || this.state === "starting" || this.state === "restarting" || this.state === "error")) {
      this._setState("stopped");
    }
    if (killFailed) {
      this._pushLog(`[dsh-desktop] 停止后端完成（taskkill 曾有告警: ${killFailed}），进程已确认退出`);
    } else if (rootPid) {
      this._pushLog(`[dsh-desktop] 停止后端完成，进程树已清理（root=${rootPid}）`);
    }
    return this.status();
  }

  async restart() {
    const stopResult = await this.stop();
    if (stopResult.state === "error") {
      return { state: "error", error: `停止旧后端失败：${stopResult.error}` };
    }
    this._crashCount = 0;
    return this.start();
  }
}

module.exports = { DshServer, findFreePort, pidExists, listDescendants, waitPidGone, httpUrl, RESTART_BACKOFF_SECONDS };
