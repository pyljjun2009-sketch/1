# ADR-001：Windows 默认使用安全渲染启动策略（inprocess GPU）

状态：已采纳（2026-08）

## 背景

在目标 Windows 环境复现：Electron 默认（`auto`）启动时 GPU 进程连续崩溃，
应用直接退出，退出码 `-2147483645`（0x80000003）。传入 `--disable-gpu` 也不能
完全避免 GPU 子进程崩溃。改用 `DSH_DESKTOP_GPU=inprocess`（GPU 工作并入浏览器
进程）后应用可稳定启动。远程桌面、虚拟机、驱动异常环境均可能触发该问题。

## 决策

1. GPU 渲染策略按以下优先级解析（`src/main/index.js`）：

   ```text
   --safe-mode（=inprocess）
   > --hardware-acceleration（=auto，恢复硬件加速的显式开关）
   > $DSH_DESKTOP_GPU（auto|off|inprocess）
   > $DSH_DESKTOP_DISABLE_GPU=1（=off）
   > settings.json: gpuMode / disableHardwareAcceleration=true（=off）
   > 平台默认：Windows = "inprocess"，其他平台 = "auto"
   ```

2. `inprocess` 模式执行：`disableHardwareAcceleration()` + `--disable-gpu` +
   `--disable-gpu-compositing` + `--in-process-gpu`。
3. 提供 `npm run start:safe`（`electron . --safe-mode`）作为安全模式入口。
4. 保留 `--hardware-acceleration` 与 `gpuMode:"auto"` 两种恢复硬件加速的方式。

## 后果

- 正面：Windows 上应用可启动性显著提升，消除 GPU 崩溃导致启动即退。
- 代价：软件渲染图形性能略降；用户可用 `--hardware-acceleration` /
  `gpuMode:"auto"` 恢复。
- 该策略在冒烟测试中验证：`DSH_DESKTOP_GPU=off` 与默认（inprocess）均可
  完整启动并加载页面。
