#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Python 3.8 标准库离线回归，所有凭证和数据均为测试夹具。"""
import copy
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import canvas_weekly_report as engine
import serve_board as board


def fixture_config():
    return {"canvas_url": "https://canvas.example/", "access_token": "fixture-token",
            "download_files": False, "github": {"push_enabled": False}}


class ConfigTests(unittest.TestCase):
    def test_example_is_local_by_default(self):
        cfg = engine.validate_config(json.loads(
            (ROOT / "config/canvas_config.example.json").read_text(encoding="utf-8")))
        self.assertFalse(cfg["github"]["push_enabled"])
        self.assertEqual(cfg["github"]["repo_dir"], "")

    def test_validation_does_not_modify_input(self):
        cfg = fixture_config()
        before = copy.deepcopy(cfg)
        normalized = engine.validate_config(cfg)
        self.assertEqual(cfg, before)
        self.assertEqual(normalized["canvas_url"], "https://canvas.example")
        self.assertEqual(normalized["lookback_days"], 7)

    def test_invalid_fields_have_readable_errors(self):
        cases = [("canvas_url", "http://canvas.example"),
                 ("canvas_url", "https://canvas.example/profile/settings"),
                 ("canvas_url", "https://user:pass@canvas.example"),
                 ("canvas_url", "https://canvas.example\n.evil.example"),
                 ("access_token", 1), ("access_token", "fixture\ntoken"),
                 ("token_expires_at", "2026-02-29"),
                 ("lookback_days", True), ("upcoming_days", "7"),
                 ("token_remind_days", -1), ("tz_offset_hours", float("nan")),
                 ("download_files", "false"), ("github", [])]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                cfg = fixture_config()
                cfg[key] = value
                with self.assertRaises(ValueError):
                    engine.validate_config(cfg)
        with self.assertRaises(ValueError):
            engine.validate_config([])

    def test_push_requires_real_repo(self):
        cfg = fixture_config()
        cfg["github"] = {"push_enabled": True, "repo_dir": ""}
        with self.assertRaisesRegex(ValueError, "已有 Git 仓库"):
            engine.validate_config(cfg)

    def test_windows_bom_config(self):
        with tempfile.TemporaryDirectory(suffix=".tmp", dir=str(ROOT / "tests")) as directory:
            config_path = Path(directory) / "canvas_config.json"
            config_path.write_text(json.dumps(fixture_config()), encoding="utf-8-sig")
            with mock.patch.object(engine, "CONFIG_PATH", config_path):
                self.assertEqual(engine.load_config()["access_token"], "fixture-token")

    def test_check_config_is_offline_and_does_not_generate_reports(self):
        with tempfile.TemporaryDirectory(suffix=".tmp", dir=str(ROOT / "tests")) as directory:
            config_path = Path(directory) / "canvas_config.json"
            config_path.write_text(json.dumps(fixture_config()), encoding="utf-8")
            environment = dict(os.environ, CANVAS_HUB_DATA_DIR=directory, PYTHONIOENCODING="utf-8")
            run = subprocess.run([sys.executable, "-B", str(ROOT / "canvas_weekly_report.py"), "--check-config"],
                                 env=environment, capture_output=True, encoding="utf-8", timeout=10)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn("CONFIG_OK", run.stdout)
            self.assertNotIn("fixture-token", run.stdout)
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ["canvas_config.json"])


