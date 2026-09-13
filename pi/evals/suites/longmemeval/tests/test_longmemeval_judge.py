import hashlib
import importlib.util
import io
import json
import os
import sys
from collections.abc import Callable
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock, patch

import httpx
from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI

SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import longmemeval_cache as cache

SPEC = importlib.util.spec_from_file_location(
    "judge_longmemeval", SCRIPTS / "judge-longmemeval.py"
)
assert SPEC and SPEC.loader
judge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(judge)
sys.path.remove(str(SCRIPTS))


def cache_row(**changes: object) -> dict[str, object]:
    return {
        "abstention": False,
        "condition": "full",
        "hypothesis": "answer",
        "judge_backend": "codex",
        "judge_model": judge.MODEL,
        "judge_response": "yes",
        "label": True,
        "prompt_sha256": "a" * 64,
        "question_id": "q",
        "question_type": "multi-session",
        "task": "task",
        "tier": "64k",
        "trial": "trial",
        **changes,
    }


def judge_item(**changes: object) -> dict[str, object]:
    return {
        "gold": {
            "abstention": False,
            "answer": "answer",
            "condition": "full",
            "question": "question",
            "question_id": "q",
            "question_type": "multi-session",
            "tier": "64k",
        },
        "hypothesis": "answer",
        "task": "task",
        "trial": "trial",
        **changes,
    }


