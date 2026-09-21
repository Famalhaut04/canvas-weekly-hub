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
    const body = await r.text();
    const clean = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const jsonMsg = (() => { try { const j = JSON.parse(body);
      return (j.message || (j.errors && j.errors[0] && j.errors[0].message)) || ""; }
      catch (e) { return ""; } })();
    if (r.status === 401) throw new Error("令牌无效或已过期（HTTP 401）：请到 Canvas 重新生成");
    if (r.status === 403) {
      if (/cloudflare|just a moment|attention required|access denied|blocked|rate limit/i.test(body))
        throw new Error("Canvas 拒绝访问（HTTP 403）：请求被学校/CDN 的防护拦截（疑似屏蔽云服务器访问）。" +
          "请稍后重试；若反复出现，请把本条提示和你的小助手地址反馈给作者");
      throw new Error("Canvas 拒绝访问（HTTP 403）：" + (jsonMsg || clean.slice(0, 140) ||
        "请确认令牌属于你自己；若反复出现请反馈此提示"));
    }
    if (!r.ok) throw new Error("Canvas API HTTP " + r.status + (jsonMsg ? "：" + jsonMsg :
      clean ? "：" + clean.slice(0, 140) : "") + " @ " + path);
    return JSON.parse(body);
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
    <div style="display:flex;align-items:center;gap:8px">
      <h3 style="flex:1">⚙️ 首次使用 · 三步完成（约 5 分钟，全程只用鼠标）</h3>
      <a class="btn" href="https://github.com/Famalhaut04/canvas-weekly-hub/blob/main/docs/Cloudflare%E9%83%A8%E7%BD%B2%E5%9B%BE%E6%96%87%E6%95%99%E7%A8%8B.md"
         target="_blank" rel="noopener">📖 图文教程</a>
      <button class="btn" id="s-close">✕</button>
    </div>

    <div class="fstep">
      <div class="fstep-h">❶ 创建你的「传话小助手」（免费 · 只需一个邮箱 · 约 3 分钟）</div>
      <p class="hint">学校禁止网页直接访问 Canvas，所以需要一个<b>只属于你的免费小助手</b>帮你转发数据——
      令牌只经过你自己的账号，不经过任何人。照下面 4 步点，全程不写代码：</p>
      <p class="hint">
        1️⃣ 打开 <a href="https://dash.cloudflare.com" target="_blank" rel="noopener">dash.cloudflare.com</a>，用<b>邮箱</b>注册并登录（免费，不用信用卡）；<br>
        2️⃣ 左侧 <b>Workers &amp; Pages</b> → <b>Create</b> → <b>Create Worker</b> → 名字随意（如 canvas）→ 点 <b>Deploy</b>；<br>
        3️⃣ 点 <b>Edit code</b> → <b>全选删除</b>默认代码 → 粘贴用下面按钮复制的代码 → 点右上 <b>Deploy</b>；<br>
        4️⃣ 复制页面显示的 <code>https://名字.你的子域.workers.dev</code>，填到下面输入框。
      </p>
      <div class="frow">
        <button class="btn primary" id="s-copycode">📋 一键复制小助手代码</button>
        <a href="https://github.com/Famalhaut04/canvas-weekly-hub/blob/main/docs/Cloudflare%E9%83%A8%E7%BD%B2%E5%9B%BE%E6%96%87%E6%95%99%E7%A8%8B.md"
           target="_blank" rel="noopener">📖 卡住了？手把手图文教程</a>
      </div>
      <div class="frow"><label>小助手地址</label>
        <input id="s-worker" placeholder="https://canvas-weekly-hub.你的子域.workers.dev"></div>
      <details class="faq"><summary>更省事的「一键部署」版（需要 GitHub 账号；自动配置提醒功能所需的存储）</summary>
        <p class="hint">点 <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/Famalhaut04/canvas-weekly-hub"
        target="_blank" rel="noopener">🚀 一键部署 ↗</a> → 按提示登录 Cloudflare 与 GitHub → 点 <b>Create and Deploy</b> →
        复制它给的网址填到上面输入框。此方式会自动创建 KV，「日历订阅 / 微信提醒」开箱即用；
        上面的手动方式看板功能完整，订阅功能需按教程常见问题绑定 KV。</p>
      </details>
    </div>

    <div class="fstep">
      <div class="fstep-h">❷ 绑定你的 Canvas 令牌（约 1 分钟）</div>
      <div class="frow"><label>Canvas 地址</label><input id="s-canvas" placeholder="https://canvas.cityu.edu.hk"></div>
      <div class="frow"><label>访问令牌</label><input id="s-token" type="password"
        placeholder="登录 Canvas 后生成，获取方法点下面的折叠说明"></div>
      <details class="faq"><summary>❓ 如何获取令牌？（约 1 分钟，只在第一次需要）</summary>
        <p class="hint">1) 登录 Canvas（<a href="https://canvas.cityu.edu.hk/profile/settings" target="_blank" rel="noopener">直达令牌生成页 ↗</a>，如提示登录先用学校账号登录）；
        2) 左下角 <b>账户(Account) → 设置(Settings)</b>；
        3) 拉到页面最底部「已批准的集成」→ 点 <b>+ 新访问令牌</b>；
        4) 目的随便填（如 weekly-report），点 <b>生成</b> → <b>立刻复制</b>（只显示这一次）粘贴到上面；
        5) 城大令牌最长 90 天——把生成页显示的到期日填到下面④，<b>剩 5 天会自动提醒你更换</b>。</p>
      </details>
      <div class="frow"><label>令牌到期日</label><input id="s-exp" placeholder="YYYY-MM-DD，选填但强烈建议填写"></div>
      <div class="frow"><label></label>
        <button class="btn primary" id="s-test">🔌 测试连接</button>
        <span style="font-size:.8rem;color:var(--muted)">显示 ✅ 后再进行第 ❸ 步</span>
      </div>
      <div class="status" id="s-status"></div>
    </div>

    <div class="fstep">
      <div class="fstep-h">❸ 生成看板 &amp; 开启提醒</div>
      <div class="frow"><label></label>
        <button class="btn primary" id="s-fetch">🚀 抓取并生成看板</button>
        <span style="font-size:.8rem;color:var(--muted)">抓完会自动打开你的看板</span>
      </div>
      <div class="frow"><label></label>
        <button class="btn" id="s-sub">📅 启用日历订阅 / 微信提醒</button>
        <span style="font-size:.8rem;color:var(--muted)">手机日历自动提醒截止；微信每天 18:30 推送待办</span>
      </div>
      <div class="frow"><label>微信 SendKey</label><input id="s-sendkey" type="password"
        placeholder="可选，在 sct.ftqq.com 免费获取"></div>
      <div class="subbox" id="s-subbox" style="display:none">
        <div>✅ 已启用。把下面的链接添加到手机日历（订阅一次，永久自动更新）：</div>
        <code id="s-icsurl"></code>
        <button class="btn" id="s-copy" style="margin-top:6px">复制链接</button>
      </div>
    </div>

    <details class="faq" style="margin:10px 18px 0"><summary>❓ 常见问题</summary>
      <p class="hint">
      <b>Failed to fetch</b>：小助手地址填错或还没部署完成 → 回到①检查；<br>
      <b>HTTP 401</b>：令牌错误或过期 → 到 Canvas 重新生成并粘贴；<br>
      <b>显示 0 门课程</b>：确认 Canvas 地址是 canvas.cityu.edu.hk；<br>
      <b>清除浏览器缓存后要重新粘贴令牌</b>：正常现象，数据可重新抓取，建议常点「⬇️ 下载我的学习网站」留离线备份。</p>
    </details>

    <div style="display:flex;justify-content:space-between;margin-top:12px">
      <button class="btn" id="s-clear" style="color:#c0392b">清除我的数据</button>
      <button class="btn" id="s-close2">关闭</button>
    </div>
  </div>`;;
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
  $("s-close2").onclick = () => { ov.style.display = "none"; };
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
      showFirstTip();
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
  // 小助手地址即时连通性检测（输完 0.7 秒自动检查，当场发现填错）
  const wkInp = $("s-worker");
  if (!document.getElementById("worker-check")) {
    const wkSpan = document.createElement("span");
    wkSpan.id = "worker-check";
    wkSpan.style.cssText = "font-size:.78rem;margin-left:6px;white-space:nowrap";
    wkInp.parentElement.appendChild(wkSpan);
    let wkTimer = null;
    const wkRun = async () => {
      const v = wkInp.value.trim();
      const el = $("worker-check");
      if (!v) { el.textContent = ""; return; }
      if (!/^https:\/\/.+\.workers\.dev\/?$/.test(v)) {
        el.style.color = S_WARN;
        el.textContent = "⚠️ 地址应以 https:// 开头、以 .workers.dev 结尾";
        return;
      }
      el.style.color = ""; el.textContent = "⏳ 正在检查…";
      try {
        const r = await fetch(v.replace(/\/+$/, "") + "/");
        const j = await r.json().catch(() => null);
        if (j && j.name && String(j.name).includes("canvas-weekly-hub")) {
          el.style.color = S_OK; el.textContent = "✅ 小助手在线";
        } else {
          el.style.color = S_WARN; el.textContent = "⚠️ 能连上但不是本项目的代码：回 Cloudflare 确认已粘贴";
        }
      } catch (e) {
        el.style.color = S_WARN; el.textContent = "❌ 连不上：检查地址拼写，或部署还没完成";
      }
    };
    wkInp.addEventListener("input", () => { clearTimeout(wkTimer); wkTimer = setTimeout(wkRun, 700); });
    if (wkInp.value) wkRun();
  }

  $("s-copycode").onclick = async () => {
    try {
      const r = await fetch("https://raw.githubusercontent.com/Famalhaut04/canvas-weekly-hub/main/worker.js");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const code = await r.text();
      await navigator.clipboard.writeText(code);
      status("✅ 代码已复制到剪贴板。去 Cloudflare 的 Edit code 里全选粘贴，点右上 Deploy 即可", S_OK);
    } catch (e) {
      window.open("https://raw.githubusercontent.com/Famalhaut04/canvas-weekly-hub/main/worker.js", "_blank");
      status("复制失败（浏览器限制）：已打开代码页，Ctrl+A 全选复制即可", S_WARN);
    }
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

/* ---------------- 新手引导条 & 更新按钮 ---------------- */
function showFirstTip() {
  if (document.getElementById("first-tip")) return;
  if (HUB_STORE.get("hubTipDone")) return;
  const main = document.querySelector("main");
  if (!main) return;
  const tip = document.createElement("div");
  tip.id = "first-tip";
  tip.innerHTML = `🎉 <b>看板已就绪！</b>常用三件事：
    ① 每周回来点一次顶部 <b>🔄</b> 更新数据；
    ② 顶部 <b>📅 截止日历</b> 可导入手机，到点自动提醒；
    ③ <b>⚙️ 设置</b> 里可下载离线版「我的学习网站.html」和开启微信提醒。
    <button title="知道了" style="margin-left:auto;flex:none">✕</button>`;
  tip.querySelector("button").onclick = () => {
    HUB_STORE.set("hubTipDone", "1");
    tip.remove();
  };
  main.insertBefore(tip, main.firstChild);
}

const refreshBtn = document.createElement("button");
refreshBtn.id = "refresh-btn";
refreshBtn.className = "icon-btn";
refreshBtn.title = "更新数据：重新抓取 Canvas（约 10 秒）";
refreshBtn.textContent = "🔄";
document.getElementById("settings-btn").parentElement.insertBefore(
  refreshBtn, document.getElementById("settings-btn"));
refreshBtn.onclick = async () => {
  const c = hubCfg();
  if (!c.worker || !c.token) { showSetup(); return; }
  refreshBtn.textContent = "⏳";
  refreshBtn.disabled = true;
  try {
    const data = await fetchAll();
    boot(data);
    showFirstTip();
  } catch (e) {
    showSetup();
    const st = document.getElementById("s-status");
    if (st) { st.textContent = "❌ " + e.message; st.style.color = "#c0392b"; }
  } finally {
    refreshBtn.textContent = "🔄";
    refreshBtn.disabled = false;
  }
};

const _bootRaw = window.__HUB_BOOT__;
window.__HUB_BOOT__ = function () {
  _bootRaw();
  // 数据就绪后补上新手引导条（仅网页版）
  const has = (() => { try {
    const d = JSON.parse(HUB_STORE.get("hubData") || "null");
    return !!(d && d.weeks && d.weeks.length);
  } catch (e) { return false; } })();
  if (has) showFirstTip();
};

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
