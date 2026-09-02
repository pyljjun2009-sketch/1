# 升级接口设计与实现

桌面端把"升级"拆成三条独立轨道，每个结果都带显式 `status` 枚举，诚实报告当前能力，不抛错、不假升级；接入真实升级服务时**无需改动 IPC 协议**。

## 三条轨道与状态枚举

| track | 含义 | 当前状态 | 接入点 |
| --- | --- | --- | --- |
| `app` | 桌面应用自升级 | v0.1.2 NSIS 安装版已接入 GitHub；下载后确认重启安装 | `electron-builder.yml` 的 `publish` 配置 |
| `backend` | DSH 后端（npm 包 `@deepseek-ai/dsh`）升级 | `check()` 已实现；`apply()` **已实现**（备份→npm→校验→同步→重启） | `src/main/updater.js` 的 `BACKEND_UPGRADER` |
| `profile` | Profile bundle 依赖更新 | `check()` 已实现（对比 npm registry）；`apply()` 已实现（`dsh plugin update`） | `src/main/updater.js` 的 `_checkProfile`/`_applyProfile` |

`status` 枚举（结果对象统一携带）：

```text
not-configured    接口可用但未配置（无发布源 / electron-updater 不可用）
up-to-date        已是最新
update-available  发现新版本（尚未下载）
update-downloaded 新版本已下载（重启应用后安装，NSIS 默认下次启动安装）
error             检查/执行失败（reason 含原因）
```

## IPC 协议（渲染进程侧，经 `window.dshDesktop.upgrade.*` 调用）

```js
// 检查升级；track: "app" | "backend" | "profile"
const result = await window.dshDesktop.upgrade.check("backend");
// -> { track, status, supported, current, latest, available, message, reason?, hint? }

// 执行升级；targetVersion 可选（缺省 = latest）
const result = await window.dshDesktop.upgrade.apply("backend");
// -> { track, status, applied, message, reason?, hint? }

// 订阅升级过程事件（checking / available / downloading / downloaded / error ...）
const unsubscribe = window.dshDesktop.upgrade.onEvent((payload) => { ... });
```

对应主进程实现：`src/main/updater.js`（`UpgradeManager.check/apply`），通道定义：`src/shared/channels.js`。UI 呈现时应区分：`not-configured` → "升级暂不可用"；`update-available` → "发现更新"；`update-downloaded` → "已下载，重启安装"；`error` → 显示 `reason` 与恢复指引。

> 桌面端帮助菜单和设置面板会实时展示三条轨道的 status/message/reason/hint；
> 检测到更新时，设置面板提供对应的一键操作入口。

## 应用自升级（v0.1.2 已接入）

默认更新源是公开仓库 `https://github.com/pyljjun2009-sketch/1/releases`，不在客户端嵌入令牌。

- v0.1.0 / v0.1.1 没有更新源，需要手动运行一次 v0.1.2 NSIS 安装包。
- 后续在设置 → 升级管理检查并下载；下载完成显示“保存工作并重启安装”。
- 安装前自动备份、停止后端、标记正常退出，然后运行经过 SHA-512 验证的安装器。
- 只接受更高的正式版本，不自动安装 alpha/beta 或降级；网络错误与“未配置”分开报告。
- 便携版和开发/解包目录不支持原地自动替换，请使用 NSIS 安装版。
- 当前使用 electron-updater 6.x：关闭 `autoInstallOnAppQuit`，仅在用户确认后调用 `quitAndInstall(false, true)`，普通退出不会偷偷安装。
- 当前安装包未使用代码签名证书，Windows 可能显示未知发布者提示。SHA-512 能校验下载完整性，但不代替发布者签名。

## 维护者发布新版本

本地 `npm run dist` 默认 `--publish never`，不会擅自上传。准备公开发布时，先修改版本、完成测试和构建，再执行 `npm run verify:release`。将以下同一版本的文件一起上传到现有仓库的**非草稿、非预发布** GitHub Release：

1. `DeepSeek-Harness-Desktop-<version>-x64.exe`
2. `DeepSeek-Harness-Desktop-<version>-x64.exe.blockmap`
3. `latest.yml`
4. 便携版（可选，不用于自动升级）

不要修改生成资产的名称，也不要在上传全部资产前发布 Release。旧版客户端要发现更新，远端必须实际存在更高版本。

联网只读检查：`node node_modules/electron/cli.js scripts/check-update-source.js`。
真实 HTTP 下载与篡改校验：`npm run test:update`，该测试不会执行安装器。

## 更换发布源（可选）

1. 在 `electron-builder.yml` 中配置发布源（generic/github/s3 等），例如：

   ```yaml
   publish:
     provider: generic
     url: https://updates.example.com/dsh-desktop/
     channel: latest
   ```

2. 重新打包：`npm run dist`（打包会生成 `app-update.yml`）。
3. 发布产物时把 `latest.yml`（win）与安装包一并上传到发布源。
4. `upgrade.check("app")` 检查更新；`apply("app")` 下载后返回 `status:"update-downloaded"`，用户确认后通过 `upgrade.installApp()` 完成安装。

## 接入 2：后端自动升级（backend track）

**已实现**（`src/main/updater.js` 的 `BACKEND_UPGRADER.apply`）。

升级流程（每步失败有明确回滚/提示）：

```text
1. 备份 Profile（package.json / pnpm-lock.yaml / cordis.patch.yml）→ BackupManager
2. npm install -g @deepseek-ai/dsh@<target>（锁定版本，不顺带升级）
3. 校验：新版本号 + yaml 运行库完整性
4. 升级后自动执行 dsh plugin --profile web install 修复 bundle 一致性
5. 重启后端
```

触发方式：
- **启动时自动检查**：后端就绪后对比 npm 最新版，发现新版本弹窗提示（"立即升级 / 稍后再说 / 查看详情"）；
- **设置面板手动升级**：升级管理 tab → 检测到更新时显示"升级 DSH 后端（自动备份+重启）"按钮。

可注入点：`BACKEND_UPGRADER.apply({ server, targetVersion, backupManager, dshHome, execNpm })`
- `execNpm` 可注入（测试用），默认用 `spawnSync` 执行真实 npm。

返回示例：
```js
// 成功
{ applied: true, status: "up-to-date", version: "0.1.2-rc.1", backupId: "...", resynced: true, message: "DSH 已升级到 ..." }
// 失败（npm 安装失败）
{ applied: false, status: "error", backupId: "...", reason: "npm 安装失败（exit=1）", output: "...", hint: "可回滚备份: ..." }
```

`server` 提供 `restart()`、`version`、`_binPath`、`status()` 等成员（见 `src/main/dsh-server.js`），升级器不应直接修改 DSH 本体文件。

## 兼容性约定

- `settings.json` 向前兼容：未知字段忽略；非法值拒绝写入或回退默认值并告警（见 `src/main/config.js`）。
- IPC 通道只增不删；新增能力时在 `src/shared/channels.js`、`src/preload/preload.js`（最小权限）与 `src/preload/preload-settings.js`（完整权限）三处同步注册。
- 升级失败永不假成功：必须返回明确的 `status` 与 `reason`，由 UI 呈现。
- 升级状态机有单测覆盖（`test/updater.test.js`，注入假 autoUpdater / mock fetch），改动后运行 `npm test`。
