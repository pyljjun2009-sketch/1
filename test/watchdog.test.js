/**
 * 崩溃看门狗单元测试。
 * 测试 decideAfterMainExit 决策逻辑、URL 安全校验、进程探测等纯函数。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const {
  pidAlive,
  isSafeWebUrl,
  decideAfterMainExit,
  PROBE_ATTEMPTS,
} = require("../src/main/watchdog.js");

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "watchdog-test-"));
}

test("pidAlive: 非法输入返回 false", () => {
  assert.equal(pidAlive(null), false);
  assert.equal(pidAlive(undefined), false);
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive("abc"), false);
});

test("pidAlive: 当前进程存在", () => {
  assert.equal(pidAlive(process.pid), true);
});

test("isSafeWebUrl: 只接受 http(s) 本机地址", () => {
  assert.equal(isSafeWebUrl("http://127.0.0.1:3080/"), true);
  assert.equal(isSafeWebUrl("http://localhost:8080/"), true);
  assert.equal(isSafeWebUrl("http://[::1]:3080/"), true);
  assert.equal(isSafeWebUrl("http://0.0.0.0:9999/"), true);
  assert.equal(isSafeWebUrl("https://127.0.0.1:443/"), true);
  // 拒绝：非本机、非 http(s)、注入尝试
  assert.equal(isSafeWebUrl("http://evil.example.com/"), false);
  assert.equal(isSafeWebUrl("https://example.com/"), false);
  assert.equal(isSafeWebUrl("file:///C:/Windows/system32"), false);
  assert.equal(isSafeWebUrl("javascript:alert(1)"), false);
  assert.equal(isSafeWebUrl("cmd /c calc"), false);
  assert.equal(isSafeWebUrl(""), false);
  assert.equal(isSafeWebUrl(null), false);
  assert.equal(isSafeWebUrl(undefined), false);
  assert.equal(isSafeWebUrl("http://127.0.0.1:3080/ --evil"), false); // 空白字符 → 拒绝
  assert.equal(isSafeWebUrl(" http://127.0.0.1/"), false); // 前导空白 → 拒绝
});

test("decideAfterMainExit: 正常退出（有 clean-exit 标记）→ clean，不打开浏览器", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, ".last-clean-exit"), new Date().toISOString(), "utf8");
    writeFileSync(join(dir, ".dsh-web-url"), "http://127.0.0.1:3080/", "utf8");
    let opened = false;
    const result = await decideAfterMainExit({
      userDataDir: dir,
      urlFile: join(dir, ".dsh-web-url"),
      probe: async () => true,
      open: () => { opened = true; },
      exists: (p) => require("node:fs").existsSync(p),
    });
    assert.equal(result, "clean");
    assert.equal(opened, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decideAfterMainExit: 无 URL 文件 → no-url，不打开", async () => {
  const dir = makeTmp();
  try {
    let opened = false;
    const result = await decideAfterMainExit({
      userDataDir: dir,
      urlFile: join(dir, ".dsh-web-url"),
      probe: async () => true,
      open: () => { opened = true; },
      exists: () => false,
    });
    assert.equal(result, "no-url");
    assert.equal(opened, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decideAfterMainExit: URL 非法 → invalid-url，不打开", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, ".dsh-web-url"), "http://evil.example.com/", "utf8");
    let opened = false;
    const result = await decideAfterMainExit({
      userDataDir: dir,
      urlFile: join(dir, ".dsh-web-url"),
      probe: async () => true,
      open: () => { opened = true; },
      exists: () => false,
    });
    assert.equal(result, "invalid-url");
    assert.equal(opened, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decideAfterMainExit: 探测可达 → opened，打开浏览器一次", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, ".dsh-web-url"), "http://127.0.0.1:3080/", "utf8");
    let openCount = 0;
    const result = await decideAfterMainExit({
      userDataDir: dir,
      urlFile: join(dir, ".dsh-web-url"),
      probe: async () => true,
      open: () => { openCount += 1; },
      exists: () => false,
    });
    assert.equal(result, "opened");
    assert.equal(openCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decideAfterMainExit: 探测全部失败 → unreachable，不打开", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, ".dsh-web-url"), "http://127.0.0.1:3080/", "utf8");
    let probeCount = 0;
    let opened = false;
    const result = await decideAfterMainExit({
      userDataDir: dir,
      urlFile: join(dir, ".dsh-web-url"),
      probe: async () => { probeCount += 1; return false; },
      open: () => { opened = true; },
      exists: () => false,
    });
    assert.equal(result, "unreachable");
    assert.equal(probeCount, PROBE_ATTEMPTS);
    assert.equal(opened, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decideAfterMainExit: 第二次探测成功也打开（重试语义）", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, ".dsh-web-url"), "http://127.0.0.1:3080/", "utf8");
    let attempt = 0;
    let opened = false;
    const result = await decideAfterMainExit({
      userDataDir: dir,
      urlFile: join(dir, ".dsh-web-url"),
      probe: async () => { attempt += 1; return attempt >= 2; },
      open: () => { opened = true; },
      exists: () => false,
    });
    assert.equal(result, "opened");
    assert.equal(opened, true);
    assert.ok(attempt >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
