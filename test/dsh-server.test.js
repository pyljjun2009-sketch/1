/**
 * DshServer 生命周期测试：端口分配、启动解析、就绪、崩溃重启、超时、进程树清理。
 * 使用 test/fixtures/fake-dsh.js 模拟 dsh web，不依赖真实 DSH 安装。
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync, existsSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const net = require("node:net");
const { DshServer, findFreePort, pidExists, listDescendants, waitPidGone, httpUrl } = require("../src/main/dsh-server.js");
const { settings, DEFAULTS } = require("../src/main/config.js");

const FIXTURE = join(__dirname, "fixtures", "fake-dsh.js");

function resetSettings() {
  settings.data = JSON.parse(JSON.stringify(DEFAULTS));
  settings.userDataDir = mkdtempSync(join(tmpdir(), "dsh-server-cwd-"));
}

beforeEach(() => {
  resetSettings();
});

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn, timeoutMs = 20_000, interval = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return fn();
}

test("findFreePort: 返回可绑定端口", async () => {
  const port = await findFreePort(0, "127.0.0.1");
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => srv.close(resolve));
  });
});

test("findFreePort: 首选端口被占用时回退到 OS 分配", async () => {
  const occupied = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, srv }));
  });
  try {
    const port = await findFreePort(occupied.port, "127.0.0.1");
    assert.notEqual(port, occupied.port);
    assert.ok(port > 0);
  } finally {
    await new Promise((resolve) => occupied.srv.close(resolve));
  }
});

test("findFreePort: 超时时同时关闭首选与回退监听器", async () => {
  const created = [];
  const netApi = {
    createServer() {
      const server = {
        closed: false,
        handlers: {},
        unref() {},
        on(event, fn) { this.handlers[event] = fn; },
        listen() {
          if (created.length === 1) queueMicrotask(() => this.handlers.error(new Error("occupied")));
          // 第二个监听器故意挂起，交给超时清理。
        },
        close(cb) { this.closed = true; if (cb) cb(); },
      };
      created.push(server);
      return server;
    },
  };
  await assert.rejects(findFreePort(3080, "127.0.0.1", { netApi, timeoutMs: 20 }), /超时/);
  assert.equal(created.length, 2);
  assert.ok(created.every((server) => server.closed), "两个监听器都应在超时后关闭");
});

test("_resolveLaunch: 使用 settings.dshCommand 自定义命令", () => {
  settings.set({ dshCommand: ["C:\\node.exe", "C:\\dsh\\lib\\bin.js", "web"] });
  const server = new DshServer();
  const { argv, source } = server._resolveLaunch();
  assert.deepEqual(argv, ["C:\\node.exe", "C:\\dsh\\lib\\bin.js", "web"]);
  assert.equal(source, "settings.dshCommand");
});

test("_resolveLaunch: 自动探测 npm 全局安装的 dsh", () => {
  const fakeRoot = mkdtempSync(join(tmpdir(), "dsh-npm-root-"));
  const binDir = join(fakeRoot, "@deepseek-ai", "dsh", "lib");
  const { mkdirSync, writeFileSync } = require("node:fs");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "bin.js"), "// fake");
  writeFileSync(join(fakeRoot, "@deepseek-ai", "dsh", "package.json"), JSON.stringify({ version: "9.9.9" }));

  const server = new DshServer();
  server._npmGlobalRoot = () => fakeRoot;
  const { argv, source } = server._resolveLaunch();
  assert.equal(argv[0], "node");
  assert.equal(argv[1], join(binDir, "bin.js"));
  assert.equal(argv[2], "web");
  assert.ok(source.startsWith("npm global"));
  assert.equal(server._detectVersion(), "9.9.9");
  rmSync(fakeRoot, { recursive: true, force: true });
});

test("start: 假后端就绪（running），状态含 url/pid/cwd/launchCommand", async () => {
  settings.set({ dshCommand: [process.execPath, FIXTURE] });
  const server = new DshServer();
  const st = await server.start();
  assert.equal(st.state, "running");
  assert.ok(st.url.startsWith("http://127.0.0.1:"));
  assert.ok(Number.isInteger(st.pid));
  assert.ok(st.cwd && existsSync(st.cwd));
  assert.ok(Array.isArray(st.launchCommand) && st.launchCommand.includes("--port"));
  assert.ok(st.launchCommand.includes("--no-open"), "桌面端不应额外打开系统浏览器的 WebUI");
  await server.stop();
});

test("start: 工作目录回退到 <userData>/workspace 并自动创建", async () => {
  const savedHome = process.env.DSH_HOME;
  delete process.env.DSH_HOME; // 排除环境变量干扰，验证 userData 回退
  settings.set({ dshCommand: [process.execPath, FIXTURE], workingDirectory: null });
  const server = new DshServer();
  try {
    await server.start();
    assert.equal(server.cwd, join(settings.userDataDir, "workspace"));
    assert.ok(existsSync(server.cwd));
  } finally {
    if (savedHome !== undefined) process.env.DSH_HOME = savedHome;
    await server.stop();
  }
});

test("崩溃自动重启：running 后杀掉子进程，指数退避后回到 running", async () => {
  settings.set({ dshCommand: [process.execPath, FIXTURE] });
  const server = new DshServer();
  server.on("error", () => {});
  await server.start();
  const oldPid = server.pid;
  assert.ok(oldPid);
  // 模拟崩溃；退避期间状态应为 restarting（不显示 stale running）
  server.child.kill();
  const restarting = await waitFor(() => server.state === "restarting", 5000);
  assert.ok(restarting, `期望进入 restarting，实际 state=${server.state}`);
  const ok = await waitFor(
    () => server.state === "running" && server.pid && server.pid !== oldPid,
    20_000
  );
  assert.ok(ok, `期望自动重启回到 running，实际 state=${server.state} crashCount=${server._crashCount}`);
  assert.equal(server._crashCount, 0, "重启就绪后崩溃计数应清零");
  await server.stop();
});

test("崩溃重启耗尽：进程反复启动即退，最终 error 且 crashCount=3", async () => {
  settings.set({ dshCommand: [process.execPath, FIXTURE] });
  const server = new DshServer();
  server.readyTimeoutMs = 300;
  process.env.DSH_FAKE_EXIT = "1";
  try {
    const st = await server.start();
    assert.equal(st.state, "error");
    assert.ok(st.error.includes("意外退出"), `error=${st.error}`);
    assert.equal(server._crashCount, 3);
    assert.ok(server.lastExit && server.lastExit.code === 1);
  } finally {
    delete process.env.DSH_FAKE_EXIT;
    await server.stop();
  }
});

test("启动超时：后端挂起不监听 -> error 且含超时信息", async () => {
  settings.set({ dshCommand: [process.execPath, FIXTURE] });
  const server = new DshServer();
  server.readyTimeoutMs = 800;
  process.env.DSH_FAKE_NO_LISTEN = "1";
  try {
    const st = await server.start();
    assert.equal(st.state, "error");
    assert.ok(st.error.includes("超时"), `error=${st.error}`);
  } finally {
    delete process.env.DSH_FAKE_NO_LISTEN;
    await server.stop();
  }
});

test("stop: Windows 进程树清理（含孙进程）", async () => {
  settings.set({ dshCommand: [process.execPath, FIXTURE] });
  const pidfile = join(mkdtempSync(join(tmpdir(), "dsh-pidfile-")), "pids.json");
  process.env.DSH_FAKE_GRANDCHILD = "1";
  process.env.DSH_FAKE_PIDFILE = pidfile;
  const server = new DshServer();
  try {
    await server.start();
    let pids = null;
    for (let i = 0; i < 40 && !pids; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (existsSync(pidfile)) {
        try {
          pids = JSON.parse(readFileSync(pidfile, "utf8"));
        } catch {
          /* 重试 */
        }
      }
    }
    assert.ok(pids && pids.grand, `未捕获主/孙进程 pid（pidfile=${pidfile}）`);
    assert.ok(pidAlive(pids.pid) || server.state === "running");
    await server.stop();
    assert.equal(server.state, "stopped");
    assert.ok(!pidAlive(pids.pid), "主进程应已被清理");
    assert.ok(!pidAlive(pids.grand), "孙进程应已被 taskkill /T 清理");
  } finally {
    delete process.env.DSH_FAKE_GRANDCHILD;
    delete process.env.DSH_FAKE_PIDFILE;
  }
});

