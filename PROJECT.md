# DeepSeek Harness Desktop（DSH 桌面端）—— 项目完整文档

> 本文件为项目全貌文档，聚合 README、CHANGELOG、UPGRADE、架构决策与代码实现信息。
> 仓库位置：`D:\AI\DSH` ｜ 远程：`https://github.com/pyljjun2009-sketch/1` ｜ 当前项目版本：`v0.1.2` ｜ GitHub 最新发布：`v0.1.0`（2026-09-02 核验，本地尚未发布）

---

## 一、项目概述

**DeepSeek Harness Desktop** 是一个独立运行的、类似 Codex 的桌面客户端，把 DeepSeek Harness 的浏览器 UI（`dsh web`）封装为原生桌面应用。

**核心原则：DSH 本体（`@deepseek-ai/dsh`）零改动。** 桌面端只作为外部进程宿主启动 `dsh web`，界面、会话、配置等全部沿用现有的 DSH 安装与 `$DSH_HOME` 数据。

### 项目定位与演进

- 最初目标：将 DSH 封装为独立 Codex 风格桌面 UI，预留升级接口，其他不变
- 2.0 计划（决策点已确认 2026-08-14）：路径 B（本项目完善）、V1 不做备份加密、加入 Profile 轨道、集成设置面板、GitHub Release 发布
- 已发布 v0.1.0 正式版；v0.1.2 为本地可升级安装版，接入 GitHub Releases，保留 v0.1.1 的全部完善内容

### 技术栈

| 组件 | 技术 |
|---|---|
| 桌面框架 | Electron 43.x + Node 22 主进程 |
| 打包 | electron-builder 26.x（NSIS + portable） |
| 测试 | node:test（125 个用例 + 33 文件语法检查 + HTTP 更新校验 + 冒烟协议） |
| 后端 | `@deepseek-ai/dsh`（npm 全局安装，外部进程托管） |
| 语言 | JavaScript（CommonJS），无构建步骤（除打包） |

---

## 二、架构设计

### 2.1 总体架构

```
┌─────────────────────────────────────────────────────────┐
│                  Electron 主进程 (src/main)              │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌───────────┐  │
│  │ index.js│→ │window.js │→ │ ipc.js  │→ │ updater.js│  │
│  └────┬────┘  └──────────┘  └────┬────┘  └───────────┘  │
│       │                          │                      │
│  ┌────▼────┐  ┌──────────┐  ┌────▼────┐  ┌───────────┐  │
│  │config.js│  │dsh-server│  │backup.js│  │crash-     │  │
│  │         │  │  .js     │  │         │  │recovery.js│  │
│  └─────────┘  └────┬─────┘  └─────────┘  └───────────┘  │
│                    │ spawn (shell:false)                │
│                    ▼                                    │
│   ┌─────────────────────────────┐                      │
│   │ node …/@deepseek-ai/dsh/    │  ← 独立后端进程        │
│   │ lib/bin.js web --host …     │    （不修改 DSH 本体） │
│   └─────────────────────────────┘                      │
│        │  http://127.0.0.1:<port>/                      │
│        ▼                                                │
│   ┌─────────────────────────────┐  ┌─────────────────┐  │
│   │ 主窗口：加载页 → 真实 Web UI │←│ preload.js（最小）│  │
│   └─────────────────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────┘
   │ 看门狗（独立 node 进程，detached）
   ▼ 崩溃/异常关闭 → 自动打开系统浏览器访问 Web UI
```

### 2.2 模块职责（src/main）

| 模块 | 行数 | 职责 |
|---|---|---|
| `index.js` | 390 | 入口：GPU 策略、单实例锁、冒烟协议、退出清理、启动后版本检查 |
| `dsh-server.js` | 977 | 后端生命周期：预检、端口、就绪轮询、退避重启、确认式进程树清理 |
| `config.js` | 183 | 配置存储 + 原子 schema 校验（非法值拒绝/回退默认） |
| `window.js` | 182 | 主窗口与菜单；导航安全（同源限制、外链交给系统浏览器） |
| `ipc.js` | 267 | IPC 接线；设置页身份校验；事务恢复编排；受限字段防护 |
| `updater.js` | 525 | 三轨升级、版本校验、并发串行化与更新后重启 |
| `backup.js` | 315 | 完整性校验、事务恢复、创建/列表/对比/删除，保留 10 份 |
| `crash-recovery.js` | 113 | 崩溃恢复管理器（退出标记、崩溃计数、诊断） |
| `watchdog.js` | 209 | 崩溃看门狗（独立进程，异常退出自动打开浏览器） |

### 2.3 进程模型

- **主进程**：Electron 主进程，管理窗口/生命周期/IPC
- **后端进程**：`node <npm-global>@deepseek-ai/dsh/lib/bin.js web --host <host> --port <port> --no-open`（`shell:false`，无 cmd 包装）
- **看门狗进程**：由主进程提取 `watchdog.js` 到 userData 后用 node detached 运行，监控主进程 PID

