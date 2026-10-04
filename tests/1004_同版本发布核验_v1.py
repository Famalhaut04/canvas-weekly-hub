"""公开发布的打包 / 下载核对，仅使用 Git 已提交源码；不读取个人配置。"""
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist/1004_课程读取同版本发布_v1"
REPO = "Famalhaut04/canvas-weekly-hub"
TAG = "e30ce1879d5b4c9b07c2628839573a618a46fe43"
ZIP = "canvas-weekly-hub-v2.2-source.zip"
NOTICE = "content/1004_v2.2课程读取修复公告_v1.md"


def run(*args):
    return subprocess.check_output(args, cwd=str(ROOT)).decode("utf-8").strip()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def normal(data):
    return data.decode("utf-8-sig").replace("\r\n", "\n").encode("utf-8")


def inspect_zip(path):
    banned = {"canvas_config.json", "data.json", "last_state.json", "deadlines.ics", "hub_home.json", "我的学习网站.html"}
    with zipfile.ZipFile(str(path)) as archive:
        for name in archive.namelist():
            parts = Path(name).parts
            assert not name.startswith(("/", "\\")) and ".." not in parts, "不安全的归档路径"
            assert Path(name).name not in banned, "归档包含个人配置 / 产物文件"
            assert not any(p in ("downloads", "reports", "site-repo", "dist", ".git") for p in parts), "归档包含私有产物目录"
            if name.endswith((".json", ".py", ".js", ".cjs", ".md", ".html", ".toml", ".txt")):
                text = archive.read(name).decode("utf-8-sig")
                assert not re.search(r"\b\d{3,}~[A-Za-z0-9_-]{25,}\b", text), "归档中存在疑似真实 Canvas 凭证，请人工核查文件：" + name
        example = json.loads(archive.read("config/canvas_config.example.json"))
        assert example["access_token"] == "" and example["github"]["push_enabled"] is False
        assert "function submissionState" in archive.read("web/overrides.js").decode("utf-8")
        assert "X-Canvas-Pagination" in archive.read("worker/runtime.js").decode("utf-8")
        return len(archive.namelist())


def download(url, path):
    subprocess.check_call(["curl.exe", "--fail", "--location", "--silent", "--show-error",
                           "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15",
                           "--max-time", "90", "--output", str(path), url], cwd=str(ROOT))
    return path.read_bytes()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if sys.argv[1] == "prepare":
        commit = run("git", "rev-parse", "HEAD")
        subprocess.check_call(["git", "archive", "--format=zip", "--output=" + str(OUT / ZIP), commit], cwd=str(ROOT))
        (OUT / "worker.js").write_bytes(subprocess.check_output(["git", "show", commit + ":worker.js"], cwd=str(ROOT)))
        entries = inspect_zip(OUT / ZIP)
        for name in (ZIP, "worker.js"):
            data = (OUT / name).read_bytes()
            print(name, len(data), digest(data))
        print("Archive entries:", entries, "Source commit:", commit)
        return
    assert sys.argv[1] == "verify"
    release = json.loads(run("gh", "api", "repos/" + REPO + "/releases/tags/v2.2"))
    assert release["tag_name"] == "v2.2" and not release["draft"] and not release["prerelease"]
    assert normal(release["body"].encode("utf-8")).strip() == normal((ROOT / NOTICE).read_bytes()).strip()
    assert run("git", "ls-remote", "origin", "refs/tags/v2.2").split()[0] == TAG
    commit = run("git", "rev-parse", "HEAD")
    main_commit = run("git", "ls-remote", "origin", "refs/heads/main").split()[0]
    assert main_commit == commit, "远端 main 与待核验功能提交不同"
    result = {"verified_at": datetime.now(timezone(timedelta(hours=8))).isoformat(), "commit": commit,
              "main": main_commit, "tag": TAG, "release": release["html_url"], "assets": {}, "pages": {}}
    for name in ("worker.js", ZIP):
        asset = next(a for a in release["assets"] if a["name"] == name)
        data = download(asset["browser_download_url"], OUT / ("verified-" + name))
        assert data == (OUT / name).read_bytes(), "公开附件与本地发布包不一致"
        assert len(data) == asset["size"]
        if asset.get("digest"):
            assert asset["digest"] == "sha256:" + digest(data)
        result["assets"][name] = {"bytes": len(data), "sha256": digest(data), "url": asset["browser_download_url"]}
    result["archive_entries"] = inspect_zip(OUT / ("verified-" + ZIP))
    for name in ("web/index.html", "web/overview.html", "worker.js"):
        url = "https://famalhaut04.github.io/canvas-weekly-hub/" + name
        data = download(url + "?audit=" + commit[:10], OUT / ("pages-" + Path(name).name))
        assert normal(data) == normal((ROOT / name).read_bytes()), "Pages 文件尚未更新：" + name
        result["pages"][name] = {"sha256_lf": digest(normal(data)), "url": url}
    result["pages_build"] = json.loads(run("gh", "api", "repos/" + REPO + "/pages/builds/latest"))
    assert result["pages_build"]["status"] == "built" and result["pages_build"]["commit"] == commit
    target = ROOT / "tests/artifacts/1004_v2.2课程读取发布核验_v1.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("PASS Release正文、main、历史标签、两个公开附件、源码隐私检查、三个Pages文件与构建一致")
    print("Evidence:", target)


if __name__ == "__main__":
    main()
