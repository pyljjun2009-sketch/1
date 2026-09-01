# DeepSeek Harness Desktop（DSH 桌面端）

一个独立运行的、类似 Codex 的桌面客户端，把 DeepSeek Harness 的浏览器 UI（`dsh web`）封装为原生桌面应用。

**核心原则：DSH 本体（`@deepseek-ai/dsh`）零改动。** 桌面端只作为外部进程宿主启动 `dsh web`，界面、会话、配置等全部沿用你现有的 DSH 安装与 `$DSH_HOME` 数据。

## 特性

- 🚀 启动即用：自动启动 `dsh web` 后端，就绪后自动载入 Web UI（本地加载页过渡，无白屏）
- 🛡️ 安全渲染默认：Windows 默认 `inprocess` GPU 模式（软件渲染并入浏览器进程），彻底规避 GPU 进程崩溃导致的启动即退；可用 `--hardware-acceleration` 恢复
- 🪟 原生窗口：菜单（含"升级状态"）、快捷键（Ctrl+R 刷新、F12 开发者工具）、单实例锁、开机自启
- 🔁 后端自愈：异常退出自动重启（指数退避 1s/3s/10s，最多 3 次）；停止时**确认式**进程树清理（taskkill 状态检查 + 主 PID 消失轮询 + 后代枚举，残留即报 error）
- 🔌 升级接口：应用自升级 + 后端升级 + Profile bundle 更新三条轨道，状态机诚实报告，见 `UPGRADE.md`
- 💾 数据备份/恢复：一键备份 DSH profile（bundle 清单/patch 配置），支持恢复/对比/删除，自动保留最近 10 份
- 🔧 崩溃恢复：启动时检测异常退出，连续崩溃 3 次后弹诊断对话框，支持一键恢复或 Profile 重置
- 🔒 安全：contextIsolation + 沙箱 preload；DSH 页面与设置页最小权限分离；设置管理 IPC 仅接受本地设置页调用；默认拒绝系统权限；外链、配置与备份参数均校验
- ⚙️ 可配置 + 设置面板：Ctrl+, 打开，集成备份管理/崩溃恢复/通用配置/升级状态/关于

## 环境要求

- Node.js ≥ 20（系统内需有 `node`，用于启动 dsh 后端）
- 已安装 DeepSeek Harness CLI：`npm i -g @deepseek-ai/dsh`（桌面端会自动探测 npm 全局安装位置）

## 安装与运行

```bash
npm install
npm start            # 启动桌面端
npm run start:safe   # 安全模式（等同 --safe-mode，强制 inprocess GPU）
```

命令行开关：

| 开关 | 效果 |
| --- | --- |
| `--safe-mode` | 强制 `inprocess` GPU（软件渲染），启动最稳 |
| `--hardware-acceleration` | 强制 `auto`（恢复硬件加速） |

## 测试与质量

```bash
npm test                  # 全部单元测试（71 个用例）
npm run test:unit         # 配置/升级/IPC 快速单测
npm run test:process      # Windows 进程树与停止确认（dsh-server）
npm run test:syntax       # 全部 JS 语法检查（27 个文件，含本地页面脚本）
npm run test:smoke        # 冒烟（真实 dsh，依赖本机全局安装）
npm run test:smoke:fixture# 冒烟（内置假 DSH fixture，CI 可用，不依赖本机 dsh）
npm run test:package      # 解包构建 + ASAR 内容验证（15 个关键文件）
npm run clean             # 清理 dist/、dist-test/、dist-review/
```

> **例行审核清单**：DSH 版本检查、全局安装完整性（yaml 模块）、Profile 五项一致性检查
> 见 `docs/DSH-启动卡住经验总结.md` → "每次审核的标准检查清单" 章节。

冒烟输出协议（退出码 0=成功 / 1=失败），FAIL 行附带完整诊断（state/error/cwd/command/source/bin/版本/lastExit/logTail）：

```text
DSH_DESKTOP_SMOKE_OK url=<url> state=running pid=<pid> dsh=<version>
DSH_DESKTOP_SMOKE_FAIL reason=already-running
DSH_DESKTOP_SMOKE_FAIL reason=ready-timeout
DSH_DESKTOP_SMOKE_FAIL reason=backend-start
DSH_DESKTOP_SMOKE_FAIL reason=backend-timeout
DSH_DESKTOP_SMOKE_FAIL reason=page-timeout
```

