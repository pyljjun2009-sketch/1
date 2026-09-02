# 变更日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

## [0.1.2] - 2026-09-02

- NSIS 安装版绑定现有公开 GitHub Releases 更新源；新增下载进度和“保存工作并重启安装”入口
- 安装前自动备份并停止后端；普通退出不安装，拒绝降级、预发布版和便携/解包目录自动替换
- 修复下载事件没有发到设置页、重复检查、已下载状态丢失、断网误报未配置等问题
- Electron 升至同主版本补丁 43.5.1，采用官方 SHA-256 验证的运行时；构建复用本地运行时，默认 `--publish never`
- 新增真实 HTTP 下载/篡改校验集成测试、公网只读检查与发布资产校验脚本
- 125/125 测试、33/33 语法检查、依赖审计 0 漏洞；实际公网更新源检查成功
- 本机全局 DSH 可执行文件缺失，原真实全局冒烟未通过；未擅自修改全局 DSH
- 项目内隔离官方 DSH 0.1.1-rc.2 的打包态真实冒烟通过；一键 `npm run verify` 全部通过

本版本仅生成本地安装包，尚未提交或公开发布；完整说明见 `docs/RELEASE-0.1.2.md`。

## [0.1.1] - 2026-09-01

### 完善

- **事务式备份恢复**：恢复前校验 manifest、允许路径、文件存在性与 SHA-256；同卷暂存目录切换，失败自动回滚 Profile 与 `settings.yaml`
- **运行中安全恢复**：设置页恢复备份时自动停止后端、恢复文件、同步 Profile 依赖并重新启动
- **三轨升级补全**：设置页可执行应用、DSH 后端和 Profile bundle 更新；Profile 更新成功后自动重启后端
- **升级串行化**：同一升级轨道拒绝重复并发 apply，避免多次 npm/plugin 操作互相破坏
- **一键验收**：新增 `npm run verify` 与 `npm run verify:local`，覆盖单测、语法、审计、模拟/真实冒烟和 ASAR 完整性
- **项目内产物管理**：A/B 构建目录迁入 `D:\AI\DSH\artifacts`，安装包自动汇总到 `D:\AI\DSH\release`，下载失败自动重试
- 发布资产统一使用无空格文件名，保证 `latest.yml` 引用与实际安装包名称一致
- 新增 ADR-003，记录事务式恢复与升级串行化的架构决策

### 修复

- 配置混合补丁改为完整校验后原子应用；重复初始化不再继承旧目录的陈旧字段
- 自定义 `dshCommand` 拒绝空白参数
- 管理 IPC 在缺少 `senderFrame` 时改为默认拒绝，并正确处理安装路径中的空格、中文和 URL 编码
- Profile 升级正确使用构造函数传入的 `DSH_HOME`；损坏的 package.json 和非法 bundle 不再误报“已是最新”
- 非法 bundle 声明不再触发路径逃逸检查或健康检查崩溃
- 端口分配超时时同时关闭首选和回退监听器，修复资源泄漏
- 应用更新改为关闭 `autoDownload` 后显式下载一次，避免重复下载竞态
- 后端指定版本升级后校验实际安装版本是否一致
- preload 通道测试现在校验真实字符串值，不再可能空通过
- 帮助菜单删除“后端一键升级未实现”的过期提示，并展示三条升级轨道

### 验证

- 111 个 `node:test` 用例全部通过
- 30 个 JavaScript 文件语法检查全部通过
- npm audit：0 个已知漏洞
- 模拟 DSH 与本机真实 DSH `0.1.1-rc.2` 冒烟均通过
- 0.1.1 打包程序真实启动冒烟通过（后端与 HTTP 页面就绪、退出码 0、进程树正常清理）
- Electron 解包与 ASAR 18/18 关键文件校验通过

### 修复（多轮系统性测试发现）

- **备份恢复竞态（数据安全）**：恢复最旧备份时，恢复前自动备份触发的清理策略会删除源备份，导致"静默恢复失败"——现改为先将源备份内容读入内存再恢复
- **恢复后 node_modules 残留**：restore 现在清理 `profiles/web` 下所有内容（含 node_modules），避免恢复后 bundle 声明与已安装插件不一致（恢复语义 = 关键文件回滚 + 依赖重建）
- **diff 遗漏全局设置**：备份对比现在按 manifest 记录的全部文件（含 `.settings.yaml`）对比，不再只对比 3 个 profile 文件
- **崩溃待重启期间 stop() 失效**：`_restartPending` 续跑路径现在检查 `_stopRequested`，用户停止后不再被自动拉起
- **并发 stop/start 竞态**：start() 守卫不再返回过期 running 快照；stop() 末尾不再覆盖新实例状态；spawn 后收到停止请求立即终止——无孤儿进程、状态一致
- **child 引用竞态**：stop() 只清理它实际停止的那个 child，start() 并发 spawn 的新进程引用不被抹掉
- **`_tryReuse` 返回值契约**：yaml 损坏时统一返回状态对象（error），不再返回字符串破坏 start() 契约
- **启动超时残留进程树**：`_killChild` 补 `taskkill /T`（与 stop 一致）
- **pidExists 超时误判**：tasklist 查询超时/失败时保守假设进程存活，避免 stop() 假成功
- **findFreePort 无超时**：加 10s 整体超时 + start() 调用点兜底 error
- **IPv6 URL 构造**：探测/复用/主 URL 统一走 `httpUrl()`（自动加方括号）
- **同步阻塞优化**：wmic/powershell/tasklist 超时缩短（15s/20s/10s → 5s/8s/3s），减少 stop() 期间 UI 冻结
- **POSIX 进程树清理**：非 Windows spawn detached 独立进程组，stop/_killChild 用负 PID 杀整棵树
- **host 配置注入**：监听地址增加格式校验（拒绝空白/斜杠，防 CLI 参数注入）
- **冒烟模式跳过看门狗**：`DSH_DESKTOP_SMOKE` 下不 spawn 看门狗进程
- **CRASH_RESET 数据安全**：重置前备份失败时取消重置（防无备份可回滚的数据丢失）
- **preflight 写入拦截**：profile 目录写测试不再只拦 EPERM（ENOSPC/EROFS 等同样阻断并诊断）
- 看门狗/升级器/设置面板若干健壮性改进（事件补发、fetch 连接释放、UI 错误提示）

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
