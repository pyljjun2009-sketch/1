# ADR-002：DSH 后端生命周期与 Electron 窗口生命周期解耦

状态：部分采纳（2026-08）—— 默认"窗口关闭=退出应用=停止后端"，
提供 `keepBackendRunning` 配置支持常开模式；完整 supervisor 化列为后续演进。

## 背景

上一轮审查指出：`window-all-closed` 会停止后端，若目标是"关窗后 DSH 常开"，
需要把 DSH supervisor 与 Electron UI 解耦。用户目标是"桌面端稳定常开"，
需要明确两种语义并让用户可选。

## 决策

1. 新增配置 `keepBackendRunning`（默认 `false`）：
   - `false`（默认）：关闭窗口 → 退出应用 → `before-quit` 中**确认式**停止
     后端（taskkill /T + 主 PID 消失轮询 + 后代枚举），退出后零残留。
   - `true`：关闭窗口仅关闭 UI，后端保持运行（应用进程不退出）；再次启动
     应用实例（单实例锁的 `second-instance` 事件）唤回窗口。
2. 退出路径统一走 `before-quit` + `preventDefault` + `server.stop()` 完成后
   放行，杜绝"看起来退出了、子进程还在"。
3. 后端进程的可靠性（自动重启、退避、树级清理、诊断）由 `DshServer`
   独立负责，不依赖窗口存在。

## 后续演进（未采纳部分）

- 完整 supervisor：独立 Node 守护进程 / Windows Task / Job Object 托管 DSH，
  Electron 只连接 UI。收益：窗口关闭、GPU 崩溃、Electron 自身重启都不影响后端。
- 需要补充：状态发现（端口/健康）、版本协调、常驻单实例锁、手动停止入口、
  托盘图标。

## 后果

- 默认行为符合"桌面应用"直觉（退出即停，且确保进程树清理）。
- `keepBackendRunning: true` 满足"服务常开"需求，无需额外常驻进程，
  代价是应用进程常驻内存。
