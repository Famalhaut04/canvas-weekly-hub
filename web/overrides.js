/* ===== 网页版扩展：设置向导 + 抓取 + 导出（由 web/build_web.py 注入 web/index.html） ===== */
/* 依赖主脚本中的全局：$、esc、boot、render、DATA、buildIcsText（本文件提供） */

const WEBSITE_FILE = "我的学习网站.html";
const HUB_MANAGED_ORIGIN = window.__HUB_WORKER_ORIGIN__ || "";

const HUB_STORE = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
  set(k, v) {
    try { localStorage.setItem(k, v); }
    catch (e) { throw new Error("浏览器无法保存数据：存储已禁用或空间不足。请允许本站存储或换用其他浏览器。"); }
  },
  del(k) { localStorage.removeItem(k); },
};

// 一组相关数据一起保存，失败时尽量恢复旧值，避免看板与快照不一致。
function storeTogether(values) {
  const old = {};
  try {
    for (const k of Object.keys(values)) old[k] = localStorage.getItem(k);
  } catch (e) { throw new Error("无法读取浏览器存储，请允许本站存储后重试。"); }
  try {
    for (const k of Object.keys(values)) HUB_STORE.set(k, values[k]);
  } catch (e) {
    for (const k of Object.keys(old)) {
      try { old[k] === null ? localStorage.removeItem(k) : localStorage.setItem(k, old[k]); }
      catch (restoreError) { /* 保留最初的存储错误供用户处理 */ }
    }
    throw e;
  }
}

function normalizeOrigin(value, label) {
  let u;
  try { u = new URL(String(value || "").trim()); }
  catch (e) { throw new Error(label + "应是完整的 HTTPS 地址，例如 https://canvas.cityu.edu.hk"); }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password || u.search || u.hash ||
      !["", "/"].includes(u.pathname)) {
    throw new Error(label + "只需填写 HTTPS 站点地址，不要附带页面路径、账号或查询参数");
  }
  return u.origin;
}

function validateHubCfg(cfg) {
  const c = Object.assign({}, cfg);
  // 本地浏览器验收允许同源 loopback HTTP；部署页面仍使用自己的 HTTPS 站点。
  const managedLocal = HUB_MANAGED_ORIGIN && c.worker === HUB_MANAGED_ORIGIN &&
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(c.worker);
  c.worker = managedLocal ? c.worker : normalizeOrigin(c.worker, "小助手地址");
  c.canvasUrl = normalizeOrigin(c.canvasUrl, "Canvas 地址");
  c.token = String(c.token || "").trim();
  if (!c.token || /\s/.test(c.token)) throw new Error("请填写完整的 Canvas 访问令牌，不要带空格或换行");
  if (c.expires) {
    const d = new Date(c.expires + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.expires) || isNaN(d) || d.toISOString().slice(0, 10) !== c.expires)
      throw new Error("令牌到期日应是有效日期，格式为 YYYY-MM-DD");
  }
  return c;
}

async function requestText(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
    const body = await response.text();
    return { response, body };
  } catch (e) {
    if (controller.signal.aborted) throw new Error("请求超过 20 秒，请检查网络和小助手地址后重试");
    if (e instanceof TypeError) throw new Error("网络连接失败，请检查网络、小助手地址和跨域设置");
    throw e;
  } finally { clearTimeout(timer); }
}

let hubBusy = false;
async function withHubTask(action) {
  if (hubBusy) throw new Error("已有操作正在进行，请等待完成后再试");
  hubBusy = true;
  const ids = ["s-test", "s-fetch", "s-unsub", "s-close", "s-close2", "s-clear", "refresh-btn", "reminder-refresh", "s-import", "s-backup"];
  ids.push("s-worker", "s-canvas", "s-token", "s-exp", "s-web-entry", "s-agent-entry");
  const buttons = ids.map((id) => document.getElementById(id)).filter(Boolean);
  const disabled = buttons.map((b) => b.disabled);
  buttons.forEach((b) => { b.disabled = true; });
  try { return await action(); }
  finally {
    hubBusy = false;
    buttons.forEach((b, i) => { b.disabled = disabled[i]; });
  }
}

function hubCfg() {
  return {
    worker: HUB_MANAGED_ORIGIN || (HUB_STORE.get("hubWorker") || "").trim(),
    canvasUrl: (HUB_STORE.get("hubCanvasUrl") || "https://canvas.cityu.edu.hk").trim(),
    token: (HUB_STORE.get("hubToken") || "").trim(),
    expires: (HUB_STORE.get("hubExpires") || "").trim(),
    sendkey: (HUB_STORE.get("hubSendKey") || "").trim(),
    secret: (HUB_STORE.get("hubSecret") || "").trim(),
  };
}

/* 更新提醒只检查本地时间；所有 Canvas 操作由用户触发。 */
const REMINDER_DAY = 86400000;
let reminderTimer = null;
let reminderDismissed = "";
let reminderRevision = 0;

function reminderPrefs() {
  try {
    const p = JSON.parse(HUB_STORE.get("hubUpdateReminder") || "null");
    if (p && typeof p.enabled === "boolean" && Number.isSafeInteger(p.days) && p.days >= 1)
      return p;
  } catch (e) { /* 损坏的设置使用默认值 */ }
  return { enabled: true, days: 3 };
}