class FetchTests(unittest.TestCase):
    def test_assignment_failure_does_not_save_snapshot(self):
        def api(base, token, path, params=None, options=None):
            if path == "/courses":
                return [{"id": 1, "name": "Fixture Course"}]
            if path.endswith("/assignments"):
                raise RuntimeError("fixture connection failure")
            return []
        with mock.patch.object(engine, "api_get_all", side_effect=api), \
                mock.patch.object(engine, "load_last_state", return_value={}), \
                mock.patch.object(engine, "load_previous_sections", return_value=[]), \
                mock.patch.object(engine, "save_last_state") as save, \
                mock.patch.object(engine, "update_site") as update:
            result = engine.run_once(fixture_config())
        self.assertFalse(result["ok"])
        self.assertIn("fixture connection failure", result["error"])
        save.assert_not_called()
        update.assert_not_called()

    def test_partial_failure_is_reported_in_markdown(self):
        def api(base, token, path, params=None, options=None):
            if path == "/courses":
                return [{"id": 1, "name": "Fixture Course"}]
            if path.endswith("/files"):
                raise RuntimeError("fixture permission error")
            return []
        with mock.patch.object(engine, "api_get_all", side_effect=api), \
                mock.patch.object(engine, "load_last_state", return_value={}), \
                mock.patch.object(engine, "load_previous_sections", return_value=[]):
            week, state, stats = engine.fetch_week_data(engine.validate_config(fixture_config()))
        self.assertEqual(len(week["warnings"]), 1)
        self.assertIn("课件未能读取", engine.render_markdown(week, stats=stats))

    def test_paginated_list_cannot_silently_truncate(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps([{"id": 1}] * 100).encode("utf-8")
        response.__enter__.return_value.headers = {"Link": '<https://canvas.example/api/v1/courses?per_page=100&page=2>; rel="next"'}
        with mock.patch.object(engine, "api_open", return_value=response), \
                mock.patch.object(engine, "MAX_PAGES", 1):
            with self.assertRaisesRegex(RuntimeError, "分页请求预算"):
                engine.api_get_all("https://canvas.example", "fixture-token", "/courses")

    def test_invalid_list_is_rejected_but_file_metadata_still_works(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"id": 2, "url": "https://fixture.example/file"}'
        response.__enter__.return_value.headers = {}
        with mock.patch.object(engine, "api_open", return_value=response):
            with self.assertRaisesRegex(RuntimeError, "列表格式异常"):
                engine.api_get_all("https://canvas.example", "fixture-token", "/courses/1/assignments")
            metadata = engine.api_get_all("https://canvas.example", "fixture-token", "/courses/1/files/2")
            self.assertEqual(metadata[0]["id"], 2)


class BoardTests(unittest.TestCase):
    def test_only_board_files_are_public_and_refresh_uses_local_data(self):
        with tempfile.TemporaryDirectory(suffix=".tmp", dir=str(ROOT / "tests")) as directory:
            directory = Path(directory)
            data_path = directory / "data.json"
            data_path.write_text(json.dumps({"weeks": [], "fixture": "local-output"}), encoding="utf-8")
            (directory / "canvas_config.json").write_text("fixture-private-token", encoding="utf-8")
            with mock.patch.object(board, "BOARD_DIR", directory), \
                    mock.patch.object(board, "DATA_PATH", data_path):
                server = board.ThreadingHTTPServer(("127.0.0.1", 0), board.Handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                origin = "http://127.0.0.1:%d" % server.server_port
                try:
                    with urllib.request.urlopen(origin + "/", timeout=5) as response:
                        self.assertIn("<html", response.read().decode("utf-8"))
                    with urllib.request.urlopen(origin + "/data.json", timeout=5) as response:
                        self.assertEqual(json.load(response)["fixture"], "local-output")
                    with urllib.request.urlopen(origin + "/refresh?probe=1", timeout=5) as response:
                        self.assertTrue(json.load(response)["probe"])
                    for route in ["/canvas_config.json", "/../canvas_config.json", "/downloads/"]:
                        for method in ["GET", "HEAD"]:
                            request = urllib.request.Request(origin + route, method=method)
                            with self.assertRaises(urllib.error.HTTPError) as failure:
                                urllib.request.urlopen(request, timeout=5)
                            self.assertEqual(failure.exception.code, 404)
                    with self.assertRaises(urllib.error.HTTPError) as failure:
                        urllib.request.urlopen(origin + "/refresh", timeout=5)
                    self.assertEqual(failure.exception.code, 405)
                    request = urllib.request.Request(origin + "/refresh", method="POST")
                    with mock.patch.object(board.subprocess, "run", side_effect=subprocess.TimeoutExpired("fixture", 600)):
                        with self.assertRaises(urllib.error.HTTPError) as failure:
                            urllib.request.urlopen(request, timeout=5)
                        self.assertEqual(failure.exception.code, 504)
                    result = subprocess.CompletedProcess([], 0, stdout="fixture success", stderr="")
                    with mock.patch.object(board.subprocess, "run", return_value=result):
                        with urllib.request.urlopen(request, timeout=5) as response:
                            payload = json.load(response)
                    self.assertTrue(payload["ok"])
                    self.assertEqual(payload["data"]["fixture"], "local-output")
                    self.assertFalse(board._refresh_lock.locked())
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
