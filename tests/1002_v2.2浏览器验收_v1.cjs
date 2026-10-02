/* 使用已安装的 Edge 和 Node 24 内置 WebSocket，离线检查真实页面尺寸及反馈。 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS = path.join(__dirname, "artifacts");
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
  global.fetch = async (url, options) => {
    const target = new URL(url);
    if (target.hostname === "127.0.0.1") return nativeFetch(url, options);
    assert.equal(target.hostname, "canvas.example", "不允许测试访问真实学校");
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    canvasCalls.push(target.pathname);
    const now = new Date().toISOString();
    let data = [];
    if (target.pathname.endsWith("/users/self")) data = { id: 1, name: "Fixture User" };
    else if (target.pathname.endsWith("/courses")) data = [{ id: 1, name: "Fixture Course", course_code: "TEST1001" }];
    else if (target.pathname.endsWith("/assignments")) data = [{ id: 2, name: "Fixture Assignment", created_at: now, updated_at: now,
      due_at: new Date(Date.now() + 2 * 86400000).toISOString(), points_possible: 10, submission_types: ["online_upload"],
      html_url: "https://canvas.example/courses/1/assignments/2", submission: { workflow_state: "unsubmitted" } }];
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
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
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
