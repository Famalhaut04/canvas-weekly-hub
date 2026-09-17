#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""城大 Canvas 课程助手 · 图形界面版

面向不使用 AI agent 的同学：填好 Canvas 令牌，注册一个每周定时任务，
之后每周自动抓取课程动态并打开看板，无需任何命令行操作。

打包为 exe 后双击即可运行；也支持：
    --run            静默执行一次抓取并打开看板（供计划任务调用）
    --run --no-open  静默执行但不打开浏览器
    --selftest       自检：检查数据目录、配置与网络连通性
"""

import contextlib
import io
import json
import os
import subprocess
import sys
import threading
import webbrowser
from datetime import datetime
from pathlib import Path

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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import canvas_weekly_report as engine  # noqa: E402

APP_TITLE = "城大 Canvas 课程助手"
TASK_NAME = "CityU-Canvas-Assistant"      # 计划任务名（用 ASCII，避免命令行编码问题）
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


# ---------------------------------------------------------------- 配置读写

def load_cfg():
    if engine.CONFIG_PATH.is_file():
        try:
            cfg = json.loads(engine.CONFIG_PATH.read_text(encoding="utf-8"))
            merged = dict(DEFAULT_CONFIG)
            merged.update(cfg)
            merged["github"] = dict(DEFAULT_CONFIG["github"], **(cfg.get("github") or {}))
            return merged
        except json.JSONDecodeError:
            pass
    return dict(DEFAULT_CONFIG)


def save_cfg(cfg):
    engine.CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


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
        tr = f'"{sys.executable}" --run'
    else:
        tr = f'"{sys.executable}" "{Path(__file__).resolve()}" --run'
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
        webbrowser.open(path.as_uri())


def latest_standalone():
    files = sorted(engine.REPORT_DIR.glob("本周课程动态_*.html"))
    return files[-1] if files else None


# ---------------------------------------------------------------- 静默运行（计划任务调用）

def append_run_log(text):
    """静默运行没有界面，把结果追加到 run.log，便于用户排查"到底跑了没有"。"""
    try:
        p = engine.BASE_DIR / "run.log"
        if p.is_file() and p.stat().st_size > 200_000:
            p.write_text("", encoding="utf-8")
        with open(p, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    except OSError:
        pass


def silent_run(open_after=True):
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
                   f"新资料 {n_files}（新下载 {res['stats']['downloaded']}，跳过 {res['stats']['skipped']}，"
                   f"失败 {res['stats']['failed']}）"
                   + (f"；{res['token_warn']}" if res.get("token_warn") else ""))
    if open_after and res["standalone"]:
        open_in_browser(res["standalone"])
    return 0


def selftest():
    lines = []
    lines.append(f"数据目录: {engine.BASE_DIR}")
    lines.append(f"配置文件: {engine.CONFIG_PATH} (存在={engine.CONFIG_PATH.is_file()})")
    lines.append(f"页面模板: {engine.resolve_resource('site-template/index.html')}")
    cfg = load_cfg()
    lines.append(f"Canvas 地址: {cfg['canvas_url']}")
    if cfg.get("access_token"):
        ok, msg = engine.test_connection(cfg)
        lines.append(f"连接测试: {'成功' if ok else '失败'} - {msg}")
    else:
        lines.append("连接测试: 跳过（未填写令牌）")
    text = "\n".join(lines)
    print(text)
    # 打包成无控制台窗口的程序时看不到输出，同时写入日志文件便于排查
    try:
        (engine.BASE_DIR / "selftest.log").write_text(text, encoding="utf-8")
    except OSError:
        pass
    return 0


# ---------------------------------------------------------------- 图形界面

def build_gui():
    import tkinter as tk
    from tkinter import messagebox, ttk

    cfg = load_cfg()
    root = tk.Tk()
    root.title(f"{APP_TITLE} v1.0")
    root.geometry("760x680")
    root.minsize(700, 600)

    pad = {"padx": 10, "pady": 4}

    header = tk.Label(root, text=f"🎓 {APP_TITLE}", font=("Microsoft YaHei", 14, "bold"),
                      anchor="w", fg="#1e5aa8")
    header.pack(fill="x", **pad)
    tk.Label(root, text="填好 Canvas 令牌 → 注册每周定时任务 → 之后自动推送，无需任何命令行操作",
             anchor="w", fg="#555").pack(fill="x", padx=10)

    # ---- 第一步：Canvas 信息 ----
    box1 = ttk.LabelFrame(root, text=" 第一步：填写 Canvas 信息 ")
    box1.pack(fill="x", **pad)

    def row(parent, label, default="", width=46, show=None):
        f = tk.Frame(parent)
        f.pack(fill="x", padx=10, pady=3)
        tk.Label(f, text=label, width=12, anchor="w").pack(side="left")
        var = tk.StringVar(value=default)
        ent = tk.Entry(f, textvariable=var, width=width, show=show)
        ent.pack(side="left", fill="x", expand=True)
        return var, ent

    url_var, _ = row(box1, "Canvas 地址", cfg["canvas_url"])
    token_var, token_ent = row(box1, "访问令牌", cfg["access_token"], show="●")
    exp_var, _ = row(box1, "令牌到期日", cfg["token_expires_at"])

    f_show = tk.Frame(box1)
    f_show.pack(fill="x", padx=10)
    tk.Label(f_show, text="", width=12).pack(side="left")
    show_var = tk.BooleanVar(value=False)

    def toggle_show():
        token_ent.config(show="" if show_var.get() else "●")
    tk.Checkbutton(f_show, text="显示令牌", variable=show_var, command=toggle_show).pack(side="left")
    dl_var = tk.BooleanVar(value=bool(cfg["download_files"]))
    tk.Checkbutton(f_show, text="自动下载新课件到 downloads 文件夹", variable=dl_var).pack(side="left", padx=12)

    tk.Label(box1, text="令牌获取：登录 Canvas → 账户(Account) → 设置(Settings) → 页面底部「+ 新访问令牌」，"
                        "生成后立即复制粘贴到上方（只显示一次）",
             anchor="w", fg="#777", wraplength=700, justify="left").pack(fill="x", padx=10, pady=(2, 6))

    # ---- 第二步：定时任务 ----
    box2 = ttk.LabelFrame(root, text=" 第二步：设置每周自动推送 ")
    box2.pack(fill="x", **pad)
    f2 = tk.Frame(box2)
    f2.pack(fill="x", padx=10, pady=6)
    tk.Label(f2, text="频率").pack(side="left")
    freq_var = tk.StringVar(value="每周")
    ttk.Combobox(f2, textvariable=freq_var, values=["每周", "每天"], width=6,
                 state="readonly").pack(side="left", padx=(4, 12))
    tk.Label(f2, text="星期").pack(side="left")
    wd_var = tk.StringVar(value="周五")
    ttk.Combobox(f2, textvariable=wd_var, values=[w[0] for w in WEEKDAYS], width=6,
                 state="readonly").pack(side="left", padx=(4, 12))
    tk.Label(f2, text="时间").pack(side="left")
    time_var = tk.StringVar(value="19:00")
    tk.Entry(f2, textvariable=time_var, width=8).pack(side="left", padx=(4, 12))

    status_var = tk.StringVar(value="")
    tk.Label(f2, textvariable=status_var, fg="#0a7").pack(side="left")

    # ---- 第三步：操作按钮 ----
    box3 = ttk.LabelFrame(root, text=" 操作 ")
    box3.pack(fill="x", **pad)
    log = tk.Text(root, height=13, wrap="word", bg="#0f1115", fg="#d6e2f0",
                  font=("Consolas", 9))
    log.pack(fill="both", expand=True, padx=10, pady=(0, 10))

    def say(msg):
        log.insert("end", msg + "\n")
        log.see("end")
        root.update_idletasks()

    def collect():
        c = load_cfg()
        c.update({
            "canvas_url": url_var.get().strip(),
            "access_token": token_var.get().strip(),
            "token_expires_at": exp_var.get().strip(),
            "download_files": dl_var.get(),
            "github": dict(c.get("github") or {}, push_enabled=False),
        })
        save_cfg(c)
        return c

    def do_test():
        c = collect()
        if not c["access_token"]:
            messagebox.showwarning(APP_TITLE, "请先填写访问令牌")
            return
        say("正在测试连接…")
        ok, msg = engine.test_connection(c)
        say(("✅ " if ok else "❌ ") + msg)

    def do_run():
        c = collect()
        if not c["access_token"]:
            messagebox.showwarning(APP_TITLE, "请先填写访问令牌")
            return
        btn_run.config(state="disabled")
        say("开始抓取，请稍候…")

        def work():
            buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                    res = engine.run_once(c)
            except Exception as e:            # 兜底：任何异常都要让按钮恢复可用
                res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            out = buf.getvalue().strip()
            if out:
                say(out)
            if not res.get("ok"):
                say(f"❌ 抓取失败：{res.get('error')}")
            else:
                w = res["week"]
                n_new = sum(len(x["new_assignments"]) for x in w["courses"])
                n_unsub = sum(1 for x in w["courses"] for a in x["upcoming"] + x["new_assignments"]
                              if a.get("submitted") is False and not a.get("graded"))
                say(f"✅ 完成：{len(w['courses'])} 门课程，新任务 {n_new} 个，未提交 {n_unsub} 个，"
                    f"新资料 {len([f for x in w['courses'] for f in x['new_files']])} 份"
                    f"（新下载 {res['stats']['downloaded']}，已存在跳过 {res['stats']['skipped']}，"
                    f"失败 {res['stats']['failed']}）")
                if res.get("token_warn"):
                    say("⚠️ " + res["token_warn"])
                if res.get("standalone"):
                    say(f"看板已生成：{res['standalone']}")
                    open_in_browser(res["standalone"])
            btn_run.config(state="normal")
        threading.Thread(target=work, daemon=True).start()

    def do_open_board():
        f = latest_standalone()
        if f:
            open_in_browser(f)
        else:
            messagebox.showinfo(APP_TITLE, "还没有生成看板，请先点「立即抓取一次」")

    def do_open_dir(p):
        p = Path(p)
        p.mkdir(parents=True, exist_ok=True)
        open_in_browser(p)

    def do_register():
        c = collect()
        if not c["access_token"]:
            messagebox.showwarning(APP_TITLE, "请先填写并保存访问令牌")
            return
        hhmm = time_var.get().strip()
        try:
            datetime.strptime(hhmm, "%H:%M")
        except ValueError:
            messagebox.showerror(APP_TITLE, "时间格式应为 HH:MM，例如 19:00")
            return
        wd = dict(WEEKDAYS)[wd_var.get()]
        ok, msg = register_task(freq_var.get(), wd, hhmm)
        status_var.set("已注册" if ok else "注册失败")
        say(("✅ " if ok else "❌ ") + msg)
        if ok:
            messagebox.showinfo(APP_TITLE, msg + "\n\n到点后会自动抓取并弹出看板（需电脑开机且已登录）。")
        else:
            messagebox.showwarning(APP_TITLE, msg)

    def do_unregister():
        ok, msg = unregister_task()
        status_var.set("未注册")
        say(("✅ " if ok else "ℹ️ ") + msg)

    def mk(parent, text, cmd):
        b = tk.Button(parent, text=text, command=cmd)
        b.pack(side="left", padx=6, pady=6)
        return b

    mk(box1, "测试连接", do_test)
    btn_run = mk(box3, "立即抓取一次", do_run)
    mk(box3, "打开最新看板", do_open_board)
    mk(box3, "周报文件夹", lambda: do_open_dir(engine.REPORT_DIR))
    mk(box3, "课件文件夹", lambda: do_open_dir(engine.BASE_DIR / cfg["download_dir"]))
    mk(box2, "注册 / 更新定时任务", do_register)
    mk(box2, "取消定时任务", do_unregister)

    status_var.set(task_status())
    say(f"数据目录：{engine.BASE_DIR}")
    say("提示：先在第一步粘贴令牌并「测试连接」，通过后到第二步设置时间并注册定时任务。")
    say("说明：定时任务到点运行时，会自动抓取课程动态并弹出看板（电脑需开机且已登录）。")

    root.mainloop()
    return 0


def main():
    args = sys.argv[1:]
    if "--selftest" in args:
        return selftest()
    if "--run" in args:
        return silent_run(open_after="--no-open" not in args)
    return build_gui()


if __name__ == "__main__":
    sys.exit(main())
