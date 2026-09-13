"""Regression tests for diagnostic availability and spending boundaries."""

from copy import deepcopy
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from harbor.models.agent.context import AgentContext
from pi_evals import trials, scaling, scaling_report
from pi_evals.adapters.pi import PiEval, convert_pi_events
from pi_evals.artifacts import write_json
from pi_evals.trials import trial_rows, usage
from test_tool_mode import PROFILE
from fixtures.trials import completed_trajectory, write_trial


class TrialReliabilityTest(TestCase):
    def test_unknown_pricing_preserves_tokens_in_completed_and_errored_reports(self):
        for errored in (False, True):
            with self.subTest(errored=errored), TemporaryDirectory() as directory:
                root = Path(directory)
                trajectory = completed_trajectory()
                trajectory["final_metrics"]["total_cost_usd"] = None
                trajectory["steps"][0]["metrics"].pop("cost_usd")
                raw = {
                    "trial_name": "trial",
                    "task_name": "task",
                    "verifier_result": {
                        "rewards": {
                            "quality": 0.5,
                            "reward": 0.5,
                            "valid_experiment": 1,
                            "submission_exported": 1,
                        }
                    },
                }
                if errored:
                    raw["exception_info"] = {"exception_type": "TimeoutError"}
                write_trial(root, trajectory=trajectory, result=raw)
                for row in (
                    trials.rows(root)[0],
                    trial_rows(root, export_reward="submission_exported")[0],
                ):
                    self.assertEqual(row["input"], 5)
                    self.assertEqual(row["cache"], 2)
                    self.assertEqual(row["output"], 3)
                    self.assertIsNone(row["total_cost"])
                    self.assertIsNone(row["ordinary_cost"])
                    self.assertEqual(
                        row["status"], "errored" if errored else "completed"
                    )
                if not errored:
                    self.assertEqual(trials.rows(root)[0]["quality"], 0.5)

    def test_unknown_price_does_not_hide_invalid_numeric_metrics(self):
        for invalid in (-1, True, float("nan"), float("inf"), "unknown"):
            trajectory = completed_trajectory()
            trajectory["final_metrics"]["total_cost_usd"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                usage(trajectory)
        trajectory["final_metrics"]["total_cost_usd"] = None
        trajectory["steps"][0]["metrics"]["prompt_tokens"] = -1
        with self.assertRaises(ValueError):
            usage(trajectory)

    def test_nested_operations_are_cell_scoped_and_wait_deduplicated(self):
        def event(cell, call, name="exec"):
            return {
                "type": "tool_execution_end",
                "toolName": name,
                "toolCallId": call,
                "result": {
                    "details": {
                        "cellId": cell,
                        "traces": [
                            {"id": "op-1", "name": "exec_command", "status": "done"}
                        ],
                    }
                },
            }

        events = [
            event("cell-1", "call-1"),
            event("cell-1", "call-2", "wait"),
            event("cell-2", "call-3"),
            {
                "type": "tool_execution_end",
                "toolName": "exec_command",
                "toolCallId": "op-1",
                "result": {},
            },
        ]

        def convert(items):
            return convert_pi_events(
                items,
                ["test"],
                agent_version="test",
                model_name="test",
                pi_evals=PROFILE["agents"][1]["kwargs"]["pi_evals"],
            )

        self.assertEqual(
            convert(events).final_metrics.extra["underlying_operations"], 3
        )
        events.append(event(None, "call-4"))
        self.assertIsNone(convert(events).final_metrics.extra["underlying_operations"])

    def test_pi_adapter_reads_sidecar_without_contaminating_json_stream(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            profile = deepcopy(PROFILE["agents"][1])
            adapter = PiEval(
                logs_dir=root, model_name=profile["model_name"], **profile["kwargs"]
            )
            adapter._instructions = ["test"]
            events = [
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "content": [],
                        "usage": {"input": 5, "output": 2},
                    },
                }
            ]
            raw = "".join(json.dumps(event) + "\n" for event in events)
            (root / "pi-events.jsonl").write_text(raw)
            evidence = [
                {"type": "pi_eval_tools", "mode": "code_mode_only", "valid": True},
                {"type": "pi_eval_compaction", "timestamp": 123},
            ]
            (root / "eval-events.jsonl").write_text(
                "".join(json.dumps(e) + "\n" for e in evidence)
            )
            adapter.populate_context_post_run(AgentContext())
            trajectory = json.loads((root / "trajectory.json").read_text())
            self.assertEqual(
                trajectory["agent"]["extra"]["tool_mode_evidence"], evidence
            )
            self.assertEqual((root / "pi-events.jsonl").read_text(), raw)

    def test_scaling_gates_current_slot_not_future_slots_or_correctness(self):
        for status, valid, returncode, expected_calls in (
            ("incomplete", 0, 0, 1),
            ("completed", 0, 0, 1),
            ("completed", 1, 2, 1),
            ("completed", 1, 0, 3),
        ):
            with (
                self.subTest(status=status, valid=valid, code=returncode),
                TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                schedule = [
                    {"arm": arm, "job_name": arm, "config": arm + ".yaml"}
                    for arm in ("pi-direct", "pi-code", "native")
                ]
                write_json(root / "schedule.json", schedule)
                write_json(root / "preflight-passed.json", {})
                calls = []

                def execute(command, **kwargs):
                    calls.append(command)
                    return subprocess.CompletedProcess(command, returncode)

                def current(output, entry):
                    self.assertEqual(entry, schedule[len(calls) - 1])
                    return {**entry, "status": status, "valid": valid, "quality": 0}

                with (
                    patch.object(scaling, "verify", return_value={}),
                    patch.object(
                        scaling_report,
                        "report",
                        side_effect=AssertionError("report used as spending gate"),
                    ),
                    patch.object(scaling.subprocess, "run", side_effect=execute),
                    patch.object(scaling, "read_slot", side_effect=current),
                ):
                    if expected_calls == 1:
                        with self.assertRaises(
                            (RuntimeError, subprocess.CalledProcessError)
                        ):
                            scaling.run(root)
                    else:
                        scaling.run(root)
                self.assertEqual(len(calls), expected_calls)
