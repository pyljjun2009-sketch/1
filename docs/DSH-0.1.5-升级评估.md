# DSH 0.1.5-rc.1 升级评估（决定：暂不升级）

> 评估日期：2026-09-11（插件兼容性审计复核：2026-09-11）｜ 结论：**暂不升级**，保持 dsh `0.1.1-rc.2` + 桌面端 `0.1.2`
> 本文档记录调研证据与升级前置条件，供将来决策复用。
>
> **审计要点**：9 个第三方插件中仅 3 个明确支持 0.1.5-rc.1；`dshmarket`（插件市场）09-13 最新版仍不兼容；
> `@openviking/dsh-memory-plugin`（记忆能力）存疑且社区已报告故障 ⇒ 当前不具备安全升级条件。
>
> **附注**：DSH 目前不存在严格意义的"稳定版"——npm `latest` 指向的 `0.1.5-rc.1` 本身是 `prerelease`，
> 整个 0.1.x 系列均为 rc/alpha 通道；本机所用 `0.1.1-rc.2` 同为 rc 版本但为官方 `latest` 长期指向的稳定落点。

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
| 插件（本机版本） | npm 最新（发布时间） | 0.1.5-rc.1 兼容判定 |
|---|---|---|
| `@anionex/dsh-vision-toolkit` ^0.1.40 | 0.1.44（09-10） | ✅ **明确支持**：peer 含 `^0.1.5-rc.1` |
| `dsh-tongflow` ^0.6.0 | 0.8.2（09-12） | ✅ **支持**：peer 含 `^0.1.5-alpha.0`（prerelease 段同为 0.1.5） |
| `@nanmicoder/dsh-agent-teams` 0.1.14（固定） | 0.1.17-rc.1（09-11） | ✅ **明确支持**：peer 列出 `0.1.5-rc.1` |
| **`dshmarket`** ^1.40.0 | **1.46.1（09-13，最新）** | ❌ **不兼容**：peer 仅 `^0.1.0-rc.7 \|\| ^0.1.1-rc.2 \|\| ^0.1.2-alpha.2`（无 0.1.5 段） |
| **`@openviking/dsh-memory-plugin`** ^0.3.0 | 0.3.0（08-28，未更新） | ⚠️ **存疑**：peer `>=0.1.0-rc.6 <0.2.0` 的 prerelease 段为 0.1.0，按 semver 规则不匹配 0.1.5-rc.1；且社区报告"接口变更引发记忆插件故障" |
| `dsh-pocket` ^1.8.3 | 2.10.6（09-10） | ❓ 未声明 dsh peer（仅 cordis），需实测 |
| `@vectorize-io/hindsight-coding-agents` ^0.5.1 | 0.6.0（09-11） | ❓ 未声明 dsh peer，需实测 |
| `aegis` | GitHub commit 固定 | ❓ 未知，需查上游分支 |
| `dsh-sub2api-personal` | 本地 `link:` | ❓ 仅声明 `@deepseek-ai/cordis ^4.0.1`，需自行适配 |
| `@deepseek-ai/dsh-base` / `dsh-web-app` | 官方 | 随宿主同步升级 |

**审计结论（2026-09-11）**：9 个第三方插件中仅 **3 个明确支持** 0.1.5-rc.1，**1 个明确不兼容**（`dshmarket` —— 插件市场，管理插件的核心工具，09-13 最新版仍未适配），**1 个存疑**（`@openviking/dsh-memory-plugin` —— 记忆能力，社区已报告故障），其余 4 个未声明需实测。⇒ **当前不具备安全升级条件**。

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
