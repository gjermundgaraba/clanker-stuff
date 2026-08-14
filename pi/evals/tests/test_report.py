import importlib.util
import io
import json
import math
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "report", Path(__file__).parents[1] / "scripts" / "report.py"
)
assert SPEC and SPEC.loader
report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report)


class ReportTest(TestCase):
    def test_reports_single_step_usage_and_matched_delta(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for mode, quality, tokens in (("off", 0.5, 10), ("on", 1, 7)):
                trial = root / mode
                trial.mkdir()
                (trial / "config.json").write_text(
                    json.dumps(
                        {
                            "agent": {
                                "kwargs": {"agent_label": f"pi-vanilla-{mode}"}
                            }
                        }
                    )
                )
                (trial / "result.json").write_text(
                    json.dumps(
                        {
                            "agent_result": {"n_input_tokens": tokens},
                            "finished_at": "2026-01-01T00:00:01Z",
                            "started_at": "2026-01-01T00:00:00Z",
                            "task_name": "pi-evals/example",
                            "verifier_result": {
                                "rewards": {
                                    "compaction_count": int(mode == "on"),
                                    "quality": quality,
                                    "valid_experiment": 1,
                                }
                            },
                        }
                    )
                )

            (root / "longmemeval-judge-codex-gpt.jsonl").write_text(
                json.dumps(
                    {
                        "condition": "full",
                        "judge_backend": "codex",
                        "label": False,
                        "question_type": "knowledge-update",
                        "tier": "64k",
                        "trial": "on",
                    }
                )
                + "\n"
            )
            values = report.rows(root)
            delta = report.matched_deltas(values)[0]

            self.assertEqual([row["input"] for row in values], [10, 7])
            self.assertEqual([row["quality_source"] for row in values], ["verifier", "qa_judge"])
            self.assertEqual(delta["quality"], -0.5)
            self.assertEqual(delta["input"], -3)
            self.assertEqual(delta["compactions"], 1)

    def test_matched_delta_excludes_invalid_quality(self) -> None:
        values = [
            {
                "cache": 0,
                "compactions": 0,
                "cost": 0,
                "input": 0,
                "latency": 0,
                "mode": "off",
                "output": 0,
                "platform": "pi-vanilla",
                "quality": 1,
                "task": "example",
                "valid": 1,
            },
            {
                "cache": 0,
                "compactions": 1,
                "cost": 0,
                "input": 0,
                "latency": 0,
                "mode": "on",
                "output": 0,
                "platform": "pi-vanilla",
                "quality": 0,
                "task": "example",
                "valid": 0,
            },
        ]

        delta = report.matched_deltas(values)[0]

        self.assertEqual(delta["on_valid"], 0)
        self.assertTrue(math.isnan(delta["quality"]))

    def test_summarizes_longmemeval_types_and_paired_flips(self) -> None:
        values = []
        for mode, quality in (("off", 1), ("on", 0)):
            values.append(
                {
                    "mode": mode,
                    "platform": "pi-vanilla",
                    "quality": quality,
                    "condition": "full",
                    "question_type": "knowledge-update",
                    "task": "example",
                    "tier": "64k",
                    "valid": 1,
                }
            )

        summaries = report.longmemeval_type_summaries(values)
        flips = report.paired_flips(values)[0]

        self.assertEqual(
            [(row["mode"], row["quality"]) for row in summaries],
            [("off", 1), ("on", 0)],
        )
        self.assertEqual({row["condition"] for row in summaries}, {"full"})
        self.assertEqual({row["tier"] for row in summaries}, {"64k"})
        self.assertEqual(flips["off_only"], 1)

        evidence = {
            **values[0],
            "condition": "evidence",
            "mode": None,
            "tier": None,
        }
        [summary] = report.longmemeval_type_summaries([evidence])
        self.assertEqual((summary["mode"], summary["tier"]), ("base", None))

    def test_rejects_obsolete_judge_rows_without_metadata(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "longmemeval-judge-old.jsonl"
            path.write_text(json.dumps({"label": True, "trial": "trial"}) + "\n")

            with self.assertRaisesRegex(ValueError, "obsolete judge row missing"):
                report.rows(Path(directory))

    def test_evidence_condition_requires_null_tier(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "longmemeval-judge-invalid.jsonl"
            path.write_text(
                json.dumps(
                    {
                        "condition": "evidence",
                        "label": True,
                        "question_type": "multi-session",
                        "tier": "64k",
                        "trial": "trial",
                    }
                )
                + "\n"
            )

            with self.assertRaisesRegex(ValueError, "invalid LongMemEval condition/tier"):
                report.rows(root)

    def test_agent_arm_parsing_is_platform_agnostic(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            trial = root / "trial"
            trial.mkdir()
            (trial / "config.json").write_text(
                json.dumps({"agent": {"kwargs": {"agent_label": "new-platform-on"}}})
            )
            (trial / "result.json").write_text(
                json.dumps(
                    {
                        "finished_at": "2026-01-01T00:00:01Z",
                        "started_at": "2026-01-01T00:00:00Z",
                        "task_name": "pi-evals/example",
                    }
                )
            )

            [row] = report.rows(root)
            self.assertEqual((row["platform"], row["mode"]), ("new-platform", "on"))

    def test_main_prints_evidence_summary_without_matched_arms(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            trial = root / "trial"
            trial.mkdir()
            (trial / "config.json").write_text(
                json.dumps({"agent": {"kwargs": {"agent_label": "platform"}}})
            )
            (trial / "result.json").write_text(
                json.dumps(
                    {
                        "finished_at": "2026-01-01T00:00:01Z",
                        "started_at": "2026-01-01T00:00:00Z",
                        "task_name": "pi-evals/longmemeval-evidence-01",
                    }
                )
            )
            (root / "longmemeval-judge-test.jsonl").write_text(
                json.dumps(
                    {
                        "condition": "evidence",
                        "label": True,
                        "question_type": "multi-session",
                        "tier": None,
                        "trial": "trial",
                    }
                )
                + "\n"
            )

            output = io.StringIO()
            with patch.object(report.sys, "argv", ["report.py", str(root)]):
                with redirect_stdout(output):
                    report.main()

            self.assertIn("| evidence | None | platform | base |", output.getvalue())
