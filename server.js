/**
 * NPU 实时监控 + 排队占用管理服务 (Node.js)
 *
 * - 后台每 5 秒 SSH 到各宿主机执行 npu-smi 命令, 解析各卡 HBM / AI Core 占用
 * - 维护每台设备的排队占用列表 (未来一周, 过期自动删除, 落盘持久化)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Client } = require("ssh2");

const BASE_DIR = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "config.json"), "utf-8"));
const DATA_DIR = path.join(BASE_DIR, "data");
const QUEUE_FILE = path.join(DATA_DIR, "queue.json");
const ANN_FILE = path.join(DATA_DIR, "announcements.json");

const POLL_INTERVAL = 5 * 1000; // NPU 状态轮询间隔
const MAX_FUTURE_DAYS = 7;      // 只能排未来一周

const HOSTS = {};
for (const h of CONFIG.hosts || []) HOSTS[h.name] = h;

// ---------------------------------------------------------------- 工具函数

function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function isValidLocalDT(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !isNaN(new Date(s).getTime());
}

// ---------------------------------------------------------------- npu-smi 输出解析

/**
 * 解析 npu-smi 表格输出, 提取每张卡的 AI Core(%) 和 HBM 用量(MB).
 * 兼容任意表头含 AICore / HBM 关键字的表格, 如:
 *   | NPU-ID | AICore(%) | HBM-Usage(MB) |
 *   | 0      | 12        | 703 / 32768   |
 */
function parseNpuTable(text) {
  const lines = text.split("\n").filter((l) => l.trim().startsWith("|"));
  let header = null, headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split("|").slice(1, -1).map((c) => c.trim());
    const joined = cols.join(" ").toLowerCase();
    if (joined.includes("aicore") || joined.includes("hbm")) {
      header = cols.map((c) => c.toLowerCase());
      headerIdx = i;
      break;
    }
  }
  if (!header) return null;

  const chips = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!cols.length || !/^\d+$/.test(cols[0])) continue;
    const chip = { id: parseInt(cols[0], 10), aicore: null, hbm_used: null, hbm_total: null };
    for (let j = 1; j < header.length && j < cols.length; j++) {
      if (header[j].includes("aicore")) {
        const m = cols[j].match(/[\d.]+/);
        chip.aicore = m ? parseFloat(m[0]) : 0;
      } else if (header[j].includes("hbm") || header[j].includes("memory")) {
        const nums = cols[j].match(/[\d.]+/g) || [];
        if (nums.length) {
          chip.hbm_used = parseFloat(nums[0]);
          if (nums.length > 1) chip.hbm_total = parseFloat(nums[1]);
        }
      }
    }
    if (chip.aicore !== null || chip.hbm_used !== null) chips.push(chip);
  }
  return chips.length ? chips : null;
}

// ---------------------------------------------------------------- NPU 状态采集

const status = {};
for (const name of Object.keys(HOSTS)) {
  status[name] = { connected: false, error: null, chips: [], raw: "", updated_at: null };
}

function pollHost(name) {
  const cfg = HOSTS[name];
  return new Promise((resolve) => {
    let settled = false;
    const conn = new Client();
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch (_) { /* ignore */ }
      status[name] = { ...result, updated_at: nowIso() };
      resolve();
    };
    const timer = setTimeout(() => done({ connected: false, error: "连接超时", chips: [], raw: "" }), 12000);
    conn
      .on("ready", () => {
        conn.exec(cfg.command || "npu-smi info -t 5", (err, stream) => {
          if (err) return done({ connected: false, error: String(err), chips: [], raw: "" });
          let out = "", errOut = "";
          stream.on("data", (d) => (out += d.toString("utf-8")));
          stream.stderr.on("data", (d) => (errOut += d.toString("utf-8")));
          stream.on("close", () => {
            const chips = parseNpuTable(out);
            if (chips) done({ connected: true, error: null, chips, raw: out });
            else done({ connected: true, error: "解析失败(无法识别 npu-smi 输出)", chips: [], raw: (out + "\n" + errOut).trim() });
          });
        });
      })
      .on("error", (e) => done({ connected: false, error: String(e), chips: [], raw: "" }))
      .connect({
        host: cfg.host,
        port: cfg.port || 22,
        username: cfg.username,
        readyTimeout: 8000,
        ...(cfg.key_path
          ? { privateKey: fs.readFileSync(cfg.key_path) }
          : { password: cfg.password || "" }),
      });
  });
}

function pollAll() {
  Promise.all(Object.keys(HOSTS).map(pollHost)).catch(() => { /* 单机失败已在 status 中标记 */ });
}
pollAll();
setInterval(pollAll, POLL_INTERVAL);

// ---------------------------------------------------------------- 排队占用管理

function loadQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  } catch (_) {
    return [];
  }
}

function saveQueue(q) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2), "utf-8");
}

