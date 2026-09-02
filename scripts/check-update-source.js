/** Read-only online check through Electron's real network stack and packaged update config. */
const { app } = require("electron");
const { join, resolve } = require("node:path");
const { NsisUpdater } = require("electron-updater/out/NsisUpdater");
const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor");
const { UpgradeManager } = require("../src/main/updater");
const project = resolve(__dirname, "..");
const data = join(project, "artifacts", "update-source-check");
app.setPath("userData", data);
app.disableHardwareAcceleration();
const guard = setTimeout(() => { console.error("UPDATE_SOURCE_CHECK_TIMEOUT"); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const updater = new NsisUpdater(null, {
    version: require("../package.json").version, name: "dsh-update-source-check", isPackaged: true,
    userDataPath: data, baseCachePath: data,
    appUpdateConfigPath: resolve(process.argv[2] || join(project, "artifacts", "dsh-desktop-build-a", "win-unpacked", "resources", "app-update.yml")),
    whenReady: () => app.whenReady(), onQuit: () => {}, quit: () => { throw new Error("Read-only check must not install"); },
  });
  updater.httpExecutor = new ElectronHttpExecutor();
  updater.logger = null;
  const manager = new UpgradeManager({ appUpdaterLoader: async () => updater });
  const result = await manager.check("app");
  console.log("UPDATE_SOURCE_CHECK " + JSON.stringify(result));
  clearTimeout(guard);
  app.exit(["up-to-date", "update-available"].includes(result.status) ? 0 : 1);
}).catch((err) => { console.error(err.message); clearTimeout(guard); app.exit(1); });
