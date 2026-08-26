import importlib.util
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch


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
        item = {
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
        }
        with (
            TemporaryDirectory() as directory,
            patch.object(sys, "argv", ["judge", directory, "--workers", "1"]),
            patch.object(judge, "_inputs", return_value=[item]),
            patch.object(judge, "_codex", return_value="yes") as codex,
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
            with patch.object(judge.report, "rows", return_value=rows) as load_rows:
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
