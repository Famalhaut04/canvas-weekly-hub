#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""城大 Canvas 课程助手 · 图形界面版 v1.1

面向不使用 AI agent 的同学：像安装普通软件一样选好保存位置，
粘贴 Canvas 令牌，注册每周定时任务，之后每周自动抓取并弹出
「我的学习网站」页面。

向导流程（首次运行）：
    ① 选择数据保存位置（模拟安装路径选择）
    ② 绑定 Canvas 令牌（测试连接）
    ③ 设置每周定时推送
    ④ 完成：主界面 + 内置使用说明 + 「打开我的学习网站」入口

打包为 exe 后双击即可运行；也支持：
    --run            静默执行一次抓取并打开我的学习网站（供计划任务调用）
    --run --no-open  静默执行但不打开浏览器
    --selftest       自检：数据目录、配置与网络连通性

环境变量（内部/调试用）：
    HUB_START_PAGE=n  直接从第 n 页启动（0-3，用于截图与测试）
"""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox, ttk


# 无控制台窗口运行时 stdout/stderr 为 None，包装成空对象，避免引擎里的 print 报错
class _Null:
    def write(self, *a):
        pass

    def flush(self):
        pass


if sys.stdout is None:
    sys.stdout = _Null()
if sys.stderr is None:
    sys.stderr = _Null()

APP_TITLE = "城大 Canvas 课程助手"
APP_VERSION = "v1.1"
TASK_NAME = "CityU-Canvas-Assistant"      # 计划任务名（用 ASCII，避免命令行编码问题）
POINTER_NAME = "hub_home.json"            # 数据位置指针（存于 exe/脚本旁）
WEBSITE_NAME = "我的学习网站.html"
DEFAULT_CONFIG = {
    "canvas_url": "https://canvas.cityu.edu.hk",
    "access_token": "",
    "token_expires_at": "",
    "token_remind_days": 5,
    "lookback_days": 7,
    "upcoming_days": 7,
    "tz_offset_hours": 8,
    "download_files": True,
    "download_dir": "downloads",
    "term_filter": "",
    "github": {"username": "", "repo_name": "learning-hub", "repo_dir": "", "push_enabled": False},
}
WEEKDAYS = [("周一", "MON"), ("周二", "TUE"), ("周三", "WED"), ("周四", "THU"),
            ("周五", "FRI"), ("周六", "SAT"), ("周日", "SUN")]
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# ---------------- 配色（现代软件风格） ----------------
C_BG = "#f2f5fa"          # 窗口底
C_HEADER = "#17427d"      # 顶栏深蓝
C_CARD = "#ffffff"        # 卡片
C_LINE = "#e3e8f0"        # 分隔线
C_ACCENT = "#1e5aa8"      # 主按钮 / 强调
C_OK = "#0f8a4f"
C_WARN = "#c0392b"
C_MUTED = "#6b7280"
FONT = "Microsoft YaHei UI"
FONT_B = "Microsoft YaHei UI"


# ---------------------------------------------------------------- 位置指针与引擎懒加载

def app_dir():
    """exe（或脚本）所在目录：指针文件放这里。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def pointer_path():
    return app_dir() / POINTER_NAME


def read_pointer():
    try:
        return Path(json.loads(pointer_path().read_text(encoding="utf-8"))["data_dir"])
    except (FileNotFoundError, json.JSONDecodeError, KeyError, OSError):
        return None


def write_pointer(data_dir):
    pointer_path().write_text(json.dumps({"data_dir": str(data_dir)}, ensure_ascii=False),
                              encoding="utf-8")


def resolve_data_dir():
    """决定数据目录：环境变量 > 指针文件 > exe 旁默认。返回前设置引擎需要的环境变量。"""
    env = os.environ.get("CANVAS_HUB_DATA_DIR")
    p = read_pointer()
    data_dir = Path(env) if env else (p if p else app_dir())
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ["CANVAS_HUB_DATA_DIR"] = str(data_dir)
    return data_dir


_ENGINE = None


def get_engine():
    """懒加载抓取引擎：必须在数据目录环境变量就绪后调用。"""
    global _ENGINE
    if _ENGINE is None:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        import canvas_weekly_report as engine
        _ENGINE = engine
    return _ENGINE


# ---------------------------------------------------------------- 配置读写（基于数据目录）

def cfg_path():
    return resolve_data_dir() / "canvas_config.json"


