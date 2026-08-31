# DSH 启动卡住问题经验总结

本文档基于多次实际故障排查，记录 DSH Desktop 桌面端启动卡住的全部已知根因、排查流程和修复方法。桌面端已实现对应的自动防护（预检/诊断/一键修复），但掌握以下经验有助于在桌面端无法启动时快速定位问题。

## 一、问题现象

DSH 桌面端启动后长期停留在"正在启动 DeepSeek Harness / 初始化桌面端"画面，无法进入主页面。**问题通常不是桌面窗口本身，而是它等待的 `dsh web` 后端已经退出。**

## 二、已知根因分类

### A 类：Profile / 插件配置问题（最常见）

| 根因 | 症状 | 修复 |
|---|---|---|
| bundle 声明但未安装 | `cannot resolve profile bundle @xxx` | `dsh plugin --profile web install` |
| 卸载事务被强制中断 | bundle 在 package.json 但 node_modules/pnpm-lock 已删除 | `dsh plugin --profile web remove @xxx` |
| 插件 API 不兼容（旧版） | `without inject` / `must declare output` | 升级插件到兼容版本 |
| patch 引用不存在的包 | `Cannot find package xxx` | 检查 cordis.patch.yml |
| Profile 目录权限异常 | `EPERM: operation not permitted` | 检查 ~/.dsh/profiles/web/ 权限 |

### B 类：DSH 全局安装问题（较少见）

| 根因 | 症状 | 修复 |
|---|---|---|
| 全局 DSH 运行库损坏 | `Cannot find module '../schema/yaml-1.1/merge.js'` | `npm install -g @deepseek-ai/dsh@<当前版本>`（锁定版本重装） |
| DSH 版本过旧 | 与新插件不兼容 | 升级 DSH（先备份） |

### C 类：Electron / 环境问题（最少见）

| 根因 | 症状 | 修复 |
|---|---|---|
| GPU 进程崩溃 | 启动即退（退出码 -2147483645） | `--safe-mode`（inprocess GPU） |
| 配置文件损坏 | 无法解析 JSON | 删除 settings.json，重建默认配置 |
| **软件渲染下视觉工具黑屏** | DSH Web UI 中 WebGL/Canvas 视觉工具黑屏 | `settings.json` 设 `gpuMode: "auto"` 恢复硬件加速；若 GPU 崩溃再用 `--safe-mode` 兜底 |

### C 类补充：视觉工具黑屏（2026-08-31）

- **根因**：Windows 默认 `inprocess`（软件渲染）→ DSH Web UI 的视觉工具（依赖 WebGL/Canvas）在 SwiftShader 软件渲染下黑屏。
- **解决**：`%APPDATA%\dsh-desktop\settings.json` 设 `"gpuMode": "auto"`（恢复硬件加速）。
- **兜底**：若硬件加速导致 GPU 进程崩溃（启动即退 `-2147483645`），用 `--safe-mode` 启动或改回 `"gpuMode": "inprocess"`。
- **权衡**：视觉工具优先选 `auto`；稳定性优先选 `inprocess`（此时视觉工具可能黑屏）。

### C 类补充：桌面版启动时浏览器自动弹出 Web UI（2026-09-01）

- **根因**：`dsh web` **默认自动在系统默认浏览器打开 Web UI**（`openBrowser: true`，`--open` 是默认值）。桌面版 spawn `dsh web --host --port`（未加 `--no-open`）→ 后端就绪后浏览器自动弹出。
- **修复**：桌面版启动命令追加 **`--no-open`**（`dsh-server.js` 的 `launchCommand`），UI 已在 Electron 窗口内展示，不再弹系统浏览器。
- **排查要点**：若桌面版启动伴随浏览器弹出 localhost 页面，优先检查 dsh web 启动参数是否含 `--no-open`，而不是怀疑 playwright/外部脚本（除非另有独立 playwright 测试进程）。

## 二点五、每次审核的标准检查清单（版本 + 完整性）

以下检查应在每次版本升级、插件变更或例行审核时执行，防止 DSH 版本落后或运行库损坏导致启动失败。

### 1. 版本检查（对比 npm 最新版）

```powershell
# 查看本机已安装版本
npm list -g @deepseek-ai/dsh --depth=0

# 查看 npm 最新版（需要网络）
npm view @deepseek-ai/dsh version

# 查看版本发布时间线
npm view @deepseek-ai/dsh time --json | Select-String -Pattern '"0\.' | Select-Object -Last 5
```

| 对比结果 | 处理 |
|---|---|
| 本机版本 < npm 最新版 | `npm install -g @deepseek-ai/dsh@<最新版>` 升级（先备份 profile） |
| 本机版本 = npm 最新版 | ✅ 无需升级 |
| npm 不可达（离线） | 检查 GitHub Releases 页，或确认本机版本可用即可 |

> 已知版本时间线：`0.1.0-rc.6`(08-13) → `0.1.0-rc.7`(08-17) → `0.1.0-rc.8`(08-19) → `0.1.1-rc.1`(08-21) → `0.1.1-rc.2`(08-21 最新)

