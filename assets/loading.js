/* Local loading-page controller. Kept external to satisfy a strict CSP. */
(() => {
  "use strict";
  const statusEl = document.getElementById("status");
  const errorEl = document.getElementById("error");
  const spinnerEl = document.getElementById("spinner");
  const retryBtn = document.getElementById("retry");

  function render(status) {
    if (!status) return;
    if (status.state === "running") {
      statusEl.textContent = "后端已就绪，正在载入界面…";
      errorEl.style.display = "none";
      spinnerEl.classList.remove("hidden");
    } else if (status.state === "starting" || status.state === "restarting") {
      spinnerEl.classList.remove("hidden");
      const diagnostic = [status.port ? `端口 ${status.port}` : "", status.cwd ? `工作目录: ${status.cwd}` : ""].filter(Boolean).join(" · ");
      statusEl.textContent = "正在启动后端…";
      if (status.logTail?.length) {
        errorEl.style.display = "block";
        errorEl.textContent = `${diagnostic}\n\n--- 后端日志 ---\n${status.logTail.slice(-20).join("\n")}`;
      }
    } else if (status.state === "error") {
      spinnerEl.classList.add("hidden");
      statusEl.textContent = "后端启动失败";
      errorEl.style.display = "block";
      const diagnostic = [status.cwd ? `工作目录: ${status.cwd}` : "", status.launchCommand ? `命令: ${status.launchCommand.join(" ")}` : "", status.launchSource ? `来源: ${status.launchSource}` : "", status.lastExit ? `退出码: ${status.lastExit.code ?? "?"} 信号: ${status.lastExit.signal ?? "无"}` : ""].filter(Boolean).join("\n");
      errorEl.textContent = `${status.error || "未知错误"}${diagnostic ? `\n\n${diagnostic}` : ""}\n\n--- 后端日志（末尾） ---\n${(status.logTail || []).slice(-30).join("\n")}`;
      retryBtn.classList.remove("hidden");
    } else if (status.state === "stopped") {
      statusEl.textContent = "后端已停止";
      errorEl.style.display = "none";
      spinnerEl.classList.add("hidden");
    }
  }

  window.dshDesktop.getStatus().then(render).catch((err) => render({ state: "error", error: err.message }));
  window.dshDesktop.onStatus(render);
  window.dshDesktop.onError(render);
  retryBtn.addEventListener("click", async () => {
    retryBtn.classList.add("hidden");
    errorEl.style.display = "none";
    spinnerEl.classList.remove("hidden");
    statusEl.textContent = "正在重新启动…";
    try { render(await window.dshDesktop.restart()); } catch (err) { render({ state: "error", error: err.message }); }
  });
})();
