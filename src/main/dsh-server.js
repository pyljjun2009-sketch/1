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

/** 找一个空闲端口：优先使用首选端口，否则由 OS 分配。 */
function findFreePort(preferred, host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", () => {
      // 首选端口被占用：让 OS 分配
      const srv2 = net.createServer();
      srv2.unref();
      srv2.on("error", reject);
      srv2.listen(0, host, () => {
        const p = srv2.address().port;
        srv2.close(() => resolve(p));
      });
    });
    srv.listen(preferred, host, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
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
        timeout: 10_000,
      });
      return r.status === 0 && r.stdout.includes(`"${pid}"`);
    } catch {
      return false;
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
  const wmic = spawnSync(
    "wmic",
    ["process", "get", "ProcessId,ParentProcessId", "/FORMAT:CSV"],
    { windowsHide: true, encoding: "utf8", timeout: 15_000 }
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
      { windowsHide: true, encoding: "utf8", timeout: 20_000 }
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
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /** 启动前检测端口占用：若已有 dsh web 实例运行在常用端口，输出警告。 */
  async _warnPortOccupied(host) {
    for (const probePort of [3080, 8080]) {
      const probeUrl = `http://${host}:${probePort}/`;
      if (await this._probeUrl(probeUrl)) {
        this._pushLog(
          `[dsh-desktop] ⚠ 检测到端口 ${probePort} 已有服务运行（可能是外部启动的 dsh web）：${probeUrl}。如需复用，在 settings.json 设置 port:${probePort}；如需独立，在 settings.json 设置 port:0`
        );
      }
    }
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
    }
    return null;
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
    // 已有进行中的启动循环，或存在存活实例时，不重复启动
    if (this.state === "starting") return this.status();
    if (this.state === "running" && this.child) return this.status();

    const host = settings.get("host") || "127.0.0.1";
    const preferred = Number(settings.get("port")) || 0;
    this._stopRequested = false;
    this.error = null;
    this.lastExit = null;

    // 检测外部 dsh 占用（warn 日志，不阻断）
    await this._warnPortOccupied(host);

    this.port = await findFreePort(preferred, host);
    this.url = `http://${host}:${this.port}/`;
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
    this.launchCommand = [...argv, "--host", host, "--port", String(this.port)];
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
        this._setState("error", {
          error: `dsh 后端意外退出（code=${code} signal=${signal}），已尝试 ${MAX_CRASH_RESTARTS} 次重启`,
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

    // 若等待期间子进程已退出并请求过重启，则在此续跑（此时不报超时）
    if (this._restartPending) {
      this._restartPending = false;
      this.state = "stopped"; // 复位状态，允许 start() 重新进入
      return this.start();
    }
    // 等待期间已进入 error（如崩溃次数耗尽、spawn 失败），保留原错误信息
    if (this.state === "error") return this.status();
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
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* 已退出 */
          }
        }, 3000);
      }
    }

    // 轮询确认主进程消失（以及树内无残留）
    const mainGone = rootPid ? await waitPidGone(rootPid, 5000) : true;
    const leftovers = rootPid && mainGone ? this._listDescendants(rootPid).filter((p) => this._pidExists(p)) : [];

    this.child = null;
    this.pid = null;

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

    if (this.state === "running" || this.state === "starting" || this.state === "restarting" || this.state === "error") {
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
    await this.stop();
    this._crashCount = 0;
    return this.start();
  }
}

module.exports = { DshServer, findFreePort, pidExists, listDescendants, waitPidGone, RESTART_BACKOFF_SECONDS };
