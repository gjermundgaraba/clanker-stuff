import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from harbor.models.trajectories import Agent, FinalMetrics, Metrics, Step, Trajectory
from pi_evals.adapters.codex import (
    CodexEval,
    load_codex_journal,
)

MANIFEST = {
    "platform": "codex-native",
    "compaction_mode": "on",
    "expected_mechanism": "codex-native",
    "expected_protocol": None,
}
USAGE = {
    "cacheWriteInputTokens": 0,
    "cachedInputTokens": 2,
    "inputTokens": 10,
    "outputTokens": 3,
    "reasoningOutputTokens": 1,
    "totalTokens": 13,
}


def response(kind: str, turn_id: str, *, input_tokens: int = 10):
    return {
        "kind": kind,
        "responseId": f"response-{kind}-{turn_id}",
        "threadId": "thread-1",
        "turnId": turn_id,
        "usage": {
            **USAGE,
            "inputTokens": input_tokens,
            "totalTokens": input_tokens + 3,
        },
    }


def attempt(state: str, *, segment: int = 0):
    return {
        "compactedAfterSegment": segment,
        "kind": "compaction_attempt",
        "state": state,
        "threadId": "thread-1",
        "timestamp": "2026-08-25T10:00:00Z",
        "turnId": "compact-1",
    }


def write_journal(path: Path, records: list[dict]) -> None:
    path.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records),
        encoding="utf-8",
    )


def base_trajectory() -> Trajectory:
    return Trajectory(
        agent=Agent(name="Codex", version="test"),
        steps=[
            Step(
                step_id=1,
                source="agent",
                message="continued",
                metrics=Metrics(),
            )
        ],
        final_metrics=FinalMetrics(),
    )