## 构建安装包（Windows）

```bash
npm run dist              # NSIS 安装包 + 便携版
npm run dist:portable     # 仅便携版 exe
npm run pack              # 仅解包目录（快速验证）
```

- 输出目录自动选择（`scripts/build.js` 内置逻辑）：
  - **A/B 双目录交替**：`%LOCALAPPDATA%\dsh-desktop-build-a` / `-b`——运行中的实例在 A 时构建到 B，反之亦然，**永不因 exe 占用而 EBUSY**
  - 构建后自动更新桌面快捷方式指向最新版
  - 可用环境变量 `DSH_DESKTOP_BUILD_DIR` 显式指定单目录覆盖：

  ```bash
  set DSH_DESKTOP_BUILD_DIR=D:\build\dsh-desktop&& npm run dist
  ```

- 两个目录都被占用（两个实例同时在跑）时会提示关闭一个。
- 本仓库位于 `D:\AI\DSH`（非 OneDrive 同步目录，避免同步文件锁）；构建产物输出到 `%LOCALAPPDATA%\dsh-desktop-build-a/-b`，同样避开同步目录。

## 配置

配置文件：`%APPDATA%/dsh-desktop/settings.json`（首次运行自动生成；非法值拒绝写入或回退默认并告警）。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `dshCommand` | string[] \| null | `null` | 自定义 dsh 启动命令 argv（不含 `--host/--port`）。⚠ 仅可在配置文件中手动设置，IPC 拒绝修改 |
| `nodeBin` | string \| null | `null` | 运行 dsh 的 node 可执行文件。⚠ 同上，仅配置文件可改 |
| `host` | string | `127.0.0.1` | 后端监听地址 |
| `port` | number | `0` | 后端端口（0-65535），`0`=自动选空闲端口 |
| `workingDirectory` | string \| null | `null` | 后端工作目录；`null` 按序回退 `$DSH_HOME` → `<userData>/workspace` |
| `gpuMode` | "auto"\|"off"\|"inprocess"\|null | `null` | GPU 策略；`null` 时平台默认：Windows=`inprocess`，其他=`auto` |
| `disableHardwareAcceleration` | boolean | `false` | 旧字段兼容：`true` 等价 `gpuMode:"off"` |
| `keepBackendRunning` | boolean | `false` | 关窗后后端常开（进程不退出，再次启动应用唤回窗口）；`false`=退出即停并确认式清理 |
| `launchAtLogin` | boolean | `false` | 开机自启 |
| `openDevTools` | boolean | `false` | 启动后自动打开开发者工具 |
| `autoRestartOnCrash` | boolean | `true` | 后端异常退出自动重启（指数退避，最多 3 次） |
| `openBrowserOnCrash` | boolean | `true` | 桌面程序崩溃/非正常关闭后，自动打开系统浏览器访问 Web UI（由看门狗进程监控；`taskkill /T` 全树强杀场景不保证） |
| `reuseExistingDsh` | boolean | `false` | 复用已有 DSH 实例（验证 DeepSeek 标记后直接挂接，不重新启动） |
| `allowNetworkAccess` | boolean | `false` | 允许监听非 localhost 地址（⚠ 会暴露 DSH Web 到局域网，需显式开启） |

### GPU 渲染策略解析顺序

```text
--safe-mode（=inprocess）> --hardware-acceleration（=auto）
> $DSH_DESKTOP_GPU（auto|off|inprocess）> $DSH_DESKTOP_DISABLE_GPU=1（=off）
> settings.json: gpuMode / disableHardwareAcceleration=true（=off）
> 平台默认：Windows = inprocess，其他 = auto
```

另有 `DSH_DESKTOP_NO_SANDBOX=1` 可追加 `--no-sandbox`（虚拟机/受限环境的最后手段）。设计决策见 `docs/adr/ADR-001-safe-rendering.md`。

## 退出与常开语义

- 默认（`keepBackendRunning:false`）：关闭窗口 → 退出应用 → `before-quit` 中确认式停止后端（taskkill /T + 主 PID 消失轮询 + 后代枚举），退出后零残留。
- 常开（`keepBackendRunning:true`）：关窗仅关 UI，后端保持运行；再次启动应用实例唤回窗口。设计决策见 `docs/adr/ADR-002-backend-ui-lifecycle.md`。

