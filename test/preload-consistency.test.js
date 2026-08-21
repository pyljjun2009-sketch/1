/**
 * IPC 通道一致性测试：确保 preload 常量与 channels.js 同步。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const CH = require("../src/shared/channels.js");

/** 从 preload 文件中提取 CH.XXX 引用的键名。 */
function extractPreloadKeys(filename) {
  const content = readFileSync(join(__dirname, "..", "src", "preload", filename), "utf8");
  // 匹配 CH.KEY_NAME 模式（invoke 和 subscribe 调用）
  const matches = [...content.matchAll(/CH\.([A-Z_]+)/g)];
  return new Set(matches.map((m) => m[1]));
}

test("preload.js 的通道常量与 channels.js 完全同步", () => {
  const preloadKeys = extractPreloadKeys("preload.js");
  const channelKeys = new Set(Object.keys(CH));

  // preload 中引用的每个键都必须在 channels.js 中定义
  for (const key of preloadKeys) {
    assert.ok(channelKeys.has(key), `preload.js 引用了 CH.${key}，但 channels.js 中不存在`);
  }
});

test("preload-settings.js 的通道常量与 channels.js 完全同步", () => {
  const preloadKeys = extractPreloadKeys("preload-settings.js");
  const channelKeys = new Set(Object.keys(CH));

  for (const key of preloadKeys) {
    assert.ok(channelKeys.has(key), `preload-settings.js 引用了 CH.${key}，但 channels.js 中不存在`);
  }

  // settings 预加载应包含所有管理 API 的通道
  const managementKeys = [
    "BACKUP_CREATE", "BACKUP_LIST", "BACKUP_RESTORE", "BACKUP_DIFF", "BACKUP_DELETE",
    "CRASH_GET_STATUS", "CRASH_DIAGNOSE", "CRASH_MARK_CLEAN", "CRASH_RESET", "CRASH_RESYNC",
    "UPGRADE_CHECK", "UPGRADE_APPLY",
    "GET_CONFIG", "SET_CONFIG",
    "OPEN_DEVTOOLS",
  ];
  for (const key of managementKeys) {
    assert.ok(preloadKeys.has(key), `preload-settings.js 缺少管理通道: ${key}`);
  }
});

test("preload.js（最小权限）不应包含管理 API 通道", () => {
  const preloadKeys = extractPreloadKeys("preload.js");
  const restrictedKeys = [
    "BACKUP_CREATE", "BACKUP_RESTORE", "BACKUP_DELETE",
    "CRASH_GET_STATUS", "CRASH_DIAGNOSE", "CRASH_MARK_CLEAN", "CRASH_RESET", "CRASH_RESYNC",
    "GET_CONFIG", "SET_CONFIG",
    "UPGRADE_CHECK", "UPGRADE_APPLY",
  ];
  for (const key of restrictedKeys) {
    assert.ok(!preloadKeys.has(key), `preload.js 不应包含管理通道: ${key}（安全风险）`);
  }
});
