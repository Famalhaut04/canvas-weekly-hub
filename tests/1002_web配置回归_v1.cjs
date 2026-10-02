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

function harness(seed = {}, route = async () => new Response("[]")) {
  const values = new Map(Object.entries(seed));
  values.set("hubStars", JSON.stringify({ n: 1, t: Date.now() }));
  const nodes = new Map();
  const timers = new Map();
  let timerId = 0;
  class Element {
    constructor() {
      this.style = {}; this.value = ""; this.textContent = "";
      this.disabled = false; this.href = "#";
      this.parentElement = { insertBefore() {}, appendChild: (el) => nodes.set(el.id, el) };
    }
    set innerHTML(html) {
      this.html = html;
      for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Element());
    }
    get innerHTML() { return this.html; }
    addEventListener(type, fn) { this[type] = fn; }
    dispatchEvent(event) { if (this[event.type]) this[event.type](event); }
    removeAttribute() {}
    setAttribute() {}
  }
  for (const id of ["settings-btn", "ics-link", "star-count"]) nodes.set(id, new Element());
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const calls = [];
  const context = vm.createContext({
    URL, URLSearchParams, AbortController, Response, Event, Date, Uint8Array,
    crypto: webcrypto, localStorage: storage,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return route(String(url), options); },
    document: {
      getElementById: (id) => nodes.get(id) || null,
      createElement: () => new Element(), querySelector: () => null,
      body: { appendChild: (el) => nodes.set(el.id, el) },
    },
    window: { __HUB_BOOT__: () => {} }, navigator: {}, location: { reload() {} },
    confirm: () => false, alert() {}, boot() {},
    $: (id) => nodes.get(id),
  });
  vm.runInContext(SOURCE + "\nglobalThis.api = {normalizeOrigin, validateHubCfg, hubCfg, fetchAll, apiAll, showSetup, withHubTask, requestText};", context);
  const form = (c = cfg) => {
    context.api.showSetup();
    for (const [id, field] of Object.entries({ "s-worker": "worker", "s-canvas": "canvasUrl",
      "s-token": "token", "s-exp": "expires", "s-sendkey": "sendkey" })) nodes.get(id).value = c[field];
  };
  return { context, api: context.api, values, nodes, storage, timers, calls, form };
}

function response(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
function saved(c = cfg) {
  return { hubWorker: c.worker, hubCanvasUrl: c.canvasUrl, hubToken: c.token,
    hubExpires: c.expires, hubSendKey: c.sendkey };
}

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

test("没有 KV 时阻止订阅上传，提示看板仍可用", async () => {
  const h = harness({}, async () => response(info));
  h.form();
  await h.nodes.get("s-sub").onclick();
  assert.match(h.nodes.get("s-status").textContent, /未绑定 KV/);
  assert.equal(h.calls.some((c) => c.url.endsWith("/setup")), false);
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
    assert.equal(data.version, "2.2.0");
    assert.equal(data.capabilities.subscriptions, bound);
    assert.equal(data.name, info.name);
  }
});

test("Worker 作业失败时不发送提醒或保存错误快照", async () => {
  const source = fs.readFileSync(path.join(ROOT, "worker.js"), "utf8");
  const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  const writes = new Map();
  const calls = [];
  const kv = { list: async () => ({ keys: [{ name: "cfg:fixture-secret" }] }),
    get: async () => JSON.stringify({ token: "fixture-token", sendkey: "fixture-sendkey", host: "canvas.example" }),
    put: async (key, value) => writes.set(key, value) };
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/api/v1/courses?")) return response([{ id: 1 }]);
    if (String(url).includes("/assignments?")) return response({ error: "fixture failure" }, 503);
    return response([]);
  };
  try { await worker.scheduled({}, { HUB_KV: kv }, {}); }
  finally { global.fetch = originalFetch; }
  assert.equal(calls.some((url) => url.includes("sctapi.ftqq.com")), false);
  assert.equal([...writes.keys()].some((key) => key.startsWith("snap:")), false);
  assert.equal([...writes.keys()].some((key) => key.startsWith("err:")), true);
});

test("Worker 日历拒绝异常列表和分页截断", async () => {
  const source = fs.readFileSync(path.join(ROOT, "worker.js"), "utf8");
  const { default: worker } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  const kv = { get: async () => JSON.stringify({ token: "fixture-token", host: "canvas.example" }) };
  const originalFetch = global.fetch;
  try {
    for (const [data, pattern] of [[{}, /列表格式异常/],
      [Array.from({ length: 100 }, (_, id) => ({ id })), /分页达到上限/]]) {
      global.fetch = async () => response(data);
      const r = await worker.fetch(new Request("https://fixture.example/ics?secret=fixture-secret-at-least-16"), { HUB_KV: kv });
      assert.equal(r.status, 500);
      assert.match((await r.json()).error, pattern);
    }
  } finally { global.fetch = originalFetch; }
});

test("生成页面包含完整扩展脚本，所有内联脚本能解析", () => {
  const html = fs.readFileSync(path.join(ROOT, "web/index.html"), "utf8");
  // Python 读取模板时统一换行，Windows 工作副本可能仍是 CRLF。
  assert.ok(html.replace(/\r\n/g, "\n").includes(SOURCE.replace(/\r\n/g, "\n")));
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 3);
  for (const match of scripts) new vm.Script(match[1]);
});