### 2. 全局安装完整性检查（yaml 运行库）

上次故障：yaml schema 子目录被清空导致 `Cannot find module '../schema/yaml-1.1/merge.js'`。每次审核应验证：

```powershell
# 关键文件是否存在
Test-Path "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\yaml\dist\schema\yaml-1.1\merge.js"

# yaml schema 目录文件数（正常应为 20 个左右）
(Get-ChildItem "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\yaml\dist\schema\yaml-1.1" -File).Count

# 四个 schema 子目录文件数（common:8, core:8, json:2, yaml-1.1:20）
Get-ChildItem "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\yaml\dist\schema" -Directory | ForEach-Object {
  "$($_.Name): $((Get-ChildItem $_.FullName -File).Count) 个文件"
}
```

| 检查结果 | 处理 |
|---|---|
| merge.js 存在且四个目录文件数正常 | ✅ 完整 |
| 文件缺失或目录为空 | 锁定版本重装：`npm install -g @deepseek-ai/dsh@<当前版本>` |

### 3. Profile 一致性检查（五项）

```powershell
# 检查 bundle 能否解析（返回码 0 = 可启动）
dsh --profile web --dump-config

# 桌面端自动检查（设置 → 崩溃恢复 → Profile 健康检查）
```

### 4. 桌面端健康检查

```powershell
npm run test:syntax    # 23/23 通过
npm test               # 65/65 通过
npm run test:smoke:fixture  # 冒烟测试
```

### 快速一条命令（PowerShell）

```powershell
# 一键检查版本 + 完整性
$v = npm list -g @deepseek-ai/dsh --depth=0 2>$null | Select-String 'dsh@'; $latest = npm view @deepseek-ai/dsh version 2>$null;
$yaml = Test-Path "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\yaml\dist\schema\yaml-1.1\merge.js";
Write-Output "已安装: $v | npm最新: $latest | yaml完整: $yaml"
```

## 三、推荐排查顺序（优先级从高到低）

```text
桌面端卡在启动页
│
├─ 检查 dsh web 能否独立启动
│  ├─ 成功 → 问题在桌面端 Electron 侧（窗口/单实例/preload）
│  └─ 失败 → 继续 ↓
│
├─ 检查 dsh --profile web --dump-config
│  ├─ 失败（cannot resolve profile bundle）→ A 类：查 profile 依赖一致性
│  └─ 成功 → 继续 ↓
│
├─ 检查 dsh web 启动时的实际错误
│  ├─ Cannot find module yaml/merge → B 类：全局 DSH 运行库损坏
│  ├─ 插件 API 报错 → A 类：插件兼容性
│  ├─ EPERM → A 类：权限问题
│  └─ 其他 → 查日志定位
│
└─ 检查 GPU / Electron 环境 → C 类
```

## 四、五项一致性检查（插件操作后必做）

| 检查位置 | 安装完成时 | 卸载完成时 |
|---|---|---|
| `package.json.dependencies` | 应存在依赖 | 应删除依赖 |
| `dsh.profile.bundles` | bundle 插件应存在 | 应删除 bundle |
| `pnpm-lock.yaml` | 应有锁定记录 | 应无对应记录 |
| `node_modules` | 应有实际插件目录 | 应无实际插件目录 |
| `cordis.patch.yml` | 普通插件应有正确挂载 | 普通插件的手工挂载应删除 |

检查命令：`dsh --profile web --dump-config`（返回码 0 = 可启动）

## 五、修复原则

1. **先备份再修改**：至少备份 package.json / pnpm-lock.yaml / cordis.patch.yml
2. **不要删除 ~/.dsh**：含凭据、会话、workspace、插件数据
3. **不要手工操作 node_modules**：用 `dsh plugin` 命令操作
4. **不要只改 package.json**：让 DSH/pnpm 同步锁文件和依赖
5. **锁定版本修复**：全局安装损坏时用当前版本重装，不顺带升级
6. **重装桌面端不能解决 profile 问题**

## 六、桌面端自动防护

桌面端已实现以下防护，无需手动排查即可识别常见问题：

| 防护 | 位置 | 说明 |
|---|---|---|
| Profile EPERM 预检 | dsh-server.js `_preflight()` | 启动前写入测试文件检测权限 |
| Bundle 存在性验证 | dsh-server.js `_checkProfileBundles()` | package.json 声明的每个 bundle 检查 node_modules |
| 五项一致性检查 | dsh-server.js `_checkProfileHealth()` | 完整检查 package.json/lock/node_modules/patch/bundles |
| DSH 运行库完整性 | dsh-server.js `_preflight()` | 验证 yaml schema 模块存在 |
| 错误智能诊断 | dsh-server.js `analyzeDshError()` | 识别 8+ 种已知错误模式，给出修复指引 |
| 设置页一键修复 | settings.html + ipc.js | "Profile 健康检查" / "修复插件依赖" 按钮 |
| 加载页实时日志 | loading.html | starting 阶段显示后端输出 |
