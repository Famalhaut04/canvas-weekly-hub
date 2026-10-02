/* 使用已安装的 Edge 和 Node 24 内置 WebSocket，离线检查真实页面尺寸及反馈。 */
const fs = require("node:fs");
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
  const profile = path.join(ARTIFACTS, "1002_browser_validation_v1.tmp");
  assert.ok(!fs.existsSync(profile), "临时浏览器目录已存在，请先检查是否有上次未退出的测试进程");
  fs.mkdirSync(profile);
  const child = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--user-data-dir=" + profile,
    "about:blank"], { windowsHide: true, stdio: "ignore" });
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
      fs.writeFileSync(path.join(ARTIFACTS, "1002_" + mode.name + "_setup_v1.png"), Buffer.from(screenshot.data, "base64"));
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
  } finally {
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
