import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from pi_evals import report

MANIFEST = {
    "platform": "future",
    "compaction_mode": "on",
    "expected_mechanism": "native",
    "expected_protocol": None,
}


def completed_trajectory(manifest: dict = MANIFEST) -> dict:
    return {
        "agent": {"extra": {"pi_evals": manifest}},
        "steps": [
            {
                "llm_call_count": 1,
                "metrics": {
                    "cached_tokens": 2,
                    "completion_tokens": 3,
                    "cost_usd": 0.2,
                    "prompt_tokens": 5,
                },
            }
        ],
        "final_metrics": {
            "total_cached_tokens": 2,
            "total_completion_tokens": 3,
            "total_cost_usd": 0.2,
            "total_prompt_tokens": 5,
        },
    }


def write_trial(
    root: Path,
    *,
    trial_name: str = "trial",
    result: dict | None = None,
    manifest: dict = MANIFEST,
    trajectory: dict | None = None,
    write_result: bool = True,
) -> None:
    trial = root / trial_name
    trial.mkdir()
    (trial / "config.json").write_text(
        json.dumps(
            {
                "agent": {"kwargs": {"pi_evals": manifest}},
                "task": {"path": "suite/task"},
                "trial_name": trial_name,
            }
        )
    )
    if write_result:
        (trial / "result.json").write_text(
            json.dumps(
                result
                or {
                    "trial_name": trial_name,
                    "task_name": "task",
                    "verifier_result": {
                        "rewards": {
                            "quality": 1,
                            "valid_experiment": 1,
                            "reward": 1,
                        }
                    },
                }
            )
        )
    if trajectory is not None:
        steps = (result or {}).get("step_results") or []
        path = trial / "agent" / "trajectory.json"
        if steps:
            path = (
                trial / "steps" / steps[-1]["step_name"] / "agent" / "trajectory.json"
            )
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(trajectory))


