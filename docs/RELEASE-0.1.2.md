# v0.1.2 可升级安装版

日期：2026-09-02。源码、安装包、运行时下载缓存和测试材料均保存在 `D:\AI\DSH`。

## 更新搜索结论

- 官方 DSH npm `latest` 和 `next`：`0.1.1-rc.2`。
- 官方 DSH alpha：`0.1.2-alpha.4`，涉及接口兼容变更，本次未替换用户全局 DSH。
- Electron：原 43.4.0，已更新至同主版本补丁 43.5.1；44.1.1 是查询时的新主版本，本次未跨主版本升级。
- electron-updater 6.8.9、electron-builder 26.15.3 沿用当前版本。
- 项目公开 GitHub Release 当前为 v0.1.0；本次仅生成本地 v0.1.2，未公开上传。

来源：[DSH 官方发布](https://github.com/deepseek-ai/deepseek-harness/releases)、[DSH npm 元数据](https://registry.npmjs.org/@deepseek-ai/dsh/latest)、[Electron 官方 43.5.1](https://github.com/electron/electron/releases/tag/v43.5.1)、[自动更新说明](https://www.electron.build/auto-update/)。

## 安装与后续升级

首次运行 `D:\AI\DSH\release\DeepSeek-Harness-Desktop-0.1.2-x64.exe`，安装目录可选择 `D:\AI\DSH\installed`。之后从安装器创建的快捷方式启动，在设置 → 升级管理检查、下载并确认重启安装。

构建工具创建的“DeepSeek Harness Desktop”快捷方式指向解包目录，供开发测试；它与 NSIS 安装器创建的“DeepSeek Harness”快捷方式不同。自动升级须使用后者。

升级前自动备份并停止后端；默认不降级、不选测试版、不在普通退出时安装。便携版需手动替换。没有代码签名证书时，Windows 可能显示未知发布者警告。

## 测试与限制

- 完整测试：125/125 通过；语法检查：33/33 通过；依赖审计：0 个已知漏洞。
- 新打包程序的模拟后端启动、HTTP 页面加载和退出清理通过，退出码 0。
- `npm run verify` 一键验收全部通过（约 33 秒）。
- 项目内隔离官方 DSH `0.1.1-rc.2` 的打包态真实启动、网页加载与退出清理通过，退出码 0；日志保存在 `artifacts/smoke-real-0.1.2/`。
- ASAR 18/18 关键文件、嵌入的 GitHub 更新源、发布文件名/大小/SHA-512/blockmap 均通过校验。

真实升级组件已验证本地 HTTP 检查、下载、SHA-512 校验和损坏文件拒绝；安装调用及准备失败有隔离单测覆盖，不会在测试中执行安装器。

公网只读检查已成功连接现有 GitHub 更新源：本地 0.1.2，远端 0.1.0，正确不触发降级。发布更高版本后，安装版才会提示可下载更新。

本机全局 DSH 的可执行文件在本次检查时缺失，原 `verify:local` 真实全局 DSH 步骤失败；这与桌面更新通道无关。没有擅自修复或覆盖用户全局安装。

隔离环境安装位于 `artifacts/dsh-test-runtime`：npm 默认 peer 解析停滞后，使用 `--legacy-peer-deps` 完成安装，并按官方包清单补齐 19 个必需 peer 依赖，再通过真实启动验证。该目录仅用于测试，不会自动接管用户日常配置。日常使用仍需有效的全局 DSH 或显式指定后端命令。

发布流程和可重复校验命令见 [UPGRADE.md](../UPGRADE.md)。
