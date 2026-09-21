/**
 * Canvas Weekly Hub · 轻量代理与提醒 Worker
 *
 * 学生自部署到自己的 Cloudflare 账号（免费）：
 *   - /proxy/*          无状态转发 Canvas API（令牌经请求头传入，不存储）
 *   - /setup (POST)     保存订阅配置到 KV（仅学生自己的空间）：{secret, token, sendkey}
 *   - /ics?secret=      动态生成截止日历 ICS（日历 App 订阅一次，永久自动更新）
 *   - scheduled (Cron)  每日定时抓取，通过 Server酱 推送微信提醒（配置了 SendKey 才启用）
 *
 * 隐私：所有数据只存在学生自己的 Cloudflare KV 里；本 Worker 不含任何固定令牌。
 * CORS：允许任意来源（页面可能部署在 github.io 或本地文件），安全由“令牌只在学生
 *       自己的 Worker 与浏览器之间流转”保证。
 */

const CANVAS_HOST_DEFAULT = "canvas.cityu.edu.hk";
// Instructure/学校边缘防护会拦截"非浏览器"特征请求（403），带上常规浏览器 UA 可显著降低被拦概率
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DAYS_AHEAD = 7;          // 微信提醒覆盖的未来天数
const ICS_DAYS_AHEAD = 60;     // 日历订阅覆盖的未来天数
const HK = 8 * 3600;           // 展示时区 UTC+8（秒）

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Canvas-Token, X-Canvas-Host",
  "Access-Control-Max-Age": "86400",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function text(body, type = "text/calendar; charset=utf-8") {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": type, ...CORS, "Cache-Control": "max-age=1800" },
  });
}

/* ---------------- Canvas 抓取 ---------------- */

function hkNow() {
  return new Date(Date.now() + HK);
}

function parseTs(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function fmtHK(d) {
  if (!d) return "无截止时间";
  const t = new Date(d.getTime() + HK);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
         `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

async function canvasAll(host, token, path, params = {}) {
  const base = `https://${host}/api/v1/${path.replace(/^\/+/, "")}`;
  let page = 1, out = [];
  for (;;) {
    const qs = new URLSearchParams({ ...params, per_page: "100", page: String(page) });
    const r = await fetch(`${base}?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
                 "User-Agent": BROWSER_UA },
    });
    if (r.status === 401) throw new Error("令牌无效或已过期（HTTP 401）");
    if (!r.ok) throw new Error(`Canvas API HTTP ${r.status} @ ${path}`);
    const arr = await r.json();
    out = out.concat(Array.isArray(arr) ? arr : [arr]);
    if (!Array.isArray(arr) || arr.length < 100 || page >= 20) break;
    page += 1;
  }
  return out;
}

async function collectData(host, token) {
  const courses = await canvasAll(host, token, "courses", {
    enrollment_state: "active", "include[]": "term",
  });
  const out = [];
  for (const c of courses) {
    const [assignments, files, announcements] = await Promise.all([
      canvasAll(host, token, `courses/${c.id}/assignments`,
                { order_by: "due_at", "include[]": "submission" }).catch(() => []),
      canvasAll(host, token, `courses/${c.id}/files`,
                { sort: "created_at", order: "desc" }).catch(() => []),
      canvasAll(host, token, `courses/${c.id}/announcements`, {}).catch(() => []),
    ]);
    out.push({ course: c, assignments, files, announcements });
  }
  return out;
}

function upcomingItems(raw, daysAhead) {
  const now = Date.now();
  const end = now + daysAhead * 86400000;
  const items = [];
  for (const { course, assignments } of raw) {
    for (const a of assignments) {
      const due = parseTs(a.due_at);
      const sub = a.submission || {};
      if (!due || due.getTime() < now || due.getTime() > end) continue;
      items.push({
        course: course.name || "", code: course.course_code || "",
        name: a.name || "未命名任务", due: a.due_at, points: a.points_possible,
        url: a.html_url || "",
        submitted: ["submitted", "graded", "pending_review"].includes(sub.workflow_state),
        graded: sub.workflow_state === "graded",
      });
    }
  }
  items.sort((x, y) => new Date(x.due) - new Date(y.due));
  return items;
}

/* ---------------- ICS 生成 ---------------- */

function icsEscape(s) {
  return (s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;")
    .replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function buildIcs(raw, daysAhead) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const end = now.getTime() + daysAhead * 86400000;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0",
    "PRODID:-//canvas-weekly-hub//deadline-subscription//CN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Canvas 截止日历"];
  let count = 0;
  for (const { course, assignments } of raw) {
    const seen = new Set();
    for (const a of assignments) {
      const due = parseTs(a.due_at);
      if (!due || due.getTime() < now.getTime() || due.getTime() > end) continue;
      const key = (a.html_url || "") + "|" + (a.name || "");
      if (seen.has(key)) continue;
      seen.add(key);
      const z = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
      const sub = a.submission || {};
      const mark = sub.workflow_state === "graded" ? "（已评分）"
        : ["submitted", "pending_review"].includes(sub.workflow_state) ? "（已提交）" : "";
      lines.push("BEGIN:VEVENT",
        `UID:${(a.id || count) + "-" + course.id}@canvas-weekly-hub`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${z(due)}`,
        `DTEND:${z(new Date(due.getTime() + 15 * 60000))}`,
        `SUMMARY:${icsEscape(`[${course.course_code || course.name}] ${a.name}${mark}`)}`,
        `DESCRIPTION:${icsEscape(a.html_url || "")}`,
        "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY",
        `DESCRIPTION:${icsEscape(a.name || "")}`, "END:VALARM",
        "END:VEVENT");
      count += 1;
    }
  }
  lines.push("END:VCALENDAR");
  return { body: lines.join("\r\n") + "\r\n", count };
}