class ReportTest(TestCase):
    def test_completed_row_uses_verified_manifest_reward_usage_and_timings(
        self,
    ) -> None:
        with TemporaryDirectory() as directory:
            result = {
                "trial_name": "trial",
                "task_name": "task",
                "started_at": "2026-01-01T00:00:00Z",
                "finished_at": "2026-01-01T00:00:10Z",
                "agent_execution": {
                    "started_at": "2026-01-01T00:00:01Z",
                    "finished_at": "2026-01-01T00:00:04Z",
                },
                "step_results": [
                    {
                        "step_name": "final",
                        "agent_execution": {
                            "started_at": "2026-01-01T00:00:05Z",
                            "finished_at": "2026-01-01T00:00:07Z",
                        },
                    }
                ],
                "verifier_result": {
                    "rewards": {
                        "quality": 0.5,
                        "valid_experiment": 1,
                        "reward": 0.5,
                    }
                },
            }
            write_trial(
                Path(directory), result=result, trajectory=completed_trajectory()
            )
            [row] = report.rows(Path(directory))
            self.assertEqual(
                (
                    row["trial"],
                    row["status"],
                    row["platform"],
                    row["quality"],
                    row["valid"],
                    row["ordinary_requests"],
                    row["compaction_attempts"],
                    row["input"],
                    row["agent_seconds"],
                    row["wall_seconds"],
                ),
                (
                    "trial",
                    "completed",
                    "future",
                    0.5,
                    1,
                    1,
                    0,
                    5,
                    2.0,
                    10.0,
                ),
            )

    def test_compaction_counts_and_request_kinds_come_from_atif(self) -> None:
        with TemporaryDirectory() as directory:
            trajectory = completed_trajectory()
            trajectory["steps"].extend(
                [
                    {
                        "llm_call_count": 1,
                        "extra": {
                            "event_type": "context_compaction",
                            "state": "succeeded",
                        },
                    },
                    {
                        "llm_call_count": 1,
                        "extra": {
                            "event_type": "context_compaction",
                            "state": "failed",
                        },
                    },
                    {
                        "extra": {
                            "event_type": "context_compaction",
                            "state": "aborted",
                        },
                    },
                ]
            )
            write_trial(Path(directory), trajectory=trajectory)
            [row] = report.rows(Path(directory))
            self.assertEqual(
                (
                    row["ordinary_requests"],
                    row["compaction_requests"],
                    row["compaction_attempts"],
                    row["compaction_successes"],
                    row["compaction_failures"],
                ),
                (1, None, 3, 1, 2),
            )
            self.assertEqual(row["ordinary_cost"], 0.2)
            self.assertTrue(
                all(
                    row[key] is None
                    for key in (
                        "input",
                        "cache",
                        "output",
                        "compaction_cost",
                        "total_cost",
                    )
                )
            )

    def test_missing_request_count_evidence_is_unavailable_not_zero(self) -> None:
        with TemporaryDirectory() as directory:
            trajectory = completed_trajectory()
            uncounted = json.loads(json.dumps(trajectory["steps"][0]))
            uncounted.pop("llm_call_count")
            trajectory["steps"].append(uncounted)
            trajectory["final_metrics"] = {
                "total_cached_tokens": 4,
                "total_completion_tokens": 6,
                "total_cost_usd": 0.4,
                "total_prompt_tokens": 10,
            }
            write_trial(Path(directory), trajectory=trajectory)
            [row] = report.rows(Path(directory))
            self.assertIsNone(row["ordinary_requests"])
            self.assertEqual(row["compaction_requests"], 0)

    def test_config_only_trials_are_incomplete_and_join_known_task_names(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            write_trial(
                root,
                trial_name="completed",
                trajectory=completed_trajectory(),
            )
            write_trial(root, trial_name="queued", write_result=False)
            values = report.rows(root)
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

    def test_completed_oracle_allows_unavailable_trajectory_usage(self) -> None:
        manifest = {**MANIFEST, "platform": "oracle"}
        with TemporaryDirectory() as directory:
            write_trial(Path(directory), manifest=manifest)
            [row] = report.rows(Path(directory))
            self.assertEqual(row["status"], "completed")
            self.assertTrue(
                all(
                    row[key] is None
                    for key in (*report.METER_KEYS, *report.COMPACTION_KEYS)
                )
            )

        with TemporaryDirectory() as directory:
            trajectory = completed_trajectory(manifest)
            trajectory.pop("final_metrics")
            write_trial(Path(directory), manifest=manifest, trajectory=trajectory)
            [row] = report.rows(Path(directory))
            self.assertEqual(row["status"], "completed")
            self.assertTrue(all(row[key] is None for key in report.METER_KEYS))
            self.assertEqual(row["compaction_attempts"], 0)

    def test_completed_non_oracle_requires_trajectory(self) -> None:
        with TemporaryDirectory() as directory:
            write_trial(Path(directory))
            with self.assertRaisesRegex(ValueError, "missing trajectory"):
                report.rows(Path(directory))

    def test_completed_requires_matching_manifest_and_final_reward_contract(
        self,
    ) -> None:
        for rewards, message in [
            (
                {"quality": True, "valid_experiment": 1, "reward": 1},
                "quality must",
            ),
            (
                {"quality": 1, "valid_experiment": 0.5, "reward": 1},
                "valid_experiment must",
            ),
            (
                {"quality": 0.5, "valid_experiment": 1, "reward": 1},
                "reward must equal",
            ),
        ]:
            with self.subTest(rewards=rewards), TemporaryDirectory() as directory:
                write_trial(
                    Path(directory),
                    result={
                        "trial_name": "trial",
                        "task_name": "task",
                        "verifier_result": {"rewards": rewards},
                    },
                    trajectory=completed_trajectory(),
                )
                with self.assertRaisesRegex(ValueError, message):
                    report.rows(Path(directory))
        with TemporaryDirectory() as directory:
            changed = {**MANIFEST, "compaction_mode": "off"}
            write_trial(Path(directory), trajectory=completed_trajectory(changed))
            with self.assertRaisesRegex(ValueError, "manifests do not match"):
                report.rows(Path(directory))

    def test_errors_without_trajectory_are_null_and_use_config_manifest(self) -> None:
        with TemporaryDirectory() as directory:
            write_trial(
                Path(directory),
                result={
                    "trial_name": "trial",
                    "task_name": "task",
                    "exception_info": {"exception_type": "Error"},
                },
            )
            [row] = report.rows(Path(directory))
            self.assertEqual(
                (row["status"], row["quality"], row["input"], row["platform"]),
                ("errored", None, None, "future"),
            )

    def test_errors_use_the_latest_available_cumulative_trajectory(self) -> None:
        with TemporaryDirectory() as directory:
            result = {
                "trial_name": "trial",
                "task_name": "task",
                "step_results": [
                    {"step_name": "earlier"},
                    {
                        "step_name": "failed",
                        "exception_info": {"exception_type": "Error"},
                    },
                ],
            }
            root = Path(directory)
            write_trial(root, result=result)
            path = root / "trial/steps/earlier/agent/trajectory.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(completed_trajectory()))
            [row] = report.rows(root)
            self.assertEqual(
                (row["status"], row["input"], row["compaction_attempts"]),
                ("errored", 5, 0),
            )

    def test_incomplete_trajectory_usage_and_compactions_fail_independently(self) -> None:
        for breakage, available, unavailable in [
            ("usage", "compaction_attempts", "input"),
            ("compactions", "input", "compaction_attempts"),
        ]:
            with self.subTest(breakage=breakage), TemporaryDirectory() as directory:
                trajectory = completed_trajectory()
                trajectory["steps"].append(
                    {
                        "llm_call_count": 1,
                        "metrics": {
                            "cached_tokens": 0,
                            "completion_tokens": 0,
                            "cost_usd": 0,
                            "prompt_tokens": 0,
                        },
                        "extra": {
                            "event_type": "context_compaction",
                            "state": "succeeded" if breakage == "usage" else "bad",
                        },
                    }
                )
                if breakage == "usage":
                    trajectory["final_metrics"]["total_prompt_tokens"] = 6
                write_trial(
                    Path(directory),
                    result={"trial_name": "trial", "task_name": "task"},
                    trajectory=trajectory,
                )
                [row] = report.rows(Path(directory))
                self.assertIsNotNone(row[available])
                self.assertIsNone(row[unavailable])

    def test_agent_seconds_requires_every_expected_timing(self) -> None:
        self.assertEqual(
            report._timings(
                {
                    "step_results": [
                        {
                            "agent_execution": {
                                "started_at": "2026-01-01T00:00:00Z",
                                "finished_at": "2026-01-01T00:00:01Z",
                            }
                        },
                        {"agent_execution": {"started_at": "invalid"}},
                    ]
                }
            )[0],
            None,
        )
        self.assertIsNone(
            report._timings(
                {
                    "agent_execution": {
                        "started_at": "2026-01-01T00:00:01Z",
                        "finished_at": "2026-01-01T00:00:00Z",
                    }
                }
            )[0]
        )

    def test_zero_cache_and_cost_may_be_null_in_step_metrics(self) -> None:
        with TemporaryDirectory() as directory:
            trajectory = completed_trajectory()
            trajectory["steps"][0]["metrics"].update(
                {"cached_tokens": None, "cost_usd": None}
            )
            trajectory["final_metrics"].update(
                {"total_cached_tokens": 0, "total_cost_usd": 0}
            )
            write_trial(Path(directory), trajectory=trajectory)
            [row] = report.rows(Path(directory))
            self.assertEqual((row["cache"], row["total_cost"]), (0, 0))

    def test_completed_rejects_invalid_atif_step_shapes(self) -> None:
        for steps in (None, {}, [], [None]):
            with self.subTest(steps=steps), TemporaryDirectory() as directory:
                trajectory = completed_trajectory()
                trajectory["steps"] = steps
                write_trial(Path(directory), trajectory=trajectory)
                with self.assertRaisesRegex(ValueError, "trajectory steps must"):
                    report.rows(Path(directory))

    def test_completed_requires_strict_final_metric_types(self) -> None:
        for metric, value, message in [
            ("total_cached_tokens", True, "cache total must be"),
            ("total_prompt_tokens", 5.0, "input total must be"),
            ("total_completion_tokens", -1, "output total must be"),
            ("total_cost_usd", True, "total_cost total must be"),
            ("total_cost_usd", -0.2, "total_cost total must be"),
        ]:
            with (
                self.subTest(metric=metric, value=value),
                TemporaryDirectory() as directory,
            ):
                trajectory = completed_trajectory()
                trajectory["final_metrics"][metric] = value
                write_trial(Path(directory), trajectory=trajectory)
                with self.assertRaisesRegex(ValueError, message):
                    report.rows(Path(directory))

    def test_step_exception_makes_a_verified_trajectory_errored(self) -> None:
        with TemporaryDirectory() as directory:
            result = {
                "trial_name": "trial",
                "task_name": "task",
                "step_results": [
                    {
                        "step_name": "final",
                        "exception_info": {"exception_type": "Error"},
                    }
                ],
                "verifier_result": {
                    "rewards": {
                        "quality": 1,
                        "valid_experiment": 1,
                        "reward": 1,
                    }
                },
            }
            write_trial(
                Path(directory), result=result, trajectory=completed_trajectory()
            )
            [row] = report.rows(Path(directory))
            self.assertEqual(
                (row["status"], row["quality"], row["valid"], row["reward"]),
                ("errored", None, None, None),
            )

    def test_trial_name_mismatch_and_completed_bad_usage_fail(self) -> None:
        with TemporaryDirectory() as directory:
            write_trial(
                Path(directory), result={"trial_name": "other", "task_name": "task"}
            )
            with self.assertRaisesRegex(ValueError, "trial_name does not match"):
                report.rows(Path(directory))
        with TemporaryDirectory() as directory:
            broken = completed_trajectory()
            broken["final_metrics"]["total_prompt_tokens"] = 6
            write_trial(Path(directory), trajectory=broken)
            with self.assertRaisesRegex(ValueError, "total does not match"):
                report.rows(Path(directory))
        with TemporaryDirectory() as directory:
            broken = completed_trajectory()
            broken["final_metrics"]["total_cost_usd"] = float("nan")
            write_trial(Path(directory), trajectory=broken)
            with self.assertRaisesRegex(ValueError, "nonnegative finite number"):
                report.rows(Path(directory))
        for metric, total in [
            ("prompt_tokens", "total_prompt_tokens"),
            ("completion_tokens", "total_completion_tokens"),
        ]:
            with self.subTest(metric=metric), TemporaryDirectory() as directory:
                broken = completed_trajectory()
                broken["steps"][0]["metrics"].pop(metric)
                broken["final_metrics"][total] = 0
                write_trial(Path(directory), trajectory=broken)
                with self.assertRaisesRegex(ValueError, "tokens must be"):
                    report.rows(Path(directory))

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
