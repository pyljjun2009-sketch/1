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
