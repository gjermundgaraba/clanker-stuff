import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from pi_evals.auth import require_auth_file
from pi_evals.codex import CodexEval, load_codex_compactions, load_codex_usage
from pi_evals.pi import (
    _PI_EVENT_GUARD,
    CONTROLLED_COMPACTION_MARKER,
    PiEval,
    controlled_instruction,
    convert_pi_events,
    load_pi_events,
)


class PiTrajectoryTest(TestCase):
    def test_controlled_compaction_marker_is_hidden_from_the_agent(self) -> None:
        instruction = f"{CONTROLLED_COMPACTION_MARKER}Continue"
        self.assertEqual(controlled_instruction(instruction, False), ("Continue", False))
        self.assertEqual(controlled_instruction(instruction, True), ("Continue", True))
        with self.assertRaisesRegex(ValueError, "must be the first line"):
            controlled_instruction(f"Continue\n{CONTROLLED_COMPACTION_MARKER}", True)

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
            {
                "aborted": False,
                "result": {
                    "tokensBefore": 5000,
                    "usage": {
                        "cost": {"total": 0.1},
                        "input": 2,
                        "output": 1,
                    },
                },
                "type": "compaction_end",
            },
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
            ["user", "agent", "agent", "user", "agent"],
        )
        tool_step = trajectory.steps[1]
        self.assertEqual(tool_step.tool_calls[0].function_name, "read")
        self.assertEqual(tool_step.observation.results[0].content, "CITRINE")
        self.assertEqual(
            trajectory.steps[2].extra["event_type"], "context_compaction"
        )
        self.assertEqual(trajectory.steps[2].extra["state"], "succeeded")
        self.assertEqual(trajectory.steps[2].metrics.prompt_tokens, 2)
        self.assertEqual(trajectory.steps[2].metrics.cost_usd, 0.1)
        self.assertEqual(trajectory.final_metrics.total_prompt_tokens, 21)
        self.assertEqual(trajectory.final_metrics.total_completion_tokens, 4)
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
                        "mechanism": "codex-native",
                        "state": "succeeded",
                        "timestamp": "2026-01-01T00:00:01Z",
                    }
                ],
            )

    def test_codex_uses_exact_ordinary_and_compaction_usage(self) -> None:
        with TemporaryDirectory() as directory:
            logs_dir = Path(directory)
            session_dir = logs_dir / "sessions/2026/01/01"
            session_dir.mkdir(parents=True)
            (session_dir / "rollout-2026-01-01T00-00-00-session.jsonl").write_text(
                "\n".join(
                    json.dumps(event)
                    for event in [
                        {
                            "timestamp": "2026-01-01T00:00:00Z",
                            "type": "session_meta",
                            "payload": {"cli_version": "0.147.0", "id": "session-1"},
                        },
                        {
                            "timestamp": "2026-01-01T00:00:01Z",
                            "type": "event_msg",
                            "payload": {"type": "user_message"},
                        },
                        {
                            "timestamp": "2026-01-01T00:00:01Z",
                            "type": "event_msg",
                            "payload": {"turn_id": "turn-1", "type": "task_started"},
                        },
                        {
                            "timestamp": "2026-01-01T00:00:02Z",
                            "type": "response_item",
                            "payload": {
                                "content": [{"text": "done", "type": "output_text"}],
                                "role": "assistant",
                                "type": "message",
                            },
                        },
                        {
                            "timestamp": "2026-01-01T00:00:03Z",
                            "type": "event_msg",
                            "payload": {
                                "info": {
                                    "last_token_usage": {
                                        "cached_input_tokens": 1,
                                        "input_tokens": 2,
                                        "output_tokens": 3,
                                        "total_tokens": 5,
                                    },
                                    "total_token_usage": {
                                        "cached_input_tokens": 1,
                                        "input_tokens": 2,
                                        "output_tokens": 3,
                                        "total_tokens": 5,
                                    },
                                },
                                "type": "token_count",
                            },
                        },
                        {
                            "timestamp": "2026-01-01T00:00:04Z",
                            "type": "compacted",
                            "payload": {},
                        },
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            usage = {
                "cacheWriteInputTokens": 0,
                "cachedInputTokens": 20,
                "inputTokens": 100,
                "outputTokens": 10,
                "reasoningOutputTokens": 5,
                "totalTokens": 110,
            }
            records = [
                {
                    "kind": "ordinary",
                    "responseId": "ordinary-response",
                    "threadId": "session-1",
                    "turnId": "turn-1",
                    "usage": usage,
                },
                {
                    "kind": "compaction",
                    "responseId": "compact-response",
                    "threadId": "session-1",
                    "turnId": "turn-1",
                    "usage": {**usage, "inputTokens": 200, "totalTokens": 210},
                },
            ]
            (logs_dir / "codex-usage.jsonl").write_text(
                "\n".join(json.dumps(record) for record in records) + "\n",
                encoding="utf-8",
            )
            adapter = CodexEval(
                logs_dir=logs_dir,
                model_name="openai/gpt-5.6-terra",
                version="0.147.0",
            )
            with patch.object(adapter, "_compute_cost_from_pricing", return_value=1.0):
                trajectory = adapter._convert_events_to_trajectory(session_dir)

            self.assertIsNotNone(trajectory)
            metered = [step for step in trajectory.steps if step.metrics]
            self.assertEqual(
                [
                    (step.metrics.prompt_tokens, (step.extra or {}).get("event_type"))
                    for step in metered
                ],
                [(100, None), (200, "context_compaction")],
            )
            self.assertEqual(trajectory.final_metrics.total_prompt_tokens, 300)
            self.assertEqual(trajectory.final_metrics.total_cost_usd, 2.0)

    def test_codex_exact_usage_log_is_strict(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "usage.jsonl"
            path.write_text(
                json.dumps(
                    {
                        "kind": "ordinary",
                        "responseId": "response-1",
                        "usage": {
                            "cacheWriteInputTokens": 0,
                            "cachedInputTokens": 1,
                            "inputTokens": 2,
                            "outputTokens": 3,
                            "reasoningOutputTokens": 1,
                            "totalTokens": 5,
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            self.assertEqual(len(load_codex_usage(path)), 1)
            path.write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid usage kind"):
                load_codex_usage(path)

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
