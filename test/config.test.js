/**
 * 配置存储与校验测试。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Settings, DEFAULTS } = require("../src/main/config.js");

function makeDir() {
  return mkdtempSync(join(tmpdir(), "dsh-desktop-config-"));
}

function fakeApp(dir) {
  return {
    getPath: () => dir,
    setLoginItemSettings: () => {},
  };
}

test("init: 空目录生成默认配置并落盘", () => {
  const dir = makeDir();
  const s = new Settings().init(fakeApp(dir));
  assert.equal(s.get("port"), 0);
  assert.equal(s.get("host"), "127.0.0.1");
  assert.equal(s.get("autoRestartOnCrash"), true);
  assert.ok(existsSync(join(dir, "settings.json")));
  rmSync(dir, { recursive: true, force: true });
});

test("set: 合法补丁持久化到文件", () => {
  const dir = makeDir();
  const s = new Settings().init(fakeApp(dir));
  s.set({ port: 12345, host: "0.0.0.0", autoRestartOnCrash: false });
  assert.equal(s.get("port"), 12345);
  const reloaded = new Settings().init(fakeApp(dir));
  assert.equal(reloaded.get("port"), 12345);
  assert.equal(reloaded.get("host"), "0.0.0.0");
  assert.equal(reloaded.get("autoRestartOnCrash"), false);
  rmSync(dir, { recursive: true, force: true });
});

test("set: 非法 port 拒绝（负数/超界/字符串/浮点）", () => {
  const dir = makeDir();
  const s = new Settings().init(fakeApp(dir));
  for (const bad of [-1, 65536, "3080", 1.5, NaN]) {
    assert.throws(() => s.set({ port: bad }), /port/);
    assert.equal(s.get("port"), 0, `port 应保持默认: ${bad}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("set: 非法 dshCommand / nodeBin / host / 布尔 拒绝", () => {
  const dir = makeDir();
  const s = new Settings().init(fakeApp(dir));
  assert.throws(() => s.set({ dshCommand: "node bin.js" }), /dshCommand/);
  assert.throws(() => s.set({ dshCommand: ["node", 42] }), /dshCommand/);
  assert.throws(() => s.set({ dshCommand: [] }), /dshCommand/);
  assert.throws(() => s.set({ nodeBin: "" }), /nodeBin/);
  assert.throws(() => s.set({ host: 123 }), /host/);
  assert.throws(() => s.set({ host: "" }), /host/);
  assert.throws(() => s.set({ launchAtLogin: "yes" }), /launchAtLogin/);
  assert.throws(() => s.set({ workingDirectory: "" }), /workingDirectory/);
  // 合法值
  s.set({ dshCommand: null, nodeBin: null, workingDirectory: null, launchAtLogin: true });
  assert.equal(s.get("launchAtLogin"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("set/init: gpuMode 与 keepBackendRunning 校验", () => {
  const dir = makeDir();
  const s = new Settings().init(fakeApp(dir));
  // 合法枚举
  for (const mode of ["auto", "off", "inprocess", null]) {
    s.set({ gpuMode: mode });
    assert.equal(s.get("gpuMode"), mode);
  }
  // 非法枚举拒绝
  assert.throws(() => s.set({ gpuMode: "turbo" }), /gpuMode/);
  assert.throws(() => s.set({ gpuMode: 42 }), /gpuMode/);
  // keepBackendRunning 布尔校验
  s.set({ keepBackendRunning: true });
  assert.equal(s.get("keepBackendRunning"), true);
  assert.throws(() => s.set({ keepBackendRunning: "yes" }), /keepBackendRunning/);
  // 文件内非法 gpuMode 回退默认
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ gpuMode: "turbo" }));
  const s2 = new Settings().init(fakeApp(dir));
  assert.equal(s2.get("gpuMode"), DEFAULTS.gpuMode);
  rmSync(dir, { recursive: true, force: true });
});

test("set: 未知字段静默忽略", () => {
  const dir = makeDir();
  const s = new Settings().init(fakeApp(dir));
  s.set({ futureField: "whatever", port: 9999 });
  assert.equal(s.get("port"), 9999);
  assert.equal("futureField" in s.data, false);
  rmSync(dir, { recursive: true, force: true });
});

test("init: 配置文件损坏时回退默认值并产生警告", () => {
  const dir = makeDir();
  writeFileSync(join(dir, "settings.json"), "{not json!!!");
  const s = new Settings().init(fakeApp(dir));
  assert.equal(s.get("port"), 0);
  assert.equal(s.get("host"), "127.0.0.1");
  assert.ok(s.warnings.some((w) => w.includes("无法解析")));
  rmSync(dir, { recursive: true, force: true });
});

test("init: 配置字段非法时回退默认值并产生警告", () => {
  const dir = makeDir();
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ port: 999999, host: "", autoRestartOnCrash: "yes" })
  );
  const s = new Settings().init(fakeApp(dir));
  assert.equal(s.get("port"), DEFAULTS.port);
  assert.equal(s.get("host"), DEFAULTS.host);
  assert.equal(s.get("autoRestartOnCrash"), DEFAULTS.autoRestartOnCrash);
  assert.ok(s.warnings.some((w) => w.includes("非法")));
  rmSync(dir, { recursive: true, force: true });
});

test("init: 向前兼容——未知字段不破坏加载", () => {
  const dir = makeDir();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ future: { a: 1 }, port: 4321 }));
  const s = new Settings().init(fakeApp(dir));
  assert.equal(s.get("port"), 4321);
  assert.ok(s.warnings.some((w) => w.includes("未知")));
  rmSync(dir, { recursive: true, force: true });
});