/* ---------------- 快照对比（变化检测） ---------------- */

function snapshotOf(raw) {
  const snap = {};
  for (const { course, assignments } of raw) {
    const m = {};
    for (const a of assignments) {
      m[String(a.id)] = { name: a.name || "", due: a.due_at || null,
                          wf: (a.submission || {}).workflow_state || null };
    }
    snap[String(course.id)] = m;
  }
  return snap;
}

function diffSnapshots(prev, curr) {
  const changes = [];
  for (const [cid, items] of Object.entries(curr)) {
    const prevItems = (prev && prev.assignments && prev.assignments[cid]) || {};
    for (const [aid, cur] of Object.entries(items)) {
      const old = prevItems[aid];
      if (!old) continue;
      if (old.due && old.due !== cur.due) {
        changes.push({ type: "改期", name: cur.name,
          detail: `截止时间 ${fmtHK(parse_ts_safe(old.due))} → ${fmtHK(parse_ts_safe(cur.due))}` });
      }
      if (old.wf !== "graded" && cur.wf === "graded") {
        changes.push({ type: "新评分", name: cur.name, detail: "作业已出分，去 Canvas 查看" });
      }
    }
    for (const [aid, old] of Object.entries(prevItems)) {
      if (!items[aid]) {
        changes.push({ type: "移除", name: old.name || aid, detail: "作业已删除或被隐藏" });
      }
    }
  }
  return changes;
}

function parse_ts_safe(s) {
  try { return new Date(s); } catch (e) { return null; }
}

/* ---------------- Server酱 推送 ---------------- */

async function serverchan(sendkey, title, desp) {
  const body = new URLSearchParams({ title, desp });
  const r = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(sendkey)}.send`,
                        { method: "POST", body });
  return r.ok;
}

/* ---------------- 路由 ---------------- */

async function handleProxy(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/proxy\/?/, "");
  if (!path) return json({ error: "缺少 API 路径，例如 /proxy/courses" }, 400);
  const token = request.headers.get("X-Canvas-Token") || "";
  const host = request.headers.get("X-Canvas-Host") || env.CANVAS_HOST || CANVAS_HOST_DEFAULT;
  const target = `https://${host}/api/v1/${path}${url.search}`;
  const r = await fetch(target, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
               "User-Agent": BROWSER_UA },
  });
  return new Response(r.body, {
    status: r.status,
    headers: { "Content-Type": r.headers.get("Content-Type") || "application/json; charset=utf-8", ...CORS },
  });
}

