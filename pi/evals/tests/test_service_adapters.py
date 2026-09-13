import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from pi_evals.adapters.services import ServicePiEval, ServiceCodexEval
from pi_evals.adapters.pi import PiEval
from pi_evals.adapters.codex import CodexEval
from harbor.models.agent.context import AgentContext
from test_tool_mode import PROFILE


class ServiceAdaptersTest(unittest.TestCase):
    def test_no_builtin_tools(self):
        with patch.object(PiEval, "_session_args", return_value=["--no-skills"]):
            self.assertEqual(
                object.__new__(ServicePiEval)._session_args(),
                ["--no-skills", "--no-builtin-tools"],
            )

    def test_adapter_counts_backend_attempts_not_exec_wrappers(self):
        with TemporaryDirectory() as directory:
            profile = PROFILE["agents"][0]
            adapter = ServicePiEval(
                logs_dir=Path(directory),
                model_name=profile["model_name"],
                **profile["kwargs"],
            )
            adapter._instructions = ["task"]
            (adapter.logs_dir / "pi-events.jsonl").write_text(
                json.dumps(
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "content": [],
                            "usage": {"input": 5, "output": 2},
                        },
                    }
                )
                + "\n"
            )
            events = [
                {
                    "type": "pi_eval_service_start",
                    "operation": n,
                    "name": "list_records",
                }
                for n in (1, 2)
            ]
            events += [
                {"type": "pi_eval_service_end", "operation": 1, "success": False},
                {"type": "pi_eval_service_end", "operation": 2, "success": True},
            ]
            evidence = [
                {"type": "pi_eval_tools", "mode": "direct", "valid": True},
                {"type": "pi_eval_compaction"},
            ]
            events += evidence
            (adapter.logs_dir / "service-events.jsonl").write_text(
                "\n".join(map(json.dumps, events))
            )
            adapter.populate_context_post_run(AgentContext())
            actual = json.loads((adapter.logs_dir / "trajectory.json").read_text())
            self.assertEqual(
                actual["final_metrics"]["extra"]["underlying_operations"], 2
            )
            self.assertEqual(actual["agent"]["extra"]["tool_mode_evidence"], evidence)
            self.assertEqual(actual["final_metrics"]["total_prompt_tokens"], 5)
            self.assertEqual(
                [o["success"] for o in actual["agent"]["extra"]["tool_operations"]],
                [False, True],
            )

    def test_native_adapter_keeps_backend_counts_and_audit(self):
        with (
            TemporaryDirectory() as directory,
            patch.object(CodexEval, "populate_context_post_run"),
        ):
            adapter = object.__new__(ServiceCodexEval)
            adapter.logs_dir = Path(directory)
            trajectory = {
                "agent": {"extra": {}},
                "final_metrics": {"extra": {"underlying_operations": 99}},
            }
            (adapter.logs_dir / "trajectory.json").write_text(json.dumps(trajectory))
            events = [
                {
                    "type": "pi_eval_service_start",
                    "operation": n,
                    "name": "list_records",
                }
                for n in (1, 2)
            ]
            audit = [
                {
                    "method": "rawResponseItem/completed",
                    "params": {"item": {"type": "custom_tool_call", "name": "exec"}},
                },
                {
                    "method": "turn/completed",
                    "params": {"turn": {"status": "completed"}},
                },
            ]
            for name, values in (
                ("service-events.jsonl", events),
                ("native-audit.jsonl", audit),
            ):
                (adapter.logs_dir / name).write_text("\n".join(map(json.dumps, values)))
            adapter.populate_context_post_run(None)
            actual = json.loads((adapter.logs_dir / "trajectory.json").read_text())
            self.assertEqual(
                actual["final_metrics"]["extra"],
                {"underlying_operations": 2, "tool_calls": 1},
            )
            self.assertEqual(actual["agent"]["extra"]["native_diagnostic_audit"], audit)