async function refreshBinding(c) {
  // 绑定学校、个人实例与令牌，不在状态里重复保存明文令牌，也不发送绑定值。
  const bytes = new TextEncoder().encode(JSON.stringify([c.worker, c.canvasUrl, c.token]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function legacyRefreshTime(data) {
  if (!data) return null;
  const date = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(data.updated_at || "");
  const zone = /^UTC([+-]\d+(?:\.\d+)?)$/.exec(data.tz_label || "");
  if (!date || !zone || Math.abs(Number(zone[1])) > 14) return null;
  const wall = Date.UTC(+date[1], +date[2] - 1, +date[3], +date[4], +date[5]);
  const d = new Date(wall);
  if (d.getUTCFullYear() !== +date[1] || d.getUTCMonth() !== +date[2] - 1 ||
      d.getUTCDate() !== +date[3] || d.getUTCHours() !== +date[4] || d.getUTCMinutes() !== +date[5]) return null;
  return wall - Number(zone[1]) * 3600000;
}

async function currentRefreshState() {
  const c = hubCfg(), binding = await refreshBinding(c);
  let state;
  const raw = HUB_STORE.get("hubRefreshState");
  try { state = JSON.parse(raw || "null"); } catch (e) {}
  if (raw !== null && raw !== undefined) {
    if (state && state.binding === binding && state.version === 1 &&
        (state.successAt === null || (Number.isFinite(state.successAt) && state.successAt > 0))) return state;
    // 有状态但身份不匹配或字段损坏时，不用旧历史推断另一个身份的更新时间。
    return { version: 1, binding, successAt: null };
  }
  let data;
  try { data = JSON.parse(HUB_STORE.get("hubData") || "null"); } catch (e) {}
  const successAt = c.token && data && data.canvas_url === c.canvasUrl ? legacyRefreshTime(data) : null;
  return { version: 1, binding, successAt };
}

function refreshNotice(msg) {
  const el = document.getElementById("refresh-message");
  if (el) el.textContent = msg;
}

async function updateRefreshReminder() {
  clearTimeout(reminderTimer);
  const revision = ++reminderRevision;
  const time = document.getElementById("refresh-time");
  if (!time) return;
  try {
    const state = await currentRefreshState();
    if (revision !== reminderRevision) return;
    const p = reminderPrefs();
    const age = state.successAt === null ? null : Date.now() - state.successAt;
    time.textContent = state.successAt === null ? "更新时间未知，可手动刷新" :
      "上次成功更新：" + new Date(state.successAt).toLocaleString("zh-CN", { hour12: false }) + "（设备时区）";
    const label = document.getElementById("refresh-plan");
    if (label) label.textContent = p.enabled ? "每 " + p.days + " 天提醒 · 点击才刷新" : "更新提醒已关闭 · 可随时手动刷新";
    const signature = JSON.stringify([state.binding, state.successAt, p.days]);
    const banner = document.getElementById("refresh-reminder");
    if (banner) {
      banner.hidden = !p.enabled || age === null || age < p.days * REMINDER_DAY || reminderDismissed === signature;
      document.getElementById("reminder-text").textContent = "课程数据已满 " + p.days + " 天未更新，是否现在刷新？";
      document.getElementById("reminder-later").onclick = () => {
        reminderDismissed = signature;
        updateRefreshReminder();
      };
    }
    if (!document.hidden && p.enabled && age !== null && reminderDismissed !== signature) {
      // 前台最多每分钟校对；后台不承诺准点触发，恢复可见后重新比较时间戳。
      const remaining = p.days * REMINDER_DAY - age;
      reminderTimer = setTimeout(updateRefreshReminder, Math.max(1000, Math.min(60000, remaining > 0 ? remaining : 60000)));
    }
  } catch (e) {
    time.textContent = "更新时间未知，可手动刷新";
    refreshNotice("无法检查本地更新记录：请允许本站存储并使用支持 HTTPS 的现代浏览器。");
  }
}

function loadReminderForm() {
  const p = reminderPrefs();
  $("s-reminder-enabled").checked = p.enabled;
  $("s-reminder-days").value = String(p.days);
  $("s-reminder-status").textContent = "";
}

// 同源标签页共享浏览器锁，不排队补抓，也不广播凭证或课程内容。
async function withCanvasTask(action) {
  return withHubTask(async () => {
    if (!navigator.locks || typeof navigator.locks.request !== "function")
      throw new Error("当前浏览器不支持多标签页刷新保护，请用新版 Edge、Chrome、Firefox 或 Safari 打开个人 HTTPS 网址后重试；旧看板仍可查看");
    return navigator.locks.request("canvas-hub-user-query", { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error("另一个标签页正在查询 Canvas，请等待它完成；本页不会排队重复刷新");
      return action();
    });
  });
}

function hostOf(url) {
  return new URL(normalizeOrigin(url, "Canvas 地址")).host;
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

function workerApi(path, params, cfg) {
  const c = validateHubCfg(cfg || hubCfg());
  const u = c.worker.replace(/\/+$/, "") + "/proxy/" + path.replace(/^\/+/, "");
  const qs = new URLSearchParams(params || {});
  return requestText(u + "?" + qs, {
    headers: { "X-Canvas-Token": c.token, "X-Canvas-Host": hostOf(c.canvasUrl) },
  }).then(({ response: r, body }) => {
    const clean = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const jsonMsg = (() => { try { const j = JSON.parse(body);
      return (j.error || j.message || (j.errors && j.errors[0] && j.errors[0].message)) || ""; }
      catch (e) { return ""; } })();
    if (r.status === 401) throw new Error("令牌无效或已过期（HTTP 401）：请到 Canvas 重新生成");
    if (r.status === 403) {
      if (/cloudflare|just a moment|attention required|access denied|blocked|rate limit/i.test(body))
        throw new Error("Canvas 拒绝访问（HTTP 403）：请求被学校/CDN 的防护拦截（疑似屏蔽云服务器访问）。" +
          "请稍后重试；若反复出现，请把本条提示和你的小助手地址反馈给作者");
      throw new Error("Canvas 拒绝访问（HTTP 403）：请检查账号的课程 / 接口权限及学校访问限制；" +
        "这不等同于令牌过期。" + (jsonMsg ? "详情：" + jsonMsg : ""));
    }
    if (r.status >= 500) throw new Error("查询服务返回 HTTP " + r.status +
      "：请检查个人助手部署、学校接口和网络；此状态不能判断令牌是否过期。" +
      (jsonMsg ? "详情：" + jsonMsg : "") + " @ " + path);
    if (!r.ok) throw new Error("Canvas API HTTP " + r.status + (jsonMsg ? "：" + jsonMsg :
      clean ? "：" + clean.slice(0, 140) : "") + " @ " + path);
    try { return JSON.parse(body); }
    catch (e) { throw new Error("小助手返回了非 JSON 数据，请检查是否部署了本项目代码"); }
  });
}

async function apiAll(path, params, cfg) {
  let page = 1, out = [];
  for (;;) {
    const arr = await workerApi(path, Object.assign({}, params || {}, { per_page: 100, page: page }), cfg);
    if (!Array.isArray(arr)) throw new Error("Canvas 列表格式异常，本次数据未保存：" + path);
    out = out.concat(arr);
    if (arr.length < 100) break;
    if (page >= 20) throw new Error("数据达到分页上限，本次数据未保存：" + path);
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

async function fetchAll(inputCfg, progress) {
  const cfg = validateHubCfg(inputCfg || hubCfg());
  const binding = await refreshBinding(cfg);
  const beforeBinding = await refreshBinding(hubCfg());
  const report = progress || (() => {});
  report("正在读取课程列表…");
  const courses = await apiAll("courses", { enrollment_state: "active", "include[]": "term" }, cfg);
  const warnings = [];

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
    report("正在抓取 " + (weekCourses.length + 1) + "/" + courses.length + "：" + name);
    const optional = (path, params, label) => apiAll(path, params, cfg).catch((e) => {
      warnings.push(name + "：" + label + "未能读取（" + e.message + "）");
      return [];
    });
    const [assignments, files, anns] = await Promise.all([
      apiAll("courses/" + cid + "/assignments", { order_by: "due_at", "include[]": "submission" }, cfg),
      optional("courses/" + cid + "/files", { sort: "created_at", order: "desc" }, "课件"),
      optional("courses/" + cid + "/announcements", {}, "公告"),
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
            detail: "截止时间 " + fmtPrev(prev.due_iso) + " → " + (due ? fmtLocal(due) : "无截止时间") });
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

  const week = {
    date: fmtDate(now), generated_at: fmtLocal(now),
    range: fmtDate(new Date(now.getTime() - 7 * 86400000)) + " ~ " + fmtDate(now),
    courses: weekCourses, warnings: warnings,
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
  if (await refreshBinding(hubCfg()) !== beforeBinding)
    throw new Error("查询期间配置已在其他页面更改，本次结果未保存，请按当前配置重新刷新");
  const successAt = Date.now();
  payload.updated_at = fmtLocal(new Date(successAt));
  storeTogether(Object.assign({}, inputCfg ? configValues(cfg) : {}, {
    hubData: JSON.stringify(payload), hubLastState: JSON.stringify(newState),
    hubRefreshState: JSON.stringify({ version: 1, binding, successAt }),
  }));
  reminderDismissed = "";
  updateRefreshReminder();
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
    alert("还没有数据，请先连接并生成看板");
    return;
  }
  const r = await fetch(HUB_MANAGED_ORIGIN ? "/site-template/index.html" : "../site-template/index.html");
  if (!r.ok) throw new Error("无法读取页面模板（HTTP " + r.status + "）");
  const tpl = await r.text();
  const ics = buildIcsText(data);
  const safeJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
  const inject = "<script>window.__HUB_DATA__ = " + safeJson(data) +
                 ";window.__HUB_ICS__ = " + safeJson(ics) + ";<\/script>\n</head>";
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

const AGENT_SETUP_PROMPT = [
  "请协助我在本机配置 Canvas Weekly Hub v2.2 的 Python 路线。",
  "1. 先读取 README.md、docs/部署指南.md、config/canvas_config.example.json、canvas_weekly_report.py 和 serve_board.py，按实际实现操作。先确认学校允许个人 API 使用；此项目使用手动令牌，不能据此认定是学校批准的应用。",
  "2. 优先使用已有 Python 3.8+ 环境；引擎仅用标准库。安装软件或依赖前征求同意。不要把 agent 路线描述成无需运行环境。",
  "3. 复制配置示例为本地 canvas_config.json，让我自己在本地填写学校 Canvas 地址与 Token，不要求把真实 Token 粘贴进聊天或提示词。不要读取或输出 Token 到聊天、日志、截图或 Git 提交；排错只展示脱敏信息。",
  "4. 保持 github.push_enabled=false，不自动上传课程数据，不自动 commit、push 或部署云端资源。",
  "5. 用选定的 Python 解释器先执行 canvas_weekly_report.py --check-config；该检查仅验证配置格式，不证明令牌或课程权限有效。通过后再运行 canvas_weekly_report.py，依据真实输出汇报，不编造课程内容。",
  "6. 成功后打开生成的“我的学习网站.html”离线快照，或用同一解释器运行 serve_board.py，访问 http://localhost:8137/。默认配置与产物在项目目录；设置 CANVAS_HUB_DATA_DIR 后使用该目录。",
  "7. 如需自动更新，配置本机 agent 或系统计划任务定时运行引擎，电脑与运行环境需要在线。本地 Python 直接查询学校，不需要 Cloudflare、KV 或云端定时器。",
  "8. 若你是云端 agent，请在读取配置或课程产物前说明：输入的凭证、读取的课程内容可能进入模型服务商，不能宣称全程只在本机处理。优先让我自行填 Token 并运行，只提供脱敏的报错。"
].join("\n");

function showSetup() {
  let ov = document.getElementById("setup-overlay");
  if (ov) {
    const saved = hubCfg();
    const fields = { "s-worker": "worker", "s-canvas": "canvasUrl", "s-token": "token",
                     "s-exp": "expires" };
    for (const id of Object.keys(fields)) $(id).value = saved[fields[id]];
    $("s-status").textContent = "";
    $("worker-check").textContent = "";
    $("s-capabilities").textContent = "v2.2 暂停云端订阅与微信提醒；日历仍可下载后导入。";
    $("s-unsub").hidden = !saved.secret;
    loadReminderForm();
    ov.style.display = "flex";
    if (!HUB_MANAGED_ORIGIN) $("s-worker").dispatchEvent(new Event("input"));
    $("s-canvas").dispatchEvent(new Event("input"));
    return;
  }
  ov = document.createElement("div");
  ov.id = "setup-overlay";
  const cfg = hubCfg();
  ov.innerHTML = `
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="setup-title">
    <div class="setup-head">
      <h3 id="setup-title" style="flex:1">${HUB_MANAGED_ORIGIN ? "连接你的 Canvas" : "创建你的课程助手"} <small class="version-badge">v2.2</small></h3>
      <a class="btn" href="${HUB_MANAGED_ORIGIN ? "/overview" : "./overview.html"}" target="_blank" rel="noopener">系统概述</a>
      <button class="btn" id="s-close" aria-label="关闭设置">✕</button>
    </div>
    <p class="hint">${HUB_MANAGED_ORIGIN ? "助手已就绪。粘贴自己的 Canvas 令牌，点击下方按钮即可生成看板。" : "先创建属于自己的网页。之后只需填 Canvas 令牌，不用配置代理地址。"}</p>
    <div class="bar">
      <a class="btn" id="s-cityu-login" href="https://canvas.cityu.edu.hk/" target="_blank" rel="noopener noreferrer">登录城大 Canvas ↗</a>
    </div>
    <p class="hint">登录学校 Canvas，到“账户 → 设置”获取访问令牌。</p>
    <div class="bar" aria-label="选择配置方式">
      <button class="btn primary" id="s-web-entry" aria-controls="s-web-panel" aria-expanded="true">基础版</button>
      <button class="btn" id="s-agent-entry" aria-controls="s-agent-panel" aria-expanded="false">升级版</button>
    </div>
    <p class="hint">基础版：网页部署与看板，适合普通用户。升级版：本地 Python / agent 配置，适合有 agent 使用经验的用户。</p>
    <section id="s-agent-panel" class="fstep" hidden>
      <div class="fstep-h">本地 Python / agent 配置</div>
      <ol class="setup-steps">
        <li>下载或克隆项目，优先使用已有 Python 3.8+ 环境。引擎仅用标准库；本路线需要电脑上的运行环境。</li>
        <li>复制 config/canvas_config.example.json 为 canvas_config.json，在本地填写学校 Canvas 地址和自己的 Token，保持 github.push_enabled=false。</li>
        <li>先执行配置检查，通过后再运行抓取引擎。检查只验证格式，不验证学校权限。</li>
        <li>成功后打开“我的学习网站.html”离线快照；或启动 serve_board.py，访问 http://localhost:8137/ 查看本地看板。</li>
        <li>自动更新由自己的 agent 或系统计划任务定时启动引擎；电脑、运行环境和网络需要在线。</li>
      </ol>
      <pre class="agent-code">python canvas_weekly_report.py --check-config
python canvas_weekly_report.py
python serve_board.py</pre>
      <p class="hint">在项目目录使用同一个 Python 解释器执行。本地 Python 直接查询学校，不需要 Cloudflare、KV 或云端定时器。</p>
      <p class="hint">不要把真实 Token 发到聊天。云端 agent 读取凭证或课程内容时，这些信息可能进入模型服务商，不能称为全程本机处理。</p>
      <div class="bar"><button class="btn primary" id="s-agent-copy">复制给 agent 的配置提示词</button>
        <a class="btn" href="https://github.com/Famalhaut04/canvas-weekly-hub/blob/main/docs/%E9%83%A8%E7%BD%B2%E6%8C%87%E5%8D%97.md" target="_blank" rel="noopener noreferrer">本地部署指南 ↗</a></div>
      <div id="s-agent-status" class="status" role="status" aria-live="polite"></div>
      <details id="s-agent-copy-details" class="faq"><summary>查看并手动复制提示词</summary>
        <label for="s-agent-prompt">提示词不包含你的配置或 Token</label>
        <textarea id="s-agent-prompt" rows="9" readonly spellcheck="false"></textarea>
      </details>
    </section>
    <div id="s-web-panel">

    <section id="s-deploy" ${HUB_MANAGED_ORIGIN ? "hidden" : ""} class="fstep">
      <div class="fstep-h">第一次使用：选择一种创建方式</div>
      <a class="btn primary" href="https://deploy.workers.cloudflare.com/?url=https://github.com/Famalhaut04/canvas-weekly-hub" target="_blank" rel="noopener">一键创建（需 Cloudflare + GitHub 账号）</a>
      <p class="hint">按部署页面完成授权，部署成功后打开自己的网址。网页与查询代理一起部署，数据不经过作者服务器。</p>
      <details class="faq" id="s-email"><summary>只有邮箱？按这 3 步创建</summary>
        <ol class="setup-steps">
          <li>注册并验证邮箱，登录 <a href="https://dash.cloudflare.com" target="_blank" rel="noopener">Cloudflare</a>，进入 Workers &amp; Pages → Create application，选择 Hello World 创建 Worker 并 Deploy。</li>
          <li>点击下方“复制部署代码”，在 Edit code 中全选替换原代码，再点 Deploy。</li>
          <li>从 Worker 概览 / Domains &amp; Routes 打开正式网址，收藏它；不要用编辑器预览网址。看到“连接你的 Canvas”后再填写令牌。</li>
        </ol>
        <div class="bar"><button class="btn primary" id="s-copycode">复制部署代码</button>
          <a class="btn" href="../worker.js" download="canvas-weekly-hub-v2.2.js">下载部署代码</a></div>
        <p class="hint">复制的是完整 worker.js，不是 worker/runtime.js。创建按钮名称可能变化，详见下方教程。不需要 KV、定时器或 SendKey，也不用安装软件。</p>
      </details>
      <p class="hint"><a href="https://github.com/Famalhaut04/canvas-weekly-hub/blob/main/docs/Cloudflare%E9%83%A8%E7%BD%B2%E5%9B%BE%E6%96%87%E6%95%99%E7%A8%8B.md" target="_blank" rel="noopener">打开分步部署教程</a></p>
    </section>

    ${HUB_MANAGED_ORIGIN ? "<section class=\"fstep\">" : "<details class=\"faq\" id=\"s-legacy\" " + (cfg.worker && cfg.token ? "open" : "") + "><summary>已有旧版小助手？继续使用原配置</summary>"}
      <div class="frow" ${HUB_MANAGED_ORIGIN ? "hidden" : ""}><label for="s-worker">小助手地址</label>
        <input id="s-worker" type="url" autocomplete="off" spellcheck="false" placeholder="https://你的助手.workers.dev"></div>
      <div class="frow"><label for="s-token">Canvas 令牌</label><input id="s-token" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴自己的访问令牌"></div>
      <p class="hint">从 <a id="s-token-help" href="https://canvas.cityu.edu.hk/profile/settings" target="_blank" rel="noopener noreferrer">Canvas 账户 → 设置 → 新访问令牌</a> 获取，填写用途及学校要求的到期日，按只显示一次处理：生成后立即复制并返回这里，丢失时创建 / 再生。具体能否重看以学校界面为准。看不到创建按钮请联系学校；令牌本身不保证只读。</p>
      <div class="frow"><label></label><button class="btn primary" id="s-fetch">连接并生成看板</button></div>
      <details class="faq" id="s-advanced"><summary>其他学校 / 到期日 / 连接检查</summary>
        <div class="frow"><label for="s-canvas">Canvas 地址</label><input id="s-canvas" type="url" spellcheck="false" placeholder="https://canvas.cityu.edu.hk"></div>
        <div class="frow"><label for="s-exp">令牌到期日</label><input id="s-exp" type="date"></div>
        <p class="hint">默认香港城市大学。这里的到期日是选填提醒，不会更改学校令牌期限；学校生成页可能要求填写。只填学校 HTTPS 域名，不附带页面路径。</p>
        <button class="btn" id="s-test">仅检查连接</button>
      </details>
    ${HUB_MANAGED_ORIGIN ? "</section>" : "</details>"}
    <div class="status" id="s-status" role="status" aria-live="polite"></div>

    <section class="fstep" aria-labelledby="s-reminder-title">
      <div class="fstep-h" id="s-reminder-title">更新提醒</div>
      <p><label><input id="s-reminder-enabled" type="checkbox"> 开启更新提醒</label></p>
      <div class="frow"><label for="s-reminder-days">提醒间隔（天）</label>
        <input id="s-reminder-days" type="number" min="1" step="1" inputmode="numeric"></div>
      <p class="hint">默认 3 天。到期只显示提示，不自动查询 Canvas；关闭页面后不会提醒，下次打开再检查。设置仅保存在当前浏览器。</p>
      <button class="btn" id="s-reminder-save">保存提醒设置</button>
      <div id="s-reminder-status" class="status" role="status" aria-live="polite"></div>
    </section>

    <p class="hint" id="s-capabilities">v2.2 暂停云端订阅与微信提醒；日历仍可下载后导入。</p>
    <button class="btn" id="s-unsub" ${cfg.secret ? "" : "hidden"}>停用旧版云端订阅</button>
    <details class="faq"><summary>离线查看 / 旧版数据迁移</summary>
      <div class="bar"><button class="btn" id="s-dlsite">下载离线看板</button><button class="btn" id="s-backup">备份看板数据</button>
        <button class="btn" id="s-import">导入历史数据</button><input id="s-import-file" type="file" accept=".json,application/json" hidden></div>
      <p class="hint">换网址、浏览器或设备时，先在旧页面备份，再导入。备份排除配置中的令牌、SendKey 和订阅密钥，但课程内容并未匿名化；导入会替换当前看板，建议先备份。离线 HTML 是导出时的快照，不会自动更新。</p>
    </details>
    <p class="hint">连接成功或抓取成功后才保存输入。普通看板的数据与令牌保存在当前浏览器。</p>
    </div>
    <div class="setup-head" style="justify-content:space-between;margin-top:12px">
      <button class="btn" id="s-clear" style="color:#c0392b">清除本机数据</button><button class="btn" id="s-close2">关闭</button>
    </div>
  </div>`;
  document.body.appendChild(ov);

  loadReminderForm();
  $("s-reminder-save").onclick = () => {
    try {
      const raw = $("s-reminder-days").value.trim();
      const days = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(days) || days < 1)
        throw new Error("提醒天数应是至少 1 天的正整数");
      const p = { enabled: $("s-reminder-enabled").checked, days };
      HUB_STORE.set("hubUpdateReminder", JSON.stringify(p));
      $("s-reminder-status").textContent = p.enabled ? "已保存：每 " + days + " 天提醒，点击才刷新。" : "已关闭提醒，仍可随时点击“刷新课程”。";
      updateRefreshReminder();
    } catch (e) { $("s-reminder-status").textContent = "未保存：" + e.message; }
  };

  $("s-agent-prompt").value = AGENT_SETUP_PROMPT;
  const chooseRoute = (agent) => {
    $("s-agent-panel").hidden = !agent;
    $("s-web-panel").hidden = agent;
    $("s-agent-entry").className = agent ? "btn primary" : "btn";
    $("s-web-entry").className = agent ? "btn" : "btn primary";
    $("s-agent-entry").setAttribute("aria-expanded", String(agent));
    $("s-web-entry").setAttribute("aria-expanded", String(!agent));
  };
  $("s-agent-entry").onclick = () => chooseRoute(true);
  $("s-web-entry").onclick = () => chooseRoute(false);
  $("s-agent-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(AGENT_SETUP_PROMPT);
      $("s-agent-status").textContent = "已复制提示词，不含你的配置或 Token。";
    } catch (e) {
      $("s-agent-copy-details").open = true;
      $("s-agent-prompt").focus();
      $("s-agent-prompt").select();
      $("s-agent-status").textContent = "复制失败：浏览器未允许访问剪贴板。请在下方手动全选复制提示词。";
    }
  };

  $("s-worker").value = cfg.worker;
  $("s-canvas").value = cfg.canvasUrl;
  $("s-token").value = cfg.token;
  $("s-exp").value = cfg.expires;
  const updateTokenHelp = () => {
    try { $("s-token-help").href = normalizeOrigin($("s-canvas").value, "Canvas 地址") + "/profile/settings"; }
    catch (e) { $("s-token-help").href = "https://canvas.cityu.edu.hk/profile/settings"; }
  };
  $("s-canvas").addEventListener("input", updateTokenHelp);
  updateTokenHelp();


  const status = (msg, color) => {
    const el = $("s-status");
    el.textContent = msg;
    el.style.color = color || "";
  };
  const S_WARN = "#c0392b", S_OK = "#0f8a4f";

  const showCapabilities = (info) => {
    $("s-capabilities").textContent = info.version === "2.2"
      ? "v2.2 已连接。云端订阅与微信提醒暂停，日历可下载后导入。"
      : "小助手使用旧版代码，看板可用；建议更新到 v2.2。云端订阅入口已暂停。";
  };

  const checkWorker = async (c) => {
    let result = await requestText(c.worker + "/health");
    if (result.response.status === 404) result = await requestText(c.worker + "/");
    const { response, body } = result;
    let info;
    try { info = JSON.parse(body); } catch (e) { /* 下面提供统一提示 */ }
    if (!response.ok) throw new Error("小助手服务返回 HTTP " + response.status + "：先检查 Cloudflare 部署、访问保护或服务状态；尚未验证 Canvas 令牌");
    if (!info || info.name !== "canvas-weekly-hub proxy" || info.ok !== true)
      throw new Error("小助手代码不正确：请在 Cloudflare 全选替换为本项目 Worker 代码并 Deploy");
    showCapabilities(info);
    return info;
  };

  $("s-close").onclick = () => { ov.style.display = "none"; };
  $("s-close2").onclick = () => { ov.style.display = "none"; };
  $("s-test").onclick = async () => {
    try {
      await withCanvasTask(async () => {
        const c = readSetup();
        status("正在检查小助手和 Canvas 令牌…");
        await checkWorker(c);
        const me = await workerApi("users/self", {}, c);
        if (!me || !me.id) throw new Error("Canvas 返回的用户信息不完整，本次配置未保存");
        await saveSetup(c);
        status("✅ 身份验证成功，配置已保存：" + (me.name || me.short_name || "已认证") + "。课程尚未读取，请点击“连接并生成看板”验证课程权限。", S_OK);
      });
    } catch (e) { status("❌ " + e.message, S_WARN); }
  };
  $("s-fetch").onclick = async () => {
    try {
      await withCanvasTask(async () => {
        const c = readSetup();
        await checkWorker(c);
        const me = await workerApi("users/self", {}, c);
        if (!me || !me.id) throw new Error("Canvas 认证失败，本次配置未保存");
        const data = await fetchAll(c, status);
        status("✅ 完成：" + data.weeks[0].courses.length + " 门课程已生成看板", S_OK);
        boot(data);
        showFirstTip();
        refreshNotice(data.weeks[0].warnings.length ? "看板已更新，部分内容未能读取，详见课程警告。" : "课程已更新并保存在本浏览器。");
        if (!data.weeks[0].warnings.length) ov.style.display = "none";
        else status("⚠️ 看板已生成，部分内容未能读取：\n" + data.weeks[0].warnings.join("\n"), S_WARN);
      });
    } catch (e) { status("❌ " + e.message, S_WARN); }
  };
  $("s-unsub").onclick = async () => {
    try {
      await withHubTask(async () => {
        const c = hubCfg();
        if (!c.secret) throw new Error("本浏览器没有订阅密钥；如曾在其他设备启用，请在那里关闭或在自己的 KV 中移除 cfg: 配置");
        status("正在关闭云端订阅…");
        const { response: r, body } = await requestText(c.worker + "/unsubscribe", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: c.secret }),
        });
        const j = JSON.parse(body);
        if (!r.ok || !j.ok) throw new Error("关闭失败，请更新 Worker 或在自己的 KV 中移除 cfg: 配置");
        storeTogether({ hubSecret: "", hubSendKey: "" });
        $("s-unsub").hidden = true;
        $("ics-link").href = "deadlines.ics";
        status("✅ 云端订阅配置与快照已移除；定时提醒已停用，本机看板保留。旧日历可能仍显示已缓存的事件。", S_OK);
      });
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
    let wkRevision = 0;
    const wkRun = async () => {
      const v = wkInp.value.trim();
      const revision = wkRevision;
      const el = $("worker-check");
      if (!v) { el.textContent = ""; return; }
      let origin;
      try { origin = normalizeOrigin(v, "小助手地址"); } catch (e) {
        el.style.color = S_WARN;
        el.textContent = "⚠️ " + e.message;
        return;
      }
      el.style.color = ""; el.textContent = "⏳ 正在检查…";
      try {
        const { response: r, body } = await requestText(origin + "/");
        if (revision !== wkRevision) return;
        let j = null;
        try { j = JSON.parse(body); } catch (e) {}
        if (r.ok && j && j.ok === true && j.name === "canvas-weekly-hub proxy") {
          el.style.color = S_OK; el.textContent = "✅ 小助手在线";
          showCapabilities(j);
        } else {
          el.style.color = S_WARN; el.textContent = "⚠️ 能连上但不是本项目的代码：回 Cloudflare 确认已粘贴";
        }
      } catch (e) {
        if (revision !== wkRevision) return;
        el.style.color = S_WARN; el.textContent = "❌ 连不上：检查地址拼写，或部署还没完成";
      }
    };
    wkInp.addEventListener("input", () => {
      wkRevision += 1;
      $("worker-check").textContent = "";
      $("s-capabilities").textContent = "v2.2 暂停云端订阅与微信提醒；日历仍可下载后导入。";
      clearTimeout(wkTimer); wkTimer = setTimeout(wkRun, 700);
    });
    if (wkInp.value && !HUB_MANAGED_ORIGIN) wkRun();
  }

  $("s-copycode").onclick = async () => {
    try {
      const r = await fetch("../worker.js");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const code = await r.text();
      try {
        await navigator.clipboard.writeText(code);
        status("✅ 代码已复制。到 Cloudflare 的 Edit code 全选粘贴并 Deploy，然后打开自己的网址。", S_OK);
      } catch (clipboardError) {
        triggerDownload(new Blob([code], { type: "text/javascript;charset=utf-8" }), "canvas-weekly-hub-v2.2.js");
        status("浏览器未允许复制，已下载部署代码；用文本编辑器打开后全选复制到 Cloudflare。", S_WARN);
      }
    } catch (e) {
      status("无法读取部署代码：" + e.message + "。请使用旁边的“下载部署代码”按钮。", S_WARN);
    }
  };
  $("s-dlsite").onclick = async () => {
    try {
      await downloadWebsite();
      status("✅ 已开始下载「我的学习网站.html」——双击即可打开，可拷到手机离线查看", S_OK);
    } catch (e) {
      status("❌ 下载失败：" + e.message, S_WARN);
    }
  };
  $("s-backup").onclick = () => {
    try { downloadBackup(); status("✅ 已下载看板备份，不含令牌或 SendKey。", S_OK); }
    catch (e) { status("❌ " + e.message, S_WARN); }
  };
  $("s-import").onclick = () => $("s-import-file").click();
  $("s-import-file").onchange = async () => {
    const file = $("s-import-file").files[0];
    if (!file) return;
    try {
      await withCanvasTask(async () => {
        if (file.size > 10 * 1024 * 1024) throw new Error("备份文件超过 10 MB，请选择看板导出的 JSON 文件");
        const backup = validateBackup(JSON.parse(await file.text()));
        const selectedCanvas = normalizeOrigin($("s-canvas").value, "Canvas 地址");
        if (normalizeOrigin(backup.data.canvas_url, "备份学校地址") !== selectedCanvas)
          throw new Error("备份的学校与当前设置不同，请先在“其他学校”选项中填写对应 Canvas 地址");
        storeTogether({ hubData: JSON.stringify(backup.data), hubLastState: JSON.stringify(backup.state),
          hubRefreshState: JSON.stringify({ version: 1, binding: await refreshBinding(hubCfg()), successAt: null }) });
        boot(backup.data);
        updateRefreshReminder();
        status("✅ 已导入 " + backup.data.weeks.length + " 份历史记录；令牌未导入，请填写自己的令牌。", S_OK);
      });
    } catch (e) { status("❌ 无法导入：" + e.message, S_WARN); }
    finally { $("s-import-file").value = ""; }
  };
  $("s-clear").onclick = () => {
    if (!confirm("确定清除本浏览器里的全部看板数据与令牌？这不会撤销 Canvas 令牌或云端订阅；如已启用订阅，请先点击“停用旧版云端订阅”。")) return;
    try {
    ["hubData", "hubLastState", "hubWorker", "hubCanvasUrl", "hubToken",
     "hubExpires", "hubSendKey", "hubSecret", "hubUpdateReminder", "hubRefreshState"].forEach((k) => HUB_STORE.del(k));
    reminderDismissed = "";
    updateRefreshReminder();
    status("已清除。刷新页面将回到初始状态。");
    setTimeout(() => location.reload(), 700);
    } catch (e) { status("❌ 无法清除浏览器存储，请通过浏览器的本站数据设置处理", S_WARN); }
  };
}

function readSetup() {
  const g = (id) => (document.getElementById(id) ? document.getElementById(id).value.trim() : "");
  return validateHubCfg({ worker: HUB_MANAGED_ORIGIN || g("s-worker"), canvasUrl: g("s-canvas"), token: g("s-token"),
    expires: g("s-exp"), sendkey: "", secret: hubCfg().secret });
}

async function saveSetup(inputCfg) {
  const c = validateHubCfg(inputCfg || readSetup());
  const binding = await refreshBinding(c);
  const values = configValues(c);
  if (await refreshBinding(hubCfg()) !== binding)
    values.hubRefreshState = JSON.stringify({ version: 1, binding, successAt: null });
  storeTogether(values);
  updateRefreshReminder();
  $("s-worker").value = c.worker;
  $("s-canvas").value = c.canvasUrl;
  return c;
}

function configValues(c) {
  return { hubWorker: c.worker, hubCanvasUrl: c.canvasUrl, hubToken: c.token,
    hubExpires: c.expires || "", hubSendKey: c.sendkey || "", hubSecret: c.secret || "" };
}

function validateBackup(value) {
  const data = value && value.format === "canvas-weekly-hub-backup" && value.version === 1 && value.data;
  if (!data || !Array.isArray(data.weeks) || !data.weeks.length || data.weeks.length > 52)
    throw new Error("请选择本项目导出的看板备份文件（最多 52 份历史记录）");
  normalizeOrigin(data.canvas_url, "备份学校地址");
  for (const week of data.weeks) {
    if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week.date) || !Array.isArray(week.courses))
      throw new Error("备份周报格式不正确");
    for (const course of week.courses) {
      if (!course || ["new_assignments", "upcoming", "new_files", "announcements", "changes"]
        .some((key) => !Array.isArray(course[key]) || course[key].some((item) => !item || typeof item !== "object")))
        throw new Error("备份课程格式不正确");
    }
    if (week.warnings && (!Array.isArray(week.warnings) || week.warnings.some((item) => typeof item !== "string")))
      throw new Error("备份警告格式不正确");
  }
  const state = value.state || { assignments: {} };
  if (!state.assignments || typeof state.assignments !== "object" || Array.isArray(state.assignments))
    throw new Error("备份快照格式不正确");
  for (const course of Object.values(state.assignments)) {
    if (!course || typeof course !== "object" || Array.isArray(course) ||
        Object.values(course).some((item) => !item || typeof item !== "object" || Array.isArray(item)))
      throw new Error("备份快照格式不正确");
  }
  // 仅导入明确的数据字段，忽略备份中额外的配置 / 凭证字段。
  return { data: { site_title: data.site_title, canvas_url: data.canvas_url, username: data.username,
    tz_label: data.tz_label, updated_at: data.updated_at, weeks: data.weeks }, state: { assignments: state.assignments } };
}

function buildBackup() {
  let data, state;
  try {
    data = JSON.parse(HUB_STORE.get("hubData") || "null");
    state = JSON.parse(HUB_STORE.get("hubLastState") || "null");
  } catch (e) { throw new Error("本机数据损坏，请先重新抓取课程"); }
  const clean = validateBackup({ format: "canvas-weekly-hub-backup", version: 1, data, state });
  return { format: "canvas-weekly-hub-backup", version: 1, data: clean.data, state: clean.state };
}

function downloadBackup() {
  triggerDownload(new Blob([JSON.stringify(buildBackup(), null, 2)], { type: "application/json;charset=utf-8" }),
    fmtDate(new Date()) + "_Canvas看板备份_v1.json");
}

/* ---------------- 新手引导条 & 更新按钮 ---------------- */
function showFirstTip() {
  if (document.getElementById("first-tip")) return;
  if (HUB_STORE.get("hubTipDone")) return;
  const main = document.querySelector("main");
  if (!main) return;
  const tip = document.createElement("div");
  tip.id = "first-tip";
  tip.innerHTML = `<span>🎉 <b>看板已就绪！</b>常用三件事：
    ① 点击顶部 <b>刷新课程</b> 查询最新数据，到期提醒可在设置中调整；
    ② 顶部 <b>📅 截止日历</b> 可导入手机，到点自动提醒；
    ③ <b>⚙️ 设置</b> 里可下载离线版「我的学习网站.html」。</span>
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
refreshBtn.className = "icon-btn refresh-action";
refreshBtn.title = "按已保存的配置查询最新课程，不提交设置中的草稿";
refreshBtn.textContent = "刷新课程";
document.getElementById("settings-btn").parentElement.insertBefore(
  refreshBtn, document.getElementById("settings-btn"));
refreshBtn.onclick = async () => {
  const c = hubCfg();
  if (!c.worker || !c.token) { showSetup(); return; }
  if (hubBusy) return;
  refreshBtn.textContent = "刷新中…";
  refreshNotice("正在查询 Canvas，请稍候…");
  try {
    await withCanvasTask(async () => {
      const data = await fetchAll();
      boot(data);
      showFirstTip();
      const warnings = data.weeks[0].warnings;
      refreshNotice(warnings.length ? "看板已更新，部分内容未能读取：" + warnings.join("；") : "课程已更新并保存在本浏览器。");
    });
  } catch (e) {
    refreshNotice("本次未更新：" + e.message + "。旧看板保留；可在设置中检查配置。");
  } finally {
    refreshBtn.textContent = "刷新课程";
  }
};
const reminderRefresh = document.getElementById("reminder-refresh");
if (reminderRefresh) reminderRefresh.onclick = () => refreshBtn.onclick();

if (document.addEventListener) document.addEventListener("visibilitychange", updateRefreshReminder);
if (window.addEventListener) {
  window.addEventListener("focus", updateRefreshReminder);
  window.addEventListener("pageshow", updateRefreshReminder);
  window.addEventListener("storage", (e) => {
    if (e.key === null || ["hubRefreshState", "hubData", "hubUpdateReminder", "hubToken", "hubCanvasUrl", "hubWorker"].includes(e.key)) {
      // storage 事件不传递正文给其他服务，仅在同源浏览器内重新读取已保存的看板。
      try {
        const data = JSON.parse(HUB_STORE.get("hubData") || "null");
        if (data && Array.isArray(data.weeks) && data.weeks.length) boot(data);
      } catch (error) { refreshNotice("本地看板数据无法读取，请在设置中检查或恢复备份。"); }
      updateRefreshReminder();
    }
  });
}

const _bootRaw = window.__HUB_BOOT__;
window.__HUB_BOOT__ = function () {
  _bootRaw();
  // 数据就绪后补上新手引导条（仅网页版）
  const has = (() => { try {
    const d = JSON.parse(HUB_STORE.get("hubData") || "null");
    return !!(d && d.weeks && d.weeks.length);
  } catch (e) { return false; } })();
  if (has) showFirstTip();
  updateRefreshReminder();
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
