# DSH Desktop 2.0 计划书

**目标**：基于 DeepSeek Harness 最新版本，构建一个独立运行的、类似 Codex 的桌面端应用，预留升级接口、数据备份、崩溃恢复能力。

**状态**：待审查

---

## 一、背景与现状

### 1.1 已有资源

| 资源 | 仓库/来源 | 说明 |
|---|---|---|
| DSH 核心 | `deepseek-ai/deepseek-harness` | MIT 协议，最新 0.1.0-rc.7 |
| 官方桌面端 | `sdkwork-ai/deepseek-harness-desktop` | 已有 Electron 封装、用户指南 |
| 社区桌面端 | `tycoding/deepseek-harness-desktop` | rc.5 版本 |
| DSH 命令行 | `npm i -g @deepseek-ai/dsh` | 0.1.0-rc.6（本机） |
| DSH Profile 机制 | `~/.dsh/profiles/web/` | cordis 插件树、bundle、patch |

### 1.2 本会话已解决的问题

| 问题 | 解决方案 | 状态 |
|---|---|---|
| GPU 进程崩溃导致应用退出 | Windows 默认 inprocess GPU + --safe-mode | ✅ |
| 进程树残留（cmd.exe/powershell.exe） | shell:false + 移除 PATH fallback | ✅ |
| 停止不可靠（taskkill 不验证） | 确认式 stop（轮询 PID + 后代枚举） | ✅ |
| 冒烟测试无诊断信息 | FAIL 行含 state/cwd/command/logTail(60) | ✅ |
| 配置无校验 | schema 校验 + 非法值回退默认 | ✅ |
| 升级接口假成功 | 显式 status 枚举（stub/not-configured） | ✅ |
| IPC 关闭竞态 | safeSend + isDestroyed 检查 | ✅ |
| 启动卡住无诊断 | loading 页实时显示后端日志 | ✅ |
| Profile 权限问题无预警 | EPERM 预检（写入测试文件） | ✅ |
| 外部 dsh 实例冲突 | 端口占用检测 + 复用选项 | ✅ |
| OneDrive 构建锁 | DSH_DESKTOP_BUILD_DIR 环境变量 | ✅ |

### 1.3 本次会话的关键经验

> 🧠 **DSH 启动卡住根因排序**：profile 目录权限（EPERM）> 缺失 bundle > patch 引用不存在的插件 > 插件 API 不兼容 > 升级残留失效引用。重装桌面端不能解决 profile/插件问题。

> 🧠 **退出清理关键点**：taskkill /T 按 PPID 链杀树；detached 子进程在 Windows 上也被 taskkill /T 清掉（PPID 不变）；"逃逸"场景仅在 POSIX 上成立。

---

## 二、架构设计

### 2.1 技术栈

```
┌──────────────────────────────────────────────┐
│  Electron 主进程（Node.js 22+）              │
│  ├─ DshServer（子进程管理 + 端口 + 就绪探测）│
│  ├─ BackupManager（备份/恢复）                │
│  ├─ CrashRecovery（崩溃检测 + 恢复）          │
│  ├─ UpgradeManager（升级接口）                │
│  └─ IpcBridge（进程间通信）                   │
├──────────────────────────────────────────────┤
│  Electron 渲染进程（Chromium）                │
│  ├─ 加载页（loading.html）                   │
│  ├─ DSH Web UI（dsh web 提供）               │
│  └─ 桌面端扩展 UI（备份/恢复/设置面板）       │
├──────────────────────────────────────────────┤
│  DSH 后端子进程（dsh web）                   │
│  ├─ node bin.js web --host --port            │
│  ├─ cordis 插件树                            │
│  └─ ~/.dsh/profiles/web/                     │
└──────────────────────────────────────────────┘
```

### 2.2 与现有官方桌面端的关系

官方 `sdkwork-ai/deepseek-harness-desktop` 已有基础 Electron 封装。我们的方案有两种路径：

**路径 A：基于官方桌面端二次开发**
- 优点：继承官方基础功能、社区维护
- 缺点：可能缺少我们已实现的 P0/P1 特性（GPU 降级、确认式清理、诊断等）
- 工作量：中（合并差异 + 新增功能）

