/** Static security checks for local privileged pages. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

function asset(name) {
  return readFileSync(join(__dirname, "..", "assets", name), "utf8");
}

test("本地页面使用严格 CSP 与外部脚本", () => {
  for (const page of ["loading.html", "settings.html"]) {
    const html = asset(page);
    assert.match(html, /script-src 'self';/);
    assert.doesNotMatch(html, /script-src[^;]*unsafe-inline/);
    assert.match(html, /object-src 'none'/);
    assert.match(html, /form-action 'none'/);
  }
  assert.match(asset("loading.html"), /<script src="loading\.js"><\/script>/);
  assert.match(asset("settings.html"), /<script src="settings\.js"><\/script>/);
});

test("设置页不含可执行的内联事件属性", () => {
  const html = asset("settings.html");
  const executable = html.replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(executable, /\sonclick\s*=/i);
  assert.doesNotMatch(executable, /<script(?![^>]*\bsrc=)[^>]*>/i);
});
