/**
 * 升级接口测试：后端轨道（mock fetch）与应用轨道（注入假 autoUpdater）。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { UpgradeManager, BACKEND_UPGRADER, BACKEND_PACKAGE, isSafeVersion, isSafePackageName } = require("../src/main/updater.js");

function fakeServer(version) {
  return { version, _detectVersion: async () => version };
}

function appHarness(latest = "2.0.0", options = {}) {
  const updater = new (require("node:events").EventEmitter)();
  updater.currentVersion = "1.0.0";
  const calls = [];
  updater.checkForUpdates = async () => { calls.push("check"); return { updateInfo: { version: latest } }; };
  updater.downloadUpdate = async () => { calls.push("download"); updater.emit("download-progress", { percent: 57.25 }); updater.emit("update-downloaded", { version: latest }); };
  updater.quitAndInstall = (...args) => { calls.push(["install", ...args]); };
  const manager = new UpgradeManager({ server: fakeServer("1.0.0"), appUpdaterLoader: async () => updater, prepareAppInstall: async () => { calls.push("prepare"); }, ...options });
  return { manager, updater, calls };
}

test("app: 拒绝旧版、相同版与预发布版，不下载", async () => {
  for (const latest of ["0.1.0", "1.0.0", "1.0.0+build.2", "2.0.0-alpha.1"]) {
    const { manager, calls } = appHarness(latest);
    assert.equal((await manager.apply("app")).status, "up-to-date");
    assert.equal(calls.includes("download"), false);
  }
});

test("backend: latest 低于当前预览版本时不提示降级", async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ version: "0.1.1-rc.2" }) });
  try {
    const manager = new UpgradeManager({ server: fakeServer("0.1.2-alpha.4") });
    assert.equal((await manager.check("backend")).status, "up-to-date");
  } finally { global.fetch = original; }
});

test("app: 开发模式空结果与断网必须区别报告", async () => {
  const { manager, updater } = appHarness();
  updater.checkForUpdates = async () => null;
  assert.equal((await manager.check("app")).status, "not-configured");
  updater.checkForUpdates = async () => { throw new Error("ECONNRESET"); };
  assert.equal((await manager.check("app")).status, "error");
});

test("app: 更新组件的系统兼容性和灰度发布限制不能被版本比较绕过", async () => {
  const { manager, updater } = appHarness();
  updater.checkForUpdates = async () => ({ updateInfo: { version: "2.0.0" }, isUpdateAvailable: false });
  assert.equal((await manager.apply("app")).status, "up-to-date");
});

test("app: 便携版不自动下载或安装", async () => {
  const { manager, calls } = appHarness("2.0.0", { isPortable: true });
  assert.equal((await manager.apply("app")).status, "not-configured");
  assert.equal((await manager.installApp()).status, "error");
  assert.equal(calls.length, 0);
});

test("app: 解包目录不冒充已安装应用", async () => {
  const { manager, calls } = appHarness("2.0.0", { canInstallApp: false });
  assert.equal((await manager.apply("app")).status, "not-configured");
  assert.equal((await manager.installApp()).status, "error");
  assert.equal(calls.length, 0);
});

test("app: 下载状态持久到下一次检查，进度保留数字且禁用退出自动安装", async () => {
  const { manager, updater, calls } = appHarness();
  const events = [];
  manager.setEventSink((event) => events.push(event));
  await manager.apply("app");
  assert.equal((await manager.check("app")).status, "update-downloaded");
  await manager.apply("app");
  assert.equal(calls.filter((c) => c === "download").length, 1);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(events.find((e) => e.event === "download-progress").percent, 57.25);
  assert.ok(events.every((e) => e.type === "app-event"));
});

test("app: 并发检查只发一个请求", async () => {
  const { manager, calls } = appHarness();
  await Promise.all([manager.check("app"), manager.check("app"), manager.check("app")]);
  assert.equal(calls.filter((c) => c === "check").length, 1);
});

test("app: 校验失败时不保留可安装状态", async () => {
  const { manager, updater } = appHarness();
  updater.downloadUpdate = async () => { throw new Error("sha512 checksum mismatch"); };
  assert.equal((await manager.apply("app")).status, "error");
  assert.equal((await manager.installApp()).status, "error");
});

test("app: 必须下载后才能安装，准备成功后只安装一次", async () => {
  const { manager, calls } = appHarness();
  assert.equal((await manager.installApp()).status, "error");
  await manager.apply("app");
  assert.equal((await manager.installApp()).status, "installing");
  assert.equal((await manager.installApp()).status, "error");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.slice(-2), ["prepare", ["install", false, true]]);
});

test("app: 备份或停止失败时不启动安装器，并允许重试", async () => {
  const { manager, calls } = appHarness("2.0.0", { prepareAppInstall: async () => { throw new Error("停止失败"); } });
  await manager.apply("app");
  assert.match((await manager.installApp()).reason, /停止失败/);
  assert.equal(manager._installing, false);
  assert.equal(calls.some(Array.isArray), false);
});

test("backend check: 有新版本 -> update-available", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) });
  try {
    const m = new UpgradeManager({ server: fakeServer("0.1.0") });
    const r = await m.check("backend");
    assert.equal(r.status, "update-available");
    assert.equal(r.available, true);
    assert.equal(r.current, "0.1.0");
    assert.equal(r.latest, "9.9.9");
  } finally {
    global.fetch = originalFetch;
  }
});

test("backend check: 已是最新 -> up-to-date", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ version: "0.1.0" }) });
  try {
    const m = new UpgradeManager({ server: fakeServer("0.1.0") });
    const r = await m.check("backend");
    assert.equal(r.status, "up-to-date");
    assert.equal(r.available, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("backend check: registry 不可达 -> status error + reason", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  try {
    const m = new UpgradeManager({ server: fakeServer("0.1.0") });
    const r = await m.check("backend");
    assert.equal(r.status, "error");
    assert.equal(r.available, false);
    assert.ok(r.reason.includes("ECONNREFUSED"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("backend apply: npm 安装失败时返回 error + 备份ID", async () => {
  const m = new UpgradeManager({
    server: fakeServer("0.1.0"),
    backupManager: { create: () => ({ id: "backup-test-001" }) },
    dshHome: process.env.TEMP,
  });
  // 注入失败的 npm 执行器（不真正执行 npm install）
  const r = await BACKEND_UPGRADER.apply({
    server: fakeServer("0.1.0"),
    backupManager: { create: () => ({ id: "backup-test-001" }) },
    dshHome: process.env.TEMP,
    execNpm: () => ({ status: 1, stdout: "", stderr: "ENOTFOUND registry.npmjs.org" }),
  });
  assert.equal(r.track, undefined); // 直接调用 BACKEND_UPGRADER.apply
  assert.equal(r.applied, false);
  assert.equal(r.status, "error");
  assert.equal(r.backupId, "backup-test-001");
  assert.ok(r.reason.includes("npm 安装失败"));
  void m;
});

test("backend apply: npm 成功但 yaml 缺失时报错并提示回滚", async () => {
  const server = fakeServer("9.9.9");
  // server._detectVersion 返回新版本，但 _binPath 指向不存在的路径（yaml 检查失败）
  server._binPath = "C:\\nonexistent\\bin.js";
  const r = await BACKEND_UPGRADER.apply({
    server,
    backupManager: { create: () => ({ id: "backup-test-002" }) },
    dshHome: process.env.TEMP,
    execNpm: () => ({ status: 0, stdout: "up to date", stderr: "" }),
  });
  assert.equal(r.applied, true); // npm 安装已执行
  assert.equal(r.status, "error"); // yaml 校验失败
  assert.ok(r.reason.includes("yaml"));
  assert.ok(r.hint.includes("回滚"));
});

test("backend apply: 实际安装版本与目标不一致时明确失败", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { join } = require("node:path");
  const tempDir = mkdtempSync(join(require("node:os").tmpdir(), "dsh-updater-version-"));
  const server = fakeServer("1.2.4");
  server._binPath = join(tempDir, "lib", "bin.js");
  mkdirSync(join(tempDir, "node_modules", "yaml", "dist", "schema", "yaml-1.1"), { recursive: true });
  writeFileSync(join(tempDir, "node_modules", "yaml", "dist", "schema", "yaml-1.1", "merge.js"), "// ok");
  try {
    const result = await BACKEND_UPGRADER.apply({
      server,
      targetVersion: "1.2.3",
      execNpm: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    assert.equal(result.status, "error");
    assert.match(result.reason, /不一致/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("backend apply: 拒绝非 semver 的目标版本，且不会执行 npm", async () => {
  let called = false;
  const result = await BACKEND_UPGRADER.apply({
    server: fakeServer("0.1.0"),
    targetVersion: "1.2.3 & whoami",
    backupManager: { create: () => ({ id: "should-not-backup" }) },
    execNpm: () => { called = true; return { status: 0 }; },
  });
  assert.equal(result.applied, false);
  assert.equal(result.status, "error");
  assert.match(result.reason, /版本格式非法/);
  assert.equal(called, false);
  assert.equal(isSafeVersion("1.2.3-beta.1+build.7"), true);
  assert.equal(isSafeVersion("latest"), false);
});

test("isSafePackageName: 合法 npm 包名通过", () => {
  assert.equal(isSafePackageName("@deepseek-ai/dsh-plugin"), true);
  assert.equal(isSafePackageName("dsh-plugin"), true);
  assert.equal(isSafePackageName("@scope/pkg-name"), true);
  assert.equal(isSafePackageName("@scope/pkg.name_1"), true);
});

test("isSafePackageName: 非法/注入性名称拒绝", () => {
  assert.equal(isSafePackageName(""), false);
  assert.equal(isSafePackageName(".."), false);
  assert.equal(isSafePackageName("./evil"), false);
  assert.equal(isSafePackageName("@"), false);
  assert.equal(isSafePackageName("@/x"), false);
  assert.equal(isSafePackageName("@scope/"), false);
  assert.equal(isSafePackageName(".hidden"), false);
  assert.equal(isSafePackageName("_private"), false);
  assert.equal(isSafePackageName("pkg --flag"), false);
  assert.equal(isSafePackageName("pkg;rm -rf /"), false);
  assert.equal(isSafePackageName("pkg/../evil"), false);
  assert.equal(isSafePackageName("x".repeat(300)), false);
  assert.equal(isSafePackageName(null), false);
  assert.equal(isSafePackageName(undefined), false);
  assert.equal(isSafePackageName(123), false);
});

test("backend apply: 自定义启动命令时拒绝升级全局 npm 包", async () => {
  let called = false;
  const server = fakeServer("0.1.0");
  server._resolveLaunch = () => ({ argv: [process.execPath, "custom-dsh.js", "web"], source: "settings.dshCommand" });
  const result = await BACKEND_UPGRADER.apply({
    server,
    execNpm: () => { called = true; return { status: 0 }; },
  });
  assert.equal(result.applied, false);
  assert.match(result.reason, /自定义启动命令/);
  assert.equal(called, false);
});

test("backend apply: npm 成功后会执行无 shell 的 DSH 依赖同步", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { join } = require("node:path");
  const tempDir = mkdtempSync(join(require("node:os").tmpdir(), "dsh-updater-test-"));
  const server = fakeServer("9.9.9");
  server._binPath = join(tempDir, "lib", "bin.js");
  server.state = "running";
  server.restart = async () => server;
  mkdirSync(join(tempDir, "node_modules", "yaml", "dist", "schema", "yaml-1.1"), { recursive: true });
  writeFileSync(join(tempDir, "node_modules", "yaml", "dist", "schema", "yaml-1.1", "merge.js"), "// test\n");
  let syncArgs = null;
  try {
    const result = await BACKEND_UPGRADER.apply({
      server,
      backupManager: { create: () => ({ id: "backup-test-003" }) },
      execNpm: () => ({ status: 0, stdout: "", stderr: "" }),
      execDsh: (args) => { syncArgs = args; return { status: 0, stdout: "", stderr: "" }; },
    });
    assert.deepEqual(syncArgs, ["plugin", "--profile", "web", "install"]);
    assert.equal(result.resynced, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("app check: electron-updater 不可用 -> not-configured（不抛错）", async () => {
  const m = new UpgradeManager({
    server: fakeServer("0.1.0"),
    appUpdaterLoader: async () => null,
  });
  const r = await m.check("app");
  assert.equal(r.track, "app");
  assert.equal(r.status, "not-configured");
  assert.equal(r.supported, false);
});

test("app check: 假 autoUpdater 发现新版本 -> update-available", async () => {
  const fakeUpdater = {
    currentVersion: "1.0.0",
    autoDownload: true,
    on: () => {},
    checkForUpdates: async () => ({ updateInfo: { version: "2.0.0" } }),
  };
  const m = new UpgradeManager({
    server: fakeServer("0.1.0"),
    appUpdaterLoader: async () => fakeUpdater,
  });
  const r = await m.check("app");
  assert.equal(r.status, "update-available");
  assert.equal(r.latest, "2.0.0");
  assert.equal(fakeUpdater.autoDownload, false);
});

test("app apply: 已是最新 -> up-to-date，不下载", async () => {
  let downloaded = false;
  const fakeUpdater = {
    currentVersion: "1.0.0",
    autoDownload: true,
    on: () => {},
    checkForUpdates: async () => ({ updateInfo: { version: "1.0.0" } }),
    downloadUpdate: async () => {
      downloaded = true;
    },
  };
  const m = new UpgradeManager({
    server: fakeServer("0.1.0"),
    appUpdaterLoader: async () => fakeUpdater,
  });
  const r = await m.apply("app");
  assert.equal(r.status, "up-to-date");
  assert.equal(r.applied, false);
  assert.equal(downloaded, false);
});

test("app apply: 有新版本 -> 下载并返回 update-downloaded", async () => {
  let downloaded = false;
  const fakeUpdater = {
    currentVersion: "1.0.0",
    autoDownload: true,
    on: () => {},
    checkForUpdates: async () => ({ updateInfo: { version: "2.0.0" } }),
    downloadUpdate: async () => {
      downloaded = true;
    },
  };
  const m = new UpgradeManager({
    server: fakeServer("0.1.0"),
    appUpdaterLoader: async () => fakeUpdater,
  });
  const r = await m.apply("app");
  assert.equal(r.status, "update-downloaded");
  assert.equal(r.applied, true);
  assert.equal(downloaded, true);
  assert.equal(fakeUpdater.autoDownload, false, "应关闭自动下载，避免与显式 downloadUpdate 重复");
});

test("profile check: 使用构造函数传入的 dshHome", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { join } = require("node:path");
  const home = mkdtempSync(join(require("node:os").tmpdir(), "dsh-profile-home-"));
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  writeFileSync(join(home, "profiles", "web", "package.json"), JSON.stringify({
    "dsh.profile.bundles": ["plugin-a"],
    dependencies: { "plugin-a": "1.0.0" },
  }));
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ version: "2.0.0" }) });
  try {
    const manager = new UpgradeManager({ server: fakeServer("0.1.0"), dshHome: home });
    const result = await manager.check("profile");
    assert.equal(result.status, "update-available");
    assert.equal(result.bundles[0].name, "plugin-a");
  } finally {
    global.fetch = originalFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile check/apply: 损坏或非法 bundle 声明明确报错", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { join } = require("node:path");
  const home = mkdtempSync(join(require("node:os").tmpdir(), "dsh-profile-invalid-"));
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  writeFileSync(join(home, "profiles", "web", "package.json"), JSON.stringify({
    "dsh.profile.bundles": ["plugin-ok", "../../escape", 42],
    dependencies: { "plugin-ok": "1.0.0" },
  }));
  try {
    const manager = new UpgradeManager({ server: fakeServer("0.1.0"), dshHome: home });
    const checked = await manager.check("profile");
    assert.equal(checked.status, "error");
    assert.match(checked.reason, /非法 bundle/);
    const applied = await manager.apply("profile");
    assert.equal(applied.status, "error");
    assert.equal(applied.applied, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("profile apply: 更新成功后自动重启后端", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
  const { join } = require("node:path");
  const home = mkdtempSync(join(require("node:os").tmpdir(), "dsh-profile-apply-"));
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  writeFileSync(join(home, "profiles", "web", "package.json"), JSON.stringify({
    "dsh.profile.bundles": ["plugin-a"], dependencies: { "plugin-a": "1.0.0" },
  }));
  let restartCount = 0;
  const server = fakeServer("0.1.0");
  server.restart = async () => { restartCount += 1; return { state: "running" }; };
  try {
    const manager = new UpgradeManager({
      server,
      dshHome: home,
      dshCliRunner: () => ({ status: 0, stdout: "updated", stderr: "" }),
    });
    const result = await manager.apply("profile");
    assert.equal(result.status, "up-to-date");
    assert.equal(result.restarted, true);
    assert.equal(restartCount, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("apply: 同一升级轨道并发调用会被拒绝", async () => {
  const manager = new UpgradeManager({ server: fakeServer("0.1.0") });
  let release;
  manager._applyApp = () => new Promise((resolve) => { release = resolve; });
  const first = manager.apply("app");
  await new Promise((resolve) => setImmediate(resolve));
  const second = await manager.apply("app");
  assert.equal(second.status, "error");
  assert.match(second.reason, /正在进行/);
  release({ track: "app", status: "up-to-date", applied: false });
  await first;
});

test("未知轨道 -> status error", async () => {
  const m = new UpgradeManager({ server: fakeServer("0.1.0") });
  const r = await m.check("unknown-track");
  assert.equal(r.status, "error");
  const r2 = await m.apply("unknown-track");
  assert.equal(r2.status, "error");
});

test("事件转发: onEvent sink 收到 backend-check", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ version: "9.9.9" }) });
  try {
    const m = new UpgradeManager({ server: fakeServer("0.1.0") });
    const events = [];
    m.setEventSink((payload) => events.push(payload));
    await m.check("backend");
    assert.ok(events.some((e) => e.type === "backend-check"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("BACKEND_UPGRADER 升级器已实现（非 stub）", () => {
  assert.equal(typeof BACKEND_UPGRADER.apply, "function");
  assert.ok(BACKEND_PACKAGE.length > 0);
  // 升级器源码应包含备份/安装/校验步骤（不再返回 stub 状态）
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "main", "updater.js"), "utf8");
  assert.ok(src.includes("升级前自动备份"), "应包含备份步骤");
  assert.ok(src.includes("runNpm"), "应包含可注入的 npm 执行器");
});