**路径 B：在本项目基础上完善（推荐）**
- 优点：已实现全部 P0/P1、已验证、已知所有坑点
- 缺点：需要自行跟进 DSH 核心版本更新
- 工作量：低（增量开发）

> **推荐路径 B**：本项目已解决 11 个关键问题，且代码经过 44 个单元测试 + 多轮端到端验证。增量开发比从零对齐官方更快更稳。

### 2.3 目录结构

```
D:\AI\DSHarness/
├─ src/
│  ├─ main/
│  │  ├─ index.js            # 入口（GPU/单实例/生命周期）
│  │  ├─ config.js            # 配置存储 + schema 校验
│  │  ├─ dsh-server.js        # 后端生命周期（预检/启动/停止/重启）
│  │  ├─ window.js            # 主窗口 + 菜单
│  │  ├─ ipc.js               # IPC 接线
│  │  ├─ updater.js           # 升级接口（app + backend 两轨道）
│  │  ├─ backup.js            # 🆕 数据备份/恢复管理
│  │  └─ crash-recovery.js    # 🆕 崩溃检测 + 自动恢复
│  ├─ preload/preload.js      # 沙箱桥接
│  ├─ shared/channels.js      # IPC 通道名
│  └─ renderer/               # 🆕 扩展 UI（备份面板/恢复对话框/设置）
├─ test/                      # 单元测试
├─ scripts/                   # 构建/清理/检查脚本
├─ docs/adr/                  # 架构决策记录
└─ assets/                    # 图标/加载页
```

---

## 三、新增功能设计

### 3.1 🆕 数据备份系统（BackupManager）

**用户价值**：安装/升级插件前自动备份，出问题时一键恢复。

#### 3.1.1 备份范围

| 目录/文件 | 重要性 | 说明 |
|---|---|---|
| `~/.dsh/profiles/web/package.json` | 高 | bundle 清单（升级后可能失效） |
| `~/.dsh/profiles/web/cordis.patch.yml` | 高 | 用户 patch、插件挂载配置 |
| `~/.dsh/profiles/web/cordis.yml` | 中 | 自动生成的模板（可重建但备份更稳） |
| `~/.dsh/profiles/web/node_modules/` | 中 | 已安装插件（体积大，可选） |
| `~/.dsh/credentials.yaml` | 极高 | 凭据（**绝不纳入备份文件传输**，仅本地快照） |
| `~/.dsh/settings.yaml` | 高 | 全局设置 |

#### 3.1.2 备份策略

```
备份时机：
  1. 用户手动点击"备份"按钮
  2. 插件安装/升级前（自动触发）
  3. DSH 版本升级前（自动触发）
  4. 每次成功启动后（可选，默认关闭）

存储位置：
  %APPDATA%/dsh-desktop/backups/<timestamp>/
  例如：2026-08-14T15-30-00/
  ├─ profiles-web/
  │  ├─ package.json
  │  ├─ cordis.patch.yml
  │  ├─ cordis.yml
  │  └─ node_modules.tar.zst（可选，压缩）
  ├─ settings.yaml
  ├─ manifest.json            # 元数据（DSH版本/插件列表/时间戳）
  └─ credentials.yaml.enc     # 加密后的凭据（AES-256-GCM，密钥派生自机器指纹）

保留策略：
  - 保留最近 10 份完整备份
  - 超过 10 份时自动清理最旧的（保留 manifest.json 摘要）
  - 单份备份上限 500MB（node_modules 超限时仅保留 package.json 快照）
```

#### 3.1.3 恢复策略

```
恢复流程：
  1. 用户选择恢复点（按时间戳/DSH版本/备注筛选）
  2. 显示差异预览（当前 vs 备份的 package.json diff）
  3. 用户确认 → 停止 dsh 后端 → 覆盖文件 → 重启后端
  4. 恢复后自动运行 `dsh --profile web install` 补装缺失依赖

安全措施：
  - 恢复前自动创建新备份（以防恢复出错）
  - 恢复目标目录不存在时中止并提示
  - 凭据恢复需用户输入密码（解密 .enc 文件）
  - 恢复完成后弹出状态摘要
```

