/* ===== 网页版扩展：设置向导 + 抓取 + 导出（由 web/build_web.py 注入 web/index.html） ===== */
/* 依赖主脚本中的全局：$、esc、boot、render、DATA、buildIcsText（本文件提供） */

const WEBSITE_FILE = "我的学习网站.html";

const HUB_STORE = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

function hubCfg() {
  return {
    worker: (HUB_STORE.get("hubWorker") || "").trim(),
    canvasUrl: (HUB_STORE.get("hubCanvasUrl") || "https://canvas.cityu.edu.hk").trim(),
    token: (HUB_STORE.get("hubToken") || "").trim(),
    expires: (HUB_STORE.get("hubExpires") || "").trim(),
    sendkey: (HUB_STORE.get("hubSendKey") || "").trim(),
    secret: (HUB_STORE.get("hubSecret") || "").trim(),
  };
}

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return "canvas.cityu.edu.hk"; }
}

function tzLabel() {
  const off = -new Date().getTimezoneOffset() / 60;
  return "UTC" + (off >= 0 ? "+" : "") + off;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ---------------- Canvas 抓取（经学生自己的 Worker 转发） ---------------- */

function workerApi(path, params) {
  const c = hubCfg();
  if (!c.worker) throw new Error("请先填写 Worker 地址（第①项）");
  const u = c.worker.replace(/\/+$/, "") + "/proxy/" + path.replace(/^\/+/, "");
  const qs = new URLSearchParams(params || {});
  return fetch(u + "?" + qs, {
    headers: { "X-Canvas-Token": c.token, "X-Canvas-Host": hostOf(c.canvasUrl) },
  }).then(async (r) => {
    if (r.status === 401) throw new Error("令牌无效或已过期（HTTP 401）：请到 Canvas 重新生成");
    if (r.status === 403) throw new Error("Canvas 拒绝访问（HTTP 403）：确认令牌属于你自己");
    if (!r.ok) throw new Error("Canvas API HTTP " + r.status + " @ " + path);
    return r.json();
  });
}

async function apiAll(path, params) {
  let page = 1, out = [];
  for (;;) {
    const arr = await workerApi(path, Object.assign({}, params || {}, { per_page: 100, page: page }));
    out = out.concat(Array.isArray(arr) ? arr : [arr]);
    if (!Array.isArray(arr) || arr.length < 100 || page >= 20) break;
    page += 1;
  }
  return out;
}

/* ---------------- 类型判断（与桌面引擎一致） ---------------- */

function assignKind(a) {
  const t = a.submission_types || [];
  if (a.is_quiz_assignment || a.quiz_id || t.includes("online_quiz")) return "测验";
  if (t.includes("discussion_topic")) return "讨论";
  if (t.includes("online_upload") || t.includes("online_text_entry") || t.includes("online_url")) return "提交作业";
  if (t.includes("external_tool")) return "外部工具";
  if (t.includes("not_graded")) return "不计分";
  return "任务";
}

function fileKind(name) {
  const n = (name || "").toLowerCase();
  if (/\.(ppt|pptx|key)$/.test(n)) return "PPT";
  if (/\.pdf$/.test(n)) return "PDF";
  if (/\.(doc|docx|rtf)$/.test(n)) return "Word";
  if (/\.(xls|xlsx|csv)$/.test(n)) return "Excel";
  if (/\.(zip|rar|7z|tar|gz)$/.test(n)) return "压缩包";
  if (/\.(py|ipynb|java|c|cpp|h|m|r|sql)$/.test(n)) return "代码";
  if (/\.(mp4|mov|avi|mkv)$/.test(n)) return "视频";
  return "其他";
}

/* ---------------- 抓取并生成看板 ---------------- */

async function fetchAll() {
  const cfg = hubCfg();
  if (!cfg.token) throw new Error("请先填写访问令牌");
  const courses = await apiAll("courses", { enrollment_state: "active", "include[]": "term" });

  let lastState = null;
  try { lastState = JSON.parse(HUB_STORE.get("hubLastState") || "null"); } catch (e) {}
  const newState = { assignments: {} };

  const now = new Date();
  const lookbackStart = new Date(now.getTime() - 7 * 86400000);
  const upcomingEnd = new Date(now.getTime() + 7 * 86400000);

  const weekCourses = [];
  for (const c of courses) {
    const cid = String(c.id);
    const name = c.name || ("课程" + cid);
    const code = c.course_code || "";
    const term = (c.term || {}).name || "";
    const [assignments, files, anns] = await Promise.all([
      apiAll("courses/" + cid + "/assignments", { order_by: "due_at", "include[]": "submission" })
        .catch(() => []),
      apiAll("courses/" + cid + "/files", { sort: "created_at", order: "desc" }).catch(() => []),
      apiAll("courses/" + cid + "/announcements", {}).catch(() => []),
    ]);

    const courseState = {};
    const prevCourse = (lastState && lastState.assignments && lastState.assignments[cid]) || {};
    const changes = [];
    const newAssignments = [], upcoming = [];

    for (const a of assignments) {
      const sub = a.submission || {};
      const wf = sub.workflow_state;
      const submitted = ["submitted", "graded", "pending_review"].includes(wf);
      const graded = wf === "graded";
      const created = parseTs(a.created_at), updated = parseTs(a.updated_at), due = parseTs(a.due_at);
      const isNew = !!(created && created >= lookbackStart);
      const isUpdated = !isNew && !!(updated && updated >= lookbackStart);
      const aid = String(a.id);
      courseState[aid] = { name: a.name || "", due_iso: due ? due.toISOString() : null, wf: wf };
      const prev = prevCourse[aid];
      if (prev) {
        if (prev.due_iso && prev.due_iso !== courseState[aid].due_iso) {
          changes.push({ type: "改期", name: a.name || "未命名任务",
            detail: "截止时间 " + fmtPrev(prev.due_iso) + " → " + fmtLocal(due) });
        }
        if (prev.wf !== "graded" && graded) {
          changes.push({ type: "新评分", name: a.name || "未命名任务",
            detail: "已评分：" + (sub.score ?? "-") + " / " + (a.points_possible ?? "-") + " 分" });
        }
      }
      const isDueSoon = !!(due && due >= now && due <= upcomingEnd);
      if (!isNew && !isUpdated && !isDueSoon) continue;
      const item = {
        name: a.name || "未命名任务", kind: assignKind(a),
        due_at: due ? fmtLocal(due) : "无截止时间",
        due_iso: due ? due.toISOString() : null,
        points: a.points_possible, url: a.html_url || "",
        status: isNew ? "新布置" : (isUpdated ? "有更新" : null),
        submitted: submitted, graded: graded, score: sub.score,
      };
      if (isNew || isUpdated) newAssignments.push(item);
      if (isDueSoon) upcoming.push(Object.assign({}, item));
    }
    for (const aid of Object.keys(prevCourse)) {
      if (!courseState[aid]) {
        changes.push({ type: "移除", name: prevCourse[aid].name || aid, detail: "作业已删除或被隐藏" });
      }
    }
    newState.assignments[cid] = courseState;

    const newFiles = [];
    const filesPage = cfg.canvasUrl.replace(/\/+$/, "") + "/courses/" + cid + "/files";
    for (const f of files) {
      const created = parseTs(f.created_at), updated = parseTs(f.updated_at);
      if (!created || created < lookbackStart) continue;
      const fname = f.display_name || f.filename || "未命名文件";
      newFiles.push({
        name: fname, kind: fileKind(fname),
        created_at: fmtLocal(created), updated_at: fmtLocal(updated),
        is_update: !!(updated && updated - created > 3600000),
        size_bytes: f.size || 0, size_kb: Math.round((f.size || 0) / 1024),
        url: filesPage,
      });
    }

    const newAnns = [];
    for (const an of anns) {
      const created = parseTs(an.created_at) || parseTs(an.posted_at);
      if (!created || created < lookbackStart) continue;
      newAnns.push({ title: an.title || "无标题公告", created_at: fmtLocal(created),
                     summary: stripTags(an.message || ""), url: an.html_url || "" });
    }

    weekCourses.push({ name: name, code: code, term: term,
      url: cfg.canvasUrl.replace(/\/+$/, "") + "/courses/" + cid,
      new_assignments: newAssignments, upcoming: upcoming,
      new_files: newFiles, announcements: newAnns, changes: changes });
  }

  // 与上次快照对比已完成；保存新快照
  HUB_STORE.set("hubLastState", JSON.stringify(newState));

  const week = {
    date: fmtDate(now), generated_at: fmtLocal(now),
    range: fmtDate(new Date(now.getTime() - 7 * 86400000)) + " ~ " + fmtDate(now),
    courses: weekCourses,
  };

  // 合并历史（最多 52 周）
  let weeks = [];
  try { weeks = (JSON.parse(HUB_STORE.get("hubData") || "null") || {}).weeks || []; } catch (e) {}
  weeks = weeks.filter((x) => x.date !== week.date);
  weeks.unshift(week);
  const payload = {
    site_title: "我的学习中心", canvas_url: cfg.canvasUrl, username: "",
    tz_label: tzLabel(), updated_at: week.generated_at, weeks: weeks.slice(0, 52),
  };
  HUB_STORE.set("hubData", JSON.stringify(payload));
  return payload;
}

function fmtDate(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function fmtPrev(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? fmtLocal(d) : "无截止时间";
}
function stripTags(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ").trim().slice(0, 160);
}
function parseTs(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/* ---------------- ICS（浏览器端生成） ---------------- */

function icsEsc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function buildIcsText(data, daysAhead) {
  daysAhead = daysAhead || 60;
  const now = Date.now();
  const end = now + daysAhead * 86400000;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0",
    "PRODID:-//canvas-weekly-hub//web//CN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Canvas 截止日历"];
  let count = 0;
  for (const w of (data.weeks || [])) {
    for (const c of (w.courses || [])) {
      const seen = new Set();
      const pool = (c.upcoming || []).concat(c.new_assignments || []);
      for (const a of pool) {
        const dt = a.due_iso ? new Date(a.due_iso) : null;
        if (!dt || isNaN(dt) || dt.getTime() < now || dt.getTime() > end) continue;
        const key = (a.url || "") + "|" + a.name;
        if (seen.has(key)) continue;
        seen.add(key);
        const z = (x) => x.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
        const mark = a.graded ? "（已评分）" : (a.submitted ? "（已提交）" : "");
        lines.push("BEGIN:VEVENT",
          `UID:${(count++)}@canvas-weekly-hub`, `DTSTAMP:${stamp}`,
          `DTSTART:${z(dt)}`, `DTEND:${z(new Date(dt.getTime() + 15 * 60000))}`,
          `SUMMARY:${icsEsc("[" + (c.code || c.name) + "] " + a.name + mark)}`,
          `DESCRIPTION:${icsEsc(a.url || "")}`,
          "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY",
          `DESCRIPTION:${icsEsc(a.name)}`, "END:VALARM", "END:VEVENT");
      }
    }
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/* ---------------- 导出：我的学习网站.html / ics ---------------- */

async function downloadWebsite() {
  const data = JSON.parse(HUB_STORE.get("hubData") || "null");
  if (!data || !data.weeks || !data.weeks.length) {
    alert("还没有数据，请先「🚀 抓取我的课程」");
    return;
  }
  const r = await fetch("../site-template/index.html");
  if (!r.ok) throw new Error("无法读取页面模板（HTTP " + r.status + "）");
  const tpl = await r.text();
  const ics = buildIcsText(data);
  const inject = "<script>window.__HUB_DATA__ = " + JSON.stringify(data) +
                 ";window.__HUB_ICS__ = " + JSON.stringify(ics) + ";<\/script>\n</head>";
  const blob = new Blob([tpl.replace("</head>", inject)], { type: "text/html;charset=utf-8" });
  triggerDownload(blob, WEBSITE_FILE);
}

function triggerDownload(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}

function downloadIcs() {
  const data = JSON.parse(HUB_STORE.get("hubData") || "null");
  if (!data) { alert("还没有数据，请先抓取"); return; }
  triggerDownload(new Blob([buildIcsText(data)], { type: "text/calendar;charset=utf-8" }), "deadlines.ics");
}

/* ---------------- 设置浮层 ---------------- */

function genSecret() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function showSetup() {
  let ov = document.getElementById("setup-overlay");
  if (ov) { ov.style.display = "flex"; return; }
  ov = document.createElement("div");
  ov.id = "setup-overlay";
  const cfg = hubCfg();
  ov.innerHTML = `
  <div class="modal">
    <h3>⚙️ 设置 · 连接你的 Canvas</h3>
    <p class="hint">数据只保存在你自己的浏览器里（localStorage），不会上传到任何服务器。
       浏览器无法直连 Canvas（学校未开放跨域），需要先部署一个只属于你的转发代理。</p>
    <div class="frow"><label>① 转发代理</label>
      <input id="s-worker" placeholder="https://你的子域.workers.dev">
      <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Famalhaut04/canvas-weekly-hub"
         target="_blank" rel="noopener">一键部署（免费，约2分钟）↗</a>
      <a href="https://github.com/Famalhaut04/canvas-weekly-hub/blob/main/docs/Cloudflare%E9%83%A8%E7%BD%B2%E5%9B%BE%E6%96%87%E6%95%99%E7%A8%8B.md"
         target="_blank" rel="noopener" title="零基础手把手：注册 Cloudflare → 一键部署 → 备用方案 → 英文按钮对照表">📖 手把手图文教程</a>
    </div>
    <p class="hint">点上方链接 → 登录 Cloudflare → 点 Deploy → 把给你的 .workers.dev 地址填到左边。
       部署后令牌只经过你自己的 Cloudflare，不经过任何人。</p>
    <div class="frow"><label>② Canvas 地址</label><input id="s-canvas" placeholder="https://canvas.cityu.edu.hk"></div>
    <div class="frow"><label>③ 访问令牌</label><input id="s-token" type="password"
      placeholder="Canvas → 账户 → 设置 → + 新访问令牌（只显示一次）"></div>
    <div class="frow"><label>④ 令牌到期日</label><input id="s-exp" placeholder="YYYY-MM-DD，剩5天会在页面提醒"></div>
    <div class="frow"><label>⑤ Server酱 SendKey</label><input id="s-sendkey" type="password"
      placeholder="可选：微信每日提醒（sct.ftqq.com 免费获取）"></div>
    <div class="bar">
      <button class="btn" id="s-test">🔌 测试连接</button>
      <button class="btn primary" id="s-fetch">🚀 抓取并生成看板</button>
      <button class="btn" id="s-sub">📅 启用日历订阅 / 微信提醒</button>
      <button class="btn" id="s-close">关闭</button>
      <button class="btn" id="s-clear" style="color:#c0392b">清除我的数据</button>
    </div>
    <div class="subbox" id="s-subbox" style="display:none">
      <div>✅ 订阅已启用。把下面的链接添加到手机日历（订阅一次，永久自动更新）：</div>
      <code id="s-icsurl"></code>
      <button class="btn" id="s-copy" style="margin-top:6px">复制链接</button>
    </div>
    <div class="status" id="s-status"></div>
  </div>`;
  document.body.appendChild(ov);

  $("s-worker").value = cfg.worker;
  $("s-canvas").value = cfg.canvasUrl;
  $("s-token").value = cfg.token;
  $("s-exp").value = cfg.expires;
  $("s-sendkey").value = cfg.sendkey;

  const status = (msg, color) => {
    const el = $("s-status");
    el.textContent = msg;
    el.style.color = color || "";
  };
  const S_WARN = "#c0392b", S_OK = "#0f8a4f";

  $("s-close").onclick = () => { ov.style.display = "none"; };
  $("s-test").onclick = async () => {
    saveSetup();
    const c = hubCfg();
    if (!c.worker || !c.token) { status("❌ 请先填写 Worker 地址和访问令牌", S_WARN); return; }
    status("正在测试连接…");
    try {
      const me = await workerApi("users/self");
      status("✅ 连接成功：" + (me.name || me.short_name || "已认证"));
    } catch (e) { status("❌ " + e.message, S_WARN); }
  };
  $("s-fetch").onclick = async () => {
    saveSetup();
    const c = hubCfg();
    if (!c.worker || !c.token) { status("❌ 请先填写 Worker 地址和访问令牌", S_WARN); return; }
    status("🚀 正在抓取全部课程（含提交状态、课件清单），请稍候…");
    try {
      const data = await fetchAll();
      status("✅ 完成：" + data.weeks[0].courses.length + " 门课程已生成看板");
      boot(data);
      setTimeout(() => { ov.style.display = "none"; }, 600);
    } catch (e) { status("❌ " + e.message, S_WARN); }
  };
  $("s-sub").onclick = async () => {
    const c = saveSetup();
    if (!c.worker || !c.token) { status("❌ 请先完成①②③并保存", S_WARN); return; }
    status("正在启用订阅…");
    try {
      const secret = c.secret || genSecret();
      HUB_STORE.set("hubSecret", secret);
      const r = await fetch(c.worker.replace(/\/+$/, "") + "/setup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: secret, token: c.token, sendkey: c.sendkey,
                               host: hostOf(c.canvasUrl) }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "HTTP " + r.status);
      $("s-subbox").style.display = "block";
      $("s-icsurl").textContent = j.icsUrl;
      setIcsLink(j.icsUrl);
      status("✅ 已启用：把上面链接订阅到手机日历（截止前2小时提醒）；" +
             (c.sendkey ? "微信每日提醒已就绪（Worker Cron 每天 18:30 推送）" : "如需微信提醒，填写 Server酱 SendKey 后再点一次本按钮"));
    } catch (e) { status("❌ " + e.message, S_WARN); }
  };
  $("s-copy").onclick = () => {
    navigator.clipboard.writeText($("s-icsurl").textContent)
      .then(() => status("✅ 已复制", S_OK));
  };
  $("s-clear").onclick = () => {
    if (!confirm("确定清除本浏览器里的全部看板数据与令牌？（不会影响你的 Canvas 账号）")) return;
    ["hubData", "hubLastState", "hubWorker", "hubCanvasUrl", "hubToken",
     "hubExpires", "hubSendKey", "hubSecret"].forEach((k) => HUB_STORE.del(k));
    status("已清除。刷新页面将回到初始状态。");
    setTimeout(() => location.reload(), 700);
  };
}

function saveSetup() {
  const g = (id) => (document.getElementById(id) ? document.getElementById(id).value.trim() : "");
  const map = { hubWorker: g("s-worker"), hubCanvasUrl: g("s-canvas"),
                hubToken: g("s-token"), hubExpires: g("s-exp"), hubSendKey: g("s-sendkey") };
  for (const k of Object.keys(map)) HUB_STORE.set(k, map[k]);
  let secret = HUB_STORE.get("hubSecret", "");
  if (!secret) { secret = genSecret(); HUB_STORE.set("hubSecret", secret); }
  return hubCfg();
}

function setIcsLink(url) {
  const a = document.getElementById("ics-link");
  if (!a) return;
  a.href = url;
  a.removeAttribute("download");
  a.target = "_blank";
  a.title = "订阅到手机日历（自动更新）";
}

/* ---------------- 入口接线 ---------------- */

$("settings-btn").addEventListener("click", () => showSetup());
$("ics-link").addEventListener("click", (e) => {
  // 网页版：动态生成 ICS 下载（若已启用订阅，链接已在 setIcsLink 中指向订阅地址）
  if (!/^data:/.test($("ics-link").href) && !/\/ics\?/.test($("ics-link").href)) {
    e.preventDefault();
    downloadIcs();
  }
});

window.__HUB_BOOT__ && window.__HUB_BOOT__();

/* ---------------- Star 数展示（缓存 1 小时，失败静默） ---------------- */
(async () => {
  try {
    let n = null, t = 0;
    try {
      const j = JSON.parse(HUB_STORE.get("hubStars") || "null");
      if (j) { n = j.n; t = j.t || 0; }
    } catch (e) {}
    if (!n || Date.now() - t > 3600000) {
      const r = await fetch("https://api.github.com/repos/Famalhaut04/canvas-weekly-hub");
      if (r.ok) {
        n = (await r.json()).stargazers_count;
        HUB_STORE.set("hubStars", JSON.stringify({ n, t: Date.now() }));
      }
    }
    if (n !== null && n !== undefined) {
      const el = document.getElementById("star-count");
      if (el) el.textContent = " " + n;
    }
  } catch (e) { /* 离线或限流时静默 */ }
})();