---

## 三、功能特性

### 3.1 启动与渲染

- 启动即用：自动启动 `dsh web` 后端，就绪后自动载入 Web UI（本地加载页过渡，无白屏）
- **GPU 渲染策略**：Windows 默认 `inprocess`（软件渲染并入浏览器进程），规避 GPU 子进程崩溃；可用 `--hardware-acceleration` 恢复硬件加速

### 3.2 后端自愈与清理

- 异常退出自动重启（指数退避 1s/3s/10s，最多 3 次）
- **确认式停止**：taskkill /T + 主 PID 消失轮询 + 后代枚举，残留即报 error 而非伪装 stopped
- 启动预检：node/bin/profile EPERM/bundle 一致性检查，失败给出明确诊断

### 3.3 崩溃恢复（看门狗）

- 独立看门狗进程监控主进程 PID（每 2 秒轮询）
- 主进程消失后检查 `.last-clean-exit` 退出标记：
  - 存在 → 正常关闭，看门狗静默退出
  - 不存在 → 崩溃/异常关闭：读取 `.dsh-web-url`，探测后端可达后打开系统浏览器访问 Web UI
- 开关：`openBrowserOnCrash`（默认 `true`）；日志 `%APPDATA%/dsh-desktop/watchdog.log`
- 限制：`taskkill /T /F` 全树强杀会连看门狗一起杀（Windows PPID 链）；后端已被终止则探测失败不打开

### 3.4 数据备份

- 备份范围：`~/.dsh/profiles/web/package.json`、`cordis.patch.yml`、`cordis.yml`、`~/.dsh/settings.yaml`
- 存储：`%APPDATA%/dsh-desktop/backups/<timestamp>/`，保留最近 10 份
- 恢复语义：关键文件回滚 + 清理 node_modules（依赖重建）；恢复前自动快照
- 支持：创建/列表/对比/恢复/删除

### 3.5 升级接口（三轨道）

| track | 含义 | 状态 |
|---|---|---|
| `app` | 桌面应用自升级 | v0.1.2 NSIS 安装版已接入 GitHub；下载后确认重启安装 |
| `backend` | DSH 后端（npm 包） | check() 已实现；apply() 已实现（备份→npm→校验→同步→重启） |
| `profile` | Profile bundle 依赖 | check() 已实现；apply() 已实现（dsh plugin update） |

状态枚举：`not-configured / up-to-date / update-available / update-downloaded / error`

### 3.6 安全特性

- contextIsolation + 沙箱 preload；DSH 页面与设置页最小权限分离
- 设置管理 IPC 仅接受本地设置页调用（`assertSettingsPage` 路径校验）
- `dshCommand`/`nodeBin` 禁止界面修改（仅配置文件）
- 默认拒绝系统权限；外链仅 http(s)；备份参数校验
- 严格 CSP（`default-src 'self'; script-src 'self'`）
- bundle 包名校验（防注入 npm registry URL / CLI 参数）

---

## 四、配置

