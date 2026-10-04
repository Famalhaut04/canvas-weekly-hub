"""提交状态离线回归；只使用共享虚构夹具，不读取个人配置或课程。"""
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import canvas_weekly_report as engine

CASES = json.loads((ROOT / "tests/fixtures/1004_提交状态夹具_v1.json").read_text(encoding="utf-8"))


class SubmissionTests(unittest.TestCase):
    def test_shared_status_matrix(self):
        for case in CASES:
            with self.subTest(case=case["name"]):
                expected = {key: case[key] for key in ("submitted", "graded", "submission_status")}
                self.assertEqual(engine.submission_state(case["assignment"]), expected)

    def test_labels_and_unknown_not_counted_as_unsubmitted(self):
        labels = {"submitted": "已提交", "unsubmitted": "**未提交**", "unknown": "状态待核验",
                  "graded": "已评分", "excused": "已豁免", "resubmit": "需重新提交"}
        for case in CASES:
            with self.subTest(case=case["name"]):
                state = engine.submission_state(case["assignment"])
                self.assertIn(labels[state["submission_status"]], engine.sub_label(state))
                if state["submission_status"] != "unsubmitted":
                    self.assertIsNot(state["submitted"], False)

    def test_fetch_includes_current_submission_and_refresh_replaces_status(self):
        cfg = engine.validate_config({"canvas_url": "https://canvas.example", "access_token": "fixture-token",
                                      "download_files": False, "github": {"push_enabled": False}})
        now = datetime.now(timezone.utc)
        assignment = {"id": 2, "name": "Fixture Assignment", "created_at": now.isoformat(),
                      "due_at": (now + timedelta(days=2)).isoformat(), "submission_types": ["online_upload"]}
        def route(base, token, path, params=None, options=None):
            if path == "/courses":
                return [{"id": 1, "name": "Fixture Course"}]
            if path.endswith("/assignments"):
                self.assertEqual(params["include[]"], ["submission"])
                return [dict(assignment)]
            return []
        with mock.patch.object(engine, "api_get_all", side_effect=route), \
                mock.patch.object(engine, "load_last_state", return_value={}), \
                mock.patch.object(engine, "load_previous_sections", return_value=[]):
            first, _, _ = engine.fetch_week_data(cfg)
            self.assertIsNone(first["courses"][0]["upcoming"][0]["submitted"])
            self.assertIn("未提交 0 个", engine.render_markdown(first))
            assignment["submission"] = {"workflow_state": "submitted", "submitted_at": now.isoformat()}
            second, _, _ = engine.fetch_week_data(cfg)
        self.assertTrue(second["courses"][0]["upcoming"][0]["submitted"])
        self.assertIsNone(first["courses"][0]["upcoming"][0]["submitted"], "历史记录不补造状态")


if __name__ == "__main__":
    unittest.main(verbosity=2)
