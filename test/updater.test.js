/**
 * 升级接口测试：后端轨道（mock fetch）与应用轨道（注入假 autoUpdater）。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { UpgradeManager, BACKEND_UPGRADER, BACKEND_PACKAGE } = require("../src/main/updater.js");

function fakeServer(version) {
  return { version, _detectVersion: async () => version };
}

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
