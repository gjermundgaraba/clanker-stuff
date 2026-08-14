from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from pi_evals.codex import load_codex_compactions
from pi_evals.pi import convert_pi_events, load_pi_events


class PiTrajectoryTest(TestCase):
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
            agent_version="0.84.1",
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
            agent_version="0.84.1",
            model_name="provider/model-1",
        )

        self.assertEqual(trajectory.steps[1].extra["state"], "failed")
        self.assertEqual(trajectory.final_metrics.extra["compaction_attempts"], 1)
        self.assertEqual(trajectory.final_metrics.extra["compactions"], 0)

    def test_reads_codex_persisted_compactions_at_their_segment(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "rollout-2026-01-01T00-00-00-id.jsonl"
            path.write_text(
                "\n".join(
                    [
                        '{"type":"event_msg","payload":{"type":"user_message"}}',
                        '{"type":"event_msg","payload":{"type":"user_message"}}',
                        '{"timestamp":"2026-01-01T00:00:01Z","type":"compacted","payload":{"window_number":1}}',
                        '{"type":"event_msg","payload":{"type":"context_compacted"}}',
                    ]
                ),
                encoding="utf-8",
            )

            self.assertEqual(
                load_codex_compactions(Path(directory)),
                [
                    {
                        "event_type": "context_compaction",
                        "mechanism": "codex-cli",
                        "segment": 1,
                        "state": "succeeded",
                        "timestamp": "2026-01-01T00:00:01Z",
                        "window_number": 1,
                    }
                ],
            )

    def test_load_ignores_non_json_output(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text('warning\n{"type":"session","id":"ok"}\n', encoding="utf-8")
            self.assertEqual(load_pi_events(path), [{"type": "session", "id": "ok"}])
