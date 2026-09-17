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

import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HK_TZ = timezone(timedelta(hours=8))  # 默认 UTC+8，可被配置项 tz_offset_hours 覆盖
BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "canvas_config.json"
REPORT_DIR = BASE_DIR / "reports"
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
            assignments = api_get_all(base, token, f"/courses/{cid}/assignments", {"order_by": "due_at"})
        except RuntimeError:
            assignments = []
        new_assignments, upcoming = [], []
        for a in assignments:
            created, updated, due = parse_ts(a.get("created_at")), parse_ts(a.get("updated_at")), parse_ts(a.get("due_at"))
            is_new = bool(created and created >= lookback_start)
            is_updated = (not is_new) and bool(updated and updated >= lookback_start)
            if not (is_new or is_updated or (due and now <= due <= upcoming_end)):
                continue
            item = {
                "name": a.get("name", "未命名任务"),
                "kind": assign_kind(a),
                "due_at": fmt_hk(due),
                "due_iso": due.isoformat() if due else None,
                "points": a.get("points_possible"),
                "url": a.get("html_url", ""),
                "status": "新布置" if is_new else ("有更新" if is_updated else None),
            }
            if is_new or is_updated:
                new_assignments.append(item)
            if due and now <= due <= upcoming_end:
                upcoming.append(dict(item))

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
        })

    return {
        "date": now.astimezone(HK_TZ).strftime("%Y-%m-%d"),
        "generated_at": now.astimezone(HK_TZ).strftime("%Y-%m-%d %H:%M"),
        "range": f"{lookback_start.astimezone(HK_TZ).strftime('%Y-%m-%d %H:%M')} ~ {now.astimezone(HK_TZ).strftime('%Y-%m-%d %H:%M')}",
        "courses": week_courses,
    }


# ---------------------------------------------------------------- 周报生成

def render_markdown(week):
    lines = [
        f"# Canvas 每周课程动态周报（{week['date']}）",
        "",
        f"> 数据抓取时间：{week['generated_at']}（香港时间）；统计范围：过去 7 天新增 + 未来 7 天截止。",
        "",
        "## 本周总览",
        "",
    ]
    n_new = sum(len(c["new_assignments"]) for c in week["courses"])
    n_up = sum(len(c["upcoming"]) for c in week["courses"])
    n_files = sum(len(c["new_files"]) for c in week["courses"])
    n_anns = sum(len(c["announcements"]) for c in week["courses"])
    lines += [
        f"- 本学期活跃课程：{len(week['courses'])} 门",
        f"- 本周新作业/任务：{n_new} 个；未来 7 天截止：{n_up} 个",
        f"- 本周新上传资料：{n_files} 份；新公告：{n_anns} 条",
        "",
    ]
    def is_active(c):
        return bool(c["new_assignments"] or c["upcoming"] or c["new_files"] or c["announcements"])

    for c in [x for x in week["courses"] if is_active(x)]:
        lines += [f"## {c['name']}（{c['code']}）", ""]
        lines += ["### 📝 本周新作业 / 任务", ""]
        if c["new_assignments"]:
            lines += ["| 任务 | 截止时间 | 分值 | 状态 |", "|---|---|---|---|"]
            for a in c["new_assignments"]:
                pts = a["points"] if a["points"] is not None else "-"
                lines.append(f"| [{a['name']}]({a['url']}) | {a['due_at']} | {pts} | {a['status']} |")
        else:
            lines.append("本周无新增。")
        lines += ["", "### ⏰ 未来 7 天截止", ""]
        if c["upcoming"]:
            lines += ["| 任务 | 截止时间 | 分值 |", "|---|---|---|"]
            for a in c["upcoming"]:
                pts = a["points"] if a["points"] is not None else "-"
                lines.append(f"| [{a['name']}]({a['url']}) | {a['due_at']} | {pts} |")
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


def write_report(week):
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / f"canvas周报_{week['date']}.md"
    path.write_text(render_markdown(week), encoding="utf-8")
    return path


# ---------------------------------------------------------------- 网站更新

def update_site(cfg, week):
    gh = cfg.get("github") or {}
    repo_dir = Path(gh.get("repo_dir", ""))
    if not gh.get("push_enabled", False) or not repo_dir.is_dir():
        return "已跳过（网站仓库未配置或不存在）"
    data_path = repo_dir / "data.json"
    try:
        data = json.loads(data_path.read_text(encoding="utf-8")) if data_path.exists() else {}
    except json.JSONDecodeError:
        data = {}
    weeks = data.get("weeks", [])
    weeks = [w for w in weeks if w.get("date") != week["date"]]
    weeks.insert(0, week)
    data["site_title"] = "我的学习中心"
    data["canvas_url"] = cfg["canvas_url"]
    data["username"] = gh.get("username", "")
    data["tz_label"] = "UTC%+g" % float(cfg.get("tz_offset_hours", 8))
    data["updated_at"] = week["generated_at"]
    data["weeks"] = weeks[:52]
    data_path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    # 页面模板有改动时同步到仓库，避免线上页面与模板脱节
    template = BASE_DIR / "site-template" / "index.html"
    deployed = repo_dir / "index.html"
    if template.is_file():
        html = template.read_text(encoding="utf-8")
        if not deployed.is_file() or deployed.read_text(encoding="utf-8") != html:
            deployed.write_text(html, encoding="utf-8")

    def git(*args, check=True):
        return subprocess.run(["git", *args], cwd=repo_dir, check=check,
                              capture_output=True, text=True, encoding="utf-8")

    git("add", "data.json", "index.html")
    commit = git("commit", "-m", f"周报更新 {week['date']}", check=False)
    if commit.returncode != 0:
        return "数据已更新，但无内容变化，未提交"
    git("pull", "--rebase", "origin", "main", check=False)
    push = git("push", check=False)
    if push.returncode != 0:
        return f"git push 失败：{(push.stderr or '').strip()[:150]}"
    return "网站已更新并推送"


# ---------------------------------------------------------------- 主流程

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

    try:
        week = fetch_week_data(cfg)
    except RuntimeError as e:
        print(f"FETCH_FAILED: {e}")
        sys.exit(1)

    report_path = write_report(week)
    site_status = update_site(cfg, week)

    n_new = sum(len(c["new_assignments"]) for c in week["courses"])
    n_up = sum(len(c["upcoming"]) for c in week["courses"])
    n_files = sum(len(c["new_files"]) for c in week["courses"])
    n_anns = sum(len(c["announcements"]) for c in week["courses"])
    print(f"OK 课程数={len(week['courses'])} 新作业={n_new} 即将截止={n_up} "
          f"新资料={n_files} 新公告={n_anns}")
    print(f"报告文件：{report_path}")
    print(f"网站状态：{site_status}")
    gh = cfg.get("github") or {}
    if gh.get("username"):
        print(f"网站地址：https://{gh['username'].lower()}.github.io/{gh.get('repo_name', 'learning-hub')}/")


if __name__ == "__main__":
    main()
