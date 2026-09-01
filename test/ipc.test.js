/**
 * IPC 接线测试：注入假 electron 依赖，验证处理器行为与事件转发。
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { registerIpc, isSafeExternalUrl } = require("../src/main/ipc.js");
const { settings, Settings } = require("../src/main/config.js");
const CH = require("../src/shared/channels.js");

/** 收集 handle 注册的假 ipcMain */
function makeFakeIpc() {
  const handlers = new Map();
  const settingsUrl = `file:///${join(__dirname, "..", "assets", "settings.html").replace(/\\/g, "/")}`;
  return {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    async invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ senderFrame: { url: settingsUrl } }, ...args);
    },
  };
}

function makeFakeWindow() {
  const sends = [];
  return {
    sends,
    isDestroyed: () => false,
    loadURL: () => {},
    webContents: {
      send(channel, payload) {
        sends.push({ channel, payload });
      },
      openDevTools: () => {},
      reload: () => {},
    },
  };
}

let ipc;
let win;
let calls;
let fakeBackup;

beforeEach(() => {
  ipc = makeFakeIpc();
  win = makeFakeWindow();
  calls = { restarts: 0 };
  const fakeServer = {
    status: () => ({ state: "running", url: "http://127.0.0.1:9/" }),
    restart: async () => {
      calls.restarts += 1;
      return { state: "running", url: "http://127.0.0.1:9/" };
    },
    version: "0.1.0",
    on: () => {},
    removeListener: () => {},
  };
  const fakeUpgrade = {
    check: async (track) => ({ track, status: "up-to-date" }),
    apply: async (track) => ({ track, applied: false }),
    setEventSink: (fn) => {
      calls.sink = fn;
    },
  };
  const fakeShell = { openExternal: async () => {} };
  const dir = mkdtempSync(join(tmpdir(), "dsh-ipc-"));
  fakeBackup = {
    create: (note) => ({ id: "backup-id", note }),
    list: () => [],
    restore: (id) => ({ restored: id }),
    diff: (id) => ({ id, identical: true, diffs: {} }),
    delete: (id) => ({ deleted: id }),
  };
  const fakeCrash = {
    dshHome: dir,
    getStatus: () => ({}),
    diagnose: () => ({ issues: [] }),
    markCleanExit: () => {},
  };
  new Settings().init({ getPath: () => dir, setLoginItemSettings: () => {} });
  registerIpc({
    server: fakeServer,
    getWindow: () => win,
    upgradeManager: fakeUpgrade,
    backupManager: fakeBackup,
    crashRecovery: fakeCrash,
    ipc,
    appApi: { getVersion: () => "0.1.0", setLoginItemSettings: () => {} },
    shellApi: fakeShell,
  });
});

test("STATUS 返回后端状态", async () => {
  const r = await ipc.invoke(CH.STATUS);
  assert.equal(r.state, "running");
});

test("RESTART 调用 server.restart", async () => {
  const r = await ipc.invoke(CH.RESTART);
  assert.equal(calls.restarts, 1);
  assert.equal(r.state, "running");
});

test("VERSIONS 返回结构完整", async () => {
  const r = await ipc.invoke(CH.VERSIONS);
  assert.equal(typeof r.app, "string");
  // 纯 node 环境下无 process.versions.electron/chrome；Electron 运行时有值
  assert.ok(r.electron === undefined || typeof r.electron === "string");
  assert.ok(r.chrome === undefined || typeof r.chrome === "string");
  assert.equal(typeof r.node, "string");
  assert.equal(r.dsh, "0.1.0");
});

test("SET_CONFIG: 合法补丁生效", async () => {
  const r = await ipc.invoke(CH.SET_CONFIG, { port: 8080 });
  assert.equal(r.port, 8080);
});

test("SET_CONFIG: 非法补丁抛错（invoke rejection）", async () => {
  await assert.rejects(ipc.invoke(CH.SET_CONFIG, { port: -5 }), /port/);
  await assert.rejects(ipc.invoke(CH.SET_CONFIG, { host: 123 }), /host/);
});

