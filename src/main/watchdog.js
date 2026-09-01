/**
 * 崩溃看门狗（独立 node 脚本 + 主进程集成）。
 *
 * 背景：Electron 主进程崩溃/被强杀后，自身代码无法继续运行。要实现在
 * "桌面程序崩溃或非正常关闭后自动打开浏览器访问 Web UI"，必须有外部进程
 * 持续监控主进程 PID——这就是本模块。
 *
 * 双形态：
 *  1. 独立运行（node watchdog.js <mainPid> <userDataDir>）：
 *     轮询主进程 PID；主进程消失后检查退出标记：
 *       - .last-clean-exit 存在 → 正常退出（用户主动关闭），看门狗静默退出
 *       - 不存在 → 异常退出（崩溃/被杀）：读取 .dsh-web-url，
 *         探测后端可达后调用系统默认浏览器打开 Web UI
 *  2. 由主进程调用 spawnWatchdog()：把自身（含本文件）提取到
 *     <userDataDir>/watchdog/watchdog.js 后用 node 独立运行（detached），
 *     保证主进程崩溃后看门狗仍存活。注意：taskkill /T 全树强杀场景
 *     下看门狗会随树被杀（Windows PPID 链行为），该场景不保证。
 *
 * 本文件只依赖 node 内置模块，可被 node 直接运行（无需 Electron）。
 */
const { spawn } = require("node:child_process");
const {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
} = require("node:fs");
const { join } = require("node:path");

const POLL_INTERVAL_MS = 2000;
const PROBE_ATTEMPTS = 3;
const PROBE_TIMEOUT_MS = 3000;

/** 进程是否存活（Windows 与 POSIX 通用）。 */
function pidAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 探测 URL 是否可达（任意 <500 状态码视为可达，Web UI 首页通常 200）。 */
async function probeUrl(url, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** URL 安全校验：只允许 http(s) 且 host 为本机（防 .dsh-web-url 被篡改后注入命令）。 */
function isSafeWebUrl(value) {
  if (typeof value !== "string") return false;
  // 空白字符可能是命令注入的变形（如 "http://127.0.0.1/ --evil"）
  if (/\s/.test(value)) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, ""); // 去掉 IPv6 方括号
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("127.")
  );
}

/** 调用系统默认浏览器打开 URL（平台相关，detached 不阻塞）。 */
function openBrowser(url) {
  if (process.platform === "win32") {
    // start 是 cmd 内置命令；URL 已通过 isSafeWebUrl 校验为 http(s) 本机地址
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 追加日志（写失败静默忽略）。 */
function log(userDataDir, msg) {
  try {
    appendFileSync(
      join(userDataDir, "watchdog.log"),
      `[${new Date().toISOString()}] ${msg}\n`,
      "utf8"
    );
  } catch {
    /* 忽略 */
  }
}

/**
 * 主进程消失后的决策逻辑（抽出来便于单测）：
 * @returns {"clean"|"opened"|"unreachable"|"no-url"|"invalid-url"}
 */
async function decideAfterMainExit({ userDataDir, urlFile, probe, open, exists }) {
  // 正常退出标记存在 → 用户主动关闭，不做任何事
  if (exists(join(userDataDir, ".last-clean-exit"))) return "clean";

  let url = "";
  try {
    url = String(readFileSync(urlFile, "utf8")).trim();
  } catch {
    /* 无 URL 文件 */
  }
  if (!url) return "no-url";
  if (!isSafeWebUrl(url)) return "invalid-url";

  for (let i = 0; i < PROBE_ATTEMPTS; i++) {
    if (i > 0) await sleep(1000);
    if (await probe(url)) {
      open(url);
      return "opened";
    }
  }
  return "unreachable";
}

/** 独立运行入口：node watchdog.js <mainPid> <userDataDir> */
async function main() {
  const mainPid = Number(process.argv[2]);
  const userDataDir = process.argv[3];
  if (!Number.isInteger(mainPid) || mainPid <= 0 || !userDataDir) {
    console.error("用法: node watchdog.js <mainPid> <userDataDir>");
    process.exit(2);
  }

  log(userDataDir, `看门狗启动，监控主进程 PID=${mainPid}`);

  // 轮询等待主进程消失
  while (pidAlive(mainPid)) {
    await sleep(POLL_INTERVAL_MS);
  }

  const urlFile = join(userDataDir, ".dsh-web-url");
  const result = await decideAfterMainExit({
    userDataDir,
    urlFile,
    probe: (u) => probeUrl(u),
    open: (u) => openBrowser(u),
    exists: existsSync,
  });
  log(userDataDir, `主进程已退出，决策: ${result}（url=${urlFile}）`);
  if (result === "opened") {
    log(userDataDir, "已调用系统浏览器打开 Web UI");
    process.exit(0);
  }
  if (result === "unreachable") {
    log(userDataDir, "后端不可达（可能已被一起终止），未打开浏览器");
  }
  process.exit(result === "clean" ? 0 : 1);
}

/**
 * 主进程调用：把本文件提取到 userData 后用 node 独立运行（detached），
 * 使看门狗不随主进程退出而退出。
 */
function spawnWatchdog({ userDataDir, nodeBin = "node" }) {
  try {
    const wdDir = join(userDataDir, "watchdog");
    mkdirSync(wdDir, { recursive: true });
    const wdPath = join(wdDir, "watchdog.js");
    // 打包后本文件在 asar 内，node 无法直接运行 asar 路径；
    // 提取到 userData（普通文件系统）后 node 可正常运行。
    writeFileSync(wdPath, readFileSync(__filename, "utf8"), "utf8");
    const child = spawn(nodeBin, [wdPath, String(process.pid), userDataDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { ok: true, pid: child.pid, path: wdPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  pidAlive,
  probeUrl,
  isSafeWebUrl,
  openBrowser,
  decideAfterMainExit,
  spawnWatchdog,
  POLL_INTERVAL_MS,
  PROBE_ATTEMPTS,
};