def load_cfg():
    p = cfg_path()
    if p.is_file():
        try:
            cfg = json.loads(p.read_text(encoding="utf-8"))
            merged = dict(DEFAULT_CONFIG)
            merged.update(cfg)
            merged["github"] = dict(DEFAULT_CONFIG["github"], **(cfg.get("github") or {}))
            return merged
        except json.JSONDecodeError:
            pass
    return dict(DEFAULT_CONFIG)


def save_cfg(cfg):
    cfg_path().write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- 计划任务

def schtasks(args):
    """调用 schtasks，返回 (返回码, stdout, stderr)。中文 Windows 输出为 GBK，需容错解码。"""
    r = subprocess.run(["schtasks", *args], capture_output=True, creationflags=NO_WINDOW)

    def dec(b):
        if not b:
            return ""
        for enc in ("utf-8", "gbk", "mbcs"):
            try:
                return b.decode(enc)
            except (UnicodeDecodeError, LookupError):
                continue
        return b.decode("utf-8", "ignore")

    return r.returncode, dec(r.stdout), dec(r.stderr)


def register_task(freq, weekday, hhmm):
    """注册/更新 Windows 计划任务，返回 (成功, 提示)。"""
    if getattr(sys, "frozen", False):
        tr = '"' + sys.executable + '" --run'
    else:
        tr = '"' + sys.executable + '" "' + str(Path(__file__).resolve()) + '" --run'
    args = ["/Create", "/TN", TASK_NAME, "/TR", tr, "/F", "/ST", hhmm]
    if freq == "每周":
        args += ["/SC", "WEEKLY", "/D", weekday]
    else:
        args += ["/SC", "DAILY"]
    rc, out, err = schtasks(args)
    if rc == 0:
        label = f"每周{weekday} {hhmm}" if freq == "每周" else f"每天 {hhmm}"
        return True, f"已注册定时任务：{label}（任务名 {TASK_NAME}）"
    return False, f"注册失败（可能是权限不足，可尝试以管理员身份运行）：{(err or out).strip()[:200]}"


def unregister_task():
    rc, out, err = schtasks(["/Delete", "/TN", TASK_NAME, "/F"])
    return rc == 0, "已取消定时任务" if rc == 0 else "没有找到已注册的任务"


def task_status():
    rc, out, err = schtasks(["/Query", "/TN", TASK_NAME, "/FO", "LIST"])
    if rc != 0:
        return "未注册"
    for line in (out or "").splitlines():
        if "Next Run Time" in line or "下次运行时间" in line:
            return "已注册 · 下次 " + line.split(":", 1)[-1].strip()
    return "已注册"


def open_in_browser(path):
    try:
        os.startfile(str(path))          # Windows：用默认程序打开
    except AttributeError:
        import webbrowser
        webbrowser.open(Path(path).as_uri())


# ---------------------------------------------------------------- 静默运行与自检

