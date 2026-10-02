#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地看板服务：静态托管看板目录 + /refresh 一键抓取接口。

- GET  /                托管页面模板与引擎本地 data.json（不公开配置和下载目录）
- GET  /refresh?probe=1 探测接口（立即返回，不触发抓取，供页面探测是否显示刷新按钮）
- POST /refresh         调用抓取引擎跑一遍完整流程（周报/课件/离线版/云端备份），
                        返回 {ok, log, data}（data 为最新看板数据，页面直接热更新）

仅标准库。用于个人本机（localhost），不要暴露到公网。
"""
import json
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import canvas_weekly_report as engine

BASE = Path(__file__).resolve().parent
BOARD_DIR = engine.BASE_DIR
DATA_PATH = engine.LOCAL_DATA
ENGINE = BASE / "canvas_weekly_report.py"
PORT = 8137

_refresh_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BOARD_DIR), **kwargs)

    def translate_path(self, path):
        # 仅三个公开文件；不能把含 Token 的整个数据目录静态托管出去。
        route = urlparse(path).path
        if route in ("/", "/index.html"):
            template = engine.resolve_resource("site-template/index.html")
            return str(template or (BOARD_DIR / "__missing_template__"))
        return str({"/data.json": DATA_PATH,
                    "/deadlines.ics": BOARD_DIR / "deadlines.ics"}[route])

    def log_message(self, *args):  # 静默访问日志
        pass

    # ---- 工具 ----
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- 路由 ----
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/refresh":
            if parse_qs(u.query).get("probe"):
                return self._json({"ok": True, "probe": True})
            return self._json({"ok": False, "log": "请使用 POST 刷新"}, 405)
        if u.path not in ("/", "/index.html", "/data.json", "/deadlines.ics"):
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if urlparse(self.path).path not in ("/", "/index.html", "/data.json", "/deadlines.ics"):
            return self.send_error(404)
        return super().do_HEAD()

    def do_POST(self):
        if urlparse(self.path).path == "/refresh":
            return self._do_refresh()
        self.send_error(404)

    # ---- 抓取 ----
    def _do_refresh(self):
        if not _refresh_lock.acquire(blocking=False):
            return self._json({"ok": False, "log": "已有一次抓取在进行中，请稍候"}, 409)
        try:
            r = subprocess.run(
                [sys.executable, str(ENGINE)],
                cwd=str(BASE), capture_output=True, text=True,
                encoding="utf-8", errors="ignore", timeout=600)
            log = ((r.stdout or "") + (r.stderr or "")).strip()
            ok = r.returncode == 0 and DATA_PATH.is_file()
            data = None
            if ok:
                try:
                    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    ok = False
            return self._json({"ok": ok, "log": log[-1500:] if log else "",
                               "data": data}, 200 if ok else 500)
        except subprocess.TimeoutExpired:
            return self._json({"ok": False, "log": "抓取超过 10 分钟，已停止本次进程；请检查网络后重试"}, 504)
        except OSError:
            return self._json({"ok": False, "log": "无法启动抓取引擎，请确认 Python 与数据目录可用"}, 500)
        finally:
            _refresh_lock.release()


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"本地看板服务已启动：http://localhost:{PORT}/  （Ctrl+C 停止）")
    srv.serve_forever()


if __name__ == "__main__":
    main()
