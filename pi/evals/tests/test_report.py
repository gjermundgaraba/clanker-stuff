import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase


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
                        "judge_backend": "codex",
                        "label": False,
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