配置文件：`%APPDATA%/dsh-desktop/settings.json`（首次运行自动生成）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dshCommand` | string[] \| null | `null` | 自定义 dsh 启动命令（仅配置文件可改） |
| `nodeBin` | string \| null | `null` | 运行 dsh 的 node 可执行文件（仅配置文件可改） |
| `host` | string | `127.0.0.1` | 后端监听地址 |
| `port` | number | `0` | 后端端口，`0`=自动选空闲端口 |
| `workingDirectory` | string \| null | `null` | 后端工作目录 |
| `gpuMode` | "auto"\|"off"\|"inprocess"\|null | `null` | GPU 策略 |
| `disableHardwareAcceleration` | boolean | `false` | 旧字段兼容（=gpuMode:"off"） |
| `keepBackendRunning` | boolean | `false` | 关窗后后端常开 |
| `launchAtLogin` | boolean | `false` | 开机自启 |
| `openDevTools` | boolean | `false` | 自动打开开发者工具 |
| `autoRestartOnCrash` | boolean | `true` | 后端异常退出自动重启 |
| `openBrowserOnCrash` | boolean | `true` | 崩溃后自动打开浏览器访问 Web UI |
| `reuseExistingDsh` | boolean | `false` | 复用已有 DSH 实例 |
| `allowNetworkAccess` | boolean | `false` | 允许监听非 localhost（⚠ 暴露到局域网） |

### GPU 策略解析顺序

```text
--safe-mode（=inprocess）> --hardware-acceleration（=auto）
> $DSH_DESKTOP_GPU > $DSH_DESKTOP_DISABLE_GPU=1（=off）
> settings.json: gpuMode / disableHardwareAcceleration=true（=off）
> 平台默认：Windows = inprocess，其他 = auto
```

---

## 五、测试与质量

### 5.1 测试清单（125 个用例）

| 测试文件 | 用例数 | 覆盖 |
|---|---|---|
| `dsh-server.test.js` | 24 | 端口/启动/就绪/崩溃重启/超时/进程树/竞态/非法 bundle |
| `updater.test.js` | 33 | 三轨道/版本校验/防降级/下载与安装状态/并发防护 |
| `app-update-integration.test.js` | 1 | 真实 HTTP 下载与 SHA-512 拒绝篡改 |
| `ipc.test.js` | 17 | IPC 权限/安全恢复/安装权限/设置页进度 |
| `backup.test.js` | 14 | 备份创建/完整性/事务恢复/对比/删除/竞态回归 |
| `watchdog.test.js` | 9 | 看门狗决策/URL 校验/重试 |
| `config.test.js` | 11 | 配置存储/原子补丁/重复初始化/校验/回退 |
| `crash-recovery.test.js` | 8 | 退出标记/崩溃计数/诊断 |
| `preload-consistency.test.js` | 3 | 通道名一致性 |
| `assets-security.test.js` | 3 | 页面 CSP/转义/三轨升级入口 |
| `window-security.test.js` | 2 | 窗口权限/导航安全 |

### 5.2 冒烟协议（退出码 0=成功 / 1=失败）

```text
DSH_DESKTOP_SMOKE_OK url=<url> state=running pid=<pid> dsh=<version>
DSH_DESKTOP_SMOKE_FAIL reason=already-running|ready-timeout|backend-start|backend-timeout|page-timeout
```

FAIL 行附带完整诊断：state/error/cwd/command/source/bin/version/lastExit/logTail

### 5.3 命令

```bash
npm test                  # 全部测试（125 个用例）
npm run test:unit         # 配置/升级/IPC 快速单测
npm run test:process      # Windows 进程树与停止确认
npm run test:syntax       # 全部 JS 语法检查（33 个文件）
npm run test:smoke        # 冒烟（真实 dsh）
npm run test:smoke:fixture# 冒烟（内置假 DSH fixture，CI 可用）
npm run test:package      # 解包构建 + ASAR 内容验证（18 个关键文件）
npm run verify            # 一键验收（模拟 DSH，适合 CI）
npm run verify:local      # 一键验收 + 本机真实 DSH
```

---

## 六、构建与发布

### 6.1 构建命令

```bash
npm run dist              # NSIS 安装包 + 便携版
npm run dist:portable     # 仅便携版 exe
npm run pack              # 仅解包目录（快速验证）
```

### 6.2 项目内 A/B 双目录策略（scripts/build.js）

- 构建目录：`D:\AI\DSH\artifacts\dsh-desktop-build-a` / `-b`
- 运行中的实例在 A 时构建到 B，反之亦然——**永不因 exe 占用而 EBUSY**
- 构建后自动更新桌面快捷方式 + 写 `current.txt`
- 安装包、便携版、blockmap 和 `latest.yml` 自动汇总到 `D:\AI\DSH\release`
- 环境变量 `DSH_DESKTOP_BUILD_DIR` 可显式指定单目录

### 6.3 产物验证

- `scripts/verify-build.js`：检查 ASAR 内 18 个关键文件（新增文件需同步更新清单）
- 发布前检查：全量测试、语法、冒烟、`npm audit`（0 漏洞）

### 6.4 发布流程（v0.1.0 已执行）

1. `npm run dist` 构建 NSIS + portable
2. `git tag -a v0.1.0` 并推送
3. GitHub Release API 创建 release + 上传 4 资产（NSIS exe / portable / blockmap / latest.yml）
4. Release 从 draft 转为正式发布

---

## 七、升级 DSH 后端（官方版本）

### 7.1 版本检查

```bash
npm ls -g @deepseek-ai/dsh                    # 当前版本
npm view @deepseek-ai/dsh version             # latest 标签版本
npm view @deepseek-ai/dsh dist-tags --json    # 所有标签
npm view @deepseek-ai/dsh versions --json     # 全部版本
```

### 7.2 升级到官方最新

```bash
npm install -g @deepseek-ai/dsh@latest        # 升级到 latest
npm install -g @deepseek-ai/dsh@<version>     # 升级到指定版本
```

升级后验证完整性（yaml 模块）：

```powershell
$root = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh"
Test-Path "$root\node_modules\yaml\dist\schema\yaml-1.1\merge.js"   # 必须为 True
Test-Path "$root\lib\bin.js"                                          # 必须为 True
```

> ⚠ 升级前建议先备份 Profile（桌面端设置面板 → 备份管理，或应用内后端升级流程会自动备份）。
> ⚠ 升级 npm 包不影响正在运行的 dsh web 进程；需重启后端（应用菜单"文件 → 重新启动 DSH 后端"）才生效。

---

## 八、已知限制与决策记录

### 8.1 已知限制

| 限制 | 说明 |
|---|---|
| 看门狗 vs taskkill /T | 全树强杀连看门狗一起杀，无法保证自动打开浏览器 |
| 备份明文 | V1 明文；V2 计划加 AES-256-GCM 加密 |
| 应用自升级 | 需配置 electron-builder `publish` 发布源才生效 |
| 托盘图标 | V1 不做，V2 再加 |

### 8.2 架构决策记录

- `docs/adr/ADR-001-safe-rendering.md`：安全渲染（inprocess GPU 默认）
- `docs/adr/ADR-002-backend-ui-lifecycle.md`：后端与 UI 生命周期（keepBackendRunning）
- `docs/adr/ADR-003-transactional-recovery-and-serialized-upgrades.md`：事务式恢复与升级串行化
- `docs/DSH-启动卡住经验总结.md`：故障排查经验（视觉工具黑屏、浏览器自动弹出等）

---

## 九、变更历史摘要

### [0.1.2] - 2026-09-02（可升级安装版）

- 接入现有公开 GitHub 更新源，下载进度、就绪状态与确认重启安装完整闭环
- 安装前备份并停止后端；不自动降级，不自动安装 alpha，不在普通退出时安装
- 区分安装版、便携版与开发目录，修复进度事件无法到达设置页
- Electron 43.4.0 → 43.5.1；本地构建复用已校验运行时，默认禁止自动发布
- 125 个测试、真实升级组件 HTTP/校验测试、公网只读更新检查、ASAR 和发布元数据校验通过
- 本机全局 DSH 当前可执行文件缺失，原真实全局冒烟失败；改用项目内隔离官方 DSH 0.1.1-rc.2 完成真实打包态启动验证，未修改用户全局安装。详情见 `docs/RELEASE-0.1.2.md`

### [0.1.1] - 2026-09-01（多轮测试完善版）

- 备份恢复加入完整 SHA-256 校验、允许路径检查、同卷暂存切换与失败回滚
- 运行中恢复执行“停止后端 → 恢复 → 同步 Profile 依赖 → 重启”完整闭环
- 桌面应用、DSH 后端、Profile bundles 三轨升级补全，并加入同轨并发保护
- 配置更新改为原子校验应用；管理 IPC 默认拒绝缺少来源信息的请求
- 新增一键验收命令、事务恢复 ADR 和 0.1.1 安装包/便携包
- 备份恢复竞态（源备份被 cleanup 删除）→ 先快照到内存
- restore 清理 node_modules（bundle 一致性）
- diff 支持 settings.yaml 全局设置对比
- 崩溃待重启期间 stop() 生效（不再被拉起）
- 并发 stop/start 竞态（无孤儿、状态一致）
- child 引用竞态、_tryReuse 契约、taskkill /T、pidExists 误判、findFreePort 超时、IPv6 URL、阻塞优化、进程组清理、host 校验、冒烟跳过看门狗、CRASH_RESET 数据安全、preflight 全错误拦截

验证结果：111/111 单元测试、30/30 语法检查、npm audit 0 漏洞、模拟与真实 DSH 冒烟、打包态真实页面冒烟、ASAR 18/18 校验全部通过。

### [0.1.0] - 2026-09-01（首个正式版）

- 崩溃看门狗、数据备份、崩溃恢复、设置面板、三轨道升级接口
- GPU 策略、进程树清理、启动预检、冒烟协议
- 安全加固（IPC 身份校验、shell:false、包名校验、严格 CSP）

完整变更见 `CHANGELOG.md`。

---

## 十、快速参考

### 常用目录

| 路径 | 用途 |
|---|---|
| `D:\AI\DSH` | 项目源码 |
| `%APPDATA%\dsh-desktop\` | 配置、备份、看门狗日志、状态标记 |
| `D:\AI\DSH\artifacts\dsh-desktop-build-a/-b` | 构建产物（A/B 交替） |
| `D:\AI\DSH\release` | 安装包、便携版与升级元数据汇总目录 |
| `~/.dsh/` | DSH 数据（profile、设置） |
| `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` | 全局 DSH 安装 |

### 状态标记文件（%APPDATA%/dsh-desktop/）

| 文件 | 含义 |
|---|---|
| `.last-clean-exit` | 正常退出标记（看门狗/崩溃检测用） |
| `.crash-count` | 连续崩溃计数 |
| `.last-known-good` | 上次成功启动后端时间 |
| `.dsh-web-url` | 当前 Web UI 地址（看门狗用） |
| `watchdog.log` | 看门狗运行日志 |
| `watchdog/watchdog.js` | 提取的看门狗脚本 |