test("restart: stop 后重新启动回到 running", async () => {
  settings.set({ dshCommand: [process.execPath, FIXTURE] });
  const server = new DshServer();
  await server.start();
  const st = await server.restart();
  assert.equal(st.state, "running");
  await server.stop();
});

test("stop: 残留检测失败路径 -> 报告 error 而非伪装 stopped（注入式）", async () => {
  settings.set({ dshCommand: [process.execPath, FIXTURE] });
  const server = new DshServer();
  await server.start();
  const rootPid = server.pid;
  // 注入"假残留"：模拟 taskkill 杀掉了主进程但树内仍有存活后代
  server._listDescendants = () => [rootPid, 999999];
  server._pidExists = (pid) => pid === rootPid; // 主进程仍"存活"（检测视角）
  const st = await server.stop();
  assert.equal(st.state, "error");
  assert.ok(st.error.includes("主进程"), `error 应含主进程诊断: ${st.error}`);
  // 恢复真实检测，确认实际进程已被清理（避免污染）
  server._listDescendants = () => [];
  server._pidExists = () => false;
  await server.stop();
  assert.equal(server.state, "stopped");
});

test("listDescendants/stop: 真实孙进程可枚举，停止后树为空", async () => {
  settings.set({ dshCommand: [process.execPath, FIXTURE] });
  const pidfile = join(mkdtempSync(join(tmpdir(), "dsh-pidfile-")), "pids.json");
  process.env.DSH_FAKE_GRANDCHILD = "1";
  process.env.DSH_FAKE_PIDFILE = pidfile;
  const server = new DshServer();
  try {
    await server.start();
    let grandPid = null;
    for (let i = 0; i < 40 && !grandPid; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (existsSync(pidfile)) {
        try {
          const p = JSON.parse(readFileSync(pidfile, "utf8"));
          grandPid = p.grand;
        } catch {
          /* 重试 */
        }
      }
    }
    assert.ok(grandPid, "未捕获孙进程 pid");
    const descendants = server._listDescendants(server.pid);
    assert.ok(descendants.includes(grandPid), `孙进程应被枚举到: ${descendants}`);
    const st = await server.stop();
    assert.equal(st.state, "stopped");
    assert.ok(!pidAlive(grandPid), "孙进程应已被 taskkill /T 清理");
    assert.equal(server._listDescendants(server.pid).length, 0, "停止后树应为空");
  } finally {
    delete process.env.DSH_FAKE_GRANDCHILD;
    delete process.env.DSH_FAKE_PIDFILE;
  }
});