#### 3.1.4 IPC 接口

```
通道名                          方法      说明
backup:create                  invoke   创建手动备份（返回备份ID）
backup:list                    invoke   列出所有备份（含 manifest 摘要）
backup:restore {id}            invoke   恢复指定备份
backup:diff {id}               invoke   对比当前与指定备份的差异
backup:export {id, path}       invoke   导出备份到指定路径（zip）
backup:import {path}           invoke   从外部导入备份
backup:delete {id}             invoke   删除备份
backup:event                   on       进度/状态推送（创建中/恢复中/完成/失败）
```

### 3.2 🆕 崩溃恢复系统（CrashRecovery）

**用户价值**：应用崩溃后自动恢复到最近一次正常状态，用户无感知。

#### 3.2.1 崩溃检测机制

```
检测时机：
  1. 应用启动时：检查上次退出是否异常（对比 .last-clean-exit 标记）
  2. dsh 后端启动失败时：检查是否有可用恢复点
  3. 运行时：dsh 后端连续崩溃 3 次以上时触发恢复流程

状态标记文件：
  %APPDATA%/dsh-desktop/
  ├─ .last-clean-exit          # 正常退出时写入时间戳；异常退出时不存在
  ├─ .crash-count              # 连续崩溃计数（重启后归零）
  └─ .last-known-good          # 上次成功启动的时间戳
```

#### 3.2.2 恢复策略

```
场景 A：应用崩溃后重启
  1. 检测 .last-clean-exit 不存在
  2. 弹出对话框："检测到异常退出，是否恢复到上次正常状态？"
  3. 用户选择"恢复" → 执行最近一次成功备份的恢复流程
  4. 用户选择"跳过" → 正常启动（写入 .last-clean-exit）
  5. 用户选择"查看日志" → 打开日志目录

场景 B：dsh 后端连续崩溃
  1. 连续崩溃 3 次后，弹出诊断对话框：
     "DSH 后端多次启动失败，可能原因：
      - Profile 目录权限异常
      - 插件不兼容
      - 配置损坏
     建议操作：
      [恢复到上次正常状态]  [查看后端日志]  [重置 Profile（需确认）]"
  2. 选择"恢复" → 执行恢复流程
  3. 选择"重置" → 备份当前 profile → 恢复默认 bundle → 重新安装

场景 C：Profile 目录损坏（EPERM）
  1. 预检检测到 EPERM
  2. 加载页显示："Profile 目录无法写入，可能是权限问题"
  3. 提供"以管理员身份重试"按钮
```

#### 3.2.3 IPC 接口

```
通道名                           方法      说明
crash:get-status                invoke   获取崩溃状态（clean/unclean/crash-loop）
crash:recover {backupId}        invoke   执行恢复
crash:reset-profile             invoke   重置 profile 到默认状态
crash:get-log {lines}           invoke   获取 dsh 后端最近 N 行日志
crash:event                     on       状态推送
```

### 3.3 升级接口完善（UpgradeManager 增强）

在现有 status 枚举基础上，增加完整的升级流程状态机：

```
轨道         当前状态           目标状态
─────────────────────────────────────────────
app          not-configured    配置 electron-builder publish → update-available
                               → update-downloaded → 更新下载完成，重启后安装
backend      stub              实现 npm install -g @deepseek-ai/dsh@latest
                               → update-available → 版本比较
                               → 更新下载完成 → 自动重启后端
profile      无               新增轨道：bundle 更新检测（npm outdated）
                               → 可更新列表 → 一键更新
```

**profile 轨道**（新增）：
- 检测 `~/.dsh/profiles/web/node_modules` 中哪些包有新版本
- 一键更新：`dsh --profile web install`（后台执行）
- 更新前自动备份（联动 BackupManager）

#### IPC 接口（扩展）

```
通道名                               方法      说明
upgrade:check {track}               invoke   检查升级（track: app|backend|profile）
upgrade:apply {track, target?}      invoke   执行升级
upgrade:list-profiles               invoke   列出可更新的 profile 依赖
upgrade:event                       on       进度推送（checking/downloading/installing/done）
```

