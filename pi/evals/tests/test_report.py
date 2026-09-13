from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase

from pi_evals import report, trials
from fixtures.trials import completed_trajectory, write_trial


class ReportTest(TestCase):
    def test_config_only_trials_are_incomplete_and_join_known_task_names(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            write_trial(
                root,
                trial_name="completed",
                trajectory=completed_trajectory(),
            )
            write_trial(root, trial_name="queued", write_result=False)
            values = trials.rows(root)
            self.assertEqual(
                [(row["trial"], row["status"], row["task"]) for row in values],
                [
                    ("completed", "completed", "task"),
                    ("queued", "incomplete", "task"),
                ],
            )
            summary = report.matched_summaries(values)[0]
            self.assertEqual(
                (summary["n"], summary["completed"], summary["incomplete"]),
                (2, 1, 1),
            )
            rendered = subprocess.check_output(
                [sys.executable, "-B", "-m", "pi_evals.report", str(root)], text=True
            )
            self.assertIn("| completed | completed | future |", rendered)
            self.assertIn("| queued | incomplete | future |", rendered)

    def test_summary_filters_quality_to_valid_completed_rows(self) -> None:
        summary = report.matched_summaries(
            [
                {
                    "platform": "p",
                    "mode": "on",
                    "task": "t",
                    "status": "completed",
                    "valid": 1,
                    "quality": 1,
                    "input": 10,
                    "cache": 2,
                    "output": 4,
                    "ordinary_cost": 0.1,
                    "compaction_cost": 0.2,
                    "total_cost": 0.3,
                },
                {
                    "platform": "p",
                    "mode": "on",
                    "task": "t",
                    "status": "completed",
                    "valid": 0,
                    "quality": 0,
                    "input": 8,
                    "cache": 1,
                    "output": 2,
                    "ordinary_cost": 0.3,
                    "compaction_cost": 0.4,
                    "total_cost": 0.7,
                },
                {
                    "platform": "p",
                    "mode": "on",
                    "task": "t",
                    "status": "errored",
                    "valid": None,
                    "quality": None,
                    "input": None,
                    "cache": None,
                    "output": None,
                    "ordinary_cost": None,
                    "compaction_cost": None,
                    "total_cost": None,
                },
            ]
        )[0]
        self.assertEqual(
            (summary["completed"], summary["errored"], summary["valid"]), (2, 1, 1)
        )
        self.assertEqual((summary["quality"], summary["input"]), (1, 9))
        self.assertAlmostEqual(summary["compaction_cost"], 0.3)
        self.assertEqual(summary["total_cost"], 0.5)
        self.assertEqual(summary["input_n"], 2)
        rendered = report.render(
            [
                {
                    "trial": "trial",
                    "status": "completed",
                    "platform": "p",
                    "mode": "on",
                    "task": "t",
                    "valid": 1,
                    "quality": 1,
                    "reward": 1,
                    "ordinary_requests": 1,
                    "compaction_requests": 1,
                    "compaction_attempts": 1,
                    "compaction_successes": 1,
                    "compaction_failures": 0,
                    "input": 1,
                    "cache": 0,
                    "output": 1,
                    "ordinary_cost": 0.1,
                    "compaction_cost": 0.2,
                    "total_cost": 0.3,
                    "agent_seconds": 1,
                    "wall_seconds": 1,
                }
            ]
        )
        self.assertIn("Compact $", rendered)
        self.assertIn(
            "| trial | completed | p | on | t | 1 | 1.000 | 1/1 | 1/1/0 |",
            rendered,
        )

    def test_summaries_and_deltas_accept_a_suite_score(self) -> None:
        values = [
            {
                "platform": "p",
                "mode": mode,
                "task": "t",
                "tier": "64k",
                "status": "completed",
                "valid": valid,
                "qa_quality": score,
                "input": input_tokens,
            }
            for mode, valid, score, input_tokens in [
                ("off", 1, 0.25, 10),
                ("off", 0, 1.0, 30),
                ("on", 1, 0.75, 20),
            ]
        ]
        summaries = report.matched_summaries(
            values,
            score="qa_quality",
            group_keys=("tier", "platform", "mode", "task"),
        )
        self.assertEqual(summaries[0]["qa_quality"], 0.25)
        self.assertEqual(summaries[0]["qa_quality_n"], 1)
        [delta] = report.matched_deltas(
            values,
            score="qa_quality",
            group_keys=("tier", "platform", "task"),
        )
        self.assertEqual(delta["qa_quality"], 0.5)
        self.assertEqual(delta["input"], 0)
        self.assertEqual((delta["off_input_n"], delta["on_input_n"]), (2, 1))