test("预检: 自定义命令可执行文件不存在 -> 提前 error 且诊断明确", async () => {
  settings.set({
    dshCommand: ["C:\\nonexistent\\node.exe", "C:\\nonexistent\\bin.js", "web"],
  });
  const server = new DshServer();
  const st = await server.start();
  assert.equal(st.state, "error");
  assert.ok(st.error.includes("可执行文件不存在"), `error=${st.error}`);
  assert.ok(st.logTail.some((l) => l.includes("预检失败")), "日志应含预检失败记录");
  await server.stop();
});

test("pidExists / waitPidGone: 存活与消失检测", async () => {
  const { spawn } = require("node:child_process");
  const alive = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => alive.on("spawn", resolve));
    assert.ok(pidExists(alive.pid), "存活进程应被检测到");
    assert.equal(listDescendants(alive.pid).length, 0, "无后代时返回空");
    alive.kill();
    assert.ok(await waitPidGone(alive.pid, 5000), "被杀进程应检测为消失");
    assert.ok(!pidExists(alive.pid));
  } finally {
    if (alive.exitCode === null) alive.kill();
  }
});

test("_checkProfileBundles: 检测 bundle 声明与 node_modules 不一致", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-bundle-check-"));
  const profileDir = join(dshHome, "profiles", "web");
  mkdirSync(profileDir, { recursive: true });

  // 声明了 3 个 bundle，但 node_modules 里只有 1 个
  writeFileSync(join(profileDir, "package.json"), JSON.stringify({
    "dsh.profile.bundles": [
      "@deepseek-ai/dsh-base",           // 官方基础（跳过检查）
      "@linxin666/dsh-ssh",              // 缺失
      "@linxin666/dsh-web-ui",           // 存在
    ],
  }));
  mkdirSync(join(profileDir, "node_modules", "@linxin666", "dsh-web-ui"), { recursive: true });

  const server = new DshServer();
  const missing = server._checkProfileBundles(dshHome);
  assert.deepEqual(missing, ["@linxin666/dsh-ssh"]);

  rmSync(dshHome, { recursive: true, force: true });
});

test("_checkProfileBundles/_checkProfileHealth: 非法 bundle 声明不会路径逃逸或崩溃", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-bundle-invalid-"));
  const profileDir = join(dshHome, "profiles", "web");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "package.json"), JSON.stringify({
    "dsh.profile.bundles": ["../../escape", 42],
    dependencies: {},
  }));
  const server = new DshServer();
  const missing = server._checkProfileBundles(dshHome);
  assert.equal(missing.length, 2);
  assert.ok(missing.every((item) => item.includes("非法 bundle")));
  const health = server._checkProfileHealth(dshHome);
  assert.equal(health.healthy, false);
  assert.equal(health.issues.filter((issue) => issue.check === "bundle-name").length, 2);
  rmSync(dshHome, { recursive: true, force: true });
});