def append_run_log(text):
    try:
        p = resolve_data_dir() / "run.log"
        if p.is_file() and p.stat().st_size > 200_000:
            p.write_text("", encoding="utf-8")
        with open(p, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    except OSError:
        pass


def silent_run(open_after=True):
    engine = get_engine()
    cfg = load_cfg()
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if not cfg.get("access_token", "").strip():
        append_run_log(f"[{stamp}] 跳过：尚未填写访问令牌")
        return 2
    res = engine.run_once(cfg)
    if not res["ok"]:
        append_run_log(f"[{stamp}] 失败：{res['error']}")
        return 1
    w = res["week"]
    n_new = sum(len(x["new_assignments"]) for x in w["courses"])
    n_unsub = sum(1 for x in w["courses"] for a in x["upcoming"] + x["new_assignments"]
                  if a.get("submitted") is False and not a.get("graded"))
    n_files = sum(len(x["new_files"]) for x in w["courses"])
    append_run_log(f"[{stamp}] 成功：{len(w['courses'])} 门课程，新任务 {n_new}，未提交 {n_unsub}，"
                   f"新资料 {n_files}（新下载 {res['stats']['downloaded']}，"
                   f"跳过 {res['stats']['skipped']}，失败 {res['stats']['failed']}）"
                   + (f"；{res['token_warn']}" if res.get("token_warn") else ""))
    if open_after and res.get("website"):
        open_in_browser(res["website"])
    elif open_after and res.get("standalone"):
        open_in_browser(res["standalone"])
    return 0


def selftest():
    engine = get_engine()
    lines = [f"程序目录: {app_dir()}",
             f"数据目录: {resolve_data_dir()}",
             f"配置文件: {cfg_path()} (存在={cfg_path().is_file()})",
             f"页面模板: {engine.resolve_resource('site-template/index.html')}"]
    cfg = load_cfg()
    lines.append(f"Canvas 地址: {cfg['canvas_url']}")
    if cfg.get("access_token"):
        ok, msg = engine.test_connection(cfg)
        lines.append(f"连接测试: {'成功' if ok else '失败'} - {msg}")
    else:
        lines.append("连接测试: 跳过（未填写令牌）")
    text = "\n".join(lines)
    print(text)
    try:
        (resolve_data_dir() / "selftest.log").write_text(text, encoding="utf-8")
    except OSError:
        pass
    return 0


def hex_shift(h, d):
    """颜色微调，用于按钮 hover。"""
    h = h.lstrip("#")
    rgb = [max(0, min(255, int(h[i:i + 2], 16) + d)) for i in (0, 2, 4)]
    return "#%02x%02x%02x" % tuple(rgb)


# ---------------------------------------------------------------- 图形界面

class App:
    STEPS = ["安装位置", "绑定令牌", "定时推送", "完成"]

    def __init__(self):
        self.root = tk.Tk()
        self.root.title(f"{APP_TITLE} {APP_VERSION}")
        self.root.geometry("880x720")
        self.root.minsize(820, 660)
        self.root.configure(bg=C_BG)
        self._init_styles()

        # ---- 顶栏（品牌横幅） ----
        header = tk.Frame(self.root, bg=C_HEADER, height=92)
        header.pack(fill="x")
        header.pack_propagate(False)
        tk.Label(header, text="🎓", font=(FONT, 26), bg=C_HEADER, fg="white") \
            .pack(side="left", padx=(24, 10), pady=14)
        box = tk.Frame(header, bg=C_HEADER)
        box.pack(side="left", fill="y", pady=12)
        tk.Label(box, text=APP_TITLE, font=(FONT_B, 17, "bold"), bg=C_HEADER, fg="white") \
            .pack(anchor="w")
        tk.Label(box, text="每周自动汇总 Canvas 新作业 · 未提交 · 新课件 · 公告",
                 font=(FONT, 10), bg=C_HEADER, fg="#cfe2f7").pack(anchor="w")
        tk.Label(header, text=APP_VERSION, font=(FONT, 10), bg=C_HEADER, fg="#9fc3ea") \
            .pack(side="right", padx=24)

        # ---- 步骤指示条 ----
        self.stepbar = tk.Frame(self.root, bg=C_BG)
        self.stepbar.pack(fill="x", padx=24, pady=(12, 4))
        self.step_labels = []
        for i, name in enumerate(self.STEPS, 1):
            f = tk.Frame(self.stepbar, bg=C_BG)
            f.pack(side="left", padx=(0, 4))
            dot = tk.Label(f, text=f" {i} ", font=(FONT_B, 10, "bold"),
                           bg="#c9d4e4", fg="#5b6b80", width=3)
            dot.pack(side="left")
            lbl = tk.Label(f, text=name, font=(FONT, 10), bg=C_BG, fg=C_MUTED)
            lbl.pack(side="left", padx=(4, 2))
            self.step_labels.append((dot, lbl))
            if i < len(self.STEPS):
                tk.Label(self.stepbar, text="—", bg=C_BG, fg="#c9d4e4",
                         font=(FONT, 10)).pack(side="left", padx=6)

        tk.Frame(self.root, bg=C_LINE, height=1).pack(fill="x", padx=24)

        # ---- 页面容器 ----
        self.pages = {}
        self.container = tk.Frame(self.root, bg=C_BG)
        self.container.pack(fill="both", expand=True, padx=24, pady=12)

        self._build_page_install()
        self._build_page_token()
        self._build_page_schedule()
        self._build_page_main()

        # ---- 底部状态栏 ----
        self.statusbar = tk.Label(self.root, anchor="w", bg="#e8edf5", fg=C_MUTED,
                                  font=(FONT, 9), padx=14, pady=4)
        self.statusbar.pack(fill="x", side="bottom")
        self.refresh_statusbar()

        # 首页跳转：已选过位置 → 令牌页或主界面
        start = os.environ.get("HUB_START_PAGE")
        if start is not None and start.isdigit() and int(start) in range(4):
            self.show(int(start))
        elif read_pointer() is not None:
            cfg = load_cfg()
            self.show(3 if cfg.get("access_token") else 1)
        else:
            self.show(0)

    # ---------------- 通用组件 ----------------

    def _init_styles(self):
        style = ttk.Style(self.root)
        try:
            style.theme_use("vista")
        except tk.TclError:
            pass
        style.configure("TCombobox", font=(FONT, 10))
        self.root.option_add("*Font", (FONT, 10))

    def card(self, parent, title=None, subtitle=None):
        """白色卡片（浅色描边）。"""
        outer = tk.Frame(parent, bg=C_LINE)
        inner = tk.Frame(outer, bg=C_CARD)
        inner.pack(fill="both", expand=True, padx=1, pady=1)
        if title:
            tk.Label(inner, text=title, font=(FONT_B, 12, "bold"), bg=C_CARD,
                     fg="#1f2937", anchor="w").pack(fill="x", padx=18, pady=(14, 0))
        if subtitle:
            tk.Label(inner, text=subtitle, font=(FONT, 9), bg=C_CARD, fg=C_MUTED,
                     anchor="w", justify="left", wraplength=720).pack(fill="x", padx=18, pady=(2, 0))
        return inner

    def btn(self, parent, text, cmd, primary=False):
        bg = C_ACCENT if primary else "#ffffff"
        fg = "white" if primary else "#33445c"
        b = tk.Button(parent, text=text, command=cmd, bg=bg, fg=fg,
                      font=(FONT_B, 10, "bold") if primary else (FONT, 10),
                      relief="flat", cursor="hand2", padx=16, pady=7,
                      borderwidth=1 if not primary else 0,
                      highlightthickness=1 if not primary else 0,
                      highlightbackground=C_LINE,
                      activebackground=hex_shift(bg, 18) if primary else "#eef3fa",
                      activeforeground=fg if primary else C_ACCENT)
        b.bind("<Enter>", lambda e: b.config(bg=hex_shift(bg, 18) if primary else "#f0f5fc"))
        b.bind("<Leave>", lambda e: b.config(bg=bg))
        return b

    def show(self, idx):
        for p in self.pages.values():
            p.pack_forget()
        self.pages[idx].pack(fill="both", expand=True)
        for i, (dot, lbl) in enumerate(self.step_labels):
            if i < idx:
                dot.config(bg=C_OK, fg="white")
                lbl.config(fg=C_OK, font=(FONT, 10))
            elif i == idx:
                dot.config(bg=C_ACCENT, fg="white")
                lbl.config(fg=C_ACCENT, font=(FONT_B, 10, "bold"))
            else:
                dot.config(bg="#c9d4e4", fg="#5b6b80")
                lbl.config(fg=C_MUTED, font=(FONT, 10))
        self.refresh_statusbar()

    def refresh_statusbar(self):
        p = read_pointer() or app_dir()
        cfg = load_cfg()
        tok = "令牌已填写" if cfg.get("access_token") else "未填写令牌"
        self.statusbar.config(text=f"数据位置：{p}    |    {tok}    |    定时任务：{task_status()}")

    # ---------------- 第 1 页：安装位置 ----------------

    def _build_page_install(self):
        pg = tk.Frame(self.container, bg=C_BG)
        self.pages[0] = pg
        inner = self.card(pg, "① 选择数据保存位置",
                          "像安装普通软件一样，选择一个文件夹存放你的周报、课件和配置。"
                          "建议选一个不容易误删的位置（例如 D:\\城大Canvas课程助手\\）。\n"
                          "本软件不写注册表、不装驱动，卸载就是删除文件夹。")
        inner.pack(fill="both", expand=True)

        row = tk.Frame(inner, bg=C_CARD)
        row.pack(fill="x", padx=18, pady=(16, 6))
        tk.Label(row, text="保存位置：", font=(FONT, 10), bg=C_CARD,
                 fg="#33445c").pack(side="left")
        self.install_path = tk.StringVar(value=str(app_dir() / "CanvasData"))
        tk.Entry(row, textvariable=self.install_path, font=(FONT, 10)) \
            .pack(side="left", fill="x", expand=True, padx=8)

        self.space_lbl = tk.Label(inner, text="", font=(FONT, 9), bg=C_CARD,
                                  fg=C_MUTED, anchor="w", justify="left")
        self.space_lbl.pack(fill="x", padx=18)

        def update_space(*_):
            try:
                p = Path(self.install_path.get())
                parent = p if p.exists() else p.parent
                total, used, free = shutil.disk_usage(parent)
                self.space_lbl.config(
                    text=f"可用空间 {free / 1024 ** 3:.1f} GB / 共 {total / 1024 ** 3:.1f} GB"
                         f"（课件按每周几十 MB 估算，足够用很久）")
            except (OSError, ValueError):
                self.space_lbl.config(text="路径不可用，请重新选择")

        def browse():
            d = filedialog.askdirectory(initialdir=self.install_path.get() or str(app_dir()),
                                        title="选择数据保存位置")
            if d:
                self.install_path.set(d)
                update_space()

        self.btn(row, "浏览…", browse).pack(side="left")
        self.install_path.trace_add("write", update_space)
        update_space()

        tk.Label(inner, text="⚠ 请不要选择 C:\\Program Files 等需要管理员权限的文件夹，"
                             "否则数据将无法保存。",
                 font=(FONT, 9), bg="#fdf6e3", fg="#8a6d1a", anchor="w",
                 justify="left", wraplength=740, padx=10, pady=6).pack(fill="x", padx=18, pady=(8, 4))

        bar = tk.Frame(inner, bg=C_CARD)
        bar.pack(fill="x", padx=18, pady=(10, 16))
        self.install_status = tk.Label(bar, text="", font=(FONT, 10), bg=C_CARD, fg=C_OK)
        self.install_status.pack(side="left")

        def do_install():
            target = Path(self.install_path.get().strip())
            try:
                target.mkdir(parents=True, exist_ok=True)
                probe = target / ".write_test"
                probe.write_text("ok", encoding="utf-8")
                probe.unlink()
            except OSError as e:
                self.install_status.config(fg=C_WARN, text="❌ 无法写入该文件夹")
                messagebox.showerror(APP_TITLE, f"无法写入所选文件夹，请换一个位置。\n{e}")
                return
            write_pointer(target)
            resolve_data_dir()          # 立即让引擎指向新目录
            self.install_status.config(fg=C_OK, text="✅ 位置已保存")
            save_cfg(load_cfg())        # 在新目录生成默认配置
            self.show(1)

        self.btn(bar, "下一步：绑定令牌  →", do_install, primary=True).pack(side="right")
        tk.Label(inner, text="", bg=C_CARD).pack()

    # ---------------- 第 2 页：令牌 ----------------

    def _build_page_token(self):
        pg = tk.Frame(self.container, bg=C_BG)
        self.pages[1] = pg
        inner = self.card(pg, "② 绑定 Canvas 令牌",
                          "登录 canvas.cityu.edu.hk → 左下角「账户(Account) → 设置(Settings)」→ "
                          "页面底部「+ 新访问令牌」→ 生成后立即复制（只显示一次），粘贴到下面。\n"
                          "城大令牌最长 90 天有效，填写到期日后软件会在剩 5 天时提醒你更换。")
        inner.pack(fill="both", expand=True)

        def row(label, default="", show=None):
            f = tk.Frame(inner, bg=C_CARD)
            f.pack(fill="x", padx=18, pady=5)
            tk.Label(f, text=label, font=(FONT, 10), bg=C_CARD, fg="#33445c",
                     width=10, anchor="w").pack(side="left")
            var = tk.StringVar(value=default)
            ent = tk.Entry(f, textvariable=var, font=(FONT, 10), show=show)
            ent.pack(side="left", fill="x", expand=True)
            return var, ent

        cfg = load_cfg()
        self.url_var, _ = row("Canvas 地址", cfg["canvas_url"])
        self.token_var, self.token_ent = row("访问令牌", cfg["access_token"], show="●")
        self.exp_var, _ = row("到期日期", cfg["token_expires_at"])

        opt = tk.Frame(inner, bg=C_CARD)
        opt.pack(fill="x", padx=18, pady=(2, 4))
        tk.Label(opt, text="", width=10, bg=C_CARD).pack(side="left")
        show_var = tk.BooleanVar(value=False)

        def toggle():
            self.token_ent.config(show="" if show_var.get() else "●")

        tk.Checkbutton(opt, text="显示令牌", variable=show_var, command=toggle,
                       bg=C_CARD, font=(FONT, 9), fg="#33445c",
                       activebackground=C_CARD).pack(side="left")
        self.dl_var = tk.BooleanVar(value=bool(cfg["download_files"]))
        tk.Checkbutton(opt, text="自动下载新课件到 downloads 文件夹", variable=self.dl_var,
                       bg=C_CARD, font=(FONT, 9), fg="#33445c",
                       activebackground=C_CARD).pack(side="left", padx=10)

        self.token_status = tk.Label(inner, text="", font=(FONT, 10), bg=C_CARD,
                                     fg=C_MUTED, anchor="w", wraplength=740, justify="left")
        self.token_status.pack(fill="x", padx=18, pady=(6, 0))

        bar = tk.Frame(inner, bg=C_CARD)
        bar.pack(fill="x", padx=18, pady=(8, 16))
        self.btn(bar, "← 上一步", lambda: self.show(0)).pack(side="left")

        def do_test():
            self.collect_cfg()
            engine = get_engine()
            c = load_cfg()
            if not c["access_token"]:
                messagebox.showwarning(APP_TITLE, "请先填写访问令牌")
                return
            self.token_status.config(fg=C_MUTED, text="正在测试连接…")
            self.root.update_idletasks()
            ok, msg = engine.test_connection(c)
            self.token_status.config(fg=C_OK if ok else C_WARN,
                                     text=("✅ " if ok else "❌ ") + msg)

        self.btn(bar, "🔌 测试连接", do_test, primary=True).pack(side="right")
        self.btn(bar, "下一步：定时推送  →",
                 lambda: (self.collect_cfg(), self.show(2))).pack(side="right", padx=8)
        tk.Label(inner, text="", bg=C_CARD).pack()

    def collect_cfg(self):
        c = load_cfg()
        c.update({
            "canvas_url": self.url_var.get().strip() or DEFAULT_CONFIG["canvas_url"],
            "access_token": self.token_var.get().strip(),
            "token_expires_at": self.exp_var.get().strip(),
            "download_files": self.dl_var.get(),
            "github": dict(c.get("github") or {}, push_enabled=False),
        })
        save_cfg(c)
        self.refresh_statusbar()
        return c

    # ---------------- 第 3 页：定时推送 ----------------

    def _build_page_schedule(self):
        pg = tk.Frame(self.container, bg=C_BG)
        self.pages[2] = pg
        inner = self.card(pg, "③ 设置每周自动推送",
                          "到点后软件会自动抓取课程动态并弹出「我的学习网站」页面。\n"
                          "需要电脑处于开机且已登录状态；改时间只需重新点一次注册。")
        inner.pack(fill="both", expand=True)

        f = tk.Frame(inner, bg=C_CARD)
        f.pack(fill="x", padx=18, pady=(16, 4))
        tk.Label(f, text="频率", font=(FONT, 10), bg=C_CARD).pack(side="left")
        self.freq_var = tk.StringVar(value="每周")
        ttk.Combobox(f, textvariable=self.freq_var, values=["每周", "每天"], width=6,
                     state="readonly").pack(side="left", padx=(4, 14))
        tk.Label(f, text="星期", font=(FONT, 10), bg=C_CARD).pack(side="left")
        self.wd_var = tk.StringVar(value="周五")
        ttk.Combobox(f, textvariable=self.wd_var, values=[w[0] for w in WEEKDAYS], width=6,
                     state="readonly").pack(side="left", padx=(4, 14))
        tk.Label(f, text="时间", font=(FONT, 10), bg=C_CARD).pack(side="left")
        self.time_var = tk.StringVar(value="19:00")
        tk.Entry(f, textvariable=self.time_var, width=8, font=(FONT, 10)).pack(side="left", padx=(4, 14))

        self.sched_status = tk.Label(inner, text="", font=(FONT, 10), bg=C_CARD,
                                     fg=C_OK, anchor="w")
        self.sched_status.pack(fill="x", padx=18, pady=(4, 0))

        bar = tk.Frame(inner, bg=C_CARD)
        bar.pack(fill="x", padx=18, pady=(8, 16))
        self.btn(bar, "← 上一步", lambda: self.show(1)).pack(side="left")

        def do_register():
            self.collect_cfg()
            hhmm = self.time_var.get().strip()
            try:
                datetime.strptime(hhmm, "%H:%M")
            except ValueError:
                messagebox.showerror(APP_TITLE, "时间格式应为 HH:MM，例如 19:00")
                return
            wd = dict(WEEKDAYS)[self.wd_var.get()]
            ok, msg = register_task(self.freq_var.get(), wd, hhmm)
            self.sched_status.config(fg=C_OK if ok else C_WARN, text=("✅ " if ok else "❌ ") + msg)
            self.refresh_statusbar()
            if ok:
                self.show(3)

        def do_unregister():
            ok, msg = unregister_task()
            self.sched_status.config(fg=C_OK, text=("✅ " if ok else "ℹ️ ") + msg)
            self.refresh_statusbar()

        self.btn(bar, "完成，进入软件  →", do_register, primary=True).pack(side="right")
        self.btn(bar, "取消定时任务", do_unregister).pack(side="right", padx=8)
        tk.Label(inner, text="", bg=C_CARD).pack()

    # ---------------- 第 4 页：主界面（使用说明 + 操作） ----------------

    def _build_page_main(self):
        pg = tk.Frame(self.container, bg=C_BG)
        self.pages[3] = pg

        cvs = tk.Canvas(pg, bg=C_BG, highlightthickness=0)
        scroll = tk.Scrollbar(pg, orient="vertical", command=cvs.yview)
        cvs.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        cvs.pack(side="left", fill="both", expand=True)
        wrap = tk.Frame(cvs, bg=C_BG)
        wrap_id = cvs.create_window((0, 0), window=wrap, anchor="nw")

        def on_cfg(e=None):
            cvs.configure(scrollregion=cvs.bbox("all"))
            cvs.itemconfigure(wrap_id, width=cvs.winfo_width())

        wrap.bind("<Configure>", on_cfg)
        cvs.bind("<Configure>", on_cfg)

        # -- 大按钮区：生成/打开我的学习网站 --
        hero = self.card(wrap)
        hero.pack(fill="x", pady=(0, 10))
        tk.Label(hero, text="🌐 我的学习网站", font=(FONT_B, 13, "bold"),
                 bg=C_CARD, fg="#1f2937", anchor="w").pack(fill="x", padx=18, pady=(14, 2))
        tk.Label(hero, text=f"点「立即抓取」后，会在数据文件夹生成「{WEBSITE_NAME}」，"
                            "双击即可打开，可拷到手机离线查看。",
                 font=(FONT, 9), bg=C_CARD, fg=C_MUTED, anchor="w",
                 justify="left", wraplength=760).pack(fill="x", padx=18)
        brow = tk.Frame(hero, bg=C_CARD)
        brow.pack(fill="x", padx=18, pady=(10, 16))
        self.btn(brow, "🚀 立即抓取并生成网站", self.do_run, primary=True).pack(side="left")
        self.btn(brow, "🌐 打开我的学习网站", self.do_open_website).pack(side="left", padx=8)
        self.btn(brow, "📅 周报文件夹", lambda: self.open_dir("reports")).pack(side="left")
        self.btn(brow, "📂 课件文件夹", lambda: self.open_dir("downloads")).pack(side="left")

        # -- 运行日志 --
        logcard = self.card(wrap, "运行日志")
        logcard.pack(fill="x", pady=(0, 10))
        self.log = tk.Text(logcard, height=8, wrap="word", bg="#10141c", fg="#d6e2f0",
                           insertbackground="white", relief="flat", font=("Consolas", 9),
                           padx=10, pady=8)
        self.log.pack(fill="x", padx=18, pady=(4, 16))

        # -- 使用说明 --
        helpcard = self.card(wrap, "📖 使用说明", "日常只需要记住三件事：")
        helpcard.pack(fill="x", pady=(0, 10))
        items = [
            ("1", "每周到点自动推送", "定时任务到点会自动抓取并弹出「我的学习网站」。"
                                   "若当时电脑关机，本次不补跑，下次到点照常。"),
            ("2", "想随时看一眼", "双击本软件 → 点「🌐 打开我的学习网站」；"
                              f"或直接到数据文件夹双击「{WEBSITE_NAME}」。"),
            ("3", "令牌到期（剩 5 天起提醒）", "城大令牌最长 90 天。软件会在周报和日志里预警，"
                                       "届时到 Canvas 重新生成令牌，回到第②步更新即可。"),
        ]
        for num, title, desc in items:
            rowf = tk.Frame(helpcard, bg=C_CARD)
            rowf.pack(fill="x", padx=18, pady=5)
            tk.Label(rowf, text=f" {num} ", font=(FONT_B, 10, "bold"), bg=C_ACCENT,
                     fg="white", width=3).pack(side="left", anchor="n")
            t = tk.Frame(rowf, bg=C_CARD)
            t.pack(side="left", fill="x", expand=True, padx=(8, 0))
            tk.Label(t, text=title, font=(FONT_B, 10, "bold"), bg=C_CARD,
                     fg="#1f2937", anchor="w").pack(fill="x")
            tk.Label(t, text=desc, font=(FONT, 9), bg=C_CARD, fg=C_MUTED,
                     anchor="w", justify="left", wraplength=700).pack(fill="x")

        files = self.card(wrap, "📁 数据文件夹里都有什么",
                          str(read_pointer() or app_dir()))
        files.pack(fill="x", pady=(0, 10))
        for name, desc in [
            (WEBSITE_NAME, "你的个人学习网站，双击打开（每次运行自动更新）"),
            ("reports/", "每周周报 + 单文件看板（按日期归档）"),
            ("downloads/", "自动下载的课件，按课程代码分文件夹"),
            ("deadlines.ics", "截止日历，双击导入手机日历"),
            ("canvas_config.json", "你的配置（含令牌，不要分享这个文件）"),
            ("run.log", "自动运行记录（排查“到底跑了没有”看这里）"),
        ]:
            r = tk.Frame(files, bg=C_CARD)
            r.pack(fill="x", padx=18, pady=2)
            tk.Label(r, text=name, font=("Consolas", 9), bg=C_CARD, fg=C_ACCENT,
                     anchor="w", width=22).pack(side="left")
            tk.Label(r, text=desc, font=(FONT, 9), bg=C_CARD, fg=C_MUTED,
                     anchor="w").pack(side="left")

        # -- 设置返回 --
        setcard = self.card(wrap, "⚙️ 设置",
                            "改令牌 / 改时间 / 换保存位置（换位置后需重新注册定时任务）")
        setcard.pack(fill="x", pady=(0, 12))
        srow = tk.Frame(setcard, bg=C_CARD)
        srow.pack(fill="x", padx=18, pady=(6, 16))
        self.btn(srow, "改令牌 / 地址", lambda: self.show(1)).pack(side="left")
        self.btn(srow, "改定时时间", lambda: self.show(2)).pack(side="left", padx=8)

        def reset_location():
            if not messagebox.askyesno(APP_TITLE, "更换保存位置：需要重新走一遍安装向导，"
                                                  "现有数据不会移动（可自行拷贝）。\n继续吗？"):
                return
            unregister_task()
            try:
                pointer_path().unlink()
            except OSError:
                pass
            self.show(0)

        self.btn(srow, "更换保存位置", reset_location).pack(side="left")

        tk.Label(wrap, text="隐私：令牌与课程数据只保存在你自己的电脑，本软件不向任何服务器上传数据。",
                 font=(FONT, 9), bg=C_BG, fg=C_MUTED).pack(pady=(0, 8))

    # ---------------- 主界面动作 ----------------

    def say(self, msg):
        self.log.insert("end", msg + "\n")
        self.log.see("end")

    def open_dir(self, name):
        engine = get_engine()
        p = engine.BASE_DIR / name
        p.mkdir(parents=True, exist_ok=True)
        open_in_browser(p)

    def do_run(self):
        engine = get_engine()
        cfg = self.collect_cfg()
        if not cfg["access_token"]:
            messagebox.showwarning(APP_TITLE, "请先在第②步填写访问令牌")
            self.show(1)
            return
        self.say("开始抓取，请稍候…")

        def work():
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                    res = engine.run_once(cfg)
            except Exception as e:            # 兜底：任何异常都要反馈
                res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            out = buf.getvalue().strip()
            if out:
                self.say(out)
            if not res.get("ok"):
                self.say(f"❌ 抓取失败：{res.get('error')}")
            else:
                w = res["week"]
                n_new = sum(len(x["new_assignments"]) for x in w["courses"])
                n_unsub = sum(1 for x in w["courses"] for a in x["upcoming"] + x["new_assignments"]
                              if a.get("submitted") is False and not a.get("graded"))
                n_files = len([f for x in w["courses"] for f in x["new_files"]])
                self.say(f"✅ 完成：{len(w['courses'])} 门课程，新任务 {n_new} 个，"
                         f"未提交 {n_unsub} 个，新资料 {n_files} 份"
                         f"（新下载 {res['stats']['downloaded']}，跳过 {res['stats']['skipped']}，"
                         f"失败 {res['stats']['failed']}）")
                if res.get("token_warn"):
                    self.say("⚠️ " + res["token_warn"])
                if res.get("website"):
                    self.say(f"🌐 学习网站已生成：{res['website']}")
                    open_in_browser(res["website"])

        threading.Thread(target=work, daemon=True).start()

    def do_open_website(self):
        engine = get_engine()
        web = engine.BASE_DIR / WEBSITE_NAME
        if web.is_file():
            open_in_browser(web)
            return
        files = sorted((engine.BASE_DIR / "reports").glob("本周课程动态_*.html"))
        if files:
            open_in_browser(files[-1])
        else:
            messagebox.showinfo(APP_TITLE, "还没有生成学习网站，请先点「🚀 立即抓取并生成网站」")

    def run(self):
        self.root.mainloop()
        return 0


def build_gui():
    return App().run()


def main():
    args = sys.argv[1:]
    if "--selftest" in args:
        resolve_data_dir()
        return selftest()
    if "--run" in args:
        resolve_data_dir()
        return silent_run(open_after="--no-open" not in args)
    return build_gui()


if __name__ == "__main__":
    sys.exit(main())
