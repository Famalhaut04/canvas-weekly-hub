/* 离线回归：所有课程和凭证都是测试夹具，不请求真实 Canvas / Cloudflare。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "web/overrides.js"), "utf8");
const cfg = { worker: "https://fixture.example", canvasUrl: "https://canvas.example",
  token: "fixture-token", expires: "", sendkey: "", secret: "" };
const info = { name: "canvas-weekly-hub proxy", ok: true,
  capabilities: { subscriptions: false } };

function harness(seed = {}, route = async () => new Response("[]"), options = {}) {
  const values = new Map(Object.entries(seed));
  values.set("hubStars", JSON.stringify({ n: 1, t: Date.now() }));
  const nodes = new Map();
  const timers = new Map();
  let timerId = 0;
  class Element {
    constructor() {
      this.style = {}; this.value = ""; this.textContent = "";
      this.disabled = false; this.href = "#";
      this.parentElement = { insertBefore: (el) => nodes.set(el.id, el), appendChild: (el) => nodes.set(el.id, el) };
    }
    set innerHTML(html) {
      this.html = html;
      for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Element());
    }
    get innerHTML() { return this.html; }
    addEventListener(type, fn) { this[type] = fn; }
    dispatchEvent(event) { if (this[event.type]) this[event.type](event); }
    removeAttribute() {}
    setAttribute(key, value) { this[key] = value; }
    focus() { this.focused = true; }
    select() { this.selected = true; }
  }
  for (const id of ["settings-btn", "ics-link", "star-count", ...(options.reminder ?
    ["refresh-time", "refresh-plan", "refresh-message", "refresh-reminder", "reminder-text", "reminder-later", "reminder-refresh"] : [])]) nodes.set(id, new Element());
  const events = {};
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const calls = [];
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, Response, Event, Date: options.Date || Date, Uint8Array, TextEncoder,
    crypto: webcrypto, localStorage: storage,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, requestOptions) => {
      calls.push({ url: String(url), options: requestOptions });
      if (String(url).endsWith("/health") && !options.health) return response({ error: "legacy route" }, 404);
      return route(String(url), requestOptions);
    },
    document: {
      getElementById: (id) => nodes.get(id) || null,
      createElement: () => new Element(), querySelector: () => null,
      body: { appendChild: (el) => nodes.set(el.id, el) },
      addEventListener: (type, fn) => { events[type] = fn; }, hidden: false,
    },
    window: { __HUB_BOOT__: () => {}, __HUB_WORKER_ORIGIN__: options.managedOrigin || "",
      addEventListener: (type, fn) => { events[type] = fn; } },
    navigator: { locks: { request: async (name, settings, fn) => fn({ name }) } }, location: { reload() {} },
    confirm: () => false, alert() {}, boot() {},
    $: (id) => nodes.get(id),
  });
  vm.runInContext(SOURCE + "\nglobalThis.api = {normalizeOrigin, validateHubCfg, hubCfg, fetchAll, apiAll, showSetup, withHubTask, withCanvasTask, requestText, readSetup, buildBackup, validateBackup, reminderPrefs, refreshBinding, currentRefreshState, legacyRefreshTime, updateRefreshReminder, saveSetup};", context);
  const form = (c = cfg) => {
    context.api.showSetup();
    for (const [id, field] of Object.entries({ "s-worker": "worker", "s-canvas": "canvasUrl",
      "s-token": "token", "s-exp": "expires", "s-sendkey": "sendkey" })) { if (nodes.has(id)) nodes.get(id).value = c[field]; }
  };
  return { context, api: context.api, values, nodes, storage, timers, calls, form, events };
}

function response(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
function saved(c = cfg) {
  return { hubWorker: c.worker, hubCanvasUrl: c.canvasUrl, hubToken: c.token,
    hubExpires: c.expires, hubSendKey: c.sendkey };
}

function clock(initial = Date.parse("2026-10-02T04:00:00Z")) {
  let value = initial;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [value])); }
    static now() { return value; }
  }
  return { Date: Clock, now: () => value, advance: (ms) => { value += ms; } };
}

async function reminderHarness(age, options = {}) {
  const time = options.time || clock();
  const h = harness(saved(), options.route, { ...options, reminder: true, Date: time.Date });
  const binding = await h.api.refreshBinding(cfg);
  h.values.set("hubRefreshState", JSON.stringify({ version: 1, binding, successAt: time.now() - age }));
  await h.api.updateRefreshReminder();
  return { ...h, time };
}

test("72 小时边界只提示，不自动查询；时间按设备时区显示", async () => {
  for (const age of [72 * 3600000 - 1, 72 * 3600000, 72 * 3600000 + 1]) {
    const h = await reminderHarness(age);
    assert.equal(h.nodes.get("refresh-reminder").hidden, age < 72 * 3600000);
    assert.equal(h.calls.length, 0);
    const stamp = JSON.parse(h.values.get("hubRefreshState")).successAt;
    assert.ok(h.nodes.get("refresh-time").textContent.includes(new Date(stamp).toLocaleString("zh-CN", { hour12: false })));
    assert.match(h.nodes.get("refresh-time").textContent, /设备时区/);
  }
});

test("前台跨阈值与休眠恢复只检查提醒，后台取消定时", async () => {
  const h = await reminderHarness(72 * 3600000 - 2000);
  const scheduled = [...h.timers.values()].find((t) => t.delay === 2000);
  assert.ok(scheduled);
  h.time.advance(2000); await scheduled.fn();
  assert.equal(h.nodes.get("refresh-reminder").hidden, false);
  h.context.document.hidden = true; await h.events.visibilitychange();
  assert.equal(h.timers.size, 0);
  h.time.advance(10 * 86400000);
  h.context.document.hidden = false; await h.events.visibilitychange(); await h.events.focus(); await h.events.pageshow();
  assert.equal(h.nodes.get("refresh-reminder").hidden, false);
  assert.equal(h.calls.length, 0);
});

test("暂不刷新不改成功时间，同页不重复，重开仍会提醒", async () => {
  const h = await reminderHarness(4 * 86400000);
  const original = h.values.get("hubRefreshState");
  h.nodes.get("reminder-later").onclick(); await h.api.updateRefreshReminder();
  await h.events.pageshow();
  assert.equal(h.nodes.get("refresh-reminder").hidden, true);
  assert.equal(h.values.get("hubRefreshState"), original);
  assert.equal(h.calls.length, 0);
  const reopened = harness(Object.fromEntries(h.values), undefined, { reminder: true, Date: h.time.Date });
  await reopened.api.updateRefreshReminder();
  assert.equal(reopened.nodes.get("refresh-reminder").hidden, false);
  assert.equal(reopened.calls.length, 0);
});

test("自定义天数、关闭和重载只保存提醒字段，不提交 Token 草稿", async () => {
  const h = await reminderHarness(2 * 86400000); h.form({ ...cfg, token: "unsaved-fixture" });
  const original = h.values.get("hubRefreshState");
  h.nodes.get("s-reminder-days").value = "2"; h.nodes.get("s-reminder-save").onclick();
  await h.api.updateRefreshReminder();
  assert.match(h.nodes.get("reminder-text").textContent, /满 2 天/);
  assert.equal(h.nodes.get("refresh-reminder").hidden, false);
  assert.equal(h.values.get("hubToken"), cfg.token);
  assert.equal(h.values.get("hubRefreshState"), original);
  h.nodes.get("s-reminder-enabled").checked = false; h.nodes.get("s-reminder-save").onclick();
  await h.api.updateRefreshReminder();
  assert.equal(h.nodes.get("refresh-reminder").hidden, true);
  assert.equal(h.nodes.get("refresh-btn").disabled, false);
  const next = harness(Object.fromEntries(h.values)); next.form();
  assert.equal(next.nodes.get("s-reminder-enabled").checked, false);
  assert.equal(next.nodes.get("s-reminder-days").value, "2");
  assert.equal(h.calls.filter((c) => c.url.includes("/proxy/")).length, 0);
});

test("不接受零、负数、小数、空值或溢出的提醒天数", () => {
  const h = harness(); h.form();
  for (const value of ["0", "-1", "1.5", "", "9007199254740992"]) {
    h.nodes.get("s-reminder-days").value = value; h.nodes.get("s-reminder-save").onclick();
    assert.match(h.nodes.get("s-reminder-status").textContent, /未保存.*正整数/);
    assert.equal(h.values.has("hubUpdateReminder"), false);
  }
});

test("旧时间只按明确 UTC 偏移解释，模糊或无效时间保持未知", async () => {
  const h = harness(saved(), undefined, { reminder: true });
  const old = { canvas_url: cfg.canvasUrl, updated_at: "2026-10-01 12:30", tz_label: "UTC+8", weeks: [] };
  h.values.set("hubData", JSON.stringify(old));
  assert.equal((await h.api.currentRefreshState()).successAt, Date.parse("2026-10-01T04:30:00Z"));
  assert.equal(h.api.legacyRefreshTime({ ...old, tz_label: "UTC+5.5" }), Date.parse("2026-10-01T07:00:00Z"));
  for (const data of [{ ...old, tz_label: "Asia/Shanghai" }, { ...old, updated_at: "2026-02-30 12:00" },
    { ...old, updated_at: "昨天" }, { ...old, tz_label: "" }, { ...old, updated_at: "2026-10-01 25:00" }]) {
    h.values.set("hubData", JSON.stringify(data)); await h.api.updateRefreshReminder();
    assert.match(h.nodes.get("refresh-time").textContent, /更新时间未知/);
    assert.equal(h.nodes.get("refresh-reminder").hidden, true);
  }
  assert.equal(h.calls.length, 0);
});

test("成功查询并保存后才更新时间，手动刷新仅使用已保存配置", async () => {
  const h = await reminderHarness(4 * 86400000, { route: async () => response([]) });
  h.form({ ...cfg, token: "unsaved-fixture" });
  await h.nodes.get("refresh-btn").onclick();
  assert.equal(h.calls.filter((c) => c.url.includes("/proxy/")).length, 1);
  assert.equal(h.calls.find((c) => c.url.includes("/proxy/")).options.headers["X-Canvas-Token"], cfg.token);
  assert.equal(h.values.get("hubToken"), cfg.token);
  assert.equal(JSON.parse(h.values.get("hubRefreshState")).successAt, h.time.now());
  assert.equal(h.nodes.get("refresh-btn").disabled, false);
  assert.equal(h.nodes.get("refresh-btn").textContent, "刷新课程");
  assert.match(h.nodes.get("refresh-message").textContent, /已更新并保存/);
  await h.api.updateRefreshReminder();
  assert.equal(h.nodes.get("refresh-reminder").hidden, true);
});

test("401、403、服务错误保留原看板、快照和成功时间", async () => {
  for (const status of [401, 403, 502, 503]) {
    const h = await reminderHarness(4 * 86400000, { route: async () => response({}, status) });
    h.values.set("hubData", "old-board"); h.values.set("hubLastState", "old-snapshot");
    const original = h.values.get("hubRefreshState");
    await h.nodes.get("refresh-btn").onclick();
    assert.equal(h.values.get("hubData"), "old-board"); assert.equal(h.values.get("hubLastState"), "old-snapshot");
    assert.equal(h.values.get("hubRefreshState"), original);
    assert.equal(h.nodes.get("refresh-btn").disabled, false);
    assert.match(h.nodes.get("refresh-message").textContent, status === 401 ? /令牌无效或已过期/ :
      status === 403 ? /权限/ : /查询服务返回 HTTP.*部署.*不能判断令牌/);
  }
});

test("刷新超时和网络中断不推进成功时间，也不反复弹窗", async () => {
  const h = await reminderHarness(4 * 86400000, { route: async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("fixture aborted")));
  }) });
  h.values.set("hubData", "old-board"); const original = h.values.get("hubRefreshState");
  const pending = h.nodes.get("refresh-btn").onclick();
  while (!h.calls.length) await new Promise((resolve) => setImmediate(resolve));
  [...h.timers.values()].find((t) => t.delay === 20000).fn(); await pending;
  assert.equal(h.values.get("hubRefreshState"), original); assert.equal(h.values.get("hubData"), "old-board");
  assert.match(h.nodes.get("refresh-message").textContent, /超过 20 秒/);
  const offline = await reminderHarness(4 * 86400000, { route: async () => { throw new Error("fixture network unavailable"); } });
  const before = offline.values.get("hubRefreshState"); await offline.nodes.get("refresh-btn").onclick();
  assert.equal(offline.values.get("hubRefreshState"), before);
  assert.match(offline.nodes.get("refresh-message").textContent, /本次未更新.*network unavailable/);
  assert.equal(offline.nodes.has("setup-overlay"), false);
});

test("写入成功时间失败回滚整组存储，不能宣称刷新成功", async () => {
  const h = await reminderHarness(4 * 86400000, { route: async () => response([]) });
  h.values.set("hubData", "old-board"); h.values.set("hubLastState", "old-snapshot");
  const original = h.values.get("hubRefreshState"), put = h.storage.setItem;
  let fail = true;
  h.storage.setItem = (key, value) => {
    if (key === "hubRefreshState" && fail) { fail = false; throw new Error("quota"); }
    put(key, value);
  };
  await h.nodes.get("refresh-btn").onclick();
  assert.equal(h.values.get("hubData"), "old-board"); assert.equal(h.values.get("hubLastState"), "old-snapshot");
  assert.equal(h.values.get("hubRefreshState"), original);
  assert.match(h.nodes.get("refresh-message").textContent, /本次未更新.*空间不足/);
});

test("可选内容失败保存可用结果，成功时间与警告均保留", async () => {
  const h = await reminderHarness(4 * 86400000, { route: async (url) => {
    if (url.includes("/proxy/courses?")) return response([{ id: 1, name: "Fixture Course" }]);
    if (url.includes("/files?")) return response({}, 403);
    return response([]);
  } });
  await h.nodes.get("reminder-refresh").onclick();
  assert.equal(JSON.parse(h.values.get("hubRefreshState")).successAt, h.time.now());
  assert.equal(JSON.parse(h.values.get("hubData")).weeks[0].warnings.length, 1);
  assert.match(h.nodes.get("refresh-message").textContent, /部分内容未能读取.*课件/);
});

test("更换令牌或学校后不沿用旧身份更新时间，仅检查不制造成功时间", async () => {
  const h = await reminderHarness(4 * 86400000); h.form();
  const original = h.values.get("hubRefreshState");
  await h.api.saveSetup(cfg); assert.equal(h.values.get("hubRefreshState"), original);
  await h.api.saveSetup({ ...cfg, token: "new-fixture-token" });
  assert.equal(JSON.parse(h.values.get("hubRefreshState")).successAt, null);
  await h.api.updateRefreshReminder(); assert.match(h.nodes.get("refresh-time").textContent, /未知/);
  h.values.set("hubCanvasUrl", "https://other-canvas.example");
  assert.equal((await h.api.currentRefreshState()).successAt, null);
});

test("查询途中另页更换配置，结果不覆盖新配置或旧看板", async () => {
  let release;
  const h = await reminderHarness(4 * 86400000, { route: async () => new Promise((resolve) => { release = resolve; }) });
  h.values.set("hubData", "old-board"); const original = h.values.get("hubRefreshState");
  const pending = h.nodes.get("refresh-btn").onclick();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.values.set("hubToken", "other-fixture-token"); release(response([])); await pending;
  assert.equal(h.values.get("hubData"), "old-board"); assert.equal(h.values.get("hubRefreshState"), original);
  assert.match(h.nodes.get("refresh-message").textContent, /配置已.*更改/);
});

test("多入口和两页共享锁：竞争操作不查询、不排队、结束恢复", async () => {
  let active = false, release;
  const locks = { request: async (name, options, fn) => {
    assert.equal(name, "canvas-hub-user-query"); assert.equal(options.ifAvailable, true);
    if (active) return fn(null);
    active = true; try { return await fn({ name }); } finally { active = false; }
  } };
  const first = await reminderHarness(4 * 86400000, { route: async () => new Promise((resolve) => { release = resolve; }) });
  const second = await reminderHarness(4 * 86400000);
  first.context.navigator.locks = second.context.navigator.locks = locks;
  const pending = first.nodes.get("refresh-btn").onclick();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await first.nodes.get("reminder-refresh").onclick(); await second.nodes.get("refresh-btn").onclick();
  assert.equal(first.calls.filter((c) => c.url.includes("/proxy/")).length, 1);
  assert.equal(second.calls.length, 0);
  assert.match(second.nodes.get("refresh-message").textContent, /另一个标签页/);
  release(response([])); await pending;
  assert.equal(first.nodes.get("reminder-refresh").disabled, false);
  assert.equal(second.nodes.get("refresh-btn").disabled, false);
});

test("缺少浏览器锁时明确提示，保存禁用时不误保存提醒", async () => {
  const h = await reminderHarness(4 * 86400000); h.context.navigator.locks = undefined;
  await h.nodes.get("refresh-btn").onclick();
  assert.match(h.nodes.get("refresh-message").textContent, /不支持多标签页刷新保护/);
  assert.equal(h.calls.length, 0);
  h.form(); h.storage.setItem = () => { throw new Error("blocked"); };
  h.nodes.get("s-reminder-save").onclick();
  assert.match(h.nodes.get("s-reminder-status").textContent, /未保存.*浏览器无法保存/);
  assert.equal(h.values.has("hubUpdateReminder"), false);
});

test("清除数据同步清除提醒与成功时间；导入不伪造本机查询成功", async () => {
  const h = await reminderHarness(4 * 86400000); h.form();
  const data = { canvas_url: cfg.canvasUrl, updated_at: "2026-10-01 12:00", tz_label: "UTC+8",
    weeks: [{ date: "2026-10-01", courses: [] }] };
  const backup = { format: "canvas-weekly-hub-backup", version: 1, data, state: { assignments: {} } };
  h.nodes.get("s-import-file").files = [{ size: 20, text: async () => JSON.stringify(backup) }];
  await h.nodes.get("s-import-file").onchange();
  assert.equal((await h.api.currentRefreshState()).successAt, null);
  h.values.set("hubUpdateReminder", JSON.stringify({ enabled: false, days: 5 }));
  h.context.confirm = () => true; h.nodes.get("s-clear").onclick(); await h.api.updateRefreshReminder();
  for (const key of ["hubToken", "hubData", "hubRefreshState", "hubUpdateReminder"]) assert.equal(h.values.has(key), false);
  assert.equal(h.api.reminderPrefs().days, 3);
  assert.equal(h.nodes.get("refresh-reminder").hidden, true);
});

test("Issue #4 夹具：读取完整但显示范围不会因重复刷新而扩大", async () => {
  const time = clock(), iso = (days) => new Date(time.now() + days * 86400000).toISOString();
  const assignment = (id, name, created, due, wf = "unsubmitted", url = "https://canvas.example/assignments/" + id) =>
    ({ id, name, created_at: iso(created), updated_at: iso(created), due_at: due === null ? null : iso(due),
      html_url: url, submission: { workflow_state: wf } });
  const tasks = [assignment(1, "旧任务远期截止", -30, 30), assignment(2, "近期新增远期截止", -1, 30),
    assignment(3, "旧任务近期截止", -30, 2), assignment(4, "已提交近期截止", -30, 3, "submitted"),
    assignment(5, "无截止任务", -1, null), assignment(6, "逾期任务", -1, -1),
    assignment(7, "七日当天晚间任务", -30, 7.49), assignment(8, "个人截止覆盖", -30, 4)];
  const h = harness(saved(), async (url) => {
    if (url.includes("/proxy/courses?")) return response([{ id: 1, name: "Fixture Course" }]);
    if (url.includes("/assignments?")) return response(tasks);
    return response([]);
  }, { Date: time.Date });
  const template = fs.readFileSync(path.join(ROOT, "site-template/index.html"), "utf8");
  const source = template.slice(template.indexOf("function allTodo("), template.indexOf("function render()"));
  vm.runInContext(source + "\nglobalThis.fixtureTodo = allTodo;", h.context);
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await h.api.fetchAll(cfg);
    const names = Array.from(h.context.fixtureTodo(data.weeks[0]), (task) => task.name);
    assert.deepEqual(names, ["旧任务近期截止", "已提交近期截止", "个人截止覆盖", "近期新增远期截止"]);
    assert.equal(Object.keys(JSON.parse(h.values.get("hubLastState")).assignments[1]).length, 8);
    assert.equal(JSON.parse(h.values.get("hubData")).weeks[0].courses[0].new_assignments.length, 3);
  }
  // 用户接口给出的 due_at 就是本程序使用的截止时间；没有请求课程 overrides 来重算。
  assert.ok(h.calls.filter((c) => c.url.includes("/assignments?")).every((c) => c.url.includes("include%5B%5D=submission")));
  const sameName = { name: "同名测试", due_iso: iso(2), url: "" };
  const collision = h.context.fixtureTodo({ courses: ["A", "B"].map((name) =>
    ({ name, url: "https://canvas.example/courses/" + name, upcoming: [sameName], new_assignments: [] })) });
  assert.equal(collision.length, 1, "当前缺少 URL 的跨课同名任务会合并，记录为独立修复建议，不在本轮更改范围");
});

test("Issue #4 分页夹具：第二页作业进入快照和待办", async () => {
  const time = clock();
  const old = Array.from({ length: 100 }, (_, id) => ({ id, name: "Fixture Old " + id,
    created_at: "2020-01-01T00:00:00Z", due_at: null }));
  const h = harness(saved(), async (url) => {
    if (url.includes("/proxy/courses?")) return response([{ id: 1, name: "Fixture Course" }]);
    if (url.includes("/assignments?")) return response(new URL(url).searchParams.get("page") === "1" ? old : [{
      id: 100, name: "Fixture Page Two", created_at: "2020-01-01T00:00:00Z",
      due_at: new Date(time.now() + 86400000).toISOString(), html_url: "https://canvas.example/assignments/100" }]);
    return response([]);
  }, { Date: time.Date });
  const data = await h.api.fetchAll(cfg);
  assert.equal(Object.keys(JSON.parse(h.values.get("hubLastState")).assignments[1]).length, 101);
  assert.equal(data.weeks[0].courses[0].upcoming[0].name, "Fixture Page Two");
  assert.equal(h.calls.filter((c) => c.url.includes("/assignments?")).length, 2);
});

test("agent 路线切换不验证或保存 Token，返回网页保留草稿", () => {
  const h = harness(); h.form();
  h.nodes.get("s-agent-entry").onclick();
  assert.equal(h.nodes.get("s-web-panel").hidden, true);
  assert.equal(h.nodes.get("s-agent-entry")["aria-expanded"], "true");
  assert.equal(h.values.get("hubToken"), undefined);
  h.nodes.get("s-web-entry").onclick();
  assert.equal(h.nodes.get("s-agent-panel").hidden, true);
  assert.equal(h.nodes.get("s-token").value, cfg.token);
  assert.equal(h.calls.length, 0);
});

test("复制 agent 提示词不包含填写的凭证，也不发起网络请求", async () => {
  const h = harness(); h.form(); let copied;
  h.context.navigator.clipboard = { writeText: async (text) => { copied = text; } };
  await h.nodes.get("s-agent-copy").onclick();
  assert.ok(!copied.includes(cfg.token));
  assert.match(copied, /github.push_enabled=false/);
  assert.match(copied, /--check-config/);
  assert.match(copied, /云端 agent/);
  assert.match(copied, /安装软件或依赖前征求同意/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.values.get("hubToken"), undefined);
});

test("剪贴板拒绝时展开提示词并聚焦选择，不丢失草稿", async () => {
  const h = harness(); h.form();
  h.context.navigator.clipboard = { writeText: async () => { throw new Error("denied"); } };
  await h.nodes.get("s-agent-copy").onclick();
  assert.equal(h.nodes.get("s-agent-copy-details").open, true);
  assert.equal(h.nodes.get("s-agent-prompt").focused, true);
  assert.equal(h.nodes.get("s-agent-prompt").selected, true);
  assert.match(h.nodes.get("s-agent-status").textContent, /复制失败.*手动/);
  assert.equal(h.nodes.get("s-token").value, cfg.token);
});

test("Worker 服务错误先处理部署问题，不误报学校 Token 无效", async () => {
  const h = harness(saved(), async () => response({ error: "service failure" }, 503), { health: true });
  h.form({ ...cfg, token: "new-fixture-token" });
  await h.nodes.get("s-test").onclick();
  assert.match(h.nodes.get("s-status").textContent, /小助手服务返回 HTTP 503.*尚未验证 Canvas 令牌/);
  assert.equal(h.values.get("hubToken"), cfg.token);
  assert.ok(!h.calls.some((call) => call.url.includes("/proxy/")));
});

test("身份检查成功明确未验证课程读取", async () => {
  const h = harness({}, async (url) => url.endsWith("/health") ? response(info) : response({ id: 1 }), { health: true });
  h.form(); await h.nodes.get("s-test").onclick();
  assert.match(h.nodes.get("s-status").textContent, /身份验证成功.*课程尚未读取/);
  assert.equal(h.calls.length, 2);
  assert.ok(!h.calls.some((call) => call.url.includes("courses")));
});

test("HTTPS 自定义域名可用，拒绝路径、账号和非 HTTPS", () => {
  const { api } = harness();
  assert.equal(api.normalizeOrigin(" https://my-worker.example/ ", "地址"), "https://my-worker.example");
  for (const url of ["http://fixture.example", "https://fixture.example/profile", "https://user:pass@fixture.example",
    "https://fixture.example?token=x", "https://fixture.example#x", "file:///tmp/test", "not-a-url"]) {
    assert.throws(() => api.normalizeOrigin(url, "地址"));
  }
});

test("令牌与到期日期校验，接受有效闰日", () => {
  const { api } = harness();
  assert.equal(api.validateHubCfg({ ...cfg, expires: "2028-02-29" }).expires, "2028-02-29");
  for (const expires of ["2026-02-29", "2026-04-31", "2026/10/02"]) {
    assert.throws(() => api.validateHubCfg({ ...cfg, expires }), /到期日/);
  }
  assert.throws(() => api.validateHubCfg({ ...cfg, token: "" }), /令牌/);
  assert.throws(() => api.validateHubCfg({ ...cfg, token: "fixture\ntoken" }), /令牌/);
});

test("连接失败保留原配置", async () => {
  const h = harness(saved(), async (url) => url.endsWith("/") ? response(info) : response({ error: "invalid" }, 401));
  h.form({ ...cfg, token: "bad-fixture-token" });
  await h.nodes.get("s-test").onclick();
  assert.equal(h.values.get("hubToken"), cfg.token);
  assert.match(h.nodes.get("s-status").textContent, /401/);
  assert.equal(h.nodes.get("s-test").disabled, false);
});

test("连接成功才保存草稿，兼容旧 Worker", async () => {
  const h = harness(saved(), async (url) => url.endsWith("/")
    ? response({ name: info.name, ok: true }) : response({ id: 1, name: "Fixture User" }));
  h.form({ ...cfg, worker: cfg.worker + "/", token: "new-fixture-token" });
  await h.nodes.get("s-test").onclick();
  assert.equal(h.values.get("hubWorker"), cfg.worker);
  assert.equal(h.values.get("hubToken"), "new-fixture-token");
  assert.match(h.nodes.get("s-capabilities").textContent, /旧版/);
  assert.match(h.nodes.get("s-status").textContent, /已保存/);
});

test("作业接口失败不覆盖旧看板与快照", async () => {
  const oldData = JSON.stringify({ weeks: [{ date: "2026-09-25", courses: [] }] });
  const oldState = JSON.stringify({ assignments: { 1: { 2: { name: "Fixture Assignment" } } } });
  const h = harness({ ...saved(), hubData: oldData, hubLastState: oldState }, async (url) => {
    if (url.includes("/proxy/courses?")) return response([{ id: 1, name: "Fixture Course" }]);
    if (url.includes("/assignments?")) return response({ error: "fixture failure" }, 503);
    return response([]);
  });
  await assert.rejects(h.api.fetchAll({ ...cfg, token: "new-fixture-token" }), /503/);
  assert.equal(h.values.get("hubData"), oldData);
  assert.equal(h.values.get("hubLastState"), oldState);
  assert.equal(h.values.get("hubToken"), cfg.token);
});

test("可选内容失败保留明确警告，取消截止时间不会崩溃", async () => {
  const h = harness({ ...saved(), hubLastState: JSON.stringify({ assignments: {
    1: { 2: { name: "Fixture Assignment", due_iso: "2026-10-05T00:00:00Z", wf: "unsubmitted" } },
  } }) }, async (url) => {
    if (url.includes("/proxy/courses?")) return response([{ id: 1, name: "Fixture Course" }]);
    if (url.includes("/assignments?")) return response([{ id: 2, name: "Fixture Assignment",
      created_at: "2020-01-01T00:00:00Z", due_at: null, submission: { workflow_state: "unsubmitted" } }]);
    if (url.includes("/files?")) return response({ error: "fixture permission" }, 403);
    return response([]);
  });
  const result = await h.api.fetchAll(cfg);
  assert.equal(result.weeks[0].warnings.length, 1);
  assert.match(result.weeks[0].warnings[0], /课件/);
  assert.match(result.weeks[0].courses[0].changes[0].detail, /无截止时间/);
});

test("存储空间不足恢复原配置、看板与快照", async () => {
  const h = harness({ ...saved(), hubData: "old-data", hubLastState: "old-state" }, async () => response([]));
  const original = h.storage.setItem;
  let fail = true;
  h.storage.setItem = (key, value) => {
    if (key === "hubLastState" && fail) { fail = false; throw new Error("fixture quota"); }
    original(key, value);
  };
  await assert.rejects(h.api.fetchAll({ ...cfg, token: "new-fixture-token" }), /空间不足/);
  assert.equal(h.values.get("hubData"), "old-data");
  assert.equal(h.values.get("hubLastState"), "old-state");
  assert.equal(h.values.get("hubToken"), cfg.token);
});

test("操作互斥，任务结束恢复按钮状态", async () => {
  const h = harness();
  h.form();
  let finish;
  const pending = h.api.withHubTask(() => new Promise((resolve) => { finish = resolve; }));
  assert.equal(h.nodes.get("s-fetch").disabled, true);
  assert.equal(h.nodes.get("s-token").disabled, true);
  await assert.rejects(h.api.withHubTask(async () => {}), /已有操作/);
  finish();
  await pending;
  assert.equal(h.nodes.get("s-fetch").disabled, false);
  assert.equal(h.nodes.get("s-token").disabled, false);
});

test("超时终止请求并给出可操作提示", async () => {
  const h = harness({}, (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("fixture abort")));
  }));
  const pending = h.api.requestText("https://fixture.example/");
  const timer = [...h.timers.values()].find((t) => t.delay === 20000);
  timer.fn();
  await assert.rejects(pending, /20 秒/);
  assert.equal(h.timers.size, 0);
});

test("设置不提供云端订阅或 SendKey 输入", () => {
  const h = harness(); h.form();
  assert.equal(h.nodes.has("s-sub"), false);
  assert.equal(h.nodes.has("s-sendkey"), false);
  assert.match(h.nodes.get("s-capabilities").textContent || h.nodes.get("setup-overlay").innerHTML, /暂停云端订阅/);
});

test("关闭再打开设置会恢复已保存配置", () => {
  const h = harness(saved());
  h.form({ ...cfg, token: "unsaved-fixture-token" });
  h.nodes.get("s-close").onclick();
  h.api.showSetup();
  assert.equal(h.nodes.get("s-token").value, cfg.token);
});

test("列表格式错误与分页上限不会返回不完整数据", async () => {
  const invalid = harness({}, async () => response({ error: "unexpected shape" }));
  await assert.rejects(invalid.api.apiAll("courses", {}, cfg), /列表格式异常/);
  const capped = harness({}, async () => response(Array.from({ length: 100 }, (_, id) => ({ id }))));
  await assert.rejects(capped.api.apiAll("courses", {}, cfg), /分页上限/);
});

test("Worker 根路由报告版本与 KV 能力", async () => {
  const source = fs.readFileSync(path.join(ROOT, "worker.js"), "utf8");
  const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  for (const bound of [false, true]) {
    const r = await worker.fetch(new Request("https://fixture.example/"), bound ? { HUB_KV: {} } : {});
    const data = await r.json();
    assert.equal(data.version, "2.2");
    assert.equal(data.capabilities.integrated, true);
    assert.equal(data.capabilities.subscriptions, false);
    assert.equal(data.name, info.name);
  }
});

async function fixtureWorker() {
  const source = fs.readFileSync(path.join(ROOT, "worker.js"), "utf8");
  return (await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"))).default;
}

test("云端订阅与旧 Cron 均停用，不查询或写入 KV", async () => {
  const worker = await fixtureWorker();
  const kv = new Proxy({}, { get() { throw new Error("不应访问 KV"); } });
  const original = global.fetch; global.fetch = async () => { throw new Error("不应查询云端"); };
  try {
    await worker.scheduled({}, { HUB_KV: kv }, {});
    for (const route of ["/setup", "/ics?secret=fixture-secret-at-least-16"]) {
      const r = await worker.fetch(new Request("https://fixture.example" + route), { HUB_KV: kv });
      assert.equal(r.status, 410); assert.equal(r.headers.get("Cache-Control"), "no-store");
    }
  } finally { global.fetch = original; }
});

test("旧版订阅可凭密钥停用，只移除自身配置与快照", async () => {
  const worker = await fixtureWorker(); const removed = [];
  const r = await worker.fetch(new Request("https://fixture.example/unsubscribe", {
    method: "POST", body: JSON.stringify({ secret: "fixture-secret-at-least-16" }),
  }), { HUB_KV: { delete: async (key) => removed.push(key) } });
  assert.equal(r.status, 200);
  assert.deepEqual(removed, ["cfg:fixture-secret-at-least-16", "snap:fixture-secret-at-least-16"]);
});

test("生成页面包含完整扩展脚本，所有内联脚本能解析", () => {
  const html = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8");
  // Python 读取模板时统一换行，Windows 工作副本可能仍是 CRLF。
  assert.ok(html.replace(/\r\n/g, "\n").includes(SOURCE.replace(/\r\n/g, "\n")));
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 3);
  for (const match of scripts) new vm.Script(match[1]);
});
test("同源页面自动使用自己的 Worker，一次点击校验并生成", async () => {
  const h = harness({ hubWorker: "https://old.example" }, async (url) => {
    if (url.endsWith("/health")) return response({ ...info, version: "2.2" });
    if (url.includes("users/self")) return response({ id: 1 });
    return response([]);
  }, { managedOrigin: cfg.worker, health: true });
  h.form({ ...cfg, worker: "https://untrusted.example" });
  await h.nodes.get("s-fetch").onclick();
  assert.equal(h.values.get("hubWorker"), cfg.worker);
  assert.equal(h.values.get("hubToken"), cfg.token);
  assert.ok(JSON.parse(h.values.get("hubData")).weeks.length);
  assert.ok(h.calls.every((c) => c.url.startsWith(cfg.worker + "/")));
});

function fixtureBackup() {
  return { format: "canvas-weekly-hub-backup", version: 1, data: { canvas_url: cfg.canvasUrl,
    weeks: [{ date: "2026-10-02", courses: [{ name: "Fixture", new_assignments: [], upcoming: [],
      new_files: [], announcements: [], changes: [] }] }] }, state: { assignments: {} } };
}

test("备份不含配置凭证；额外顶层凭证不会导入", () => {
  const backup = fixtureBackup(); backup.token = "do-not-export"; backup.data.token = "also-not-export";
  const h = harness({ ...saved(), hubSecret: "private-secret", hubData: JSON.stringify(backup.data),
    hubLastState: JSON.stringify(backup.state) });
  const out = JSON.stringify(h.api.buildBackup());
  for (const secret of [cfg.token, "private-secret", "do-not-export", "also-not-export"]) assert.ok(!out.includes(secret));
  assert.equal(h.api.validateBackup(backup).data.token, undefined);
  for (const value of [{}, { ...backup, version: 2 }, { ...backup, data: { canvas_url: cfg.canvasUrl, weeks: [] } },
    { ...backup, state: { assignments: [] } }]) assert.throws(() => h.api.validateBackup(value));
});

test("导入学校不匹配不覆盖历史，导入成功也不更换令牌", async () => {
  const backup = fixtureBackup(); const oldData = JSON.stringify(backup.data);
  const h = harness({ ...saved(), hubData: oldData }); h.form();
  const node = h.nodes.get("s-import-file");
  node.files = [{ size: 1024, text: async () => JSON.stringify({ ...backup, data: { ...backup.data, canvas_url: "https://other.example" } }) }];
  await node.onchange(); assert.equal(h.values.get("hubData"), oldData);
  assert.match(h.nodes.get("s-status").textContent, /学校/);
  node.files = [{ size: 1024, text: async () => JSON.stringify(backup) }];
  await node.onchange(); assert.match(h.nodes.get("s-status").textContent, /已导入/);
  assert.equal(h.values.get("hubToken"), cfg.token);
});

test("Worker 同时提供网页、说明、模板和兼容探测，设置内容安全策略", async () => {
  const worker = await fixtureWorker();
  for (const route of ["/", "/overview", "/site-template/index.html", "/web/index.html"]) {
    const r = await worker.fetch(new Request("https://fixture.example" + route, { headers: { Accept: "text/html" } }), {});
    assert.equal(r.status, 200); assert.match(r.headers.get("Content-Type"), /text\/html/);
    assert.match(r.headers.get("Content-Security-Policy"), /sha256-|script-src 'none'/);
    assert.equal(r.headers.get("Referrer-Policy"), "no-referrer");
    const html = await r.text(); assert.match(html, /v2\.2/);
    if (route === "/") assert.match(html, /__HUB_WORKER_ORIGIN__ = location.origin/);
  }
  const head = await worker.fetch(new Request("https://fixture.example/", { method: "HEAD", headers: { Accept: "text/html" } }), {});
  assert.equal(await head.text(), "");
});

test("代理仅查询课程接口，拒绝异常地址并阻止认证重定向", async () => {
  const worker = await fixtureWorker(); const original = global.fetch; const calls = [];
  global.fetch = async (url, options) => { calls.push({ url: String(url), options }); return response({ id: 1 }); };
  const request = (route, host = "canvas.example") => new Request("https://fixture.example/proxy/" + route, {
    headers: { "X-Canvas-Host": host, "X-Canvas-Token": cfg.token },
  });
  try {
    for (const host of ["evil.example/path", "user@evil.example", "127.0.0.1", "localhost", "evil.example:443"])
      assert.equal((await worker.fetch(request("users/self", host), {})).status, 400);
    assert.equal((await worker.fetch(request("users/1/profile"), {})).status, 400);
    assert.equal(calls.length, 0);
    const r = await worker.fetch(request("users/self"), {});
    assert.equal(r.status, 200); assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.equal(calls[0].url, "https://canvas.example/api/v1/users/self");
    assert.ok(!calls[0].url.includes(cfg.token));
    assert.equal(calls[0].options.headers.Authorization, "Bearer " + cfg.token);
    assert.equal(calls[0].options.redirect, "manual");
    global.fetch = async () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } });
    assert.equal((await worker.fetch(request("users/self"), {})).status, 502);
  } finally { global.fetch = original; }
});

test("看板转义导入文本并阻止脚本链接", () => {
  const html = fs.readFileSync(path.join(ROOT, "site-template/index.html"), "utf8");
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].find((m) => m[1].includes("function safeHref"));
  const helpers = script[1].slice(script[1].indexOf("const esc"), script[1].indexOf("const HK"));
  const c = vm.createContext({ URL, document: {} }); vm.runInContext(helpers + "\nglobalThis.helper = { safeHref, esc };", c);
  for (const url of ["javascript:alert(1)", "data:text/html,test", "//evil.example", "https://user:pass@evil.example"])
    assert.equal(c.helper.safeHref(url), "#");
  assert.equal(c.helper.safeHref("downloads/file.pdf"), "downloads/file.pdf");
  assert.equal(c.helper.esc("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
});
