/*
 * 设置页脚本。必须保持为独立文件，配合 settings.html 的 CSP 禁止内联脚本。
 * 所有来自 Profile、备份 manifest 或升级服务的数据在写入 HTML 前都要转义。
 */
(() => {
  "use strict";

  const dsh = window.dshDesktop;
  const byId = (id) => document.getElementById(id);

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toast(message, duration = 3000) {
    const el = byId("toast");
    el.textContent = String(message ?? "");
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), duration);
  }

  function errorMessage(err) {
    return err && err.message ? err.message : String(err || "未知错误");
  }

  function badgeClass(status) {
    if (status === "up-to-date" || status === "ok" || status === "healthy") return "ok";
    if (status === "update-available") return "info";
    if (status === "warning" || status === "stub") return "warn";
    return "err";
  }

  async function loadBackups() {
    const el = byId("backup-list");
    try {
      const list = await dsh.backup.list();
      if (!list.length) {
        el.innerHTML = '<div class="empty">暂无备份</div>';
        return;
      }
      el.innerHTML = list.map((item) => {
        const id = esc(item.id);
        const note = item.note ? `<span class="badge info">${esc(item.note)}</span>` : "";
        return `<div class="backup-item"><div><strong>${id}</strong> ${note}<div class="backup-meta">DSH ${esc(item.dshVersion || "?")} · ${Number(item.files?.length) || 0} 个文件</div></div><div class="backup-actions"><button class="btn" data-action="backup-diff" data-id="${id}">对比</button><button class="btn primary" data-action="backup-restore" data-id="${id}">恢复</button><button class="btn danger" data-action="backup-delete" data-id="${id}">删除</button></div></div>`;
      }).join("");
    } catch (err) {
      el.textContent = `备份列表加载失败：${errorMessage(err)}`;
    }
  }

  async function restoreBackup(id) {
    if (!confirm(`确定恢复备份 ${id}？当前配置会被覆盖（会先自动备份）。`)) return;
    try {
      const result = await dsh.backup.restore(id);
      toast(`已恢复（恢复前备份: ${result.beforeBackupId}）`);
      await loadBackups();
    } catch (err) {
      toast(`恢复失败：${errorMessage(err)}`, 5000);
    }
  }

  async function diffBackup(id) {
    try {
      const diff = await dsh.backup.diff(id);
      if (diff.identical) {
        toast("当前状态与备份完全一致");
        return;
      }
      const lines = Object.entries(diff.diffs).map(([file, info]) =>
        `${file}: 备份 ${info.backupHash} (${info.backupSize}B) ≠ 当前 ${info.currentHash} (${info.currentSize}B)`
      );
      alert(`差异（${Object.keys(diff.diffs).length} 个文件）：\n\n${lines.join("\n")}`);
    } catch (err) {
      toast(`对比失败：${errorMessage(err)}`, 5000);
    }
  }

  async function deleteBackup(id) {
    if (!confirm(`确定删除备份 ${id}？`)) return;
    try {
      await dsh.backup.delete(id);
      toast("已删除");
      await loadBackups();
    } catch (err) {
      toast(`删除失败：${errorMessage(err)}`, 5000);
    }
  }

  async function loadCrash() {
    const el = byId("crash-status");
    try {
      const diag = await dsh.crash.diagnose();
      let html = `<div class="status-card"><span>上次退出：</span><span class="badge ${diag.uncleanExit ? "warn" : "ok"}">${diag.uncleanExit ? "异常" : "正常"}</span>&nbsp;&nbsp;<span>连续崩溃：</span><span class="badge ${diag.crashCount >= 3 ? "err" : "ok"}">${Number(diag.crashCount) || 0} 次</span>${diag.lastKnownGood ? `<br><span style="color:#8b949e;">上次成功启动: ${esc(diag.lastKnownGood)}</span>` : ""}</div>`;
      for (const issue of diag.issues || []) {
        html += `<div class="status-card"><span class="badge ${issue.level === "error" ? "err" : "warn"}">${esc(issue.level)}</span> ${esc(issue.message)}<br><span style="color:#8b949e;">${esc(issue.action)}</span></div>`;
      }
      html += '<div class="row" style="margin-top:14px;"><button class="btn" data-action="crash-mark-clean">标记退出正常</button><button class="btn primary" data-action="profile-check">Profile 健康检查</button><button class="btn" data-action="profile-resync">修复插件依赖</button><button class="btn danger" data-action="profile-reset">重置 Profile</button></div>';
      el.innerHTML = html;
    } catch (err) {
      el.textContent = `崩溃状态加载失败：${errorMessage(err)}`;
    }
  }

  async function checkProfile() {
    try {
      toast("正在检查 Profile 一致性…");
      const result = await dsh.crash.checkProfile();
      const checks = [
        ["package.json", result.hasPackageJson], ["pnpm-lock.yaml", result.hasLock],
        ["cordis.patch.yml", result.hasPatch], ["node_modules", result.hasNodeModules],
      ].map(([name, ok]) => `${name}: ${ok ? "✅" : "❌"}`).join(" | ");
      let html = `<div class="status-card"><strong>Profile 一致性检查</strong> <span class="badge ${result.healthy ? "ok" : "err"}">${result.healthy ? "健康" : "异常"}</span><br><span style="font-size:12px;color:#8b949e;">${esc(result.profileDir)}</span><br><span style="font-size:12px;">${checks}</span>`;
      if (result.issues?.length) {
        html += '<div style="margin-top:8px;">' + result.issues.map((issue) => `<div class="status-card"><span class="badge ${badgeClass(issue.level)}">${esc(issue.level)}</span> ${esc(issue.msg)}</div>`).join("") + "</div>";
      } else {
        html += '<p style="color:#8b949e;margin-top:8px;font-size:12px;">五项一致性检查全部通过</p>';
      }
      byId("profile-health").innerHTML = `${html}</div>`;
    } catch (err) {
      byId("profile-health").textContent = `Profile 检查失败：${errorMessage(err)}`;
    }
  }

  async function resyncProfile() {
    if (!confirm("将执行 dsh plugin --profile web install 同步插件依赖。确定？")) return;
    try {
      toast("正在同步插件依赖…");
      const result = await dsh.crash.resyncProfile();
      toast(result.message);
      if (!result.resync) alert(`同步失败：\n\n${String(result.output || result.message).slice(-2000)}`);
      await loadCrash();
    } catch (err) {
      toast(`同步失败：${errorMessage(err)}`, 5000);
    }
  }

  async function resetProfile() {
    if (!confirm("将重置 DSH Profile（备份当前状态后删除，下次启动重装依赖）。确定？")) return;
    try {
      const result = await dsh.crash.resetProfile();
      if (result && result.reset === false) {
        toast(`重置失败：${result.error || "未知错误"}`, 5000);
        return;
      }
      toast(`Profile 已重置（备份: ${result.backupId}）`);
      await loadCrash();
    } catch (err) {
      toast(`重置失败：${errorMessage(err)}`, 5000);
    }
  }

  async function loadConfig() {
    try {
      const cfg = await dsh.getConfig();
      byId("cfg-gpuMode").value = cfg.gpuMode ?? "null";
      byId("cfg-port").value = cfg.port ?? 0;
      byId("cfg-host").value = cfg.host ?? "127.0.0.1";
      byId("cfg-keepRunning").checked = Boolean(cfg.keepBackendRunning);
      byId("cfg-reuseDsh").checked = Boolean(cfg.reuseExistingDsh);
      byId("cfg-openBrowserOnCrash").checked = cfg.openBrowserOnCrash !== false;
    } catch (err) {
      byId("config-status").textContent = `加载失败：${errorMessage(err)}`;
    }
  }

  async function saveConfig() {
    const rawPort = byId("cfg-port").value.trim();
    const port = rawPort === "" ? 0 : Number(rawPort);
    const patch = {
      gpuMode: byId("cfg-gpuMode").value === "null" ? null : byId("cfg-gpuMode").value,
      port,
      host: byId("cfg-host").value.trim() || "127.0.0.1",
      keepBackendRunning: byId("cfg-keepRunning").checked,
      reuseExistingDsh: byId("cfg-reuseDsh").checked,
      openBrowserOnCrash: byId("cfg-openBrowserOnCrash").checked,
    };
    try {
      await dsh.setConfig(patch);
      byId("config-status").textContent = "已保存";
      toast("设置已保存");
    } catch (err) {
      byId("config-status").textContent = `保存失败：${errorMessage(err)}`;
    }
  }

  async function loadAbout() {
    const el = byId("about-info");
    try {
      const versions = await dsh.getVersions();
      const results = await Promise.all(["app", "backend", "profile"].map(async (track) => {
        try { return [track, await dsh.upgrade.check(track)]; } catch { return [track, null]; }
      }));
      const labels = { app: "桌面应用", backend: "DSH 后端", profile: "Profile bundles" };
      const upgrades = results.map(([track, result]) => result
        ? `<p>${labels[track]}: <span class="badge ${badgeClass(result.status)}">${esc(result.status)}</span> ${esc(result.message || result.reason || "")}</p>`
        : `<p>${labels[track]}: <span class="badge err">检查失败</span></p>`).join("");
      el.innerHTML = `<p><strong>DeepSeek Harness Desktop</strong></p><p>应用版本: ${esc(versions.app)} · Electron ${esc(versions.electron ?? "?")} · Node ${esc(versions.node)}</p><p>DSH 后端: ${esc(versions.dsh ?? "未连接")}</p><div style="margin-top:12px;border-top:1px solid #30363d;padding-top:10px;"><p style="font-weight:600;margin-bottom:6px;">升级状态</p>${upgrades}</div><p style="margin-top:10px;color:#8b949e;font-size:12px;">DSH 本体未做改动，由本应用托管。</p>`;
    } catch (err) {
      el.textContent = `版本信息加载失败：${errorMessage(err)}`;
    }
  }

  async function loadUpgrade() {
    const el = byId("upgrade-status");
    const tracks = [
      ["app", "桌面应用", "应用自身更新（需配置 electron-builder publish）"],
      ["backend", "DSH 后端", "@deepseek-ai/dsh npm 包更新"],
      ["profile", "Profile bundles", "已安装 bundle 依赖的版本更新"],
    ];
    const cards = await Promise.all(tracks.map(async ([track, label, description]) => {
      try {
        const result = await dsh.upgrade.check(track);
        const detail = result.status === "update-available" && result.bundles?.length
          ? result.bundles.map((bundle) => `${esc(bundle.name)}: ${esc(bundle.current)} → ${esc(bundle.latest)}`).join(", ")
          : esc(result.message || result.reason || "");
        const action = result.status === "update-available" && track === "profile"
          ? '<button class="btn primary" style="margin-top:8px;" data-action="profile-upgrade">更新 Profile bundles</button>' : "";
        return `<div class="status-card"><strong>${label}</strong> <span class="badge ${badgeClass(result.status)}">${esc(result.status)}</span><div style="font-size:12px;color:#8b949e;margin-top:4px;">${description}</div>${detail ? `<div style="font-size:12px;margin-top:4px;">${detail}</div>` : ""}${action}</div>`;
      } catch {
        return `<div class="status-card"><strong>${label}</strong> <span class="badge err">检查失败</span></div>`;
      }
    }));
    el.innerHTML = cards.join("");
    byId("upgrade-status-msg").textContent = "";
  }

  async function applyProfileUpgrade() {
    byId("upgrade-status-msg").textContent = "正在更新…";
    try {
      const result = await dsh.upgrade.apply("profile");
      toast(result.message || "操作完成");
      await loadUpgrade();
    } catch (err) {
      byId("upgrade-status-msg").textContent = `更新失败：${errorMessage(err)}`;
    }
  }

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    byId(`panel-${tab.dataset.tab}`).classList.add("active");
  }));

  byId("btn-create-backup").addEventListener("click", async () => {
    try {
      const note = byId("backup-note").value.trim();
      await dsh.backup.create(note || null);
      byId("backup-note").value = "";
      toast("备份已创建");
      await loadBackups();
    } catch (err) {
      toast(`备份失败：${errorMessage(err)}`, 5000);
    }
  });
  byId("btn-save-config").addEventListener("click", saveConfig);
  byId("btn-check-upgrade").addEventListener("click", async () => {
    byId("upgrade-status-msg").textContent = "检查中…";
    await loadUpgrade();
  });
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const { action, id } = target.dataset;
    if (action === "backup-diff") await diffBackup(id);
    else if (action === "backup-restore") await restoreBackup(id);
    else if (action === "backup-delete") await deleteBackup(id);
    else if (action === "crash-mark-clean") { await dsh.crash.markClean(); toast("已标记为正常退出"); await loadCrash(); }
    else if (action === "profile-check") await checkProfile();
    else if (action === "profile-resync") await resyncProfile();
    else if (action === "profile-reset") await resetProfile();
    else if (action === "profile-upgrade") await applyProfileUpgrade();
  });

  void loadBackups();
  void loadCrash();
  void loadUpgrade();
  void loadConfig();
  void loadAbout();
})();
