import json
import os
import subprocess
import tomllib
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from harbor.models.trajectories import Agent, FinalMetrics, Metrics, Step, Trajectory
from pi_evals.adapters.codex import (
    CodexEval,
    load_codex_journal,
    load_codex_turn_contexts,
    runner_command,
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
    def test_durable_model_and_effort_evidence(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(load_codex_turn_contexts(root), [])
            write_journal(root / "rollout-test.jsonl", [
                {"type": "turn_context", "payload": {"model": "gpt-6.1-sol", "effort": "high", "cwd": "/app"}},
                {"type": "event_msg", "payload": {}},
                {"type": "turn_context", "payload": {"model": "other"}},
            ])
            self.assertEqual(load_codex_turn_contexts(root), [
                {"model": "gpt-6.1-sol", "effort": "high"},
                {"model": "other", "effort": None},
            ])

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


class CodexOutputTest(TestCase):
    def test_warnings_stay_out_of_jsonl_and_failure_is_preserved(self):
        with TemporaryDirectory() as directory:
            command = (
                'function codex-eval() { echo WARNING >&2; echo \'{"type":"eval_event"}\'; return 7; }; '
                + runner_command(directory, "codex.txt")
            )
            result = subprocess.run(["bash", "-c", command], capture_output=True, text=True)
            self.assertEqual(result.returncode, 7)
            self.assertEqual(json.loads((Path(directory) / "codex.txt").read_text()), {"type": "eval_event"})
            self.assertEqual((Path(directory) / "codex-stderr.log").read_text(), "WARNING\n")


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


HOME = "/installed-agent/codex-home"


class FakeEnvironment:
    default_user = "agent"

    def __init__(self) -> None:
        self.execs: list[SimpleNamespace] = []
        self.uploads: dict[str, bytes] = {}
        self.agent_owns_home = False

    async def exec(self, command, user=None, env=None, cwd=None, timeout_sec=None):
        self.execs.append(SimpleNamespace(command=command, user=user, env=dict(env or {})))
        # Harbor creates /installed-agent as root; only root can hand a home in
        # it to the dedicated agent user.
        if user == "root" and f"mkdir -p {HOME}" in command and "chown -R 1000:1000" in command:
            self.agent_owns_home = True
        elif user != "root" and HOME in command and not self.agent_owns_home:
            return SimpleNamespace(return_code=1, stdout="", stderr="Permission denied")
        stdout = "CODEX_RUNTIME_ID 1000 1000\n" if "CODEX_RUNTIME_ID" in command else ""
        return SimpleNamespace(return_code=0, stdout=stdout, stderr="")

    async def upload_file(self, source_path, target_path) -> None:
        self.uploads[target_path] = Path(source_path).read_bytes()

    def runner(self) -> SimpleNamespace:
        command = runner_command("/logs/agent", "codex.txt")
        [runner] = [e for e in self.execs if command in e.command]
        return runner


class CodexRunTest(IsolatedAsyncioTestCase):
    async def run_adapter(self, **kwargs) -> FakeEnvironment:
        environment = FakeEnvironment()
        # Harbor falls back to a base URL from the host shell.
        with patch.dict(os.environ), TemporaryDirectory() as directory:
            for name in ("OPENAI_BASE_URL", "OPENAI_API_BASE"):
                os.environ.pop(name, None)
            auth = Path(directory) / "auth.json"
            auth.write_text('{"OPENAI_API_KEY": "test"}')
            adapter = CodexEval(
                logs_dir=Path(directory),
                model_name="openai/gpt-6.1-sol",
                version="0.166.0",
                pi_evals={**MANIFEST, "compaction_mode": "off"},
                **kwargs,
            )
            with patch.object(CodexEval, "_resolve_auth_json_path", return_value=auth):
                await adapter.run("solve it", environment, SimpleNamespace())
        return environment

    async def test_base_url_reaches_codex_env_and_config(self) -> None:
        environment = await self.run_adapter(base_url="http://proxy.test/v1")

        runner = environment.runner()
        self.assertEqual(runner.env["OPENAI_BASE_URL"], "http://proxy.test/v1")
        config = tomllib.loads(
            environment.uploads[f"{HOME}/config.toml"].decode()
        )
        self.assertEqual(config["openai_base_url"], "http://proxy.test/v1")
        self.assertTrue(config["features"]["unified_exec"])

        environment = await self.run_adapter()
        runner = environment.runner()
        self.assertNotIn("OPENAI_BASE_URL", runner.env)

    async def test_root_hands_the_codex_home_to_the_agent_user(self) -> None:
        environment = await self.run_adapter()

        self.assertTrue(environment.agent_owns_home)
        [auth] = [
            e for e in environment.execs if "chown 1000:1000 /tmp/codex-secrets" in e.command
        ]
        self.assertEqual(auth.user, "root")
        self.assertIn("chmod 600 /tmp/codex-secrets/auth.json", auth.command)