class CodexCompactionTest(TestCase):
    def test_runtime_capture_covers_all_terminal_states(self) -> None:
        result = subprocess.run(
            ["node", "runtime/codex-eval.mjs", "--self-test"],
            check=False,
            cwd=Path(__file__).parents[1],
        )
        self.assertEqual(result.returncode, 0)

    def test_journal_separates_usage_and_strict_attempts(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "codex-events.jsonl"
            write_journal(path, [attempt("failed"), response("ordinary", "turn-1")])

            usage, attempts = load_codex_journal(path)
            self.assertEqual(attempts, [attempt("failed")])
            self.assertEqual(usage, [response("ordinary", "turn-1")])

            write_journal(path, [{**attempt("failed"), "state": "unknown"}])
            with self.assertRaisesRegex(ValueError, "invalid compaction attempt"):
                load_codex_journal(path)

    def test_failed_attempt_without_usage_becomes_unmetered_atif_step(self) -> None:
        with TemporaryDirectory() as directory:
            logs_dir = Path(directory)
            write_journal(
                logs_dir / "codex-events.jsonl",
                [attempt("failed"), response("ordinary", "turn-1")],
            )
            adapter = CodexEval(
                logs_dir=logs_dir,
                model_name="openai/gpt-5.6-terra",
                pi_evals=MANIFEST,
            )
            with (
                patch.object(
                    CodexEval.__mro__[1],
                    "_convert_events_to_trajectory",
                    return_value=base_trajectory(),
                ),
                patch.object(adapter, "_compute_cost_from_pricing", return_value=0.1),
            ):
                trajectory = adapter._convert_events_to_trajectory(logs_dir)

            self.assertIsNotNone(trajectory)
            compaction = next(
                step
                for step in trajectory.steps
                if (step.extra or {}).get("event_type") == "context_compaction"
            )
            self.assertEqual(compaction.extra["state"], "failed")
            self.assertEqual(compaction.extra["compacted_after_segment"], 0)
            self.assertIsNone(compaction.metrics)
            self.assertEqual(trajectory.final_metrics.total_prompt_tokens, 10)

    def test_failed_attempt_preserves_optional_exact_usage(self) -> None:
        with TemporaryDirectory() as directory:
            logs_dir = Path(directory)
            write_journal(
                logs_dir / "codex-events.jsonl",
                [
                    attempt("aborted"),
                    response("compaction", "compact-1", input_tokens=20),
                    response("ordinary", "turn-1"),
                ],
            )
            adapter = CodexEval(
                logs_dir=logs_dir,
                model_name="openai/gpt-5.6-terra",
                pi_evals=MANIFEST,
            )
            with (
                patch.object(
                    CodexEval.__mro__[1],
                    "_convert_events_to_trajectory",
                    return_value=base_trajectory(),
                ),
                patch.object(adapter, "_compute_cost_from_pricing", return_value=0.1),
            ):
                trajectory = adapter._convert_events_to_trajectory(logs_dir)

            compaction = next(
                step
                for step in trajectory.steps
                if (step.extra or {}).get("event_type") == "context_compaction"
            )
            self.assertEqual(compaction.extra["state"], "aborted")
            self.assertEqual(compaction.metrics.prompt_tokens, 20)
            self.assertEqual(trajectory.final_metrics.total_prompt_tokens, 30)

    def test_success_requires_and_uses_matching_durable_rollout(self) -> None:
        with TemporaryDirectory() as directory:
            logs_dir = Path(directory)
            write_journal(
                logs_dir / "codex-events.jsonl",
                [
                    attempt("succeeded"),
                    response("compaction", "compact-1", input_tokens=20),
                    response("ordinary", "turn-1"),
                ],
            )
            adapter = CodexEval(
                logs_dir=logs_dir,
                model_name="openai/gpt-5.6-terra",
                pi_evals=MANIFEST,
            )
            with patch.object(
                CodexEval.__mro__[1],
                "_convert_events_to_trajectory",
                return_value=base_trajectory(),
            ):
                with self.assertRaisesRegex(ValueError, "durable compactions"):
                    adapter._convert_events_to_trajectory(logs_dir)

            (logs_dir / "rollout-test.jsonl").write_text(
                "".join(
                    [
                        json.dumps(
                            {"type": "event_msg", "payload": {"type": "user_message"}}
                        )
                        + "\n",
                        json.dumps(
                            {
                                "timestamp": "2026-08-25T10:00:00Z",
                                "type": "compacted",
                                "payload": {},
                            }
                        )
                        + "\n",
                    ]
                ),
                encoding="utf-8",
            )
            with (
                patch.object(
                    CodexEval.__mro__[1],
                    "_convert_events_to_trajectory",
                    return_value=base_trajectory(),
                ),
                patch.object(adapter, "_compute_cost_from_pricing", return_value=0.1),
            ):
                trajectory = adapter._convert_events_to_trajectory(logs_dir)

            compaction = next(
                step
                for step in trajectory.steps
                if (step.extra or {}).get("event_type") == "context_compaction"
            )
            self.assertEqual(compaction.extra["state"], "succeeded")
            self.assertEqual(compaction.metrics.prompt_tokens, 20)


class CodexInstallTest(IsolatedAsyncioTestCase):
    async def test_install_requires_the_pinned_image_binary(self) -> None:
        adapter = CodexEval(
            logs_dir=Path("."),
            model_name="openai/gpt-5.6-terra",
            version="0.147.0",
            pi_evals=MANIFEST,
        )
        environment = SimpleNamespace(
            exec=AsyncMock(
                return_value=SimpleNamespace(
                    return_code=0,
                    stdout="codex-cli 0.147.0\n",
                )
            )
        )

        await adapter.install(environment)

        environment.exec.return_value = SimpleNamespace(
            return_code=0,
            stdout="codex-cli 0.148.0\n",
        )
        with self.assertRaisesRegex(RuntimeError, "Codex 0.147.0"):
            await adapter.install(environment)

        unpinned = CodexEval(
            logs_dir=Path("."),
            model_name="openai/gpt-5.6-terra",
            pi_evals=MANIFEST,
        )
        with self.assertRaisesRegex(ValueError, "pinned Codex version"):
            await unpinned.install(environment)
