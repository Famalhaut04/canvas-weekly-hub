#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Canvas LMS 每周课程动态抓取 + 学习网站更新脚本。

适用于任意 Canvas LMS（Instructure）实例（如香港城市大学 canvas.cityu.edu.hk），
配置文件中修改 canvas_url 即可适配自己学校的 Canvas。

流程：
  1. 读取同目录 canvas_config.json（Canvas 地址、API Token、GitHub 设置、时区）
  2. 调用 Canvas REST API 抓取本学期全部活跃课程的：
       - 过去 N 天新建/有更新的作业任务
       - 未来 N 天即将截止的作业
       - 过去 N 天新上传的文件资料（PPT/PDF/Word 等）
       - 过去 N 天发布的新公告
  3. 在 reports/ 目录生成 markdown 周报（canvas周报_日期.md）
  4. 将本周数据合并进学习网站仓库的 data.json，并 git commit + push

安全约定：canvas_config.json 含个人 Token，已被 .gitignore 排除，永远不会进入任何仓库。

仅依赖 Python 标准库。token 未配置时生成提示报告并正常退出（退出码 2）。
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HK_TZ = timezone(timedelta(hours=8))  # 默认 UTC+8，可被配置项 tz_offset_hours 覆盖


def resolve_base_dir():
    """确定数据目录：配置文件、周报、下载、快照都放这里。

    - 若设置了环境变量 CANVAS_HUB_DATA_DIR，优先使用（便于测试或多实例）；
    - 若被 PyInstaller 打包成 exe，用 exe 所在目录（__file__ 在 exe 里指向临时解压目录，
      写入那里会在退出时丢失）；
    - 否则用脚本所在目录。
    """
    env = os.environ.get("CANVAS_HUB_DATA_DIR")
    if env:
        p = Path(env)
        p.mkdir(parents=True, exist_ok=True)
        return p
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def resolve_resource(rel_path):
    """查找随程序分发的只读资源（如页面模板）：exe 内置资源 → 数据目录 → 脚本目录。"""
    candidates = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / rel_path)
    candidates.append(BASE_DIR / rel_path)
    candidates.append(Path(__file__).resolve().parent / rel_path)
    for c in candidates:
        if c.is_file():
            return c
    return None


BASE_DIR = resolve_base_dir()
CONFIG_PATH = BASE_DIR / "canvas_config.json"
REPORT_DIR = BASE_DIR / "reports"
LOCAL_DATA = BASE_DIR / "data.json"
PER_PAGE = 100
MAX_PAGES = 20


# ---------------------------------------------------------------- 基础工具

def load_config():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        print("CONFIG_MISSING: 未找到 canvas_config.json。"
              "请先复制 config/canvas_config.example.json 为 canvas_config.json，"
              "并填入你自己的 Canvas Token（步骤见 docs/部署指南.md）。")
        sys.exit(2)
    except json.JSONDecodeError as e:
        print(f"CONFIG_INVALID: canvas_config.json 不是合法的 JSON：{e}")
        sys.exit(2)


def parse_ts(s):
    """解析 Canvas 的 ISO8601 时间字符串为 aware datetime。"""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def fmt_hk(dt):
    return dt.astimezone(HK_TZ).strftime("%Y-%m-%d %H:%M") if dt else "无截止时间"


