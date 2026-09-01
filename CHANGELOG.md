# 变更日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 2026-09-01

首个正式发布版。桌面端作为 DSH Web 后端的独立宿主，提供类似 Codex 的桌面 UI 体验；DSH 本体（`@deepseek-ai/dsh`）零改动。

### 新增

- **崩溃自动恢复（看门狗）**：桌面程序崩溃或非正常关闭后，自动打开系统浏览器访问 Web UI
  - 独立看门狗进程（`src/main/watchdog.js`）监控主进程 PID，不随主进程退出
  - 通过 `.last-clean-exit` 标记区分"正常关闭"（不弹窗）与"崩溃/异常关闭"（自动打开浏览器）
  - 仅接受 http(s) 本机地址（127.*/localhost/::1），拒绝注入变形
  - 设置面板可开关（`openBrowserOnCrash`，默认开启）；日志在 `%APPDATA%/dsh-desktop/watchdog.log`
- **数据备份系统**：备份 profile 关键文件（bundle 清单/patch 配置），支持创建/列表/对比/恢复/删除，恢复前自动快照（原子恢复）
- **崩溃恢复管理器**：检测异常退出（`.last-clean-exit` / 连续崩溃计数 / last-known-good），提供诊断与恢复建议
- **设置面板**：独立本地页面（备份管理/崩溃恢复/升级管理/通用设置/关于），仅本地设置页可调用管理 IPC
- **升级接口（三轨道）**：`app`（electron-updater，需配置发布源）、`backend`（npm 包升级：备份→安装→校验→同步依赖→重启）、`profile`（bundle 依赖更新检测与一键更新）
- **GPU 渲染策略**：Windows 默认 `inprocess`（软件渲染并入浏览器进程），解决 GPU 子进程崩溃导致应用直接退出；支持 `--safe-mode`/`--hardware-acceleration`/`DSH_DESKTOP_GPU` 覆盖
- **后端进程树清理**：确认式停止（taskkill /T + 主 PID 消失轮询 + 后代枚举），退出零残留
- **启动预检**：node/bin/profile EPERM/bundle 一致性检查，失败给出明确诊断
- **冒烟测试协议**：机器可读诊断输出（状态/命令/cwd/日志尾部），用于 CI 与排障

### 安全加固

- IPC 管理通道身份校验（仅本地设置页可调用），拒绝渲染进程修改 `dshCommand`/`nodeBin`
- 备份 ID 正则校验防路径穿越；恢复流程原子化（先删后拷 + 恢复前自动备份）
- 命令执行一律 `shell:false`（参数数组），不经过 cmd.exe/shell
- 升级目标版本 semver 严格校验；Profile bundle 包名格式校验（防注入 npm registry URL / CLI 参数）
- URL 校验：外部链接仅允许 http(s)；看门狗仅接受本机地址
- 严格 CSP（`default-src 'self'; script-src 'self'`），渲染一律 textContent/转义
- 窗口默认拒绝系统权限请求；外部导航一律交给系统浏览器
- `npm audit`：0 漏洞

### 构建与部署

- A/B 双目录交替构建（`%LOCALAPPDATA%\dsh-desktop-build-a/-b`），运行中实例不阻塞构建
- 构建后自动更新桌面快捷方式；`current.txt` 记录当前版本
- 打包内容完整性校验（`verify-build.js`，18 个关键文件）
- 一键切换脚本（`scripts/cleanup-old-version.ps1`）：关闭旧实例后清理并指向最新构建

### 修复

- dsh web 启动默认自动打开浏览器的问题：`--no-open`（根因：dsh 默认 `openBrowser:true`）
- 视觉工具黑屏（WebGL/Canvas）：`gpuMode:auto` 预设
- 后端启动超时子进程残留：超时后确认式清理
- 重启时旧后端未停止导致端口/状态异常：restart 先确认 stop 成功
- 配置保存失败无反馈：`set()` 告警而非静默
- 备份恢复非原子（先删后拷的顺序问题）
- 设置页身份校验路径归一化（Windows 反斜杠/正斜杠）
- 首次启动误判为异常退出：无标记且无历史记录时识别为首次

### 已知限制

- 看门狗不覆盖 `taskkill /T /F` 全树强杀（Windows PPID 链会连看门狗一起杀）
- 崩溃后后端若已被一起终止，探测失败则不打开浏览器
- 备份为明文（V2 计划加 AES-256-GCM 加密）
- 应用自升级需配置 electron-builder `publish` 发布源

### 测试

- 87 个单元测试（node:test）：config/updater/ipc/dsh-server/backup/crash-recovery/watchdog/preload-consistency/window-security/assets-security
- 29 个文件语法检查
- 真实集成验证：看门狗崩溃场景（探测→打开浏览器）与正常退出场景（静默）