## 崩溃自动恢复（打开浏览器访问 Web UI）

- **原理**：Electron 主进程崩溃后自身无法自救，因此应用启动成功后会在后台拉起一个**独立看门狗进程**（`src/main/watchdog.js`，由 node 运行，`detached` 不随主进程退出）。
- **行为**：看门狗轮询主进程 PID——主进程消失后检查退出标记 `.last-clean-exit`：
  - 存在 → 用户主动正常关闭，看门狗静默退出（不会打开浏览器）；
  - 不存在 → 判定崩溃/非正常关闭，读取 `.dsh-web-url`（启动时写入的 Web UI 地址），探测后端可达后调用系统默认浏览器打开 Web UI。
- **开关**：设置面板"通用设置 → 崩溃/异常关闭后自动打开浏览器访问 Web UI"，对应配置 `openBrowserOnCrash`（默认 `true`）。
- **日志**：看门狗运行日志在 `%APPDATA%/dsh-desktop/watchdog.log`。
- **已知限制**：`taskkill /T /F` 全树强杀会把看门狗一并杀掉（Windows PPID 链行为），该场景无法保证自动打开浏览器；崩溃后后端若已被一起终止，探测失败则不打开。

## 目录结构

```
D:\AI\DSH/
├─ src/
│  ├─ main/            # 主进程
│  │  ├─ index.js      # 入口（GPU 策略、单实例、冒烟协议、退出清理）
│  │  ├─ config.js     # 配置存储 + schema 校验
│  │  ├─ dsh-server.js # 后端生命周期（预检、端口、就绪、退避重启、确认式树级清理）
│  │  ├─ window.js     # 主窗口与菜单
│  │  ├─ ipc.js        # IPC 接线（依赖可注入；受限字段防护）
│  │  ├─ updater.js    # 升级接口（三轨道：app/backend/profile）
│  │  ├─ backup.js     # 数据备份管理器
│  │  ├─ crash-recovery.js # 崩溃恢复管理器
│  │  └─ watchdog.js   # 崩溃看门狗（独立进程：异常退出自动打开浏览器访问 Web UI）
│  ├─ preload/
│  │  ├─ preload.js        # 最小权限桥接（DSH 页面/加载页用）
│  │  └─ preload-settings.js  # 完整管理权限桥接（设置页专用）
│  └─ shared/channels.js   # IPC 通道名
├─ test/               # node:test 单元测试（76 个用例）
├─ scripts/            # check-syntax / clean / build / init-smoke-settings / verify-build
├─ docs/adr/           # 架构决策记录（ADR-001/002）
├─ assets/             # 图标、加载页/设置页及受 CSP 保护的页面脚本
├─ electron-builder.yml
├─ UPGRADE.md          # 升级接口设计文档
└─ PLAN-2.0.md         # 2.0 计划书
```

## 开发调试

```bash
$env:DSH_DESKTOP_DEBUG = "1"; npm start          # 主进程启动链路 breadcrumb
$env:DSH_DESKTOP_GPU = "off"; npm start          # 强制软件渲染（off 级）
$env:DSH_DESKTOP_USER_DATA = "D:\tmp\dsh"; npm start   # 覆盖数据目录（测试隔离）
```

## 常见问题

- **应用启动即退出 / GPU 进程崩溃**：Windows 默认已是 `inprocess`；仍异常时用 `npm run start:safe` 或加 `DSH_DESKTOP_NO_SANDBOX=1`。
- **"dsh 后端意外退出"**：加载页会显示完整诊断（命令、cwd、bin 路径、日志尾部）；先确认 `npm i -g @deepseek-ai/dsh` 与 node 可用，或检查 `settings.json` 的 `dshCommand`/`nodeBin`。
- **端口冲突**：默认自动挑选空闲端口，不会与已在运行的 `dsh web`（如 3080）冲突。
- **升级 DSH 后端**：终端执行 `npm i -g @deepseek-ai/dsh@latest`，然后在应用内"文件 → 重新启动 DSH 后端"。
- **升级状态**：帮助菜单 → "升级状态" 可查看两条轨道的当前能力（应用自升级需配置发布源；后端轨道当前仅检测）。
