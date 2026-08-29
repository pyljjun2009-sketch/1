const { test } = require("node:test");
const assert = require("node:assert/strict");
const { denyPermissions } = require("../src/main/window.js");

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