### 3.4 🆕 设置面板（渲染进程内嵌 UI）

在 DSH Web UI 之外提供一个独立的桌面端设置面板（可通过菜单或托盘图标打开）：

```
面板内容：
  ├─ 通用设置
  │  ├─ GPU 渲染策略（auto/off/inprocess）
  │  ├─ 开机自启
  │  ├─ 关窗行为（退出/常开）
  │  ├─ dsh 命令路径
  │  └─ 工作目录
  ├─ 数据备份
  │  ├─ 备份列表（时间戳/大小/操作按钮）
  │  ├─ [立即备份] 按钮
  │  ├─ [恢复] 按钮（选择备份点）
  │  ├─ [导出] 按钮
  │  └─ 自动备份开关
  ├─ 崩溃恢复
  │  ├─ 上次退出状态
  │  ├─ 连续崩溃次数
  │  └─ [查看日志] [重置 Profile]
  ├─ 升级管理
  │  ├─ 应用版本 / DSH 版本
  │  ├─ [检查更新] 按钮
  │  └─ 各轨道状态
  └─ 关于
     ├─ 版本信息
     ├─ ADR 文档链接
     └─ [打开用户数据目录]
```

实现方式：独立的 HTML/CSS/JS 页面（非 React，避免引入框架），通过 preload 暴露的 `window.dshDesktop` API 与主进程通信。

---

## 四、实施路线

### Phase 1：基础框架（1-2 天）

| 任务 | 说明 | 优先级 |
|---|---|---|
| 拉取 DSH 最新版本 | `npm i -g @deepseek-ai/dsh@latest`，确认 profile 兼容 | P0 |
| 验证现有功能 | 全部 44 个单元测试 + 冒烟 + 打包 | P0 |
| 确认官方桌面端差异 | 对比 sdkwork-ai 实现，决定合并策略 | P1 |

### Phase 2：数据备份（2-3 天）

| 任务 | 说明 | 优先级 |
|---|---|---|
| 实现 BackupManager 核心 | 备份/恢复/清单/保留策略 | P0 |
| 实现 IPC 接口 | backup:* 通道 + preload 暴露 | P0 |
| 备份 UI 面板 | 列表/创建/恢复/导出 | P1 |
| 自动备份钩子 | 插件安装前/升级前触发 | P1 |
| 凭据加密 | AES-256-GCM + 机器指纹 | P2 |

### Phase 3：崩溃恢复（2-3 天）

| 任务 | 说明 | 优先级 |
|---|---|---|
| 实现 CrashRecovery 核心 | 状态标记/检测/恢复流程 | P0 |
| 启动时恢复提示 | .last-clean-exit 检测 + 对话框 | P0 |
| 连续崩溃保护 | 3 次崩溃后弹诊断对话框 | P1 |
| Profile 重置功能 | 备份当前 → 恢复默认 → 重装 | P2 |
| 恢复后自动健康检查 | 恢复完成后验证后端能启动 | P1 |

### Phase 4：升级增强（1-2 天）

| 任务 | 说明 | 优先级 |
|---|---|---|
| 后端轨道升级实现 | npm i -g @deepseek-ai/dsh@latest + 重启 | P0 |
| Profile 轨道 | 检测可更新 bundle + 一键更新 | P1 |
| 升级状态对话框 | 帮助菜单升级状态 + 设置面板集成 | P1 |
| 应用自升级 | 配置 electron-builder publish | P2 |

### Phase 5：设置面板 + UI 打磨（2-3 天）

| 任务 | 说明 | 优先级 |
|---|---|---|
| 设置面板 HTML/CSS/JS | 通用/备份/恢复/升级/关于 | P1 |
| 托盘图标 | 最小化到托盘 + 右键菜单 | P2 |
| 菜单完善 | 文件/编辑/视图/帮助完整菜单 | P1 |
| 加载页 UI 打磨 | 品牌化 + 进度条 + 状态图标 | P2 |

### Phase 6：测试与发布（2-3 天）