def api_get_all(base_url, token, path, params=None):
    """GET Canvas API 并自动翻页，返回全部条目列表。"""
    params = dict(params or {})
    params.setdefault("per_page", PER_PAGE)
    items = []
    page = 1
    while page <= MAX_PAGES:
        qs = dict(params)
        qs["page"] = page
        url = f"{base_url.rstrip('/')}/api/v1{path}?" + urllib.parse.urlencode(qs, doseq=True)
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                batch = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:200]
            raise RuntimeError(f"Canvas API {path} 返回 HTTP {e.code}：{detail}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"无法连接 Canvas（{e.reason}）。请检查网络/校园网。") from e
        if not isinstance(batch, list):
            batch = [batch]
        items.extend(batch)
        if len(batch) < int(params["per_page"]):
            break
        page += 1
    return items


def strip_html(html, limit=160):
    text = re.sub(r"<[^>]+>", " ", html or "")
    text = re.sub(r"&[a-z]+;|&#\d+;", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def assign_kind(a):
    """推断作业类型，用于界面图标区分。"""
    types = a.get("submission_types") or []
    if a.get("is_quiz_assignment") or a.get("quiz_id") or "online_quiz" in types:
        return "测验"
    if "discussion_topic" in types:
        return "讨论"
    if "online_upload" in types or "online_text_entry" in types or "online_url" in types:
        return "提交作业"
    if "external_tool" in types:
        return "外部工具"
    if "not_graded" in types:
        return "不计分"
    return "任务"


# ---------------------------------------------------------------- 状态快照（增量 diff）

def load_last_state():
    try:
        return json.loads((BASE_DIR / "last_state.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_last_state(state):
    state["saved_at"] = datetime.now(timezone.utc).isoformat()
    (BASE_DIR / "last_state.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- 课件下载

def download_new_file(base, token, cid, fobj, dest_dir):
    """下载单个新文件，返回 (状态, 本地路径)。

    状态为 "downloaded"（实际下载）、"skipped"（本地已有同大小文件）或 None（失败）。
    """
    fid = fobj.get("id")
    if not fid:
        return None, None
    safe_name = re.sub(r'[\\/:*?"<>|]', "_", fobj.get("name", f"file_{fid}"))
    dest = dest_dir / safe_name
    try:
        if fobj.get("size_bytes") and dest.exists() and dest.stat().st_size == fobj["size_bytes"]:
            return "skipped", str(dest)
        meta = api_get_all(base, token, f"/courses/{cid}/files/{fid}")
        url = (meta[0] if isinstance(meta, list) else meta).get("url")
        if not url:
            return None, None
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=180) as resp, open(dest, "wb") as out:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                out.write(chunk)
        return "downloaded", str(dest)
    except Exception as e:  # 下载失败不阻断整体流程
        print(f"  [下载失败] {fobj.get('name')}: {e}", file=sys.stderr)
        if dest.exists():
            dest.unlink(missing_ok=True)
        return None, None


# ---------------------------------------------------------------- ICS 日历导出

def ics_escape(s):
    return (s or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def build_ics(week, path):
    """把未来有截止时间的任务写成 ICS 日历文件，返回事件数量。"""
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0",
             "PRODID:-//canvas-weekly-hub//deadline-export//CN",
             "CALSCALE:GREGORIAN", "METHOD:PUBLISH"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    count = 0
    for c in week["courses"]:
        seen = set()
        pool = c.get("upcoming", []) + c.get("new_assignments", [])
        for a in pool:
            dt = parse_ts(a.get("due_iso"))
            if not dt or dt < datetime.now(timezone.utc):
                continue
            key = (a.get("url") or "") + "|" + a["name"]
            if key in seen:
                continue
            seen.add(key)
            uid = hashlib.md5(key.encode("utf-8")).hexdigest() + "@canvas-weekly-hub"
            start = dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            end = (dt + timedelta(minutes=15)).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            summary = ics_escape(f"[{c.get('code') or c['name']}] {a['name']}")
            lines += ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}",
                      f"DTSTART:{start}", f"DTEND:{end}",
                      f"SUMMARY:{summary}",
                      f"DESCRIPTION:{ics_escape(a.get('url', ''))}",
                      "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY",
                      f"DESCRIPTION:{ics_escape(a['name'])}", "END:VALARM",
                      "END:VEVENT"]
            count += 1
    lines.append("END:VCALENDAR")
    path.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
    return count


def file_kind(name):
    n = (name or "").lower()
    if n.endswith((".ppt", ".pptx", ".key")):
        return "PPT"
    if n.endswith(".pdf"):
        return "PDF"
    if n.endswith((".doc", ".docx", ".rtf")):
        return "Word"
    if n.endswith((".xls", ".xlsx", ".csv")):
        return "Excel"
    if n.endswith((".zip", ".rar", ".7z", ".tar", ".gz")):
        return "压缩包"
    if n.endswith((".py", ".ipynb", ".java", ".c", ".cpp", ".h", ".m", ".r", ".sql")):
        return "代码"
    if n.endswith((".mp4", ".mov", ".avi", ".mkv")):
        return "视频"
    return "其他"


# ---------------------------------------------------------------- 数据抓取

def fetch_week_data(cfg):
    base = cfg["canvas_url"]
    token = cfg["access_token"].strip()
    lookback_days = int(cfg.get("lookback_days", 7))
    upcoming_days = int(cfg.get("upcoming_days", 7))
    term_filter = (cfg.get("term_filter") or "").strip()
    prev_state = load_last_state()
    new_state = {"assignments": {}}
    stats = {"downloaded": 0, "skipped": 0, "failed": 0, "total": 0}

    now = datetime.now(timezone.utc)
    lookback_start = now - timedelta(days=lookback_days)
    upcoming_end = now + timedelta(days=upcoming_days)

    courses = api_get_all(base, token, "/courses", {
        "enrollment_state": "active",
        "include[]": ["term"],
    })
    if term_filter:
        courses = [c for c in courses
                   if term_filter.lower() in (c.get("term") or {}).get("name", "").lower()]

    week_courses = []
    for c in courses:
        cid = c["id"]
        name = c.get("name") or f"课程{cid}"
        code = c.get("course_code", "")
        term = (c.get("term") or {}).get("name", "")

        # ---- 作业 ----
        try:
            assignments = api_get_all(base, token, f"/courses/{cid}/assignments",
                                      {"order_by": "due_at", "include[]": ["submission"]})
        except RuntimeError:
            assignments = []
        new_assignments, upcoming, changes = [], [], []
        course_state = {}
        prev_course = prev_state.get("assignments", {}).get(str(cid), {})
        for a in assignments:
            created, updated, due = parse_ts(a.get("created_at")), parse_ts(a.get("updated_at")), parse_ts(a.get("due_at"))
            sub = a.get("submission") or {}
            wf = sub.get("workflow_state")
            submitted = wf in ("submitted", "graded", "pending_review")
            graded = wf == "graded"
            is_new = bool(created and created >= lookback_start)
            is_updated = (not is_new) and bool(updated and updated >= lookback_start)

            # 记录当前状态，与上次快照对比出"改期/新评分/移除"
            aid = str(a.get("id"))
            course_state[aid] = {"name": a.get("name", ""),
                                 "due_iso": due.isoformat() if due else None,
                                 "wf": wf}
            prev = prev_course.get(aid)
            if prev:
                aname = a.get("name", "未命名任务")
                if prev.get("due_iso") and prev["due_iso"] != course_state[aid]["due_iso"]:
                    changes.append({"type": "改期", "name": aname,
                                    "detail": f"截止时间 {fmt_hk(parse_ts(prev['due_iso']))} → {fmt_hk(due)}"})
                if prev.get("wf") != "graded" and graded:
                    changes.append({"type": "新评分", "name": aname,
                                    "detail": f"已评分：{sub.get('score', '-')} / {a.get('points_possible', '-')} 分"})

            is_due_soon = bool(due and now <= due <= upcoming_end)
            if not (is_new or is_updated or is_due_soon):
                continue
            item = {
                "name": a.get("name", "未命名任务"),
                "kind": assign_kind(a),
                "due_at": fmt_hk(due),
                "due_iso": due.isoformat() if due else None,
                "points": a.get("points_possible"),
                "url": a.get("html_url", ""),
                "status": "新布置" if is_new else ("有更新" if is_updated else None),
                "submitted": submitted,
                "graded": graded,
                "score": sub.get("score"),
            }
            if is_new or is_updated:
                new_assignments.append(item)
            if is_due_soon:
                upcoming.append(dict(item))
        # 上次见过、这次消失的作业 = 已删除或被老师隐藏
        for aid, prev in prev_course.items():
            if aid not in course_state:
                changes.append({"type": "移除", "name": prev.get("name") or aid,
                                "detail": "作业已从课程中删除或被隐藏"})
        new_state["assignments"][str(cid)] = course_state

        # ---- 新文件 ----
        try:
            files = api_get_all(base, token, f"/courses/{cid}/files",
                                {"sort": "created_at", "order": "desc"})
        except RuntimeError:
            files = []
        new_files = []
        files_page = f"{base}/courses/{cid}/files"
        for f_ in files:
            created, updated = parse_ts(f_.get("created_at")), parse_ts(f_.get("updated_at"))
            if not (created and created >= lookback_start):
                continue
            changed = bool(updated and (updated - created).total_seconds() > 3600)
            fname = f_.get("display_name") or f_.get("filename") or "未命名文件"
            new_files.append({
                "id": f_.get("id"),
                "name": fname,
                "kind": file_kind(fname),
                "created_at": fmt_hk(created),
                "updated_at": fmt_hk(updated),
                "is_update": changed,
                "size_bytes": f_.get("size") or 0,
                "size_kb": round((f_.get("size") or 0) / 1024),
                # Canvas 文件本身没有可公开访问的直链，统一指向课程「文件」页，浏览器已登录即可打开
                "url": files_page,
            })
        # 新资料自动下载到本地复习目录（可在配置中关闭）
        if cfg.get("download_files", True) and new_files:
            dl_dir = Path(cfg.get("download_dir") or "downloads")
            if not dl_dir.is_absolute():
                dl_dir = BASE_DIR / dl_dir
            dl_dir = dl_dir / re.sub(r'[\\/:*?"<>|]', "_", code or name)
            dl_dir.mkdir(parents=True, exist_ok=True)
            for f_ in new_files:
                stats["total"] += 1
                status, saved = download_new_file(base, token, cid, f_, dl_dir)
                f_["saved"] = bool(saved)
                if status == "downloaded":
                    stats["downloaded"] += 1
                elif status == "skipped":
                    stats["skipped"] += 1
                else:
                    stats["failed"] += 1

        # ---- 公告 ----
        try:
            anns = api_get_all(base, token, f"/courses/{cid}/announcements", {})
        except RuntimeError:
            anns = []
        new_anns = []
        for an in anns:
            created = parse_ts(an.get("created_at")) or parse_ts(an.get("posted_at"))
            if created and created >= lookback_start:
                new_anns.append({
                    "title": an.get("title", "无标题公告"),
                    "created_at": fmt_hk(created),
                    "summary": strip_html(an.get("message", "")),
                    "url": an.get("html_url", ""),
                })

        week_courses.append({
            "name": name,
            "code": code,
            "term": term,
            "url": f"{base}/courses/{cid}",
            "new_assignments": new_assignments,
            "upcoming": upcoming,
            "new_files": new_files,
            "announcements": new_anns,
            "changes": changes,
        })

    week = {
        "date": now.astimezone(HK_TZ).strftime("%Y-%m-%d"),
        "generated_at": now.astimezone(HK_TZ).strftime("%Y-%m-%d %H:%M"),
        "range": f"{lookback_start.astimezone(HK_TZ).strftime('%Y-%m-%d %H:%M')} ~ {now.astimezone(HK_TZ).strftime('%Y-%m-%d %H:%M')}",
        "courses": week_courses,
    }
    return week, new_state, stats


# ---------------------------------------------------------------- 周报生成

def sub_label(a):
    """作业提交状态的可读标签。"""
    if a.get("graded"):
        score = a.get("score")
        return f"已评分 {score if score is not None else '-'}分"
    if a.get("submitted"):
        return "已提交"
    if a.get("submitted") is False:
        return "**未提交**"
    return "-"


def render_markdown(week, token_warn=None, stats=None):
    stats = stats or {"downloaded": 0, "skipped": 0, "failed": 0, "total": 0}
    warn_block = [f"> ⚠️ **{token_warn}**", ""] if token_warn else []
    lines = [
        f"# Canvas 每周课程动态周报（{week['date']}）",
        "",
        f"> 数据抓取时间：{week['generated_at']}；统计范围：过去 7 天新增 + 未来 7 天截止。",
        "",
    ] + warn_block + [
        "## 本周总览",
        "",
    ]
    n_new = sum(len(c["new_assignments"]) for c in week["courses"])
    n_up = sum(len(c["upcoming"]) for c in week["courses"])
    n_files = sum(len(c["new_files"]) for c in week["courses"])
    n_anns = sum(len(c["announcements"]) for c in week["courses"])
    n_unsub = sum(1 for c in week["courses"] for a in c["upcoming"] + c["new_assignments"]
                  if a.get("submitted") is False and not a.get("graded"))
    n_changes = sum(len(c.get("changes") or []) for c in week["courses"])
    lines += [
        f"- 本学期活跃课程：{len(week['courses'])} 门",
        f"- 本周新作业/任务：{n_new} 个；未来 7 天截止：{n_up} 个（未提交 {n_unsub} 个）",
        f"- 本周新上传资料：{n_files} 份（新下载 {stats.get('downloaded', 0)} 份，已存在跳过 {stats.get('skipped', 0)} 份，失败 {stats.get('failed', 0)} 份）",
        f"- 新公告：{n_anns} 条；与上次相比变化：{n_changes} 处",
        "",
    ]
    def is_active(c):
        return bool(c["new_assignments"] or c["upcoming"] or c["new_files"] or c["announcements"])

    for c in [x for x in week["courses"] if is_active(x) or x.get("changes")]:
        lines += [f"## {c['name']}（{c['code']}）", ""]
        if c.get("changes"):
            lines += ["### 🔄 与上次相比的变化", ""]
            for ch in c["changes"]:
                lines.append(f"- **{ch['type']}**：{ch['name']}（{ch['detail']}）")
            lines.append("")
        lines += ["### 📝 本周新作业 / 任务", ""]
        if c["new_assignments"]:
            lines += ["| 任务 | 截止时间 | 分值 | 状态 | 提交 |", "|---|---|---|---|---|"]
            for a in c["new_assignments"]:
                pts = a["points"] if a["points"] is not None else "-"
                lines.append(f"| [{a['name']}]({a['url']}) | {a['due_at']} | {pts} | {a['status']} | {sub_label(a)} |")
        else:
            lines.append("本周无新增。")
        lines += ["", "### ⏰ 未来 7 天截止", ""]
        if c["upcoming"]:
            lines += ["| 任务 | 截止时间 | 分值 | 提交 |", "|---|---|---|---|"]
            for a in c["upcoming"]:
                pts = a["points"] if a["points"] is not None else "-"
                lines.append(f"| [{a['name']}]({a['url']}) | {a['due_at']} | {pts} | {sub_label(a)} |")
        else:
            lines.append("未来 7 天没有截止的任务。")
        lines += ["", "### 📂 本周新上传资料", ""]
        if c["new_files"]:
            lines += ["| 文件 | 类型 | 大小 | 上传时间 |", "|---|---|---|---|"]
            for f_ in c["new_files"]:
                when = f_["updated_at"] if f_.get("is_update") else f_["created_at"]
                mark = "（有更新）" if f_.get("is_update") else ""
                lines.append(f"| [{f_['name']}]({f_['url']}) | {f_['kind']} | {f_['size_kb']} KB | {when}{mark} |")
        else:
            lines.append("本周无新资料。")
        lines += ["", "### 📢 新公告", ""]
        if c["announcements"]:
            for an in c["announcements"]:
                title = f"[{an['title']}]({an['url']})" if an.get("url") else f"**{an['title']}**"
                lines.append(f"- {title}（{an['created_at']}）：{an['summary']}…")
        else:
            lines.append("本周无新公告。")
        lines.append("")

    quiet = [x for x in week["courses"] if not is_active(x)]
    if quiet:
        lines += ["## 本周无动态的课程", "",
                  "、".join(x["name"] for x in quiet), ""]
    return "\n".join(lines)


def token_expiry_warning(cfg):
    """Token 到期倒计时：还剩 token_remind_days（默认 5）天时开始提醒。"""
    expires = (cfg.get("token_expires_at") or "").strip()
    if not expires:
        return None
    try:
        exp_date = datetime.strptime(expires, "%Y-%m-%d").date()
    except ValueError:
        return f"token_expires_at 格式应为 YYYY-MM-DD（当前值：{expires}）"
    remaining = (exp_date - datetime.now(HK_TZ).date()).days
    remind_days = int(cfg.get("token_remind_days", 5))
    if remaining < 0:
        return f"Token 已于 {expires} 过期，请立即到 Canvas「账户→设置」重新生成并更新 canvas_config.json！"
    if remaining == 0:
        return f"Token 今天（{expires}）到期！请立即到 Canvas 重新生成并更新 canvas_config.json。"
    if remaining <= remind_days:
        return f"Token 仅剩 {remaining} 天到期（{expires}），请尽快到 Canvas 重新生成并更新 canvas_config.json。"
    return None


def write_report(week, token_warn=None, stats=None):
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / f"canvas周报_{week['date']}.md"
    path.write_text(render_markdown(week, token_warn, stats), encoding="utf-8")
    return path


# ---------------------------------------------------------------- 网站更新

def site_payload(cfg, week, weeks):
    """构造看板数据结构（与 data.json 同构，本地归档与云端仓库共用）。"""
    gh = cfg.get("github") or {}
    return {
        "site_title": "我的学习中心",
        "canvas_url": cfg["canvas_url"],
        "username": gh.get("username", ""),
        "tz_label": "UTC%+g" % float(cfg.get("tz_offset_hours", 8)),
        "updated_at": week["generated_at"],
        "weeks": weeks[:52],
    }


def load_local_weeks():
    try:
        data = json.loads(LOCAL_DATA.read_text(encoding="utf-8"))
        return data.get("weeks", []) if isinstance(data, dict) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def update_site(cfg, week):
    gh = cfg.get("github") or {}
    repo_dir = Path(gh.get("repo_dir", ""))
    # 本地归档：无论是否配置云端仓库都维护，供单文件看板与历史检索使用
    weeks = [w for w in load_local_weeks() if w.get("date") != week["date"]]
    weeks.insert(0, week)
    payload = site_payload(cfg, week, weeks)
    LOCAL_DATA.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    if not gh.get("push_enabled", False) or not repo_dir.is_dir():
        return "数据已存本地（未配置云端仓库，跳过推送）"

    data_path = repo_dir / "data.json"
    data_path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    # 页面模板有改动时同步到仓库，避免线上页面与模板脱节
    template = resolve_resource("site-template/index.html")
    deployed = repo_dir / "index.html"
    if template:
        html = template.read_text(encoding="utf-8")
        if not deployed.is_file() or deployed.read_text(encoding="utf-8") != html:
            deployed.write_text(html, encoding="utf-8")
    # 截止日历文件一并放进看板仓库，供页面下载/订阅
    ics_src = BASE_DIR / "deadlines.ics"
    if ics_src.is_file():
        shutil.copy2(ics_src, repo_dir / "deadlines.ics")

    def git(*args, check=True):
        return subprocess.run(["git", *args], cwd=repo_dir, check=check,
                              capture_output=True, text=True, encoding="utf-8")

    add_paths = ["data.json", "index.html"]
    if (repo_dir / "deadlines.ics").is_file():
        add_paths.append("deadlines.ics")
    git("add", *add_paths)
    commit = git("commit", "-m", f"周报更新 {week['date']}", check=False)
    if commit.returncode != 0:
        return "数据已更新，但无内容变化，未提交"
    git("pull", "--rebase", "origin", "main", check=False)
    push = git("push", check=False)
    if push.returncode != 0:
        return f"git push 失败：{(push.stderr or '').strip()[:150]}"
    return "网站已更新并推送"


# ---------------------------------------------------------------- 主流程

def write_standalone_html(week, js_data, ics_text, path):
    """把页面模板与数据合成单个 HTML 文件，双击即可打开（无需服务器、无跨域限制）。

    给不使用 agent 的同学用：定时任务跑完直接打开这个文件就能看到本周动态。
    """
    tpl_path = resolve_resource("site-template/index.html")
    if not tpl_path:
        return None
    html = tpl_path.read_text(encoding="utf-8")
    payload = (f"<script>window.__HUB_DATA__ = {js_data};"
               f"window.__HUB_ICS__ = {json.dumps(ics_text, ensure_ascii=False)};</script>\n</head>")
    html = html.replace("</head>", payload, 1)
    path.write_text(html, encoding="utf-8")
    return path


def test_connection(cfg):
    """测试 Token 是否可用，返回 (是否成功, 提示信息)。"""
    try:
        courses = api_get_all(cfg["canvas_url"], cfg["access_token"].strip(), "/courses",
                              {"enrollment_state": "active"})
    except RuntimeError as e:
        return False, str(e)
    names = [c.get("name", "") for c in courses[:3]]
    return True, f"连接成功，检测到 {len(courses)} 门活跃课程。" + \
                 (f"例如：{'、'.join(names)}" if names else "")


def run_once(cfg=None, quiet=False):
    """执行一次完整抓取流程，返回状态字典（不退出进程，供命令行与图形界面共用）。"""
    cfg = cfg or load_config()
    result = {"ok": False, "error": None, "week": None,
              "stats": {"downloaded": 0, "skipped": 0, "failed": 0, "total": 0},
              "report": None, "ics": None, "ics_count": 0, "standalone": None,
              "site_status": None, "token_warn": None, "log": None}
    try:
        week, new_state, stats = fetch_week_data(cfg)
    except RuntimeError as e:
        result["error"] = str(e)
        return result
    result["week"] = week
    result["stats"] = stats
    save_last_state(new_state)

    ics_path = BASE_DIR / "deadlines.ics"
    result["ics_count"] = build_ics(week, ics_path)
    result["ics"] = ics_path
    ics_text = ics_path.read_text(encoding="utf-8") if ics_path.is_file() else ""

    result["token_warn"] = token_expiry_warning(cfg)
    result["report"] = write_report(week, result["token_warn"], stats)
    result["site_status"] = update_site(cfg, week)
    # 单文件看板带上本地历史归档，双击即可离线查看全部周报
    weeks = [w for w in load_local_weeks() if w.get("date") != week["date"]]
    weeks.insert(0, week)
    payload = site_payload(cfg, week, weeks)
    result["standalone"] = write_standalone_html(
        week, json.dumps(payload, ensure_ascii=False), ics_text,
        REPORT_DIR / f"本周课程动态_{week['date']}.html")
    result["ok"] = True
    return result


def main():
    global HK_TZ
    cfg = load_config()
    HK_TZ = timezone(timedelta(hours=float(cfg.get("tz_offset_hours", 8))))
    if not cfg.get("access_token", "").strip():
        msg = ("canvas_config.json 中的 access_token 为空。"
               "请按项目文档（docs/部署指南.md）的步骤，从 Canvas"
               "「账户→设置→+ New Access Token」生成令牌并填入配置文件后重试。"
               "该文件已被 .gitignore 排除，Token 不会被提交到任何仓库。")
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        path = REPORT_DIR / f"canvas周报_{datetime.now(HK_TZ):%Y-%m-%d}.md"
        path.write_text(f"# Canvas 每周课程动态周报\n\n> ⚠️ 未获取数据：{msg}\n", encoding="utf-8")
        print(f"CONFIG_MISSING: {msg}")
        print(f"报告文件：{path}")
        sys.exit(2)

    res = run_once(cfg)
    if not res["ok"]:
        print(f"FETCH_FAILED: {res['error']}")
        sys.exit(1)

    week, stats = res["week"], res["stats"]
    n_new = sum(len(c["new_assignments"]) for c in week["courses"])
    n_up = sum(len(c["upcoming"]) for c in week["courses"])
    n_files = sum(len(c["new_files"]) for c in week["courses"])
    n_anns = sum(len(c["announcements"]) for c in week["courses"])
    n_unsub = sum(1 for c in week["courses"] for a in c["upcoming"] + c["new_assignments"]
                  if a.get("submitted") is False and not a.get("graded"))
    n_changes = sum(len(c.get("changes") or []) for c in week["courses"])
    print(f"OK 课程数={len(week['courses'])} 新作业={n_new} 即将截止={n_up}（未提交 {n_unsub}） "
          f"新资料={n_files} 新公告={n_anns} 变化={n_changes} "
          f"下载={stats['downloaded']}(跳过{stats['skipped']},失败{stats['failed']})/{stats['total']} 日历事件={res['ics_count']}")
    if res["token_warn"]:
        print(f"TOKEN_WARNING: {res['token_warn']}")
    print(f"报告文件：{res['report']}")
    print(f"日历文件：{res['ics']}（可导入手机日历）")
    if res["standalone"]:
        print(f"单机看板：{res['standalone']}（双击即可打开，无需服务器）")
    print(f"看板状态：{res['site_status']}；本地看板：双击 启动学习看板.bat")
    gh = cfg.get("github") or {}
    if gh.get("username") and gh.get("repo_name"):
        print(f"云端备份仓库：https://github.com/{gh['username']}/{gh['repo_name']}（私有）")


if __name__ == "__main__":
    main()
