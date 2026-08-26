import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Agent, FinalMetrics, Metrics, Step, Trajectory

from pi_evals.adapters.auth import require_auth_file
from pi_evals.adapters.codex import (
    CodexEval,
    load_codex_compactions,
    load_codex_journal,
)
from pi_evals.adapters.pi import (
    _PI_EVENT_GUARD,
    PiEval,
    convert_pi_events,
    load_pi_events,
)
from pi_evals.protocol import (
    CONTROLLED_COMPACTION_MARKER,
    controlled_instruction,
    validate_manifest,
)

PI_VANILLA_OFF = {
    "platform": "pi-vanilla",
    "compaction_mode": "off",
    "expected_mechanism": "pi-builtin",
    "expected_protocol": None,
}
PI_PROVIDER_ON = {
    "platform": "pi-provider",
    "compaction_mode": "on",
    "expected_mechanism": "codex-provider",
    "expected_protocol": "openai-responses-compaction-v2",
}
CODEX_NATIVE_OFF = {
    "platform": "codex-native",
    "compaction_mode": "off",
    "expected_mechanism": "codex-native",
    "expected_protocol": None,
}
CODEX_NATIVE_ON = {**CODEX_NATIVE_OFF, "compaction_mode": "on"}


class PiTrajectoryTest(TestCase):
    def test_manifest_is_strict_and_controls_marked_compaction(self) -> None:
        self.assertEqual(validate_manifest(PI_VANILLA_OFF), PI_VANILLA_OFF)
        with self.assertRaisesRegex(ValueError, "exactly these keys"):
            validate_manifest({**PI_VANILLA_OFF, "extra": "no"})
        with self.assertRaisesRegex(ValueError, "'off' or 'on'"):
            validate_manifest({**PI_VANILLA_OFF, "compaction_mode": "maybe"})
        with self.assertRaisesRegex(ValueError, "nonempty string or null"):
            validate_manifest({**PI_VANILLA_OFF, "expected_protocol": 2})
        with self.assertRaisesRegex(ValueError, "nonempty string or null"):
            validate_manifest({**PI_VANILLA_OFF, "expected_protocol": "  "})
        marked = f"{CONTROLLED_COMPACTION_MARKER}Continue"
        self.assertFalse(
            controlled_instruction(marked, PI_VANILLA_OFF["compaction_mode"])[1]
        )
        self.assertTrue(
            controlled_instruction(
                marked,
                {**PI_VANILLA_OFF, "compaction_mode": "on"}["compaction_mode"],
            )[1]
        )

    def test_adapter_manifest_matches_runtime(self) -> None:
        provider_manifest = {
            "platform": "pi-provider",
            "compaction_mode": "on",
            "expected_mechanism": "codex-provider",
            "expected_protocol": "openai-responses-compaction-v2",
        }
        adapter = PiEval(
            logs_dir=Path("."),
            model_name="openai-codex/model",
            extensions=["/opt/codex-provider/index.ts"],
            pi_evals=provider_manifest,
        )
        self.assertEqual(adapter._pi_evals, provider_manifest)
        with self.assertRaisesRegex(ValueError, "Pi extensions"):
            PiEval(
                logs_dir=Path("."),
                model_name="openai-codex/model",
                pi_evals={**PI_VANILLA_OFF, "platform": "pi-provider"},
            )
        with self.assertRaisesRegex(ValueError, "Codex native"):
            CodexEval(
                logs_dir=Path("."),
                model_name="openai/model",
                pi_evals=PI_VANILLA_OFF,
            )

    def test_pi_session_is_always_isolated(self) -> None:
        adapter = PiEval(
            logs_dir=Path("."),
            model_name="openai-codex/model",
            pi_evals=PI_VANILLA_OFF,
        )

        args = adapter._session_args()

        for flag in (
            "--no-extensions",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-approve",
            "--no-skills",
        ):
            self.assertIn(flag, args)

    def test_controlled_compaction_marker_is_hidden_from_the_agent(self) -> None:
        instruction = f"{CONTROLLED_COMPACTION_MARKER}Continue"
        self.assertEqual(
            controlled_instruction(instruction, "off"), ("Continue", False)
        )
        self.assertEqual(controlled_instruction(instruction, "on"), ("Continue", True))
        with self.assertRaisesRegex(ValueError, "must be the first line"):
            controlled_instruction(f"Continue\n{CONTROLLED_COMPACTION_MARKER}", "on")

    def test_pi_event_guard_requires_successful_settlement(self) -> None:
        def run(events: list[dict[str, object]]) -> int:
            return subprocess.run(
                ["node", "-e", _PI_EVENT_GUARD],
                check=False,
                input="".join(
                    f"{json.dumps(event, ensure_ascii=False)}\n" for event in events
                ),
                text=True,
            ).returncode

        cases = (
            (
                "success",
                [
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "stopReason": "stop",
                            "content": [{"type": "text", "text": "a\u2028b"}],
                        },
                    },
                    {"type": "agent_settled"},
                ],
                0,
            ),
            (
                "retry succeeds",
                [
                    {
                        "type": "message_end",
                        "message": {"role": "assistant", "stopReason": "error"},
                    },
                    {"type": "agent_end", "willRetry": True},
                    {
                        "type": "message_end",
                        "message": {"role": "assistant", "stopReason": "stop"},
                    },
                    {"type": "agent_settled"},
                ],
                0,
            ),
            (
                "tool-only EOF",
                [
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "stopReason": "toolUse",
                        },
                    },
                    {
                        "type": "tool_execution_end",
                        "toolCallId": "call-1",
                        "toolName": "read",
                    }
                ],
                1,
            ),
            (
                "truncated before settlement",
                [
                    {
                        "type": "message_end",
                        "message": {"role": "assistant", "stopReason": "stop"},
                    }
                ],
                1,
            ),
        )
        for name, events, expected in cases:
            with self.subTest(name=name):
                self.assertEqual(run(events), expected)

    def test_pi_event_guard_rejects_terminal_outcome_at_settlement(self) -> None:
        def run(stop_reason: str) -> int:
            events = [
                {
                    "type": "message_end",
                    "message": {
                        "role": "assistant",
                        "stopReason": stop_reason,
                    },
                },
                {"type": "agent_settled"},
            ]
            return subprocess.run(
                ["node", "-e", _PI_EVENT_GUARD],
                check=False,
                input="".join(f"{json.dumps(event)}\n" for event in events),
                text=True,
            ).returncode

        for stop_reason in ("error", "aborted"):
            with self.subTest(stop_reason=stop_reason):
                self.assertNotEqual(run(stop_reason), 0)

    def test_uses_standard_auth_files_without_shell_state(self) -> None:
        with (
            TemporaryDirectory() as directory,
            patch.dict(os.environ, {"HOME": directory}, clear=True),
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
            pi = PiEval(
                logs_dir=home,
                model_name="openai-codex/gpt-5.6-terra",
                pi_evals=PI_VANILLA_OFF,
            )
            codex = CodexEval(
                logs_dir=home,
                model_name="openai/gpt-5.6-terra",
                pi_evals=CODEX_NATIVE_OFF,
            )

            self.assertEqual(pi._resolve_auth_json_path("openai-codex"), pi_auth)
            self.assertEqual(codex._resolve_auth_json_path(), codex_auth)

    def test_explicit_auth_path_wins_and_empty_credentials_fail(self) -> None:
        with (
            TemporaryDirectory() as directory,
            patch.dict(os.environ, {"HOME": directory}, clear=True),
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
                pi_evals=PI_VANILLA_OFF,
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
            pi_evals=PI_VANILLA_OFF,
        )

        self.assertEqual(trajectory.schema_version, "ATIF-v1.7")
        self.assertEqual(trajectory.session_id, "session-1")
        self.assertEqual(trajectory.agent.extra, {"pi_evals": PI_VANILLA_OFF})
        self.assertEqual(
            [step.source for step in trajectory.steps],
            ["user", "agent", "agent", "user", "agent"],
        )
        tool_step = trajectory.steps[1]
        self.assertEqual(tool_step.tool_calls[0].function_name, "read")
        self.assertEqual(tool_step.observation.results[0].content, "CITRINE")
        self.assertEqual(trajectory.steps[2].extra["event_type"], "context_compaction")
        self.assertEqual(trajectory.steps[2].extra["state"], "succeeded")
        self.assertEqual(trajectory.steps[2].metrics.prompt_tokens, 2)
        self.assertEqual(trajectory.steps[2].metrics.cost_usd, 0.1)
        self.assertEqual(trajectory.final_metrics.total_prompt_tokens, 21)
        self.assertEqual(trajectory.final_metrics.total_completion_tokens, 4)
        self.assertEqual(
            [
                step.extra["event_type"]
                for step in trajectory.steps
                if step.extra and "event_type" in step.extra
            ],
            ["context_compaction"],
        )
        self.assertEqual(trajectory.final_metrics.extra["tool_calls"], 1)

    def test_pi_conversion_emits_manifest(self) -> None:
        trajectory = convert_pi_events(
            [],
            [],
            agent_version="0.84.2",
            model_name="provider/model",
            pi_evals=PI_VANILLA_OFF,
        )
        self.assertEqual(trajectory.agent.extra, {"pi_evals": PI_VANILLA_OFF})

    def test_unsuccessful_compactions_preserve_usage_and_continuation(self) -> None:
        for expected_state, terminal in (
            (
                "failed",
                {
                    "aborted": False,
                    "errorMessage": "Compaction failed: provider error",
                    "result": {
                        "usage": {
                            "cost": {"total": 0.04},
                            "input": 3,
                            "output": 1,
                        }
                    },
                    "type": "compaction_end",
                },
            ),
            ("aborted", {"aborted": True, "type": "compaction_end"}),
        ):
            with self.subTest(state=expected_state):
                trajectory = convert_pi_events(
                    [
                        {"index": 0, "type": "harbor_instruction"},
                        terminal,
                        {"index": 1, "type": "harbor_instruction"},
                        {
                            "type": "message_end",
                            "message": {
                                "content": [{"text": "continued", "type": "text"}],
                                "role": "assistant",
                                "stopReason": "stop",
                            },
                        },
                    ],
                    ["history", "continue"],
                    agent_version="0.84.2",
                    model_name="provider/model-1",
                    pi_evals=PI_PROVIDER_ON,
                )

                compaction = trajectory.steps[1]
                self.assertEqual(compaction.extra["state"], expected_state)
                self.assertEqual(compaction.extra["compacted_after_segment"], 0)
                self.assertIsNone(compaction.extra["mechanism"])
                self.assertIsNone(compaction.extra["protocol"])
                self.assertEqual(trajectory.steps[2].message, "continue")
                self.assertEqual(trajectory.steps[3].message, "continued")
                if expected_state == "failed":
                    self.assertEqual(compaction.metrics.prompt_tokens, 3)
                    self.assertEqual(compaction.metrics.cost_usd, 0.04)
                    self.assertEqual(trajectory.final_metrics.total_prompt_tokens, 3)

    def test_failed_compaction_preserves_checkpoint_identity(self) -> None:
        trajectory = convert_pi_events(
            [
                {
                    "errorMessage": "Compaction failed after checkpoint",
                    "result": {
                        "details": {
                            "checkpoint": {"protocol": "openai-responses-compaction-v2"}
                        }
                    },
                    "type": "compaction_end",
                }
            ],
            [],
            agent_version="0.84.2",
            model_name="provider/model-1",
            pi_evals=PI_PROVIDER_ON,
        )

        compaction = trajectory.steps[0]
        self.assertEqual(compaction.extra["state"], "failed")
        self.assertEqual(compaction.extra["mechanism"], "codex-provider")
        self.assertEqual(compaction.extra["protocol"], "openai-responses-compaction-v2")

    def test_successful_compaction_mismatch_remains_visible(self) -> None:
        trajectory = convert_pi_events(
            [
                {"index": 0, "type": "harbor_instruction"},
                {
                    "result": {"usage": {"input": 1}},
                    "type": "compaction_end",
                },
            ],
            ["continue"],
            agent_version="0.84.2",
            model_name="provider/model-1",
            pi_evals=PI_PROVIDER_ON,
        )

        compaction = trajectory.steps[1]
        self.assertEqual(compaction.extra["mechanism"], "pi-builtin")
        self.assertIsNone(compaction.extra["protocol"])
        self.assertEqual(trajectory.agent.extra, {"pi_evals": PI_PROVIDER_ON})

    def test_current_context_includes_only_its_controlled_compaction(self) -> None:
        with TemporaryDirectory() as directory:
            logs_dir = Path(directory)
            events = [
                {
                    "controlled_compaction": False,
                    "index": 0,
                    "type": "harbor_instruction",
                },
                {
                    "message": {
                        "role": "assistant",
                        "usage": {"input": 100, "output": 10},
                    },
                    "type": "message_end",
                },
                {
                    "result": {"usage": {"input": 200, "output": 20}},
                    "type": "compaction_end",
                },
                {
                    "result": {
                        "usage": {
                            "cacheRead": 2,
                            "cacheWrite": 3,
                            "cost": {"total": 0.04},
                            "input": 5,
                            "output": 1,
                        }
                    },
                    "type": "compaction_end",
                },
                {
                    "controlled_compaction": True,
                    "index": 1,
                    "type": "harbor_instruction",
                },
                {
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "cacheRead": 7,
                            "cost": {"total": 0.06},
                            "input": 11,
                            "output": 2,
                        },
                    },
                    "type": "message_end",
                },
            ]
            (logs_dir / "pi-events.jsonl").write_text(
                "\n".join(json.dumps(event) for event in events) + "\n",
                encoding="utf-8",
            )
            adapter = PiEval(
                logs_dir=logs_dir,
                model_name="openai-codex/gpt-5.6-terra",
                extensions=["/opt/codex-provider/index.ts"],
                pi_evals=PI_PROVIDER_ON,
            )
            adapter._instructions = ["history", "continue"]
            context = AgentContext()

            adapter.populate_context_post_run(context)

            self.assertEqual(context.n_input_tokens, 28)
            self.assertEqual(context.n_cache_tokens, 9)
            self.assertEqual(context.n_output_tokens, 3)
            self.assertEqual(context.cost_usd, 0.1)

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
                        "protocol": None,
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
                    "compactedAfterSegment": 0,
                    "kind": "compaction_attempt",
                    "state": "succeeded",
                    "threadId": "session-1",
                    "timestamp": "2026-01-01T00:00:04Z",
                    "turnId": "turn-1",
                },
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
            (logs_dir / "codex-events.jsonl").write_text(
                "\n".join(json.dumps(record) for record in records) + "\n",
                encoding="utf-8",
            )
            adapter = CodexEval(
                logs_dir=logs_dir,
                model_name="openai/gpt-5.6-terra",
                version="0.147.0",
                pi_evals=CODEX_NATIVE_ON,
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
            self.assertEqual(trajectory.agent.extra["pi_evals"], CODEX_NATIVE_ON)

    def test_codex_exact_usage_log_is_strict(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "usage.jsonl"
            path.write_text(
                json.dumps(
                    {
                        "kind": "ordinary",
                        "responseId": "response-1",
                        "threadId": "thread-1",
                        "turnId": "turn-1",
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
            self.assertEqual(len(load_codex_journal(path)[0]), 1)
            record = json.loads(path.read_text(encoding="utf-8"))
            record["usage"]["inputTokens"] = True
            path.write_text(json.dumps(record) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid exact usage payload"):
                load_codex_journal(path)
            record["usage"]["inputTokens"] = 2
            record["extra"] = "unexpected"
            path.write_text(json.dumps(record) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "incomplete usage record"):
                load_codex_journal(path)
            path.write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid usage kind"):
                load_codex_journal(path)

    def test_codex_manifest_keeps_existing_agent_provenance(self) -> None:
        with TemporaryDirectory() as directory:
            logs_dir = Path(directory)
            usage = {
                "cacheWriteInputTokens": 0,
                "cachedInputTokens": 0,
                "inputTokens": 1,
                "outputTokens": 1,
                "reasoningOutputTokens": 0,
                "totalTokens": 2,
            }
            (logs_dir / "codex-events.jsonl").write_text(
                json.dumps(
                    {
                        "kind": "ordinary",
                        "responseId": "response",
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "usage": usage,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            base = Trajectory(
                agent=Agent(name="Codex", version="test", extra={"harbor": True}),
                steps=[
                    Step(step_id=1, source="agent", message="done", metrics=Metrics())
                ],
                final_metrics=FinalMetrics(),
            )
            adapter = CodexEval(
                logs_dir=logs_dir,
                model_name="openai/model",
                pi_evals=CODEX_NATIVE_OFF,
            )
            with (
                patch.object(
                    CodexEval.__mro__[1],
                    "_convert_events_to_trajectory",
                    return_value=base,
                ),
                patch.object(adapter, "_compute_cost_from_pricing", return_value=0.0),
            ):
                trajectory = adapter._convert_events_to_trajectory(logs_dir)
            self.assertEqual(
                trajectory.agent.extra,
                {"harbor": True, "pi_evals": CODEX_NATIVE_OFF},
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
