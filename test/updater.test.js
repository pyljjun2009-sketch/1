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

test("backend apply: 预留 stub，明确返回未实现", async () => {
  const m = new UpgradeManager({ server: fakeServer("0.1.0") });
  const r = await m.apply("backend");
  assert.equal(r.track, "backend");
  assert.equal(r.status, "stub");
  assert.equal(r.applied, false);
  assert.ok(r.hint.includes(BACKEND_PACKAGE));
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

test("BACKEND_UPGRADER 钩子存在且为 stub（升级接口预留点）", () => {
  assert.equal(typeof BACKEND_UPGRADER.apply, "function");
  assert.ok(BACKEND_PACKAGE.length > 0);
});
