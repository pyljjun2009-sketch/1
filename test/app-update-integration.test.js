/** Real electron-updater HTTP/download/hash verification; NEVER executes an installer. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { NsisUpdater } = require("electron-updater/out/NsisUpdater");
const { NodeHttpExecutor } = require("builder-util/out/nodeHttpExecutor");
const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor");
const { UpgradeManager } = require("../src/main/updater");

test("真实升级组件：HTTP 检测、下载及 SHA512 校验；损坏文件不能安装", async () => {
  const payload = Buffer.from("MZ-DSH-update-fixture-NOT-an-executable");
  const sha512 = createHash("sha512").update(payload).digest("base64");
  let corrupt = false;
  const server = http.createServer((req, res) => {
    if (req.url.split("?")[0] === "/latest.yml") {
      res.end(`version: 9.0.0\nfiles:\n  - url: update.exe\n    sha512: ${sha512}\n    size: ${payload.length}\npath: update.exe\nsha512: ${sha512}\nreleaseDate: '2026-09-02T00:00:00.000Z'\n`);
    } else if (req.url.split("?")[0] === "/update.exe") {
      const data = corrupt ? Buffer.alloc(payload.length, 0) : payload;
      res.setHeader("Content-Length", data.length);
      res.end(data);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "dsh-update-http-"));
  try {
    for (const corrupted of [false, true]) {
      corrupt = corrupted;
      const dir = join(root, corrupted ? "bad" : "good");
      mkdirSync(dir);
      const configPath = join(dir, "app-update.yml");
      writeFileSync(configPath, "updaterCacheDirName: test-updates\n");
      const updater = new NsisUpdater(null, {
        version: "0.1.2", name: "dsh-update-test", isPackaged: true,
        userDataPath: dir, baseCachePath: dir, appUpdateConfigPath: configPath,
        whenReady: async () => {}, onQuit: () => {},
        quit: () => { throw new Error("Test must not install or quit"); },
      });
      const executor = new NodeHttpExecutor();
      // Keep production streaming/checksum logic; only replace Chromium's HTTP transport.
      executor.download = ElectronHttpExecutor.prototype.download;
      updater.httpExecutor = executor;
      updater.logger = null;
      updater.disableDifferentialDownload = true;
      updater.disableWebInstaller = true;
      updater.setFeedURL({ provider: "generic", url: `http://127.0.0.1:${server.address().port}/` });
      const manager = new UpgradeManager({ appUpdaterLoader: async () => updater });
      assert.equal((await manager.check("app")).status, "update-available");
      const downloaded = await manager.apply("app");
      if (corrupted) {
        assert.equal(downloaded.status, "error");
        assert.match(downloaded.reason, /checksum|sha512/i);
        assert.equal((await manager.installApp()).status, "error");
      } else {
        assert.equal(downloaded.status, "update-downloaded");
        assert.deepEqual(readFileSync(updater.installerPath), payload);
        assert.equal((await manager.check("app")).status, "update-downloaded");
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
