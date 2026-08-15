/**
 * 测试夹具：模拟 `dsh web` 的最小后端。
 * 解析 --host/--port 启动 HTTP 服务；支持测试用开关：
 *   DSH_FAKE_NO_LISTEN=1            只挂起不监听（测启动超时）
 *   DSH_FAKE_EXIT=1                 启动后立即退出（测崩溃重启耗尽）
 *   DSH_FAKE_GRANDCHILD=1           额外派生一个孙进程（测进程树清理）
 *   DSH_FAKE_DETACHED_GRANDCHILD=1  派生 detached 孙进程（taskkill /T 杀不到，
 *                                   测 stop 的残留检测与 error 报告）
 *   DSH_FAKE_PIDFILE=<path>         把主进程 pid 与孙进程 pid 写入文件
 */
const http = require("node:http");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const get = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const host = get("--host") || "127.0.0.1";
const port = Number(get("--port"));

if (process.env.DSH_FAKE_EXIT === "1") {
  process.exit(1);
}

if (process.env.DSH_FAKE_GRANDCHILD === "1" || process.env.DSH_FAKE_DETACHED_GRANDCHILD === "1") {
  const grand = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    detached: process.env.DSH_FAKE_DETACHED_GRANDCHILD === "1",
  });
  grand.unref();
  if (process.env.DSH_FAKE_PIDFILE) {
    grand.on("spawn", () => writePids({ grand: grand.pid }));
  }
}

function writePids(extra) {
  if (!process.env.DSH_FAKE_PIDFILE) return;
  try {
    const { readFileSync, writeFileSync } = require("node:fs");
    let data = { pid: process.pid };
    try {
      data = { ...JSON.parse(readFileSync(process.env.DSH_FAKE_PIDFILE, "utf8")), ...data };
    } catch {
      /* 首次写入 */
    }
    writeFileSync(process.env.DSH_FAKE_PIDFILE, JSON.stringify({ ...data, ...extra }));
  } catch {
    /* 忽略 */
  }
}

const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><head><title>fake dsh</title></head><body>fake dsh backend</body></html>");
});

if (process.env.DSH_FAKE_NO_LISTEN === "1") {
  setInterval(() => {}, 1000); // 挂起但不监听
} else {
  srv.listen(port, host, () => {
    console.log(`fake dsh: http://${host}:${port}`);
    writePids();
  });
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