/** 删除超过结束时间的占用 */
function cleanup(q) {
  const now = Date.now();
  const kept = q.filter((e) => new Date(e.end).getTime() >= now);
  if (kept.length !== q.length) saveQueue(kept);
  return kept;
}

function getQueue() {
  return cleanup(loadQueue());
}

/** 解析卡范围文本, 返回卡号数组; 返回 null 表示全部/无法解析(保守视为全部) */
function parseCards(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t || ["all", "*", "全部", "所有"].includes(t)) return null;
  const cards = new Set();
  for (const part of t.split(/[,，;；\s]+/)) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) {
      for (let i = +m[1]; i <= +m[2]; i++) cards.add(i);
    } else if (/^\d+$/.test(part)) {
      cards.add(parseInt(part, 10));
    } else {
      return null;
    }
  }
  return [...cards];
}

/** 两请求时间与卡范围是否重叠 */
function overlap(a, b) {
  if (a.host !== b.host) return false;
  if (!(new Date(a.start) < new Date(b.end) && new Date(b.start) < new Date(a.end))) return false;
  const ca = parseCards(a.cards), cb = parseCards(b.cards);
  if (!ca || !cb) return true;
  return ca.some((c) => cb.includes(c));
}

// ---------------------------------------------------------------- 公告栏

function loadAnn() {
  try {
    return JSON.parse(fs.readFileSync(ANN_FILE, "utf-8"));
  } catch (_) {
    return {};
  }
}

function saveAnn(a) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ANN_FILE, JSON.stringify(a, null, 2), "utf-8");
}

// ---------------------------------------------------------------- HTTP 服务

const app = express();
app.use(express.json());
app.use("/static", express.static(path.join(BASE_DIR, "static")));

app.get("/api/announcements", (_req, res) => res.json(loadAnn()));

app.put("/api/announcements/:host", (req, res) => {
  if (!HOSTS[req.params.host]) return res.status(400).json({ detail: `未知设备: ${req.params.host}` });
  const text = String((req.body || {}).text || "").trim();
  const a = loadAnn();
  if (text) a[req.params.host] = text;
  else delete a[req.params.host];
  saveAnn(a);
  res.json({ ok: true, announcements: a });
});

app.get("/", (_req, res) => res.sendFile(path.join(BASE_DIR, "static", "index.html")));

app.get("/api/hosts", (_req, res) => {
  const hosts = {};
  for (const [name, s] of Object.entries(status)) {
    hosts[name] = {
      connected: s.connected,
      error: s.error,
      chips: s.chips,
      updated_at: s.updated_at,
      raw: s.connected && !s.error ? "" : String(s.raw || "").slice(-2000),
    };
  }
  res.json({ now: nowIso(), hosts });
});

app.get("/api/queue", (_req, res) => {
  const now = Date.now();
  const queue = getQueue()
    .map((e) => ({
      ...e,
      active: new Date(e.start).getTime() <= now && now < new Date(e.end).getTime(),
    }))
    .sort((a, b) => (a.host === b.host ? a.start.localeCompare(b.start) : a.host.localeCompare(b.host)));
  res.json({ now: nowIso(), queue });
});

app.post("/api/queue", (req, res) => {
  const { host, cards, start, end, owner } = req.body || {};
  if (!HOSTS[host]) return res.status(400).json({ detail: `未知设备: ${host}` });
  if (!String(owner || "").trim()) return res.status(400).json({ detail: "请填写占用人" });
  if (!isValidLocalDT(start) || !isValidLocalDT(end)) return res.status(400).json({ detail: "时间格式错误" });

  const s = new Date(start), e = new Date(end), now = new Date();
  if (s >= e) return res.status(400).json({ detail: "开始时间必须早于结束时间" });
  if (e <= now) return res.status(400).json({ detail: "结束时间已过期" });
  if (e > new Date(now.getTime() + MAX_FUTURE_DAYS * 86400000)) {
    return res.status(400).json({ detail: `只能排未来 ${MAX_FUTURE_DAYS} 天内的占用` });
  }

  const entry = {
    id: crypto.randomBytes(6).toString("hex"),
    host,
    cards: String(cards || "").trim() || "全部",
    start, end,
    owner: String(owner).trim(),
    created_at: nowIso(),
  };
  const q = getQueue();
  const overlaps = q.filter((o) => overlap(entry, o));
  q.push(entry);
  saveQueue(q);
  res.json({ entry, overlaps });
});

app.delete("/api/queue/:id", (req, res) => {
  const q = getQueue();
  const kept = q.filter((e) => e.id !== req.params.id);
  if (kept.length === q.length) return res.status(404).json({ detail: "记录不存在" });
  saveQueue(kept);
  res.json({ ok: true });
});

const PORT = CONFIG.port || 8000;
app.listen(PORT, () => {
  console.log(`NPU monitor 已启动: http://localhost:${PORT}`);
});