test("_checkProfileHealth: 五项一致性检查（bundle 存在 → healthy）", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-health-ok-"));
  const profileDir = join(dshHome, "profiles", "web");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "package.json"), JSON.stringify({
    "dsh.profile.bundles": ["@deepseek-ai/dsh-base"],
    dependencies: { "@deepseek-ai/dsh-base": "0.1.0" },
  }));
  mkdirSync(join(profileDir, "node_modules"), { recursive: true });

  const server = new DshServer();
  const result = server._checkProfileHealth(dshHome);
  assert.equal(result.healthy, true);
  assert.ok(result.hasPackageJson);
  assert.equal(result.issues.length, 0);

  rmSync(dshHome, { recursive: true, force: true });
});

test("_checkProfileHealth: bundle 存在但 node_modules 缺失 → unhealthy", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-health-bad-"));
  const profileDir = join(dshHome, "profiles", "web");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "package.json"), JSON.stringify({
    "dsh.profile.bundles": ["@linxin666/dsh-ssh"],
    dependencies: { "@linxin666/dsh-ssh": "0.2.4" },
  }));

  const server = new DshServer();
  const result = server._checkProfileHealth(dshHome);
  assert.equal(result.healthy, false);
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues[0].msg.includes("@linxin666/dsh-ssh"));

  rmSync(dshHome, { recursive: true, force: true });
});

test("httpUrl: IPv6 自动加方括号，IPv4/已带括号不再重复", () => {
  assert.equal(httpUrl("127.0.0.1", 3080), "http://127.0.0.1:3080/");
  assert.equal(httpUrl("::1", 3080), "http://[::1]:3080/");
  assert.equal(httpUrl("[::1]", 3080), "http://[::1]:3080/");
  assert.equal(httpUrl("0.0.0.0", 8080), "http://0.0.0.0:8080/");
});

test("_tryReuse: yaml 缺失时返回状态对象（非字符串），start 契约保持", async () => {
  const server = new DshServer();
  // 注入 binPath 指向一个无 yaml 的假 DSH 根
  server._binPath = join(mkdtempSync(join(tmpdir(), "dsh-badbin-")), "lib", "bin.js");
  const { mkdirSync } = require("node:fs");
  mkdirSync(join(server._binPath, ".."), { recursive: true });
  const reused = await server._tryReuse("127.0.0.1");
  assert.ok(reused && typeof reused === "object", "应返回状态对象而非字符串");
  assert.equal(reused.state, "error");
  assert.ok(reused.error && reused.error.includes("yaml"), `error 应含 yaml 诊断: ${reused.error}`);
  assert.equal(server.state, "error");
});

test("崩溃待重启期间收到 stop()：取消自动重启，不重新拉起（回归）", async () => {
  settings.set({ dshCommand: [process.execPath, FIXTURE] });
  const server = new DshServer();
  server.on("error", () => {});
  await server.start();
  const oldPid = server.pid;
  // 模拟崩溃并进入 restarting 待重启窗口
  server.child.kill();
  const restarting = await waitFor(() => server.state === "restarting", 5000);
  assert.ok(restarting);
  // 待重启期间调用 stop：必须取消重启且不拉起新进程
  const st = await server.stop();
  assert.equal(st.state, "stopped");
  assert.equal(server._restartPending, false);
  // 等待超过退避间隔，确认没有新进程被拉起
  const respawned = await waitFor(() => server.state === "running" || server.state === "starting", 4000, 300);
  assert.ok(!respawned, `stop 后不应自动重启，实际 state=${server.state}`);
  assert.ok(!pidAlive(oldPid));
});

test("并发 stop/start：状态一致，不产生孤儿，不覆盖新实例（回归）", async () => {
  settings.set({ dshCommand: [process.execPath, FIXTURE] });
  const server = new DshServer();
  server.on("error", () => {});
  await server.start();
  const oldPid = server.pid;
  // 并发触发 stop 与 start（不 await 中间态）
  const [stopRes, startRes] = await Promise.all([server.stop(), server.start()]);
  // stop 应成功停止旧进程；start 应完成启动（running）
  assert.equal(stopRes.state, "stopped");
  assert.equal(startRes.state, "running");
  // 最终状态必须与新实例一致（不被 stop 覆盖成 stopped）
  assert.equal(server.state, "running");
  assert.ok(server.child && server.child.pid, "应有存活的新 child");
  // 旧进程应被清理（无孤儿）
  assert.ok(!pidAlive(oldPid), "旧进程应被清理");
  await server.stop();
  assert.equal(server.state, "stopped");
});
