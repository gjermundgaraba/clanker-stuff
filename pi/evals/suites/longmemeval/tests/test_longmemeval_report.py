import importlib.util
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch


SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "longmemeval_report", SCRIPTS / "report.py"
)
assert SPEC and SPEC.loader
longmemeval_report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(longmemeval_report)
sys.path.remove(str(SCRIPTS))


def cache_row(**changes: object) -> dict[str, object]:
    return {
        "abstention": False,
        "condition": "evidence",
        "hypothesis": "answer",
        "judge_backend": "codex",
        "judge_model": "gpt-5.6-sol",
        "judge_response": "yes",
        "label": True,
        "prompt_sha256": "a" * 64,
        "question_id": "q",
        "question_type": "multi-session",
        "task": "task",
        "tier": None,
        "trial": "complete",
        **changes,
    }


class LongMemEvalReportTest(TestCase):
    def test_joins_labels_only_to_completed_generic_rows(self) -> None:
        with TemporaryDirectory() as directory:
            cache = Path(directory) / "judge.jsonl"
            cache.write_text(json.dumps(cache_row()) + "\n")
            values = [
                {
                    "quality": 0.0,
                    "status": "completed",
                    "trial": "complete",
                    "valid": 1,
                },
                {
                    "quality": None,
                    "status": "incomplete",
                    "trial": "incomplete",
                    "valid": None,
                },
            ]
            with patch.object(longmemeval_report.report, "rows", return_value=values):
                rows = longmemeval_report.rows(Path(directory), cache)

            self.assertEqual(rows[0]["quality"], 0.0)
            self.assertEqual(rows[0]["qa_quality"], 1.0)
            self.assertEqual(rows[0]["qa_quality_source"], "codex:gpt-5.6-sol")
            self.assertEqual(rows[0]["condition"], "evidence")
            self.assertIsNone(rows[1]["quality"])
            self.assertNotIn("condition", rows[1])

    def test_type_summary_excludes_invalid_quality_and_shows_yield(self) -> None:
        shared = {
            "condition": "full",
            "mode": "on",
            "platform": "pi",
            "question_type": "multi-session",
            "status": "completed",
            "task": "task",
            "tier": "64k",
        }
        [summary] = longmemeval_report.type_summaries(
            [
                {**shared, "qa_quality": 1.0, "valid": 1},
                {**shared, "qa_quality": 0.0, "valid": 0},
            ]
        )
        self.assertEqual(
            (
                summary["n"],
                summary["valid"],
                summary["valid_yield"],
                summary["qa_quality"],
            ),
            (2, 1, 0.5, 1.0),
        )

    def test_qa_deltas_compare_only_paired_full_history_arms(self) -> None:
        shared = {
            "condition": "full",
            "platform": "pi",
            "question_type": "multi-session",
            "status": "completed",
            "task": "task",
            "tier": "64k",
            "valid": 1,
        }
        deltas = longmemeval_report.qa_deltas(
            [
                {**shared, "mode": "off", "qa_quality": 0.0},
                {**shared, "mode": "on", "qa_quality": 1.0},
                {
                    **shared,
                    "condition": "evidence",
                    "mode": "off",
                    "qa_quality": 0.0,
                    "tier": None,
                },
                {
                    **shared,
                    "condition": "evidence",
                    "mode": "on",
                    "qa_quality": 0.0,
                    "tier": None,
                },
            ]
        )
        self.assertEqual(len(deltas), 1)
        self.assertEqual(
            (
                deltas[0]["condition"],
                deltas[0]["qa_quality"],
                deltas[0]["off_qa_quality_n"],
                deltas[0]["on_qa_quality_n"],
            ),
            ("full", 1.0, 1, 1),
        )

    def test_qa_deltas_reject_disjoint_valid_task_sets(self) -> None:
        shared = {
            "condition": "full",
            "platform": "pi",
            "question_type": "multi-session",
            "status": "completed",
            "tier": "64k",
        }
        self.assertEqual(
            longmemeval_report.qa_deltas(
                [
                    {
                        **shared,
                        "mode": "off",
                        "qa_quality": 1.0,
                        "task": "off-valid",
                        "valid": 1,
                    },
                    {
                        **shared,
                        "mode": "on",
                        "qa_quality": 0.0,
                        "task": "off-valid",
                        "valid": 0,
                    },
                    {
                        **shared,
                        "mode": "off",
                        "qa_quality": 0.0,
                        "task": "on-valid",
                        "valid": 0,
                    },
                    {
                        **shared,
                        "mode": "on",
                        "qa_quality": 1.0,
                        "task": "on-valid",
                        "valid": 1,
                    },
                ]
            ),
            [],
        )
