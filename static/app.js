/* NPU 监控与排队 - 前端逻辑 */
const $ = (sel) => document.querySelector(sel);

function fmtDT(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toLocalInput(dt) {
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}
/** 解析输入框中的 24 小时制时间 (空格或 T 分隔均可) */
function parseLocalDT(v) {
  return v ? new Date(v.trim().replace(" ", "T")) : new Date(NaN);
}
/** 24 小时制时间 +1 小时 */
function plus1h(v) {
  const d = parseLocalDT(v);
  return isNaN(d.getTime()) ? "" : toLocalInput(new Date(d.getTime() + 3600 * 1000));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function bar(pct, warn = 50, high = 85) {
  const p = Math.max(0, Math.min(100, pct));
  const cls = p >= high ? "high" : p >= warn ? "warn" : "";
  return `<span class="progress ${cls}"><div style="width:${p}%"></div></span> ${p.toFixed(0)}%`;
}

/* ---------------- 状态 ---------------- */
let hostNames = [];   // 顺序固定, 用于渲染
let hostStatus = {};  // name -> status
let queueByHost = {}; // name -> entries
let announcements = {}; // name -> 公告文本

/* ---------------- 设备卡片 ---------------- */

/** 状态表格 + 断连/解析失败信息 */
function statusHTML(s) {
  if (s && s.connected && s.chips.length) {
    const rows = s.chips.map((c) => {
      const hbmPct = c.hbm_total ? (c.hbm_used / c.hbm_total) * 100 : null;
      const hbmCell = hbmPct === null
        ? `${c.hbm_used ?? "-"} MB`
        : `${bar(hbmPct)} <span class="usage-label">(${c.hbm_used}/${c.hbm_total} MB)</span>`;
      return `<tr>
        <td>NPU ${c.id}</td>
        <td class="usage-cell">${bar(c.aicore ?? 0)}</td>
        <td class="usage-cell">${hbmCell}</td>
      </tr>`;
    }).join("");
    return `<table class="chip-table">
        <tr><th>卡</th><th>AI Core</th><th>HBM</th></tr>${rows}
      </table>
      <div class="host-updated">更新于 ${esc(s.updated_at || "-")}</div>`;
  }
  if (s && s.connected) {
    return `<div class="host-err">${esc(s.raw || s.error || "")}</div>`;
  }
  if (s) {
    return `<div class="host-err">${esc(s.error || "连接失败")}</div>`;
  }
  return "";
}

function badgeHTML(s) {
  if (!s) return '<span class="badge warn">加载中</span>';
  if (!s.connected) return '<span class="badge offline">已断连，请联系管理员</span>';
  if (!s.chips.length) return '<span class="badge warn">解析失败</span>';
  return '<span class="badge online">在线</span>';
}

/** 卡片底部的排队列表 */
function queueHTML(name) {
  const items = queueByHost[name] || [];
  if (!items.length) return '<div class="queue-empty">暂无排队</div>';
  return `<ul class="queue-list">${items.map((e) => `
    <li class="${e.active ? "active" : ""}">
      <span class="q-body">
        <span class="q-main">${fmtDT(e.start)} ~ ${fmtDT(e.end)}${e.active ? '<span class="tag-now">占用中</span>' : ""}</span>
        <span class="q-sub">${esc(e.owner)} · 卡 ${esc(e.cards)}</span>
      </span>
      <button class="del-btn" title="删除" data-id="${e.id}">×</button>
    </li>`).join("")}</ul>`;
}

/** 卡片骨架 (含底部表单, 只在设备列表变化时重建, 避免刷新打断输入) */
function hostCardShell(name) {
  const now = new Date();
  return `<div class="host-card" data-host="${esc(name)}">
    <div class="host-head"><span class="host-name">${esc(name)}</span><span class="badge-slot"></span></div>
    <div class="announce" title="双击编辑公告" data-host="${esc(name)}"></div>
    <div class="status-box"></div>
    <div class="queue-title">排队占用</div>
    <div class="queue-box"></div>
    <form class="resv-form" data-host="${esc(name)}">
      <div class="resv-grid">
        <label>卡范围
          <input name="cards" type="text" placeholder="0-3" value="all">
        </label>
        <label>开始时间
          <input name="start" type="text" placeholder="YYYY-MM-DD HH:MM" value="${toLocalInput(now)}" required>
        </label>
        <label>结束时间
          <input name="end" type="text" placeholder="YYYY-MM-DD HH:MM" value="${plus1h(toLocalInput(now))}" required>
        </label>
        <label>占用人
          <input name="owner" type="text" placeholder="你的名字" required>
        </label>
      </div>
      <button type="submit">新增占用</button>
      <div class="form-msg"></div>
    </form>
  </div>`;
}

/** 刷新各卡片的状态/排队内容 (不动表单) */
function updateCards() {
  const box = $("#hosts");
  for (const card of box.querySelectorAll(".host-card")) {
    const name = card.dataset.host;
    const s = hostStatus[name];
    card.classList.toggle("offline", !!(s && (!s.connected || (s.connected && !s.chips.length))));
    card.querySelector(".badge-slot").innerHTML = badgeHTML(s);
    card.querySelector(".status-box").innerHTML = statusHTML(s);
    card.querySelector(".queue-box").innerHTML = queueHTML(name);
    const ann = card.querySelector(".announce");
    if (ann && document.activeElement !== ann) ann.textContent = announcements[name] || "";
  }
  // 绑定删除按钮
  box.querySelectorAll(".del-btn").forEach((b) =>
    b.onclick = async () => {
      await fetch("/api/queue/" + b.dataset.id, { method: "DELETE" });
      refreshQueue();
    });
}

/** 设备列表变化时整体重建 */
function renderHosts() {
  const box = $("#hosts");
  box.innerHTML = hostNames.map(hostCardShell).join("");
  // 开始时间变化时, 结束时间自动 = 开始时间 + 1 小时;
  // 结束时间改到不晚于开始/当前时间时, 视为跨天: 结束日期自动 +1 天(开始时间不变)
  box.querySelectorAll(".resv-form").forEach((form) => {
    const start = form.elements.start, end = form.elements.end;
    start.addEventListener("change", () => { end.value = plus1h(start.value); });
    end.addEventListener("change", () => {
      const s = parseLocalDT(start.value);
      let d = parseLocalDT(end.value);
      if (!end.value || !start.value || isNaN(d) || isNaN(s)) return;
      // 结束不晚于开始 或 不晚于当前时间 时, 视为跨天: 日期 +1 天
      for (let i = 0; i < 8 && (d <= s || d <= new Date()); i++) {
        d = new Date(d.getTime() + 86400000);
      }
      end.value = toLocalInput(d);
    });
  });
  // 公告栏: 双击进入编辑, 失焦或回车保存(空内容=清除)
  box.querySelectorAll(".announce").forEach((el) => {
    el.addEventListener("dblclick", () => {
      el.contentEditable = "true";
      el.focus();
    });
    const save = async () => {
      if (!el.isContentEditable) return;
      el.contentEditable = "false";
      const text = el.textContent.trim();
      el.textContent = text;
      try {
        await fetch("/api/announcements/" + encodeURIComponent(el.dataset.host), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
      } catch { /* 保存失败时保留本地显示 */ }
      refreshAnnouncements();
    };
    el.addEventListener("blur", save);
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); el.blur(); }
      if (ev.key === "Escape") { el.textContent = announcements[el.dataset.host] || ""; el.blur(); }
    });
  });
  // 卡片点击选中: 点击卡片空白区域切换选中态 (表单/按钮/公告等交互元素不触发)
  box.querySelectorAll(".host-card").forEach((card) => {
    card.addEventListener("click", (ev) => {
      if (ev.target.closest("input, button, form, .announce, .del-btn, table, select, textarea")) return;
      const wasSelected = card.classList.contains("selected");
      box.querySelectorAll(".host-card.selected").forEach((c) => c.classList.remove("selected"));
      if (!wasSelected) card.classList.add("selected");
    });
  });
  updateCards();
}

