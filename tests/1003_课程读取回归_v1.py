"""Issue #5 离线夹具，Python 3.8 标准库；不使用个人配置与学校账号。"""
import io
import json
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import canvas_weekly_report as engine

BASE = "https://canvas.example"
TOKEN = "fixture-token"


def response(data, link=None):
    result = io.BytesIO(json.dumps(data).encode("utf-8"))
    result.headers = {"Link": link} if link is not None else {}
    return result


def failure(status, body, content_type="application/json"):
    return urllib.error.HTTPError(BASE, status, "fixture", {"Content-Type": content_type}, io.BytesIO(body.encode("utf-8")))


def config():
    return engine.validate_config({"canvas_url": BASE, "access_token": TOKEN, "download_files": False,
                                   "github": {"push_enabled": False}})


class PaginationTests(unittest.TestCase):
    def test_short_next_and_full_last_page(self):
        calls = []
        def route(req, timeout):
            calls.append(req.full_url)
            self.assertEqual(req.get_header("Authorization"), "Bearer " + TOKEN)
            return response([{"id": 1}], '<%s/api/v1/courses?page=2&opaque=abc>; rel="next"' % BASE) if len(calls) == 1 else response([{"id": i + 2} for i in range(100)])
        with mock.patch.object(engine, "api_open", side_effect=route):
            self.assertEqual(len(engine.api_get_all(BASE, TOKEN, "/courses")), 101)
        self.assertEqual(len(calls), 2)
        self.assertIn("opaque=abc", calls[1])

    def test_over_twenty_pages_is_explicitly_incomplete(self):
        calls = []
        def route(req, timeout):
            calls.append(req.full_url)
            n = len(calls)
            return response([{"id": n}], '<%s/api/v1/courses?page=%s>; rel="next"' % (BASE, n + 1))
        with mock.patch.object(engine, "api_open", side_effect=route):
            with self.assertRaises(engine.CanvasReadError) as error:
                engine.api_get_all(BASE, TOKEN, "/courses")
        self.assertEqual(error.exception.kind, "incomplete")
        self.assertEqual(len(calls), 20)

    def test_repeated_url_and_body_stop(self):
        for body_repeat in [True, False]:
            calls = []
            def route(req, timeout):
                calls.append(req.full_url)
                n = len(calls)
                return response([{"id": 1 if body_repeat else n}], '<%s/api/v1/courses?page=%s>; rel="next"' % (BASE, n + 1 if body_repeat else 1))
            with mock.patch.object(engine, "api_open", side_effect=route):
                with self.assertRaises(engine.CanvasReadError):
                    engine.api_get_all(BASE, TOKEN, "/courses")
            self.assertLessEqual(len(calls), 2)

    def test_next_url_origin_path_credentials_context_and_dates_checked(self):
        bad = ["https://evil.example/api/v1/announcements", "http://canvas.example/api/v1/announcements",
               BASE + "/api/v1/users/self", "https://user:pass@canvas.example/api/v1/announcements",
               BASE + "/api/v1/announcements?access_token=fixture-token",
               BASE + "/api/v1/announcements?context_codes[]=course_2&start_date=2026-10-01",
               BASE + "/api/v1/announcements?context_codes[]=course_1&start_date=2020-01-01"]
        for url in bad:
            with mock.patch.object(engine, "api_open", side_effect=lambda *a, **k: response([{"id": 1}], '<%s>; rel="next"' % url)) as opened:
                with self.assertRaises(engine.CanvasReadError):
                    engine.api_get_all(BASE, TOKEN, "/announcements", {"context_codes[]": ["course_1"], "start_date": "2026-10-01"})
                self.assertEqual(opened.call_count, 1)

    def test_descending_files_stop_only_after_window_covered(self):
        start = datetime(2026, 9, 25, tzinfo=timezone.utc)
        next_page = '<%s/api/v1/courses/1/files?sort=created_at&order=desc&page=2>; rel="next"' % BASE
        with mock.patch.object(engine, "api_open", side_effect=lambda *a, **k: response([
                {"id": 1, "created_at": "2026-09-26T00:00:00Z"}, {"id": 2, "created_at": "2026-09-24T00:00:00Z"}], next_page)) as opened:
            items = engine.api_get_all(BASE, TOKEN, "/courses/1/files", {"sort": "created_at", "order": "desc"}, {"window_start": start})
            self.assertEqual(items.coverage, "window")
            self.assertEqual(opened.call_count, 1)

    def test_unsorted_files_follow_next_and_complete(self):
        calls = []
        def route(req, timeout):
            calls.append(req.full_url)
            return response([{ "id": 1, "created_at": "2026-09-24T00:00:00Z"}, {"id": 2, "created_at": "2026-09-26T00:00:00Z"}],
                '<%s/api/v1/courses/1/files?sort=created_at&order=desc&page=2>; rel="next"' % BASE) if len(calls) == 1 else response([])
        with mock.patch.object(engine, "api_open", side_effect=route):
            result = engine.api_get_all(BASE, TOKEN, "/courses/1/files", {"sort": "created_at", "order": "desc"},
                                         {"window_start": datetime(2026, 9, 25, tzinfo=timezone.utc)})
        self.assertEqual(result.coverage, "all")
        self.assertEqual(len(calls), 2)

    def test_shared_budget_is_not_window_success(self):
        with mock.patch.object(engine, "api_open", side_effect=lambda *a, **k: response([{ "id": 1, "created_at": "2026-09-26T00:00:00Z"}],
                '<%s/api/v1/courses/1/files?sort=created_at&order=desc&page=2>; rel="next"' % BASE)) as opened:
            with self.assertRaises(engine.CanvasReadError) as error:
                engine.api_get_all(BASE, TOKEN, "/courses/1/files", {"sort": "created_at", "order": "desc"},
                                   {"budget": {"remaining": 1}, "window_start": datetime(2026, 9, 25, tzinfo=timezone.utc)})
            self.assertEqual(error.exception.kind, "incomplete")
            self.assertEqual(opened.call_count, 1)

    def test_redirect_handler_does_not_forward_bearer(self):
        self.assertIsNone(engine.NoApiRedirect().redirect_request(None, None, 302, "fixture", {}, "https://evil.example"))

    def test_later_page_failure_keeps_known_items_without_success_claim(self):
        with mock.patch.object(engine, "api_open", side_effect=[response([{"id": 1}], '<%s/api/v1/courses/1/files?page=2>; rel="next"' % BASE),
                failure(503, '{"message":"fixture-token"}')]):
            with self.assertRaises(engine.CanvasReadError) as error:
                engine.api_get_all(BASE, TOKEN, "/courses/1/files")
        self.assertEqual(error.exception.kind, "service_error")
        self.assertEqual(error.exception.items, [{"id": 1}])
        self.assertNotIn(TOKEN, str(error.exception))

    def test_link_attributes_and_malformed_header(self):
        self.assertEqual(engine.next_link('<%s/api/v1/courses?page=2>; title="page"; rel="next", <%s/api/v1/courses?page=1>; rel="first"' % (BASE, BASE)), BASE + '/api/v1/courses?page=2')
        for link in ['not-a-link', '<%s/api/v1/courses>; title="page"' % BASE,
                     '<%s/api/v1/courses>; rel="next", <%s/api/v1/courses>; rel="next"' % (BASE, BASE)]:
            with self.assertRaises(engine.CanvasReadError):
                engine.next_link(link)

    def test_invalid_items_and_missing_file_dates_are_not_complete(self):
        with mock.patch.object(engine, "api_open", side_effect=lambda *a, **k: response([None])):
            with self.assertRaises(engine.CanvasReadError) as error:
                engine.api_get_all(BASE, TOKEN, "/courses")
        self.assertEqual(error.exception.kind, "invalid_response")
        for stamp in [None, "2026-09-24T00:00:00", 123]:
            with mock.patch.object(engine, "api_open", side_effect=lambda *a, **k: response([{"id": 1, "created_at": stamp}])):
                with self.assertRaises(engine.CanvasReadError) as error:
                    engine.api_get_all(BASE, TOKEN, "/courses/1/files", {"sort": "created_at", "order": "desc"},
                                       {"window_start": datetime(2026, 9, 25, tzinfo=timezone.utc)})
            self.assertEqual(error.exception.kind, "incomplete")


