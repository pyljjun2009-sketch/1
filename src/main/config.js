/**
 * 桌面端配置存储（用户可编辑，向前兼容：未知字段会被忽略）。
 *
 * 配置文件位置（Windows）：%APPDATA%/dsh-desktop/settings.json
 *
 * 字段说明：
 *  - dshCommand:  string[] | null   完全自定义的 dsh web 启动命令 argv，
 *                                   （不含 --host/--port/--no-open，由主进程追加）。
 *                                   例如 ["C:\\node.exe", "C:\\...\\@deepseek-ai\\dsh\\lib\\bin.js", "web"]
 *                                   ⚠ 仅可在配置文件中手动设置，IPC 拒绝修改（防止渲染进程注入任意命令）。
 *  - nodeBin:     string | null     运行 dsh 所用的 node 可执行文件，null 时自动探测。
 *                                   ⚠ 仅可在配置文件中手动设置，IPC 拒绝修改。
 *  - host:        string            后端监听地址，默认 127.0.0.1。
 *  - port:        number            后端监听端口，0 表示自动挑选空闲端口（0-65535）。
 *  - workingDirectory: string|null  后端进程的工作目录；null 时按序回退：
 *                                   $DSH_HOME -> <userData>/workspace（自动创建）。
 *  - gpuMode:     "auto"|"off"|"inprocess"|null  GPU 渲染策略；null 时按平台默认：
 *                                   Windows = "inprocess"（软件渲染并入浏览器进程，
 *                                   规避 GPU 进程崩溃导致的启动即退），其他平台 = "auto"。
 *  - disableHardwareAcceleration: boolean  旧字段兼容：true 等价 gpuMode="off"。
 *  - keepBackendRunning: boolean   关闭窗口后是否保持 DSH 后端常开（进程不退出；
 *                                   再次启动应用实例可唤回窗口）。默认 false=退出即停后端。
 *  - launchAtLogin: boolean         开机自启。
 *  - openDevTools: boolean          启动后自动打开开发者工具。
 *  - autoRestartOnCrash: boolean    后端进程异常退出后自动重启（最多 3 次，指数退避）。
 *  - openBrowserOnCrash: boolean    桌面程序崩溃/非正常关闭后，自动打开系统浏览器访问 Web UI
 *                                   （由看门狗进程监控；taskkill /T 全树强杀场景不保证）。
 *
 * 校验规则见 VALIDATORS：非法值写入会被拒绝（set 抛错），配置文件里的非法值
 * 在加载时自动回退默认值并记录警告。
 */
const DEFAULTS = Object.freeze({
  dshCommand: null,
  nodeBin: null,
  host: "127.0.0.1",
  port: 0,
  workingDirectory: null,
  gpuMode: null,
  disableHardwareAcceleration: false,
  keepBackendRunning: false,
  reuseExistingDsh: false,
  allowNetworkAccess: false,
  launchAtLogin: false,
  openDevTools: false,
  autoRestartOnCrash: true,
  openBrowserOnCrash: true,
});

/** 单字段校验器：返回 true 表示合法。 */
const VALIDATORS = {
  dshCommand: (v) =>
    v === null || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")),
  nodeBin: (v) => v === null || (typeof v === "string" && v.trim().length > 0),
  host: (v) => typeof v === "string" && v.trim().length > 0,
  port: (v) => Number.isInteger(v) && v >= 0 && v <= 65535,
  workingDirectory: (v) => v === null || (typeof v === "string" && v.trim().length > 0),
  gpuMode: (v) => v === null || ["auto", "off", "inprocess"].includes(v),
  disableHardwareAcceleration: (v) => typeof v === "boolean",
  keepBackendRunning: (v) => typeof v === "boolean",
  reuseExistingDsh: (v) => typeof v === "boolean",
  allowNetworkAccess: (v) => typeof v === "boolean",
  launchAtLogin: (v) => typeof v === "boolean",
  openDevTools: (v) => typeof v === "boolean",
  autoRestartOnCrash: (v) => typeof v === "boolean",
  openBrowserOnCrash: (v) => typeof v === "boolean",
};

const FIELD_LABELS = {
  port: "0-65535 的整数",
  host: "非空字符串",
  dshCommand: "string[] 或 null（仅配置文件可改）",
  nodeBin: "非空字符串或 null（仅配置文件可改）",
  workingDirectory: "非空字符串或 null",
  gpuMode: '"auto"、"off"、"inprocess" 或 null',
  disableHardwareAcceleration: "布尔值",
  keepBackendRunning: "布尔值",
  reuseExistingDsh: "布尔值",
  allowNetworkAccess: "布尔值（允许局域网访问，有安全风险）",
  launchAtLogin: "布尔值",
  openDevTools: "布尔值",
  autoRestartOnCrash: "布尔值",
  openBrowserOnCrash: "布尔值（崩溃/异常关闭后自动打开浏览器访问 Web UI）",
};

function validateField(key, value) {
  const validator = VALIDATORS[key];
  if (!validator) return true; // 未知字段忽略（向前兼容）
  return validator(value);
}

class Settings {
  constructor() {
    this.file = null;
    this.userDataDir = null;
    this.data = { ...DEFAULTS };
    this.warnings = [];
  }

  /** 需在 app ready 之后调用（依赖 app.getPath）。 */
  init(app) {
    const { join } = require("node:path");
    const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
    this.userDataDir = app.getPath("userData");
    mkdirSync(this.userDataDir, { recursive: true });
    this.file = join(this.userDataDir, "settings.json");
    this.warnings = [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object") {
        for (const key of Object.keys(raw)) {
          if (!(key in DEFAULTS)) {
            this.warnings.push(`未知配置字段已忽略: ${key}`);
            continue; // 未知字段不进入 data，保持文件原样
          }
          if (validateField(key, raw[key])) {
            this.data[key] = raw[key];
          } else {
            this.warnings.push(`配置字段非法，已回退默认值: ${key}（应为 ${FIELD_LABELS[key] ?? "合法值"}）`);
          }
        }
      }
    } catch {
      this.warnings.push("配置文件不存在或无法解析，已使用默认配置");
    }
    for (const w of this.warnings) console.warn(`[dsh-desktop] ${w}`);
    this.save();
    // 应用开机自启设置
    if (app.setLoginItemSettings) {
      app.setLoginItemSettings({ openAtLogin: Boolean(this.data.launchAtLogin) });
    }
    return this;
  }

  get(key) {
    return this.data[key];
  }

  /** 校验并写入；非法值抛出 Error（IPC 调用方会收到明确的失败原因）。 */
  set(patch) {
    if (!patch || typeof patch !== "object") {
      throw new Error("配置补丁必须是对象");
    }
    for (const key of Object.keys(patch)) {
      if (!(key in DEFAULTS)) continue; // 未知字段忽略，保证向前兼容
      if (!validateField(key, patch[key])) {
        throw new Error(`配置字段非法: ${key}（应为 ${FIELD_LABELS[key] ?? "合法值"}）`);
      }
      this.data[key] = patch[key];
    }
    const saved = this.save();
    if (!saved) {
      console.warn("[dsh-desktop] 配置已应用到内存，但磁盘写入失败（重启后可能丢失）");
    }
  }

  save() {
    if (!this.file) return false;
    const { writeFileSync } = require("node:fs");
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2) + "\n", "utf8");
      return true;
    } catch (err) {
      console.error("[dsh-desktop] 保存配置失败:", err);
      this.lastSaveError = err.message;
      return false;
    }
  }

  get all() {
    return { ...this.data };
  }
}

module.exports = { settings: new Settings(), Settings, DEFAULTS, VALIDATORS, validateField };
