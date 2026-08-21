# 升级接口设计（预留）

桌面端把"升级"拆成三条独立轨道，每个结果都带显式 `status` 枚举，诚实报告当前能力，不抛错、不假升级；接入真实升级服务时**无需改动 IPC 协议**。

## 三条轨道与状态枚举

| track | 含义 | 当前状态 | 接入点 |
| --- | --- | --- | --- |
| `app` | 桌面应用自升级 | 已内置 `electron-updater`；未配置发布源时 `status:"not-configured"` | `electron-builder.yml` 的 `publish` 配置 |
| `backend` | DSH 后端（npm 包 `@deepseek-ai/dsh`）升级 | `check()` 已实现；`apply()` 为 `status:"stub"` | `src/main/updater.js` 的 `BACKEND_UPGRADER` |
| `profile` | Profile bundle 依赖更新 | `check()` 已实现（对比 npm registry）；`apply()` 已实现（`dsh plugin update`） | `src/main/updater.js` 的 `_checkProfile`/`_applyProfile` |

`status` 枚举（结果对象统一携带）：

```text
not-configured    接口可用但未配置（无发布源 / electron-updater 不可用）
up-to-date        已是最新
update-available  发现新版本（尚未下载）
update-downloaded 新版本已下载（重启应用后安装，NSIS 默认下次启动安装）
stub              接口预留但未实现（后端自动升级）
error             检查/执行失败（reason 含原因）
```

## IPC 协议（渲染进程侧，经 `window.dshDesktop.upgrade.*` 调用）

```js
// 检查升级；track: "app" | "backend"
const result = await window.dshDesktop.upgrade.check("backend");
// -> { track, status, supported, current, latest, available, message, reason?, hint? }

// 执行升级；targetVersion 可选（缺省 = latest）
const result = await window.dshDesktop.upgrade.apply("backend");
// -> { track, status, applied, message, reason?, hint? }

// 订阅升级过程事件（checking / available / downloading / downloaded / error ...）
const unsubscribe = window.dshDesktop.upgrade.onEvent((payload) => { ... });
```

对应主进程实现：`src/main/updater.js`（`UpgradeManager.check/apply`），通道定义：`src/shared/channels.js`。UI 呈现时应区分：`not-configured` → "升级暂不可用"；`update-available` → "发现更新"；`update-downloaded` → "已下载，重启安装"；`stub` → 显示 `hint` 指引。

> 桌面端帮助菜单内置"升级状态"对话框（`src/main/index.js` 的 `checkUpgrades`），
> 实时展示两条轨道的 status/message/reason/hint，并明确标注"后端轨道当前仅支持检测，一键升级尚未实现（预留接口）"。

## 接入 1：应用自升级（app track）

1. 在 `electron-builder.yml` 中配置发布源（generic/github/s3 等），例如：

   ```yaml
   publish:
     provider: generic
     url: https://updates.example.com/dsh-desktop/
     channel: latest
   ```

2. 重新打包：`npm run dist`（打包会生成 `app-update.yml`）。
3. 发布产物时把 `latest.yml`（win）与安装包一并上传到发布源。
4. 无需改任何代码：`upgrade.check("app")` 返回 `status:"update-available"` 并真正检查更新；`apply("app")` 下载后返回 `status:"update-downloaded"`，重启应用后由 NSIS 完成安装。

## 接入 2：后端自动升级（backend track）

`apply()` 当前返回 stub：

```js
{ applied: false, status: "stub", reason: "后端自动升级尚未实现（预留接口）", hint: "npm i -g @deepseek-ai/dsh@latest ..." }
```

实现真实升级时，替换 `src/main/updater.js` 中的 `BACKEND_UPGRADER.apply`：

```js
const BACKEND_UPGRADER = {
  async apply({ server, targetVersion }) {
    // 1) 用 npm/pnpm 升级 @deepseek-ai/dsh 到 targetVersion（可经 execFile 调用 npm）
    // 2) 校验新版本号（读取 server._binPath 同级 package.json 的 version）
    // 3) 等待新版本校验通过后调用 await server.restart()
    // 4) return { applied: true, status: "update-available", version: <新版本> }
  },
};
```

`server` 提供 `restart()`、`version`、`_binPath`、`status()` 等成员（见 `src/main/dsh-server.js`），升级器不应直接修改 DSH 本体文件。

## 兼容性约定

- `settings.json` 向前兼容：未知字段忽略；非法值拒绝写入或回退默认值并告警（见 `src/main/config.js`）。
- IPC 通道只增不删；新增能力时在 `src/shared/channels.js`、`src/preload/preload.js`（最小权限）与 `src/preload/preload-settings.js`（完整权限）三处同步注册。
- 升级失败永不假成功：必须返回明确的 `status` 与 `reason`，由 UI 呈现。
- 升级状态机有单测覆盖（`test/updater.test.js`，注入假 autoUpdater / mock fetch），改动后运行 `npm test`。
