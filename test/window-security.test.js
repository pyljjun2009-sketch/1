const { test } = require("node:test");
const assert = require("node:assert/strict");
const { denyPermissions, shouldShowServerWindow } = require("../src/main/window.js");

test("窗口默认拒绝系统权限请求", () => {
  let checkHandler;
  let requestHandler;
  denyPermissions({
    session: {
      setPermissionCheckHandler(handler) { checkHandler = handler; },
      setPermissionRequestHandler(handler) { requestHandler = handler; },
    },
  });
  assert.equal(checkHandler({}, "media"), false);
  let granted = true;
  requestHandler({}, "notifications", (value) => { granted = value; });
  assert.equal(granted, false);
});

test("首次窗口只在真实 DSH 页面加载完成后显示", () => {
  const server = { state: "running", url: "http://127.0.0.1:51888/" };
  assert.equal(shouldShowServerWindow(server, "file:///assets/loading.html"), false);
  assert.equal(shouldShowServerWindow(server, "http://127.0.0.1:51888/chat"), true);
  assert.equal(shouldShowServerWindow({ ...server, state: "starting" }, server.url), false);
  assert.equal(shouldShowServerWindow(server, "http://example.com/"), false);
});