test("SET_CONFIG: 拒绝渲染进程修改 dshCommand/nodeBin（安全限制）", async () => {
  await assert.rejects(
    ipc.invoke(CH.SET_CONFIG, { dshCommand: ["C:\\node.exe", "C:\\evil.js"] }),
    /dshCommand/
  );
  await assert.rejects(ipc.invoke(CH.SET_CONFIG, { nodeBin: "C:\\evil.exe" }), /nodeBin/);
  // 混合补丁：受限字段存在即整体拒绝
  await assert.rejects(ipc.invoke(CH.SET_CONFIG, { port: 1234, dshCommand: null }), /dshCommand/);
  // 非受限字段不受影响
  const r = await ipc.invoke(CH.SET_CONFIG, { port: 1234 });
  assert.equal(r.port, 1234);
});

test("OPEN_EXTERNAL: 仅放行 http(s)", async () => {
  const ok = await ipc.invoke(CH.OPEN_EXTERNAL, "https://example.com");
  assert.equal(ok.ok, true);
  const bad = await ipc.invoke(CH.OPEN_EXTERNAL, "file:///C:/Windows/system32");
  assert.equal(bad.ok, false);
  const bad2 = await ipc.invoke(CH.OPEN_EXTERNAL, "javascript:alert(1)");
  assert.equal(bad2.ok, false);
  const bad3 = await ipc.invoke(CH.OPEN_EXTERNAL, 42);
  assert.equal(bad3.ok, false);
  const bad4 = await ipc.invoke(CH.OPEN_EXTERNAL, "https://user:pass@example.com");
  assert.equal(bad4.ok, false);
});

test("管理 IPC 只允许本地设置页调用", async () => {
  const handler = ipc.handlers.get(CH.SET_CONFIG);
  assert.throws(
    () => handler({ senderFrame: { url: "http://127.0.0.1:3080/" } }, { port: 8080 }),
    /本地设置页/
  );
});

test("管理 IPC 校验备份备注长度", async () => {
  await assert.rejects(ipc.invoke(CH.BACKUP_CREATE, "x".repeat(501)), /500/);
  const result = await ipc.invoke(CH.BACKUP_CREATE, "正常备注");
  assert.equal(result.note, "正常备注");
});

test("外部 URL 校验拒绝凭据、非 HTTP 与超长输入", () => {
  assert.ok(isSafeExternalUrl("https://example.com/docs"));
  assert.ok(!isSafeExternalUrl("https://user:pass@example.com"));
  assert.ok(!isSafeExternalUrl("file:///C:/Windows"));
  assert.ok(!isSafeExternalUrl("https://example.com/" + "a".repeat(2050)));
});

test("UPGRADE_CHECK/APPLY 转发到 UpgradeManager", async () => {
  const r1 = await ipc.invoke(CH.UPGRADE_CHECK, "backend");
  assert.equal(r1.track, "backend");
  const r2 = await ipc.invoke(CH.UPGRADE_APPLY, "backend");
  assert.equal(r2.applied, false);
});

test("事件推送: sink 已注册", () => {
  assert.equal(typeof calls.sink, "function");
});

test("CRASH_RESET: 备份失败时不执行重置（数据安全回归）", async () => {
  // 让备份 create 抛错（模拟磁盘满），profile 不应被删除
  const origCreate = fakeBackup.create;
  fakeBackup.create = () => { throw new Error("磁盘满"); };
  try {
    const result = await ipc.invoke(CH.CRASH_RESET);
    assert.equal(result.reset, false);
    assert.ok(result.error && result.error.includes("备份失败"), `error=${result.error}`);
  } finally {
    fakeBackup.create = origCreate;
  }
});

test("CRASH_RESET: 重置成功返回 backupId（正常路径）", async () => {
  const result = await ipc.invoke(CH.CRASH_RESET);
  assert.equal(result.reset, true);
  assert.equal(result.backupId, "backup-id");
});
