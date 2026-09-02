/** Verify update metadata against actual release assets before publication. */
const { readFileSync, existsSync, statSync } = require("node:fs");
const { resolve, join, basename } = require("node:path");
const { createHash } = require("node:crypto");
const { load } = require("js-yaml");
const assert = require("node:assert/strict");
const version = require("../package.json").version;
const dir = resolve(process.argv[2] || join(__dirname, "..", "release"));
const meta = load(readFileSync(join(dir, "latest.yml"), "utf8"));
assert.equal(meta.version, version, "release version mismatch");
assert.ok(Array.isArray(meta.files) && meta.files.length > 0, "missing files");
for (const file of meta.files) {
  assert.equal(basename(file.url), file.url, "asset must be a local filename");
  assert.equal(file.url, `DeepSeek-Harness-Desktop-${version}-x64.exe`);
  const path = join(dir, file.url);
  assert.equal(statSync(path).size, file.size, "asset size mismatch");
  assert.equal(createHash("sha512").update(readFileSync(path)).digest("base64"), file.sha512, "asset SHA512 mismatch");
  assert.ok(existsSync(`${path}.blockmap`), "blockmap missing");
}
assert.equal(meta.path, meta.files[0].url);
assert.equal(meta.sha512, meta.files[0].sha512);
console.log(`[verify-release] PASS ${version}: filenames, sizes, SHA512, blockmap`);
