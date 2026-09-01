// Direct test of assertSettingsPage logic
const path = require("path");

// Simulate ipc.js __dirname
const ipcDirname = path.resolve("D:\\AI\\DSH\\src\\main");
const SETTINGS_PAGE_PATH = path.join(ipcDirname, "..", "..", "assets", "settings.html").replace(/\\/g, "/");
console.log("SETTINGS_PAGE_PATH:", SETTINGS_PAGE_PATH);

// Simulate test event URL (from ipc.test.js)
const testUrl = `file:///${SETTINGS_PAGE_PATH}`;
console.log("testUrl:", testUrl);

const pathname = new URL(testUrl).pathname;
console.log("pathname:", pathname);

// This is the normalization from assertSettingsPage
const normalizedPath = pathname.replace(/^\\/, "").replace(/^[/\\]+/, "").replace(/\\/g, "/");
const normalizedExpected = SETTINGS_PAGE_PATH.replace(/\\/g, "/");
console.log("normalizedPath:", normalizedPath);
console.log("normalizedExpected:", normalizedExpected);
console.log("match:", normalizedPath.toLowerCase() === normalizedExpected.toLowerCase());