| 任务 | 说明 | 优先级 |
|---|---|---|
| 单元测试补全 | backup/crash-recovery/updater 新测试 | P0 |
| 端到端测试 | 备份→安装插件→崩溃→恢复 全链路 | P0 |
| 安装包测试 | NSIS/便携版静默安装 + 启动验证 | P0 |
| 文档更新 | README/UPGRADE/ADR/用户指南 | P1 |
| GitHub 发布 | 创建 release + 发布说明 | P1 |

**预估总工期：10-14 个工作日**

---

## 五、与官方桌面端的差异矩阵

| 特性 | 官方 (sdkwork-ai) | 本项目 (dsh-desktop, D:\AI\DSHarness) | 计划新增 |
|---|---|---|---|
| Electron 封装 | ✅ | ✅ | — |
| GPU 降级 | ❓ | ✅ inprocess 默认 | — |
| 确认式进程树清理 | ❓ | ✅ waitPidGone + listDescendants | — |
| 启动预检 | ❓ | ✅ node/bin/profile EPERM | — |
| 加载页实时日志 | ❓ | ✅ starting 阶段显示 | — |
| 冒烟诊断输出 | ❓ | ✅ 完整诊断协议 | — |
| 升级接口 | ❓ | ✅ 双轨道 status 枚举 | + profile 轨道 |
| **数据备份** | ❌ | ❌ | ✅ BackupManager |
| **崩溃恢复** | ❌ | ❌ | ✅ CrashRecovery |
| **设置面板** | ❌ | ❌ | ✅ 独立 UI |
| **插件备份按钮** | ❌ | ❌ | ✅ 备份系统 |
| **Profile 重置** | ❌ | ❌ | ✅ 一键恢复 |
| 单元测试 | ❓ | ✅ 44 个用例 | + backup/crash 测试 |

---

## 六、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| DSH 核心版本升级破坏 profile 兼容性 | 插件/配置失效 | 备份系统 + 版本标记 + 恢复流程 |
| Electron/Chromium 安全漏洞 | 应用被攻击 | 跟进 Electron 安全更新 + sandbox 启用 |
| 备份数据泄露 | 凭据暴露 | AES-256-GCM 加密 + 机器指纹绑定 |
| OneDrive 同步干扰 | 构建/备份锁 | 默认备份到 %LOCALAPPDATA%（非同步目录） |
| 官方桌面端与本项目功能重叠 | 维护两份代码 | 优先合并到官方（如果官方接受 PR） |
| 插件 API 持续变化 | 兼容性问题 | Profile 轨道升级 + 崩溃恢复兜底 |

---

## 七、交付物清单

| 交付物 | 格式 | 说明 |
|---|---|---|
| DSH Desktop 2.0 安装包 | NSIS exe + portable | Windows x64 |
| 源码仓库 | Git | 含完整测试 + 文档 |
| 单元测试 | node:test | backup/crash/upgrade/config/dsh-server/ipc |
| 用户指南 | Markdown | 安装/配置/备份/恢复/升级 |
| ADR 文档 | Markdown | 架构决策记录 |
| 发布说明 | GitHub Release | 变更日志 + 升级指南 |

---

## 八、决策点（已确认 2026-08-14）

| 决策 | 结论 | 说明 |
|---|---|---|
| 1. 路径选择 | **路径 B：本项目完善** | 已有 11 个 P0/P1 特性，增量开发更快更稳 |
| 2. 备份加密 | **V1 不做** | 凭据加密留到 V2，V1 备份为明文 zip |
| 3. Profile 轨道 | **加入** | 检测可更新 bundle + 一键更新（联动备份） |
| 4. 设置面板 | **集成到 DSH 桌面端** | 独立 HTML 页面，通过菜单/快捷键打开 |
| 5. 托盘图标 | **V1 不做** | 简化范围，V2 再加 |
| 6. 发布渠道 | **GitHub Release（安全审核后发布）** | 安全审核通过才推送 |
| 7. 凭据加密 | **V2 实现** | V1 明文备份，V2 加 AES-256-GCM |

---

*计划书编写：MiMo-v2.5 | 2026-08-14*
*决策确认：用户 | 2026-08-14*
