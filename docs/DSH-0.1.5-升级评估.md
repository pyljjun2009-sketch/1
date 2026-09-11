# DSH 0.1.5-rc.1 升级评估（决定：暂不升级）

> 评估日期：2026-09-11 ｜ 结论：**暂不升级**，保持 dsh `0.1.1-rc.2` + 桌面端 `0.1.2`
> 本文档记录调研证据与升级前置条件，供将来决策复用。

## 1. 版本现状

| 项 | 值 |
|---|---|
| 本机全局 dsh | `0.1.1-rc.2`（完整：`package.json` / `lib/bin.js` / yaml 运行库校验通过） |
| npm `latest` | `0.1.5-rc.1`（`prerelease = true`，2026-09-10 发布） |
| npm `next` / `alpha` | `0.1.5-rc.2` / `0.1.5-alpha.2` |
| 变更规模 | 0.1.5-rc.1 汇总自 `v0.1.2-rc.1` 以来 **1486 个提交** |
| 桌面端 | `0.1.2`（自动更新源已验证：`up-to-date`） |

## 2. 升级价值（0.1.5-rc.1 官方 release notes 要点）

- DeepSeek-V41-Flash（`deepseek-flash`）模型适配，**新会话默认使用该模型**
- Web 支持任意类型通用文件上传（图片/文件混排、进度、取消、会话切换续显）
- 子代理支持消息排队/编辑/删除/Steer/停止；动态修改系统提示词不破坏 KV Cache
- Sidebar 多标签/分栏/全屏 + Markdown/代码/HTML/PDF/图片预览；原 Detail 面板移除
- 所有出站请求遵循 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`
- **Windows 上的本地非终端子进程不再弹出控制台窗口**（与本桌面端相关）
- 修复：Web 断线后无法自动恢复、Windows 盘符根目录 Workspace 校验、Python SDK 启动崩溃、
  流式工具调用续传分片覆盖调用 ID、空消息发送判定等
- 优化：长会话打开/恢复卡顿、内存占用、会话统计（轮次与速度 / Token 与缓存命中）

## 3. 风险清单（决定暂缓的原因）

### R1 会话数据格式 V2 → V3，单向不可降级（最高风险）
- 打开旧会话时生成伴生文件：`session.jsonl.zstd`（V2 原件保留）+ `session.v3.jsonl.zstd`（V3 权威版本）
- 上游明确：**"升级后的会话不支持降级读取"** → 回退旧版将无法读取新生成的会话
- 迁移按需触发（仅被打开/恢复的会话），随使用逐步扩大影响面

### R2 11 个 profile 插件需连锁升级
| 插件（本机版本） | npm 最新 | 备注 |
|---|---|---|
| `@nanmicoder/dsh-agent-teams` 0.1.14（固定） | 0.1.17-rc.1 | peerDependencies 明确列出 `0.1.5-rc.1` ✅ |
| `@openviking/dsh-memory-plugin` ^0.3.0 | 0.3.0（已最新） | peer 范围 `>=0.1.0-rc.6 <0.2.0`，但社区报告记忆插件故障 ⚠ |
| `dsh-pocket` ^1.8.3 | 2.10.6 | 跨大版本 |
| `dshmarket` ^1.40.0 | 1.45.1 | 待确认 |
| `@anionex/dsh-vision-toolkit` ^0.1.40 | 0.1.44 | 待确认 |
| `dsh-tongflow` ^0.6.0 | 0.8.0 | 待确认 |
| `@vectorize-io/hindsight-coding-agents` ^0.5.1 | 0.5.3 | 待确认 |
| `aegis` | GitHub commit 固定 | 需确认分支适配 |
| `dsh-sub2api-personal` | 本地 `link:` | 需自行适配 |
| `@deepseek-ai/dsh-base` / `dsh-web-app` | 官方 | 随宿主同步 |

### R3 接口破坏性变更
- Session 生命周期：持久化 API 改为生命周期持有的 `SessionHandle`；`agentLoop.create()` 改为异步；新增 session 锁
- Web 面板 API：新增 `sidebar.panellist` 与 `main` 全局面板；原 `conversation` Slot 迁移为 `main` 的 `conversation` key
- **`ctx.agent` 移除**、Inbox API 改为类型接口
- 插件引擎绑定：如 `dsh-web-all@0.3.20` 声明 `dsh.engines.dsh >= 0.1.5-rc.1`

### R4 官方性质与社区评价
- 版本标记 `prerelease`；DSH 官方定位 developer preview 并声明"会有破坏兼容性的变更"
- 社区分析：[自毁式更新，5100 个插件面临洗牌](https://www.jdon.com/94552-deepseek-harness-alpha-breaking-change-plugin.html)、
  [接口变更引发记忆插件故障](https://deepseek.club/topic/4365)

## 4. 升级前置条件（将来若要升级，按此执行）

1. **隔离实测**：独立 `DSH_HOME` + 独立 `DSH_DESKTOP_USER_DATA`，用 `npx @deepseek-ai/dsh@0.1.5-rc.1` 验证启动与插件加载，不影响现有环境
2. **插件兼容确认**：逐个检查 11 个插件的 `peerDependencies` 中 `dsh-*` 包是否声明支持 `0.1.5-rc.1`；对无兼容版本的插件准备替代或暂时移除
3. **完整备份**：profile 关键文件（package.json / cordis.patch.yml / cordis.yml）+ `~/.dsh/sessions` 会话数据 + 记录当前全局 dsh 版本以便回滚
4. **接受单向门**：确认理解 V3 会话数据不可降级读取
5. **切换顺序**：备份 → 升级 dsh → `dsh plugin --profile web install` 同步依赖 → 升级各插件 → 冒烟验证 → 观察 1-2 天

## 5. 参考来源

- 官方 release：<https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1>
- 适配实测文档（会话 V3 / 面板 API 变更取证）：<https://github.com/maple110011/dsh-obsidian-math/blob/HEAD/docs/dsh-0.1.5-adaptation.md>
- 风险分析：<https://www.jdon.com/94552-deepseek-harness-alpha-breaking-change-plugin.html>
- 升级避坑指南：<https://deepseek.club/topic/4365>
- 社区适配案例：<https://github.com/chyra-moon/deepseek-harness-desktop/commit/6b713292a88c77519143fccc8cc82e964788bf2b>