async function refreshHosts() {
  let data;
  try {
    const res = await fetch("/api/hosts");
    data = await res.json();
  } catch {
    $("#refresh-time").textContent = "无法连接服务器";
    return;
  }
  $("#refresh-time").textContent = "更新于 " + data.now;
  hostStatus = data.hosts;
  const names = Object.keys(data.hosts);
  if (names.join("\n") !== hostNames.join("\n")) {
    hostNames = names;
    renderHosts();
  } else {
    updateCards();
  }
}

async function refreshAnnouncements() {
  try {
    announcements = await (await fetch("/api/announcements")).json();
  } catch { return; }
  updateCards();
}

async function refreshQueue() {
  let data;
  try {
    const res = await fetch("/api/queue");
    data = await res.json();
  } catch { return; }
  queueByHost = {};
  for (const e of data.queue) (queueByHost[e.host] ||= []).push(e);
  for (const list of Object.values(queueByHost)) list.sort((a, b) => a.start.localeCompare(b.start));
  updateCards();
}

/* ---------------- 表单提交 (事件委托, 每卡片一份) ---------------- */
function initForm() {
  $("#hosts").addEventListener("submit", async (ev) => {
    const form = ev.target.closest(".resv-form");
    if (!form) return;
    ev.preventDefault();

    const msg = form.querySelector(".form-msg");
    const body = {
      host: form.dataset.host,
      cards: form.elements.cards.value.trim() || "all",
      start: form.elements.start.value.trim().replace(" ", "T"),
      end: form.elements.end.value.trim().replace(" ", "T"),
      owner: form.elements.owner.value.trim(),
    };
    msg.className = "form-msg";
    msg.textContent = "提交中…";
    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        msg.className = "form-msg err";
        msg.textContent = "失败: " + (data.detail || res.status);
        return;
      }
      if (data.overlaps.length) {
        msg.className = "form-msg warn";
        msg.textContent = "已提交，但与以下占用存在重叠，请自行协调:\n" +
          data.overlaps.map((o) => `  ${fmtDT(o.start)} ~ ${fmtDT(o.end)} ${o.owner} (卡 ${o.cards})`).join("\n");
      } else {
        msg.className = "form-msg ok";
        msg.textContent = "提交成功";
      }
      refreshQueue();
    } catch (e) {
      msg.className = "form-msg err";
      msg.textContent = "提交失败: " + e;
    }
  });
}

/* ---------------- 启动 ---------------- */
initForm();
refreshHosts();
refreshQueue();
refreshAnnouncements();
setInterval(refreshHosts, 5000);
setInterval(refreshQueue, 10000);
setInterval(refreshAnnouncements, 10000);

/* ---------------- 底部大时钟 ---------------- */
function updateBigClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const el = $("#big-clock");
  if (el) el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}`;
}
updateBigClock();
setInterval(updateBigClock, 10000);
