#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建网页版页面：site-template/index.html + overrides.js → web/index.html

模板改动后运行：python web/build_web.py
（GitHub Pages 直接托管生成的 web/index.html）
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

tpl = (ROOT / "site-template" / "index.html").read_text(encoding="utf-8")
ov = (ROOT / "web" / "overrides.js").read_text(encoding="utf-8")

# 内联脚本里出现 </script> 会提前终止脚本块（经典陷阱），必须转义为 <\/script>
assert "</script" not in ov.lower(), "overrides.js 含未转义的 </script>，会截断内联脚本"


def replace_once(html, old, new):
    assert html.count(old) == 1, f"锚点未唯一命中：{old[:60]!r}"
    return html.replace(old, new, 1)


# 1) 注入设置浮层样式
OVERLAY_CSS = """
  /* ---- 网页版设置浮层（build_web.py 注入） ---- */
  #setup-overlay { position: fixed; inset: 0; background: rgba(8,12,20,.8);
    z-index: 50; display: flex; align-items: flex-start; justify-content: center;
    padding: 40px 14px; overflow: auto; }
  #setup-overlay .modal { background: var(--panel); color: var(--ink); border: 1px solid var(--line);
    border-radius: 16px; width: 100%; max-width: 760px; padding: 20px 22px;
    box-shadow: 0 18px 50px rgba(0,0,0,.35); }
  #setup-overlay h3 { font-size: 1.1rem; margin-bottom: 4px; }
  #setup-overlay .frow { display: flex; gap: 8px; align-items: center; margin: 9px 0; flex-wrap: wrap; }
  #setup-overlay .frow label { width: 128px; font-size: .9rem; color: var(--muted); }
  #setup-overlay input { flex: 1; min-width: 200px; padding: 7px 10px; border: 1px solid var(--line);
    border-radius: 8px; background: var(--panel-2); color: var(--ink); font: inherit; }
  #setup-overlay .hint { font-size: .8rem; color: var(--muted); margin: 4px 0 0; }
  #setup-overlay .bar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  #setup-overlay .btn { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--panel-2); color: var(--ink); cursor: pointer; font: inherit; }
  #setup-overlay .btn.primary { background: var(--brand); color: #fff; border-color: var(--brand); font-weight: 600; }
  #setup-overlay .btn:hover { filter: brightness(1.08); }
  #setup-overlay .status { font-size: .85rem; margin-top: 8px; white-space: pre-wrap; min-height: 1.2em; }
  #setup-overlay a { color: var(--brand-2); }
  .subbox { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px;
    padding: 10px 12px; margin-top: 8px; }
  .subbox code { font-size: .78rem; word-break: break-all; color: var(--brand-2); }
  .fstep { border-top: 1px solid var(--line); margin-top: 14px; padding-top: 12px; }
  .fstep-h { font-weight: 700; font-size: .95rem; margin-bottom: 6px; }
  details.faq { margin-top: 6px; border: 1px solid var(--line); border-radius: 8px;
    padding: 6px 10px; background: var(--panel-2); font-size: .85rem; }
  details.faq summary { cursor: pointer; color: var(--brand-2); font-weight: 600; }
  details.faq p { margin: 6px 0; }
</style>"""
html = replace_once(tpl, "  .pill.upd { background: var(--soon-bg); color: var(--soon); }"
                        "\n  .pill.sub-ok { background: var(--far-bg); color: var(--far); }"
                        "\n  .pill.sub-no { background: var(--urgent-bg); color: var(--urgent); font-weight: 700; }",
                    "  .pill.upd { background: var(--soon-bg); color: var(--soon); }"
                    "\n  .pill.sub-ok { background: var(--far-bg); color: var(--far); }"
                    "\n  .pill.sub-no { background: var(--urgent-bg); color: var(--urgent); font-weight: 700; }"
                    "\n" + OVERLAY_CSS.replace("</style>", ""))

# 2) 顶栏加设置按钮
html = replace_once(
    html,
    '    <button id="theme" class="icon-btn" title="切换深色 / 浅色">🌙</button>',
    '    <button id="settings-btn" class="icon-btn" title="设置：令牌 / 抓取 / 导出">⚙️</button>\n'
    '    <button id="theme" class="icon-btn" title="切换深色 / 浅色">🌙</button>')

# 3) 启动逻辑改为：localStorage → 设置向导（原 data.json 回退保留给服务器部署形态）
OLD_START = '''/* 网页版：数据来自 localStorage（由 overrides.js 的 fetchAll 写入），否则弹设置向导 */
window.__HUB_BOOT__ = function () {'''
NEW_START = '''/* 网页版：数据来自 localStorage（由 overrides.js 的 fetchAll 写入），否则弹设置向导 */
window.__HUB_BOOT__ = function () {'''
# 模板里的原启动块
OLD_ORIG = '''if (window.__HUB_DATA__) {
  boot(window.__HUB_DATA__);            // 双击打开的单文件：数据已内嵌
} else {
  fetch("data.json", { cache: "no-store" })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(boot)
    .catch(() => {
      $("updated").textContent = "无法加载 data.json";
      $("courses").innerHTML = `<div class="panel empty">
        无法加载 data.json。若你是直接以文件方式打开本页属正常现象，请改用「本周课程动态.html」或通过本地看板访问。</div>`;
    });
}'''
NEW_ORIG = '''window.__HUB_BOOT__ = function () {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem("hubData") || "null"); } catch (e) {}
  if (window.__HUB_DATA__) {
    boot(window.__HUB_DATA__);          // 双击打开的单文件：数据已内嵌
  } else if (stored && stored.weeks && stored.weeks.length) {
    boot(stored);                        // 网页版：浏览器本地数据
  } else if (typeof showSetup === "function") {
    showSetup();                         // 网页版：首次使用 → 设置向导
  } else {
    fetch("data.json", { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(boot)
      .catch(() => {
        $("updated").textContent = "无法加载 data.json";
        $("courses").innerHTML = `<div class="panel empty">暂无数据，请先完成设置或抓取。</div>`;
      });
  }
};'''
html = replace_once(html, OLD_ORIG, NEW_ORIG)

# 4) 注入 overrides 脚本
html = replace_once(html, "</body>",
                    "<script>\n" + ov + "\n</script>\n</body>")

out = ROOT / "web" / "index.html"
out.write_text(html, encoding="utf-8")
print(f"已生成 {out}（{len(html) // 1024} KB）")