async function handleSetup(request, env) {
  if (!env.HUB_KV) return json({ error: "未绑定 KV 存储，无法启用订阅（部署时勾选 KV）" }, 501);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "请求体不是合法 JSON" }, 400); }
  const secret = String(body.secret || "");
  const token = String(body.token || "");
  if (secret.length < 16) return json({ error: "订阅密钥太短（至少 16 位随机字符）" }, 400);
  if (!token) return json({ error: "缺少令牌" }, 400);
  await env.HUB_KV.put(`cfg:${secret}`, JSON.stringify({
    token, sendkey: String(body.sendkey || ""), host: String(body.host || ""),
    updated: new Date().toISOString(),
  }));
  const origin = new URL(request.url).origin;
  return json({ ok: true, icsUrl: `${origin}/ics?secret=${secret}` });
}

async function handleIcs(request, env) {
  if (!env.HUB_KV) return json({ error: "未绑定 KV 存储" }, 501);
  const secret = new URL(request.url).searchParams.get("secret") || "";
  if (secret.length < 16) return json({ error: "密钥无效" }, 400);
  const raw = await env.HUB_KV.get(`cfg:${secret}`);
  if (!raw) return json({ error: "订阅不存在，请先在页面里保存配置" }, 404);
  const cfg = JSON.parse(raw);
  const raw_data = await collectData(cfg.host || env.CANVAS_HOST || CANVAS_HOST_DEFAULT, cfg.token);
  const { body, count } = buildIcs(raw_data, ICS_DAYS_AHEAD);
  return text(body);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (request.method === "GET" && url.pathname.startsWith("/proxy/")) {
        return await handleProxy(request, env);
      }
      if (request.method === "POST" && url.pathname === "/setup") {
        return await handleSetup(request, env);
      }
      if (request.method === "GET" && url.pathname === "/ics") {
        return await handleIcs(request, env);
      }
      if (url.pathname === "/") {
        return json({ name: "canvas-weekly-hub proxy", ok: true,
                      endpoints: ["/proxy/*", "/setup", "/ics"] });
      }
      return json({ error: "未知路径" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.HUB_KV) return;
    const list = await env.HUB_KV.list({ prefix: "cfg:" });
    for (const key of list.keys) {
      const secret = key.name.replace(/^cfg:/, "");
      try {
        const cfg = JSON.parse(await env.HUB_KV.get(key.name));
        if (!cfg.token || !cfg.sendkey) continue;       // 未配置微信提醒则跳过
        const host = cfg.host || env.CANVAS_HOST || CANVAS_HOST_DEFAULT;
        const raw = await collectData(host, cfg.token);
        const curr = snapshotOf(raw);
        const prevRaw = await env.HUB_KV.get(`snap:${secret}`);
        const prev = prevRaw ? JSON.parse(prevRaw) : null;
        const changes = diffSnapshots(prev, curr);
        const items = upcomingItems(raw, DAYS_AHEAD).filter((i) => !i.submitted);
        if (!items.length && !changes.length) continue;  // 没有值得打扰的内容则静默
        let desp = `### 未来 ${DAYS_AHEAD} 天截止（未提交）\n`;
        desp += items.length ? items.map((i) =>
          `- **${i.name}**（${i.code}）\n  截止：${fmtHK(parse_ts_safe(i.due))} ｜ ${i.points ?? "-"} 分`) .join("\n")
          : "- 无";
        if (changes.length) {
          desp += `\n\n### 与上次相比的变化\n` + changes.map((c) =>
            `- **${c.type}**：${c.name}（${c.detail}）`).join("\n");
        }
        await serverchan(cfg.sendkey,
          `Canvas 提醒：${items.length} 项即将截止，${changes.length} 项变化`, desp);
        await env.HUB_KV.put(`snap:${secret}`, JSON.stringify(curr));
      } catch (e) {
        await env.HUB_KV.put(`err:${secret}:${Date.now()}`,
          JSON.stringify({ error: String(e && e.message || e) }));
      }
    }
  },
};