class DataStateTests(unittest.TestCase):
    def test_html_challenge_with_http_200_is_not_api_success(self):
        result = io.BytesIO(b'<html>Just a Moment<script>fixture-token</script></html>')
        result.headers = {"Content-Type": "text/html"}
        with mock.patch.object(engine, "api_open", return_value=result):
            with self.assertRaises(engine.CanvasReadError) as error:
                engine.api_get_all(BASE, TOKEN, "/courses")
        self.assertEqual(error.exception.kind, "blocked")
        self.assertNotIn(TOKEN, str(error.exception))

    def test_http_errors_classified_without_html_or_credentials(self):
        cases = [(403, '{"message":"user not authorized to perform that action","token":"fixture-token"}', "application/json", "permission_denied"),
                 (403, '<html>Just a Moment<script>fixture-token</script></html>', "text/html", "blocked"),
                 (403, '<html><script>fixture-token</script></html>', "text/html", "access_denied"),
                 (401, '{"token":"fixture-token"}', "application/json", "auth_failed"),
                 (404, '<html><script>window.unsafe="fixture-token"</script></html>', "text/html", "not_found")]
        for status, body, content_type, kind in cases:
            with mock.patch.object(engine, "api_open", side_effect=failure(status, body, content_type)) as opened:
                with self.assertRaises(engine.CanvasReadError) as error:
                    engine.api_get_all(BASE, TOKEN, "/courses/1/files")
                self.assertEqual(error.exception.kind, kind)
                self.assertNotIn("fixture-token", str(error.exception))
                self.assertNotIn("<", str(error.exception))
                self.assertEqual(opened.call_count, 1)

    def test_announcements_context_dates_posted_time_and_failure_isolation(self):
        calls = []
        def route(base, token, path, params=None, options=None):
            calls.append((path, params))
            if path == "/courses":
                return [{"id": 1, "name": "Fixture A"}, {"id": 2, "name": "Fixture B"}]
            if path == "/courses/1/files":
                raise engine.CanvasReadError("permission_denied")
            if path == "/announcements":
                if params["context_codes[]"] == ["course_1"]:
                    raise engine.CanvasReadError("not_found")
                return [{"id": 2, "title": "Posted Recently", "created_at": "2020-01-01T00:00:00Z",
                         "posted_at": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()}]
            return []
        with mock.patch.object(engine, "api_get_all", side_effect=route), mock.patch.object(engine, "load_last_state", return_value={}), \
                mock.patch.object(engine, "load_previous_sections", return_value=[]):
            week, state, stats = engine.fetch_week_data(config())
        calls = [(p, q) for p, q in calls if p == "/announcements"]
        self.assertEqual(len(calls), 2)
        for index, (_, params) in enumerate(calls):
            self.assertEqual(params["context_codes[]"], ["course_%s" % (index + 1)])
            self.assertEqual(engine.parse_ts(params["end_date"]) - engine.parse_ts(params["start_date"]), timedelta(days=7))
        self.assertEqual(week["fetch_state"], "partial")
        self.assertEqual(week["courses"][0]["read_status"]["files"]["state"], "permission_denied")
        self.assertEqual(week["courses"][1]["announcements"][0]["title"], "Posted Recently")

    def test_old_content_retained_with_timestamp_not_counted_as_new(self):
        old = {"course_id": "1", "url": BASE + "/courses/1", "new_files": [{"name": "Old File", "url": "", "kind": "PDF", "size_kb": 1, "created_at": "2026-10-01"}],
               "announcements": [], "read_status": {"files": {"state": "ok", "data_updated_at": "2026-10-01T00:00:00Z"}}}
        def route(base, token, path, params=None, options=None):
            if path == "/courses":
                return [{"id": 1, "name": "Fixture A"}]
            if path.endswith("/files"):
                raise engine.CanvasReadError("permission_denied")
            return []
        with mock.patch.object(engine, "api_get_all", side_effect=route), mock.patch.object(engine, "load_last_state", return_value={}), \
                mock.patch.object(engine, "load_previous_sections", return_value=[{"courses": [old]}]):
            week, state, stats = engine.fetch_week_data(config())
        course = week["courses"][0]
        self.assertEqual(course["new_files"][0]["name"], "Old File")
        self.assertTrue(course["read_status"]["files"]["retained"])
        self.assertEqual(course["read_status"]["files"]["data_updated_at"], "2026-10-01T00:00:00Z")
        text = engine.render_markdown(week)
        self.assertIn("本次未更新，显示旧数据", text)
        self.assertNotIn("本周无新资料", text)
        self.assertIn("本周新上传资料：0", text)

    def test_required_failure_does_not_replace_previous_board_or_state(self):
        with tempfile.TemporaryDirectory(suffix=".tmp", dir=str(ROOT / "tests")) as directory:
            directory = Path(directory)
            data = directory / "data.json"
            data.write_text("old-board", encoding="utf-8")
            state = directory / "last_state.json"
            state.write_text("old-snapshot", encoding="utf-8")
            with mock.patch.object(engine, "BASE_DIR", directory), mock.patch.object(engine, "LOCAL_DATA", data), \
                    mock.patch.object(engine, "fetch_week_data", side_effect=engine.CanvasReadError("incomplete")):
                result = engine.run_once(config())
            self.assertFalse(result["ok"])
            self.assertEqual(data.read_text(encoding="utf-8"), "old-board")
            self.assertEqual(state.read_text(encoding="utf-8"), "old-snapshot")

    def test_success_empty_clears_old_data_and_is_not_permission_failure(self):
        def route(base, token, path, params=None, options=None):
            return [{"id": 1, "name": "Fixture A"}] if path == "/courses" else []
        with mock.patch.object(engine, "api_get_all", side_effect=route), mock.patch.object(engine, "load_last_state", return_value={}), \
                mock.patch.object(engine, "load_previous_sections", return_value=[{"courses": [{"course_id": "1", "new_files": [{"name": "Old"}]}]}]):
            week, state, stats = engine.fetch_week_data(config())
        self.assertEqual(week["courses"][0]["new_files"], [])
        self.assertEqual(week["courses"][0]["read_status"]["files"]["state"], "ok")
        self.assertEqual(week["fetch_state"], "complete")

    def test_output_failure_does_not_advance_assignment_snapshot(self):
        with mock.patch.object(engine, "fetch_week_data", return_value=({"fetch_state": "complete"}, {"assignments": {}}, {})), \
                mock.patch.object(engine, "build_ics", side_effect=OSError("fixture disk failure")), \
                mock.patch.object(engine, "save_last_state") as save:
            with self.assertRaises(OSError):
                engine.run_once(config())
        save.assert_not_called()

    def test_changed_token_does_not_reuse_old_sections_or_assignment_state(self):
        def route(base, token, path, params=None, options=None):
            if path == "/courses":
                return [{"id": 1, "name": "Fixture A"}]
            if path.endswith("/files"):
                raise engine.CanvasReadError("permission_denied")
            return []
        with mock.patch.object(engine, "api_get_all", side_effect=route), \
                mock.patch.object(engine, "load_last_state", return_value={"reader_binding": "different", "assignments": {"1": {"2": {"name": "Old"}}}}), \
                mock.patch.object(engine, "load_previous_sections") as previous:
            week, state, stats = engine.fetch_week_data(config())
        previous.assert_not_called()
        self.assertEqual(week["courses"][0]["changes"], [])
        self.assertEqual(week["courses"][0]["new_files"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
