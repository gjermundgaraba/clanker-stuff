import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from harbor.agents.installed.codex import Codex
from harbor.models.agent.context import AgentContext
from pi_evals.auth import require_auth_file
from pi_evals.codex import CodexEval, _redirect_prompt, load_codex_compactions
from pi_evals.pi import _PI_EVENT_GUARD, PiEval, convert_pi_events, load_pi_events


class PiTrajectoryTest(TestCase):
    def test_pi_event_guard_rejects_provider_errors(self) -> None:
        def run(event: dict[str, object]) -> int:
            return subprocess.run(
                ["node", "-e", _PI_EVENT_GUARD],
                check=False,
                input=f"{json.dumps(event, ensure_ascii=False)}\n",
                text=True,
            ).returncode

        self.assertEqual(
            run(
                {
                    "type": "message_end",
                    "message": {"role": "assistant", "stopReason": "stop"},
                }
            ),
            0,
        )
        self.assertEqual(
            run(
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "stopReason": "stop",
                        "content": [{"type": "text", "text": "a\u2028b"}],
                    },
                }
            ),
            0,
        )
        self.assertNotEqual(
            run(
                {
                    "type": "message_end",
                    "message": {"role": "assistant", "stopReason": "error"},
                }
            ),
            0,
        )
        self.assertNotEqual(run({"type": "agent_end"}), 0)

    def test_uses_standard_auth_files_without_shell_state(self) -> None:
        with TemporaryDirectory() as directory, patch.dict(
            os.environ, {"HOME": directory}, clear=True
        ):
            home = Path(directory)
            pi_auth = home / ".pi/agent/auth.json"
            codex_auth = home / ".codex/auth.json"
            pi_auth.parent.mkdir(parents=True)
            codex_auth.parent.mkdir(parents=True)
            pi_auth.write_text(
                json.dumps({"openai-codex": {"access": "pi-token"}}),
                encoding="utf-8",
            )
            codex_auth.write_text(
                json.dumps({"tokens": {"access_token": "codex-token"}}),
                encoding="utf-8",
            )
            pi = PiEval(logs_dir=home, model_name="openai-codex/gpt-5.6-terra")
            codex = CodexEval(logs_dir=home, model_name="openai/gpt-5.6-terra")

            self.assertEqual(pi._resolve_auth_json_path("openai-codex"), pi_auth)
            self.assertEqual(codex._resolve_auth_json_path(), codex_auth)

    def test_explicit_auth_path_wins_and_empty_credentials_fail(self) -> None:
        with TemporaryDirectory() as directory, patch.dict(
            os.environ, {"HOME": directory}, clear=True
        ):
            path = Path(directory) / "explicit.json"
            path.write_text(
                json.dumps({"openai-codex": {"refresh": "token"}}),
                encoding="utf-8",
            )
            pi = PiEval(
                logs_dir=Path(directory),
                model_name="openai-codex/gpt-5.6-terra",
                auth_json_path=path,
            )
            self.assertEqual(pi._resolve_auth_json_path("openai-codex"), path)

            path.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no usable credential"):
                require_auth_file(path, (("tokens", "access_token"),))

    def test_redirects_codex_prompt_through_stdin(self) -> None:
        command = "codex exec -- - 2>&1 </dev/null | tee /logs/agent/codex.txt"
        self.assertEqual(
            _redirect_prompt(command, "/tmp/instruction.md"),
            "codex exec -- - 2>&1 < /tmp/instruction.md | tee /logs/agent/codex.txt",
        )

    def test_converts_messages_tools_compaction_and_usage(self) -> None:
        events = [
            {"index": 0, "timestamp": 1_000, "type": "harbor_instruction"},
            {"id": "session-1", "type": "session"},
            {
                "type": "message_end",
                "message": {
                    "content": [
                        {"thinking": "inspect", "type": "thinking"},
                        {
                            "arguments": {"path": "clue.txt"},
                            "id": "call-1",
                            "name": "read",
                            "type": "toolCall",
                        },
                    ],
                    "model": "model-1",
                    "role": "assistant",
                    "timestamp": 2_000,
                    "usage": {
                        "cacheRead": 3,
                        "cacheWrite": 4,
                        "cost": {"total": 0.25},
                        "input": 7,
                        "output": 2,
                        "reasoning": 1,
                    },
                },
            },
            {
                "isError": False,
                "result": {"content": [{"text": "CITRINE", "type": "text"}]},
                "toolCallId": "call-1",
                "toolName": "read",
                "type": "tool_execution_end",
            },
            {"aborted": False, "result": {"tokensBefore": 5000}, "type": "compaction_end"},
            {"index": 1, "timestamp": 3_000, "type": "harbor_instruction"},
            {
                "type": "message_end",
                "message": {
                    "content": [{"text": "done", "type": "text"}],
                    "role": "assistant",
                    "usage": {"input": 5, "output": 1},
                },
            },
        ]

        trajectory = convert_pi_events(
            events,
            ["read the clue", "finish"],
            agent_version="0.84.2",
            model_name="provider/model-1",
        )

        self.assertEqual(trajectory.schema_version, "ATIF-v1.7")
        self.assertEqual(trajectory.session_id, "session-1")
        self.assertEqual(
            [step.source for step in trajectory.steps],
            ["user", "agent", "system", "user", "agent"],
        )
        tool_step = trajectory.steps[1]
        self.assertEqual(tool_step.tool_calls[0].function_name, "read")
        self.assertEqual(tool_step.observation.results[0].content, "CITRINE")
        self.assertEqual(
            trajectory.steps[2].extra["event_type"], "context_compaction"
        )
        self.assertEqual(trajectory.steps[2].extra["state"], "succeeded")
        self.assertEqual(trajectory.final_metrics.total_prompt_tokens, 19)
        self.assertEqual(trajectory.final_metrics.total_completion_tokens, 3)
        self.assertEqual(trajectory.final_metrics.extra["compactions"], 1)
        self.assertEqual(trajectory.final_metrics.extra["tool_calls"], 1)

    def test_failed_compaction_is_not_counted_as_success(self) -> None:
        trajectory = convert_pi_events(
            [
                {"index": 0, "type": "harbor_instruction"},
                {
                    "aborted": False,
                    "errorMessage": "Auto-compaction failed",
                    "type": "compaction_end",
                },
            ],
            ["continue"],
            agent_version="0.84.2",
            model_name="provider/model-1",
        )

        self.assertEqual(trajectory.steps[1].extra["state"], "failed")
        self.assertEqual(trajectory.final_metrics.extra["compaction_attempts"], 1)
        self.assertEqual(trajectory.final_metrics.extra["compactions"], 0)

    def test_reads_codex_persisted_compaction_boundary(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout-2026-01-01T00-00-00-id.jsonl"
            path.write_text(
                "\n".join(
                    [
                        '{"type":"event_msg","payload":{"type":"user_message"}}',
                        '{"type":"event_msg","payload":{"type":"user_message"}}',
                        json.dumps(
                            {
                                "timestamp": "2026-01-01T00:00:01Z",
                                "type": "compacted",
                                "payload": {"message": "before\u2028after"},
                            },
                            ensure_ascii=False,
                        ),
                        '{"type":"event_msg","payload":{"type":"context_compacted"}}',
                    ]
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                load_codex_compactions(Path(directory)),
                [
                    {
                        "compacted_after_segment": 1,
                        "event_type": "context_compaction",
                        "mechanism": "codex-cli",
                        "state": "succeeded",
                        "timestamp": "2026-01-01T00:00:01Z",
                    }
                ],
            )

    def test_codex_resumed_usage_is_reported_per_step(self) -> None:
        with TemporaryDirectory() as directory:
            logs_dir = Path(directory)
            (logs_dir / "sessions/2026/01/01").mkdir(parents=True)
            adapter = CodexEval(
                logs_dir=logs_dir,
                model_name="openai/gpt-5",
                version="0.147.0",
            )
            snapshots = iter(
                [
                    ("session-1", (100, 60, 20, 1.25)),
                    ("session-1", (160, 90, 35, 2.0)),
                    ("session-2", (40, 10, 8, 0.5)),
                ]
            )

            def populate(context: AgentContext) -> None:
                session_id, usage = next(snapshots)
                (
                    context.n_input_tokens,
                    context.n_cache_tokens,
                    context.n_output_tokens,
                    context.cost_usd,
                ) = usage
                (logs_dir / "trajectory.json").write_text(
                    json.dumps({"session_id": session_id, "steps": []}),
                    encoding="utf-8",
                )

            contexts = [AgentContext() for _ in range(3)]
            with patch.object(Codex, "populate_context_post_run", side_effect=populate):
                for context in contexts:
                    adapter.populate_context_post_run(context)

            self.assertEqual(
                [
                    (
                        context.n_input_tokens,
                        context.n_cache_tokens,
                        context.n_output_tokens,
                        context.cost_usd,
                    )
                    for context in contexts
                ],
                [
                    (100, 60, 20, 1.25),
                    (60, 30, 15, 0.75),
                    (40, 10, 8, 0.5),
                ],
            )

    def test_load_is_strict_and_preserves_unicode_line_separators(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            compaction = {
                "type": "compaction_end",
                "result": {"summary": "before\u2028after"},
            }
            path.write_text(
                '{"type":"session","id":"ok"}\n'
                + json.dumps(compaction, ensure_ascii=False)
                + "\n",
                encoding="utf-8",
            )
            self.assertEqual(
                load_pi_events(path),
                [{"type": "session", "id": "ok"}, compaction],
            )
            path.write_text("warning\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid JSON"):
                load_pi_events(path)