class LongMemEvalJudgeTest(TestCase):
    def test_defaults_to_sol(self) -> None:
        self.assertEqual(judge.MODEL, "gpt-5.6-sol")

    def test_cache_identity_includes_all_inputs(self) -> None:
        row = cache_row()
        for key, value in {
            "condition": "evidence",
            "judge_model": "other",
            "prompt_sha256": "b" * 64,
            "tier": None,
        }.items():
            with self.subTest(key=key):
                self.assertFalse(cache.same_identity(row, {**row, key: value}))

    def test_label_requires_exact_normalized_yes_or_no(self) -> None:
        self.assertTrue(cache.label(" YES "))
        self.assertFalse(cache.label("no"))
        with self.assertRaisesRegex(ValueError, "exactly yes or no"):
            cache.label("yes, correct")

    def test_cache_is_strict_and_rejects_duplicate_trials(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "cache.jsonl"
            row = cache_row()
            path.write_text("\n".join((json.dumps(row), json.dumps(row))))
            with self.assertRaisesRegex(ValueError, "duplicate judge trial"):
                cache.load_cache(path)

            for changes, message in [
                ({"judge_response": "no"}, "response and label disagree"),
                ({"label": 1}, "label must be boolean"),
                ({"prompt_sha256": "short"}, "lowercase SHA-256"),
                ({"question_type": "unknown"}, "unsupported LongMemEval"),
                ({"tier": "115k", "condition": "evidence"}, "condition/tier"),
            ]:
                with self.subTest(changes=changes):
                    path.write_text(json.dumps(cache_row(**changes)) + "\n")
                    with self.assertRaisesRegex(ValueError, message):
                        cache.load_cache(path)

            path.write_text(json.dumps(cache_row()) + "\n")
            with self.assertRaisesRegex(ValueError, "expected 'other'"):
                cache.load_cache(path, model="other")

    def test_write_cache_validates_identity_and_duplicates_before_replacement(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "cache.jsonl"
            original = cache_row(trial="original")
            cache.write_cache(path, [original])
            previous = path.read_bytes()
            for rows, message in [
                ([cache_row(), cache_row()], "duplicate judge trial"),
                ([cache_row(trial="z"), cache_row(trial="a", judge_backend="openai")], "backend"),
                ([cache_row(trial="z"), cache_row(trial="a", judge_model="other")], "model"),
                ([cache_row(label=1)], "label must be boolean"),
            ]:
                with self.subTest(message=message):
                    with self.assertRaisesRegex(ValueError, message):
                        cache.write_cache(path, iter(rows))
                    self.assertEqual(path.read_bytes(), previous)
            cache.write_cache(path, [cache_row(trial="z"), cache_row(trial="a")])
            self.assertEqual(list(cache.load_cache(path)), ["a", "z"])

    def test_uses_task_specific_rubrics(self) -> None:
        temporal = judge.prompt_for(
            "temporal-reasoning", "when?", "18 days", "19 days", abstention=False
        )
        preference = judge.prompt_for(
            "single-session-preference", "what?", "rubric", "answer", abstention=False
        )
        abstention = judge.prompt_for(
            "multi-session", "what?", "missing", "unknown", abstention=True
        )

        self.assertIn("off-by-one", temporal)
        self.assertIn("Rubric: rubric", preference)
        self.assertIn("unanswerable question", abstention)

    def test_main_reports_cache_counts_without_a_score_table(self) -> None:
        with (
            TemporaryDirectory() as directory,
            patch.object(sys, "argv", ["judge", directory, "--workers", "1"]),
            patch.object(judge, "_inputs", return_value=[judge_item()]),
            patch.object(judge, "_codex", return_value="yes") as codex,
            patch.dict(sys.modules, {"openai": None}),
            patch.dict(
                os.environ, {"OPENAI_CUSTOM_HEADERS": "X-Test: ignored"}, clear=True
            ),
        ):
            first = io.StringIO()
            with redirect_stdout(first):
                judge.main()
            self.assertEqual(
                first.getvalue(), "LongMemEval judge: cached=0 new=1 total=1\n"
            )

            second = io.StringIO()
            with redirect_stdout(second):
                judge.main()
            self.assertEqual(
                second.getvalue(), "LongMemEval judge: cached=1 new=0 total=1\n"
            )
            codex.assert_called_once()

    def test_inputs_require_result_and_one_hypothesis(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            task = root / "task"
            gold = task / "steps" / "query" / "tests" / "gold.json"
            gold.parent.mkdir(parents=True)
            gold.write_text(json.dumps({"question_id": "q"}))

            complete = root / "complete"
            (complete / "steps" / "query" / "verifier").mkdir(parents=True)
            (complete / "config.json").write_text(
                json.dumps(
                    {
                        "agent": {"name": "agent"},
                        "task": {"path": str(task)},
                    }
                )
            )
            (complete / "result.json").write_text(
                json.dumps({"trial_name": "complete", "verifier_result": {}})
            )
            (complete / "steps" / "query" / "verifier" / "hypothesis.txt").write_text(
                "answer"
            )

            incomplete = root / "incomplete"
            incomplete.mkdir()
            (incomplete / "config.json").write_text(
                json.dumps(
                    {
                        "agent": {"name": "agent"},
                        "task": {"path": str(task)},
                    }
                )
            )
            (incomplete / "result.json").write_text(
                json.dumps({"trial_name": "incomplete"})
            )

            rows = [
                {"status": "completed", "trial": "complete"},
                {"status": "errored", "trial": "incomplete"},
            ]
            with patch.object(judge, "rows", return_value=rows) as load_rows:
                self.assertEqual(
                    [item["trial"] for item in judge._inputs(root, root)],
                    ["complete"],
                )
                load_rows.assert_called_once_with(root)

                gold.unlink()
                with self.assertRaisesRegex(ValueError, "exactly one gold artifact"):
                    judge._inputs(root, root)
                gold.write_text(json.dumps({"question_id": "q"}))

                duplicate = complete / "steps" / "other" / "verifier"
                duplicate.mkdir(parents=True)
                (duplicate / "hypothesis.txt").write_text("other")
                with self.assertRaisesRegex(
                    ValueError, "exactly one hypothesis artifact"
                ):
                    judge._inputs(root, root)


class OpenAIJudgeTest(TestCase):
    def setUp(self) -> None:
        self.enterContext(patch.dict(os.environ, {}, clear=True))

    def client(self, handler: Callable[[httpx.Request], httpx.Response]) -> OpenAI:
        with patch(
            "openai.OpenAI",
            side_effect=lambda **options: OpenAI(
                http_client=httpx.Client(transport=httpx.MockTransport(handler)),
                **options,
            ),
        ):
            return judge._openai_client(api_key="test-key")

    def answer(self, content: str | None = " yes \n") -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "judge-completion",
                "object": "chat.completion",
                "created": 0,
                "model": judge.MODEL,
                "choices": [
                    {
                        "finish_reason": "stop",
                        "index": 0,
                        "message": {"content": content, "role": "assistant"},
                    }
                ],
            },
        )

    def test_script_import_does_not_require_openai(self) -> None:
        with patch.dict(sys.modules, {"openai": None}):
            SPEC.loader.exec_module(importlib.util.module_from_spec(SPEC))

    def test_request_parity_and_legacy_environment(self) -> None:
        os.environ.update(
            {
                "OPENAI_BASE_URL": "https://unused.invalid/v1",
                "OPENAI_ORG_ID": "unused-org",
                "OPENAI_PROJECT_ID": "unused-project",
            }
        )
        for organization in ("legacy-org", ""):
            with self.subTest(organization=organization):
                os.environ["OPENAI_ORGANIZATION"] = organization
                respond = Mock(return_value=self.answer())
                with self.client(respond) as client:
                    self.assertEqual(client.max_retries, 5)
                    self.assertEqual(
                        judge._post(
                            "rubric — café", client=client, model="judge-model"
                        ),
                        "yes",
                    )
                respond.assert_called_once()
                request = respond.call_args.args[0]
                self.assertEqual(request.method, "POST")
                self.assertEqual(
                    str(request.url), "https://api.openai.com/v1/chat/completions"
                )
                self.assertEqual(request.headers["Authorization"], "Bearer test-key")
                self.assertEqual(request.headers["Content-Type"], "application/json")
                self.assertEqual(
                    request.headers.get("OpenAI-Organization"), organization or None
                )
                self.assertNotIn("OpenAI-Project", request.headers)
                self.assertEqual(
                    request.extensions["timeout"],
                    {
                        "connect": 60,
                        "read": 60,
                        "write": 60,
                        "pool": 60,
                    },
                )
                self.assertEqual(
                    json.loads(request.content),
                    {
                        "max_tokens": 10,
                        "messages": [{"content": "rubric — café", "role": "user"}],
                        "model": "judge-model",
                        "n": 1,
                        "temperature": 0,
                    },
                )

    def test_rejects_environment_header_overrides_before_client_creation(self) -> None:
        os.environ["OPENAI_CUSTOM_HEADERS"] = "Authorization: Bearer wrong"
        with patch("openai.OpenAI") as create:
            with self.assertRaisesRegex(ValueError, "unset OPENAI_CUSTOM_HEADERS"):
                judge._openai_client(api_key="test-key")
            create.assert_not_called()

    def test_null_answer_is_not_a_no_label(self) -> None:
        with (
            self.client(Mock(return_value=self.answer(None))) as client,
            self.assertRaisesRegex(ValueError, "produced no answer"),
        ):
            judge._post("rubric", client=client, model=judge.MODEL)

    def test_sdk_retry_budget_and_authentication_failure(self) -> None:
        for status, attempts in (
            (401, 1),
            (429, 6),
            (500, 6),
        ):
            with self.subTest(status=status):
                respond = Mock(
                    side_effect=[
                        httpx.Response(status, json={"error": {"message": "failed"}})
                        for _ in range(attempts)
                    ]
                )
                with (
                    self.client(respond) as client,
                    patch("openai._base_client.time.sleep") as sleep,
                ):
                    with self.assertRaises(APIStatusError) as error:
                        judge._post("rubric", client=client, model=judge.MODEL)
                    self.assertEqual(error.exception.status_code, status)
                    self.assertEqual(respond.call_count, attempts)
                    self.assertEqual(sleep.call_count, attempts - 1)

    def test_sdk_obeys_retry_after_and_server_retry_controls(self) -> None:
        for headers, delay in (
            ({"Retry-After": "3"}, 3.0),
            ({"retry-after-ms": "250"}, 0.25),
            ({"Retry-After": "121"}, None),
            ({"x-should-retry": "false"}, None),
        ):
            with self.subTest(headers=headers):
                respond = Mock(
                    side_effect=[
                        httpx.Response(
                            429, headers=headers, json={"error": {"message": "busy"}}
                        ),
                        self.answer(),
                    ]
                )
                with (
                    self.client(respond) as client,
                    patch("openai._base_client.time.sleep") as sleep,
                ):
                    if delay is None:
                        with self.assertRaises(APIStatusError):
                            judge._post("rubric", client=client, model=judge.MODEL)
                        respond.assert_called_once()
                        sleep.assert_not_called()
                    else:
                        self.assertEqual(
                            judge._post("rubric", client=client, model=judge.MODEL),
                            "yes",
                        )
                        self.assertEqual(respond.call_count, 2)
                        sleep.assert_called_once_with(delay)

    def test_sdk_retries_connection_errors_and_timeouts(self) -> None:
        for transport_error, sdk_error in (
            (httpx.ConnectError, APIConnectionError),
            (httpx.ReadTimeout, APITimeoutError),
        ):
            with self.subTest(error=transport_error):
                respond = Mock(side_effect=transport_error("failed"))
                with (
                    self.client(respond) as client,
                    patch("openai._base_client.time.sleep") as sleep,
                ):
                    with self.assertRaises(sdk_error):
                        judge._post("rubric", client=client, model=judge.MODEL)
                    self.assertEqual(respond.call_count, 6)
                    self.assertEqual(sleep.call_count, 5)

    def test_workers_share_and_close_one_client_and_reuse_cache(self) -> None:
        os.environ["OPENAI_API_KEY"] = "test-key"
        clients = []
        respond = Mock(side_effect=[self.answer(), self.answer()])

        def create(**options: object) -> OpenAI:
            client = OpenAI(
                http_client=httpx.Client(transport=httpx.MockTransport(respond)),
                **options,
            )
            clients.append(client)
            return client

        with (
            TemporaryDirectory() as directory,
            patch.object(
                sys,
                "argv",
                ["judge", directory, "--backend", "openai", "--workers", "2"],
            ),
            patch.object(
                judge,
                "_inputs",
                return_value=[judge_item(), judge_item(trial="second")],
            ),
            patch("openai.OpenAI", side_effect=create) as constructor,
            patch.object(judge, "_codex") as codex,
        ):
            for expected in ("cached=0 new=2", "cached=2 new=0"):
                output = io.StringIO()
                with redirect_stdout(output):
                    judge.main()
                self.assertIn(expected, output.getvalue())
                self.assertTrue(clients[-1].is_closed())
            self.assertEqual(constructor.call_count, 2)
            self.assertEqual(respond.call_count, 2)
            codex.assert_not_called()
            current = Path(directory) / (
                f"longmemeval-judge-openai-{judge.MODEL}.jsonl"
            )
            self.assertEqual(
                set(cache.load_cache(current, backend="openai", model=judge.MODEL)),
                {"trial", "second"},
            )

    def test_historical_cache_reuse_changed_inputs_and_explicit_rejudge(self) -> None:
        os.environ["OPENAI_API_KEY"] = "test-key"
        prompt = judge.prompt_for(
            "multi-session", "question", "answer", "answer", abstention=False
        )
        historical = cache_row(
            judge_backend="openai",
            judge_response="no",
            label=False,
            prompt_sha256=hashlib.sha256(prompt.encode()).hexdigest(),
        )
        for changes, flags, calls in (
            ({}, [], 0),
            ({"hypothesis": "outdated"}, [], 1),
            ({}, ["--rejudge"], 1),
        ):
            with (
                self.subTest(changes=changes, flags=flags),
                TemporaryDirectory() as directory,
            ):
                path = Path(directory) / f"longmemeval-judge-openai-{judge.MODEL}.jsonl"
                previous = {**historical, **changes}
                cache.write_cache(path, [previous])
                respond = Mock(return_value=self.answer())
                with (
                    self.client(respond) as client,
                    patch.object(judge, "_openai_client", return_value=client),
                    patch.object(judge, "_inputs", return_value=[judge_item()]),
                    patch.object(
                        sys, "argv", ["judge", directory, "--backend", "openai", *flags]
                    ),
                    redirect_stdout(io.StringIO()) as output,
                ):
                    judge.main()
                self.assertEqual(respond.call_count, calls)
                self.assertIn(f"cached={1 - calls} new={calls}", output.getvalue())
                [row] = cache.load_cache(path).values()
                if calls == 0:
                    self.assertEqual(row, previous)
                else:
                    self.assertEqual(
                        row, {**historical, "judge_response": "yes", "label": True}
                    )
