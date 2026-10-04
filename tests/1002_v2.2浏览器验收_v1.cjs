/* 使用已安装的 Edge 和 Node 24 内置 WebSocket，离线检查真实页面尺寸及反馈。 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const artifactName = process.env.CANVAS_TEST_ARTIFACT_NAME || "1002_手动刷新与更新提醒_v1";
assert.equal(path.basename(artifactName), artifactName, "产物目录必须是本项目 artifacts 中的一个子目录名");
assert.ok(artifactName !== "." && artifactName !== "..", "禁止使用父目录作为产物目录");
const ARTIFACTS = path.join(__dirname, "artifacts", artifactName);
const EDGE = process.env.CANVAS_TEST_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  assert.ok(fs.existsSync(EDGE), "找不到已安装的 Edge；不自动安装浏览器");
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const profile = path.join(ARTIFACTS, "1002_v2.2_browser_validation_v1.tmp");
  assert.ok(!fs.existsSync(profile), "临时浏览器目录已存在，请先检查是否有上次未退出的测试进程");
  fs.mkdirSync(profile);
  const child = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + profile,
    "about:blank"], { windowsHide: true, stdio: "ignore" });
  const worker = (await import("data:text/javascript;base64," + Buffer.from(fs.readFileSync(path.join(ROOT, "worker.js"), "utf8")).toString("base64"))).default;
  const nativeFetch = global.fetch; const canvasCalls = [];
  let holdCourse = null;
  let readingPhase = "healthy";
  let submissionPhase = "unsubmitted";
  global.fetch = async (url, options) => {
    const target = new URL(url);
    if (target.hostname === "127.0.0.1") return nativeFetch(url, options);
    assert.equal(target.hostname, "canvas.example", "不允许测试访问真实学校");
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    canvasCalls.push(target.pathname);
    if (target.pathname.endsWith("/courses") && holdCourse) await holdCourse;
    const now = new Date(Date.now() - 60000).toISOString();
    let data = [];
    if (target.pathname.endsWith("/users/self")) data = { id: 1, name: "Fixture User" };
    else if (target.pathname.endsWith("/courses")) data = readingPhase === "healthy"
      ? [{ id: 1, name: "Fixture Course", course_code: "TEST1001" }]
      : [{ id: 1, name: "Fixture Course", course_code: "TEST1001" }, { id: 2, name: "Fixture Empty", course_code: "TEST1002" }];
    else if (target.pathname.endsWith("/assignments")) data = [{ id: 2, name: "Fixture Assignment", created_at: now, updated_at: now,
      due_at: new Date(Date.now() + 2 * 86400000).toISOString(), points_possible: 10, submission_types: ["online_upload"],
      html_url: "https://canvas.example/courses/1/assignments/2", submission: submissionPhase === "unknown" ? undefined :
        { workflow_state: submissionPhase, submitted_at: submissionPhase === "submitted" ? now : null } }];
    else if (target.pathname.endsWith("/files") && target.pathname.includes("/courses/1/")) {
      if (readingPhase !== "healthy") return new Response(JSON.stringify({ message: "user not authorized to perform that action" }), { status: 403, headers: { "Content-Type": "application/json" } });
      data = [{ id: 5, display_name: "Fixture Old File.pdf", created_at: now, updated_at: now, size: 1000 }];
    } else if (target.pathname.endsWith("/announcements") && target.searchParams.get("context_codes[]") === "course_1") {
      if (readingPhase !== "healthy") return new Response('<html><script>window.unsafe="fixture-token"</script>404</html>', { status: 404, headers: { "Content-Type": "text/html" } });
      data = [{ id: 6, title: "Fixture Old Announcement", posted_at: now, message: "Fixture safe text" }];
    }
    if (readingPhase === "critical" && target.pathname.endsWith("/assignments")) return new Response('{}', { status: 503, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  };
  const service = http.createServer(async (req, res) => {
    try {
      const r = await worker.fetch(new Request("http://127.0.0.1:" + service.address().port + req.url, { method: req.method, headers: req.headers }), {});
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(500); res.end("fixture failure"); }
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + service.address().port;
  let socket;
  let send;
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let attempt = 0; attempt < 100 && !fs.existsSync(portFile); attempt++) await sleep(100);
    assert.ok(fs.existsSync(portFile), "Edge 调试端口启动超时");
    const port = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]);
    const tabs = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
    const tab = tabs.find((item) => item.type === "page");
    assert.ok(tab, "Edge 未创建测试页面");
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result);
    });
    send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const evaluate = async (expression, sessionId) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const checkAgent = async (label) => {
      await evaluate("document.getElementById('s-agent-entry').focus()");
      assert.equal(await evaluate("document.activeElement.id"), "s-agent-entry");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      const route = await evaluate(`(() => ({ agent: !document.getElementById('s-agent-panel').hidden,
        web: document.getElementById('s-web-panel').hidden,
        expanded: document.getElementById('s-agent-entry').getAttribute('aria-expanded'),
        fits: document.getElementById('setup-overlay').scrollWidth <= innerWidth + 1 }))()`);
      assert.deepEqual(route, { agent: true, web: true, expanded: "true", fits: true });
      const copied = await evaluate(`(async () => {
        document.getElementById('s-token').value = 'clipboard-fixture-token';
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedPrompt = text; } } });
        await document.getElementById('s-agent-copy').onclick();
        return { text: window.__copiedPrompt, message: document.getElementById('s-agent-status').textContent };
      })()`);
      assert.ok(!copied.text.includes("clipboard-fixture-token"));
      assert.match(copied.text, /--check-config/); assert.match(copied.message, /已复制/);
      const fallback = await evaluate(`(async () => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
        await document.getElementById('s-agent-copy').onclick();
        const input = document.getElementById('s-agent-prompt');
        return { open: document.getElementById('s-agent-copy-details').open, focused: document.activeElement === input,
          selected: input.selectionStart === 0 && input.selectionEnd === input.value.length,
          message: document.getElementById('s-agent-status').textContent,
          fits: document.getElementById('setup-overlay').scrollWidth <= innerWidth + 1 };
      })()`);
      assert.equal(fallback.open, true); assert.equal(fallback.focused, true);
      assert.equal(fallback.selected, true); assert.equal(fallback.fits, true); assert.match(fallback.message, /复制失败.*手动/);
      await evaluate("document.getElementById('s-agent-entry').scrollIntoView({block:'start'})");
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(ARTIFACTS, "1002_agent_" + label + "_v1.png"), Buffer.from(shot.data, "base64"));
      await evaluate("document.getElementById('s-web-entry').focus()");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", text: " ", unmodifiedText: " ", windowsVirtualKeyCode: 32 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
      assert.equal(await evaluate("!document.getElementById('s-web-panel').hidden && document.getElementById('s-agent-panel').hidden"), true);
      const help = await evaluate(`(() => {
        const input = document.getElementById('s-canvas'); input.value = 'https://other-canvas.example';
        input.dispatchEvent(new Event('input')); const href = document.getElementById('s-token-help').href;
        input.value = 'https://canvas.cityu.edu.hk'; input.dispatchEvent(new Event('input'));
        document.getElementById('s-token').value = ''; return href;
      })()`);
      assert.equal(help, "https://other-canvas.example/profile/settings");
      console.log("PASS agent " + label + ": Enter/Space routes, credential-free clipboard, denied-copy selection, school help, no overflow");
    };
    await send("Page.enable");
    for (const mode of [{ name: "desktop", width: 1440, height: 1800, mobile: false },
      { name: "mobile", width: 390, height: 844, mobile: true }]) {
      await send("Emulation.setDeviceMetricsOverride", { width: mode.width, height: mode.height,
        deviceScaleFactor: 1, mobile: mode.mobile });
      await send("Page.navigate", { url: pathToFileURL(path.join(ROOT, "web/index.html")).href });
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        ready = await evaluate("document.readyState === 'complete' && !!document.getElementById('setup-overlay')");
        if (ready) break;
        await sleep(100);
      }
      assert.ok(ready, "页面未显示设置窗口");
      await evaluate("document.fonts.ready.then(() => true)");
      const layout = await evaluate(`(() => {
        const overlay = document.getElementById('setup-overlay');
        const modal = overlay.querySelector('.modal').getBoundingClientRect();
        const close = document.getElementById('s-close').getBoundingClientRect();
        return { viewport: innerWidth, scroll: overlay.scrollWidth, client: overlay.clientWidth,
          left: modal.left, right: modal.right, closeRight: close.right };
      })()`);
      assert.equal(layout.viewport, mode.width);
      assert.ok(layout.scroll <= layout.client + 1, "设置窗口存在横向溢出：" + JSON.stringify(layout));
      assert.ok(layout.left >= 0 && layout.right <= mode.width + 1);
      assert.ok(layout.closeRight <= mode.width);
      const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(ARTIFACTS, "1002_v2.2_public_" + mode.name + "_v1.png"), Buffer.from(screenshot.data, "base64"));
      console.log("PASS " + mode.name + " " + JSON.stringify(layout));
      await checkAgent("public_" + mode.name);
    }
    const feedback = await evaluate(`(async () => {
      document.getElementById('s-worker').value = 'http://fixture.example';
      document.getElementById('s-token').value = 'fixture-token';
      await document.getElementById('s-test').onclick();
      return { text: document.getElementById('s-status').textContent, token: localStorage.getItem('hubToken'),
        disabled: document.getElementById('s-test').disabled };
    })()`);
    assert.match(feedback.text, /HTTPS/);
    assert.equal(feedback.token, null);
    assert.equal(feedback.disabled, false);
    console.log("PASS browser invalid configuration feedback; no token saved");

    // 浏览器访问真实生成的 Worker 页面；Node 代理上游仅使用测试夹具。
    for (const mode of [{ name: "desktop", width: 1440, height: 1000, mobile: false },
      { name: "mobile", width: 390, height: 844, mobile: true }]) {
      await send("Emulation.setDeviceMetricsOverride", { width: mode.width, height: mode.height, deviceScaleFactor: 1, mobile: mode.mobile });
      await send("Page.navigate", { url: origin + "/" });
      let ready = false;
      for (let i = 0; i < 50; i++) {
        ready = await evaluate("document.readyState === 'complete' && !!document.getElementById('setup-overlay')");
        if (ready) break; await sleep(100);
      }
      if (!ready) console.log("Page diagnostic", await evaluate("({ url: location.href, body: document.body.textContent.slice(0, 1000), scripts: document.scripts.length })"));
      assert.ok(ready, "一体化页面未启动，检查 CSP 和脚本");
      const layout = await evaluate(`(() => {
        const ov = document.getElementById("setup-overlay");
        return { scroll: ov.scrollWidth, width: ov.clientWidth, workerHidden: document.getElementById("s-worker").parentElement.hidden,
          tokenVisible: document.getElementById("s-token").getBoundingClientRect().width > 0,
          advancedClosed: !document.getElementById("s-advanced").open, hasCloudSetup: !!document.getElementById("s-sub"),
          managed: HUB_MANAGED_ORIGIN };
      })()`);
      assert.equal(layout.managed, origin); assert.equal(layout.workerHidden, true);
      assert.equal(layout.tokenVisible, true); assert.equal(layout.advancedClosed, true); assert.equal(layout.hasCloudSetup, false);
      assert.ok(layout.scroll <= layout.width + 1);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(ARTIFACTS, "1002_v2.2_integrated_" + mode.name + "_v1.png"), Buffer.from(shot.data, "base64"));
      console.log("PASS integrated " + mode.name + " " + JSON.stringify(layout));
      await checkAgent("integrated_" + mode.name);
    }
    const connected = await evaluate(`(async () => {
      document.getElementById("s-token").value = "fixture-token";
      document.getElementById("s-canvas").value = "https://canvas.example";
      await document.getElementById("s-fetch").onclick();
      return { status: document.getElementById("s-status").textContent, hidden: document.getElementById("setup-overlay").style.display === "none",
        data: JSON.parse(localStorage.getItem("hubData") || "null"), worker: localStorage.getItem("hubWorker"),
        backup: JSON.stringify(buildBackup()), text: document.body.textContent };
    })()`);
    assert.equal(connected.hidden, true, connected.status); assert.equal(connected.worker, origin);
    assert.equal(connected.data.weeks[0].courses[0].upcoming[0].name, "Fixture Assignment");
    assert.match(connected.text, /Fixture Course/); assert.ok(!connected.backup.includes("fixture-token"));
    assert.equal(canvasCalls.length, 5);
    console.log("PASS single-click connection, own-origin proxy, board rendering, credential-free backup");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true);
    const boardShot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(ARTIFACTS, "1002_v2.2_board_mobile_v1.png"), Buffer.from(boardShot.data, "base64"));
    const exported = await evaluate(`(async () => {
      const original = triggerDownload; let exported;
      triggerDownload = (blob, name) => { exported = { blob, name }; };
      try {
        await downloadWebsite(); const html = await exported.blob.text();
        return { name: exported.name, containsData: html.includes("Fixture Assignment"), hasToken: html.includes("fixture-token"),
          hasSettings: html.includes('id="settings-btn"') };
      } finally { triggerDownload = original; }
    })()`);
    assert.equal(exported.name, "我的学习网站.html"); assert.equal(exported.containsData, true);
    assert.equal(exported.hasToken, false); assert.equal(exported.hasSettings, false);
    console.log("PASS offline HTML export from own Worker without configuration credentials");
    await send("Page.reload"); await sleep(400);
    assert.equal(await evaluate("document.body.textContent.includes('Fixture Assignment')"), true);
    console.log("PASS reload restores local history");

    // 可控时钟：到期只提示；所有上游调用仍是 localhost Worker 的虚构夹具。
    const beforeReminder = canvasCalls.length;
    const boundaries = await evaluate(`(async () => {
      window.__NativeDate = Date;
      const state = JSON.parse(localStorage.getItem('hubRefreshState'));
      window.__fixtureClock = state.successAt + 72 * 3600000 - 1;
      window.Date = class extends __NativeDate {
        constructor(...args) { super(...(args.length ? args : [window.__fixtureClock])); }
        static now() { return window.__fixtureClock; }
      };
      await updateRefreshReminder(); const before = document.getElementById('refresh-reminder').hidden;
      __fixtureClock += 1; await updateRefreshReminder();
      return { before, at: document.getElementById('refresh-reminder').hidden,
        message: document.getElementById('reminder-text').textContent, time: document.getElementById('refresh-time').textContent };
    })()`);
    assert.equal(boundaries.before, true); assert.equal(boundaries.at, false);
    assert.match(boundaries.message, /满 3 天/); assert.match(boundaries.time, /上次成功更新/);
    await evaluate("document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow'))");
    await sleep(100); assert.equal(canvasCalls.length, beforeReminder);
    console.log("PASS real browser 72h boundary, wake checks and reminder without Canvas requests");
    for (const mode of [{ name: 'desktop', width: 1440, height: 1000, mobile: false },
      { name: 'mobile', width: 390, height: 844, mobile: true }]) {
      await send('Emulation.setDeviceMetricsOverride', { width: mode.width, height: mode.height, deviceScaleFactor: 1, mobile: mode.mobile });
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true);
      assert.equal(await evaluate("document.getElementById('reminder-refresh').getBoundingClientRect().width > 60"), true);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(ARTIFACTS, '1002_更新提醒_' + mode.name + '_v1.png'), Buffer.from(shot.data, 'base64'));
    }
    await evaluate("document.getElementById('reminder-later').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(100);
    assert.equal(await evaluate("document.getElementById('refresh-reminder').hidden"), true);
    assert.equal(canvasCalls.length, beforeReminder);
    const preferences = await evaluate(`(async () => {
      showSetup(); document.getElementById('s-token').value = 'unsaved-fixture-token';
      document.getElementById('s-reminder-days').value = '2'; document.getElementById('s-reminder-save').click();
      await updateRefreshReminder();
      const text = document.getElementById('reminder-text').textContent;
      document.getElementById('s-reminder-enabled').checked = false; document.getElementById('s-reminder-save').click();
      await updateRefreshReminder();
      return { text, token: localStorage.getItem('hubToken'), hidden: document.getElementById('refresh-reminder').hidden,
        enabled: document.getElementById('refresh-btn').disabled, prefs: reminderPrefs() };
    })()`);
    assert.match(preferences.text, /满 2 天/); assert.equal(preferences.token, 'fixture-token');
    assert.equal(preferences.hidden, true); assert.equal(preferences.enabled, false);
    assert.deepEqual(preferences.prefs, { enabled: false, days: 2 });
    await evaluate("document.getElementById('s-reminder-title').scrollIntoView({block:'start'})");
    assert.equal(await evaluate("document.getElementById('setup-overlay').scrollWidth <= innerWidth + 1"), true);
    const preferencesShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(ARTIFACTS, '1002_提醒设置_mobile_v1.png'), Buffer.from(preferencesShot.data, 'base64'));
    await evaluate("document.getElementById('s-close').click(); window.Date = __NativeDate");
    console.log('PASS keyboard dismissal and mobile preferences; Token draft remains unsaved');

    // 两个真实标签页争抢同一个浏览器锁，第二页不排队抓取。
    const second = await send('Target.createTarget', { url: origin + '/' });
    const attached = await send('Target.attachToTarget', { targetId: second.targetId, flatten: true });
    const secondSession = attached.sessionId;
    for (let i = 0; i < 50; i++) {
      if (await evaluate("document.readyState === 'complete' && !!document.getElementById('refresh-btn')", secondSession)) break;
      await sleep(100);
    }
    assert.equal(await evaluate("!!navigator.locks", secondSession), true);
    assert.equal(await evaluate("reminderPrefs().enabled", secondSession), false);
    assert.equal(canvasCalls.length, beforeReminder);
    let releaseCourse;
    holdCourse = new Promise((resolve) => { releaseCourse = resolve; });
    try {
      await evaluate("window.__pendingRefresh = document.getElementById('refresh-btn').onclick(); true");
      for (let i = 0; i < 50 && canvasCalls.length === beforeReminder; i++) await sleep(20);
      assert.equal(canvasCalls.length, beforeReminder + 1);
      assert.equal(await evaluate("document.getElementById('refresh-btn').disabled"), true);
      await evaluate("document.getElementById('refresh-btn').onclick()", secondSession);
      assert.match(await evaluate("document.getElementById('refresh-message').textContent", secondSession), /另一个标签页/);
      assert.equal(canvasCalls.length, beforeReminder + 1);
    } finally { holdCourse = null; releaseCourse(); }
    await evaluate("window.__pendingRefresh"); await sleep(100);
    assert.equal(canvasCalls.length, beforeReminder + 4);
    assert.equal(await evaluate("document.getElementById('refresh-btn').disabled"), false);
    assert.equal(await evaluate("localStorage.getItem('hubToken')"), 'fixture-token');
    const latest = await evaluate("JSON.parse(localStorage.getItem('hubRefreshState')).successAt");
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('hubRefreshState')).successAt", secondSession), latest);
    await send('Target.closeTarget', { targetId: second.targetId });
    console.log('PASS two real tabs: one refresh performs exactly 4 fixture API calls; competing tab makes 0');

    readingPhase = "partial";
    const partial = await evaluate(`(async () => {
      await document.getElementById('refresh-btn').onclick();
      const data = JSON.parse(localStorage.getItem('hubData'));
      const c = data.weeks[0].courses[0];
      return { state: data.weeks[0].fetch_state, retained: c.read_status.files.retained,
        updated: c.read_status.files.data_updated_at, name: c.new_files[0].name,
        message: document.getElementById('refresh-message').textContent,
        warning: document.getElementById('fetch-warnings').textContent,
        text: document.body.innerText, details: document.querySelectorAll('#fetch-warnings details').length };
    })()`);
    assert.equal(partial.state, 'partial'); assert.equal(partial.retained, true);
    assert.equal(partial.name, 'Fixture Old File.pdf'); assert.ok(partial.updated);
    assert.match(partial.message, /部分更新已保存/); assert.match(partial.warning, /文件成功 1\/2/);
    assert.equal(partial.details, 2); assert.match(partial.text, /本次未更新，显示旧数据/);
    assert.ok(!partial.text.includes('window.unsafe') && !partial.text.includes('fixture-token'));
    assert.ok(!partial.text.includes('可稍后刷新重试'));
    await evaluate("document.querySelector('#fetch-warnings details summary').focus()");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate("document.querySelector('#fetch-warnings details').open"), true);
    for (const mode of [{ name: 'desktop', width: 1440, height: 1000, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
      await send('Emulation.setDeviceMetricsOverride', { width: mode.width, height: mode.height, deviceScaleFactor: 1, mobile: mode.mobile });
      await evaluate('window.scrollTo(0, 0)');
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(ARTIFACTS, '1003_分类警告_' + mode.name + '_v1.png'), Buffer.from(shot.data, 'base64'));
    }
    await evaluate("document.querySelector('.course .body').scrollIntoView({block: 'start'})");
    const retentionShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(ARTIFACTS, '1003_旧内容标记_mobile_v1.png'), Buffer.from(retentionShot.data, 'base64'));
    console.log('PASS #5 grouped warnings, keyboard expansion, partial status, old data and timestamp, no error HTML or credentials');
    submissionPhase = "unknown";
    await evaluate("document.getElementById('refresh-btn').onclick()");
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('hubData')).weeks[0].courses[0].upcoming[0].submitted"), null);
    for (const mode of [{ name: 'desktop', width: 1440, height: 1000, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
      await send('Emulation.setDeviceMetricsOverride', { width: mode.width, height: mode.height, deviceScaleFactor: 1, mobile: mode.mobile });
      assert.equal(await evaluate("Array.from(document.querySelectorAll('.pill')).some(el => el.textContent === '状态待核验')"), true);
      assert.equal(await evaluate("Array.from(document.querySelectorAll('.pill')).some(el => el.textContent === '未提交')"), false);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true);
      await evaluate("document.getElementById('todo-panel').scrollIntoView({block: 'start'})");
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(ARTIFACTS, '1004_提交待核验_' + mode.name + '_v1.png'), Buffer.from(shot.data, 'base64'));
    }
    console.log('PASS missing submission displayed as pending verification on desktop and mobile');
    submissionPhase = "submitted";
    await evaluate("document.getElementById('refresh-btn').onclick()");
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('hubData')).weeks[0].courses[0].upcoming[0].submitted"), true);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.pill')).some(el => el.textContent === '已提交')"), true);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.pill')).some(el => el.textContent === '状态待核验')"), false);
    console.log('PASS manual refresh reads newly submitted fixture and updates visible status');
    readingPhase = "critical";
    const failed = await evaluate(`(async () => {
      const before = ['hubData', 'hubLastState', 'hubRefreshState'].map(k => localStorage.getItem(k));
      await document.getElementById('refresh-btn').onclick();
      return { same: JSON.stringify(before) === JSON.stringify(['hubData', 'hubLastState', 'hubRefreshState'].map(k => localStorage.getItem(k))),
        message: document.getElementById('refresh-message').textContent, disabled: document.getElementById('refresh-btn').disabled };
    })()`);
    assert.equal(failed.same, true); assert.match(failed.message, /本次未更新.*503/); assert.equal(failed.disabled, false);
    console.log('PASS #5 required request failure preserves board, assignment snapshot and successful timestamp');

    await send("Page.navigate", { url: origin + "/overview" }); await sleep(400);
    assert.equal(await evaluate("document.querySelectorAll('tbody tr').length"), 6);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true);
    console.log("PASS system overview on mobile");
  } finally {
    global.fetch = nativeFetch;
    await new Promise((resolve) => service.close(resolve));
    if (socket && socket.readyState === WebSocket.OPEN && send) {
      try { await send("Browser.close"); } catch (error) { /* 浏览器关闭时可能先断开通道 */ }
      socket.close();
    } else child.kill();
    await sleep(500);
    // 仅清理由本测试创建的固定临时目录，并验证绝对路径在项目 artifacts 内。
    const checked = fs.realpathSync(profile);
    assert.equal(path.dirname(checked).toLowerCase(), fs.realpathSync(ARTIFACTS).toLowerCase());
    assert.ok(path.basename(checked).endsWith(".tmp"));
    fs.rmSync(checked, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
