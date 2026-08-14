import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase


SPEC = importlib.util.spec_from_file_location(
    "judge_longmemeval",
    Path(__file__).parents[1] / "scripts" / "judge-longmemeval.py",
)
assert SPEC and SPEC.loader
judge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(judge)


class LongMemEvalJudgeTest(TestCase):
    def test_defaults_to_sol(self) -> None:
        self.assertEqual(judge.MODEL, "gpt-5.6-sol")

    def test_cache_key_includes_prompt_hash_and_metadata(self) -> None:
        metadata = {"condition": "full", "tier": "64k"}
        self.assertNotEqual(
            judge._cache_key("trial", "old", metadata),
            judge._cache_key("trial", "new", metadata),
        )
        self.assertEqual(
            judge._cache_key(
                "trial", "hash", {"condition": "evidence", "tier": None}
            ),
            ("trial", "hash", "evidence", None),
        )

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
            (complete / "result.json").write_text("{}")
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

            self.assertEqual(
                [item["trial"] for item in judge._inputs(root, root)], ["complete"]
            )

            duplicate = complete / "steps" / "other" / "verifier"
            duplicate.mkdir(parents=True)
            (duplicate / "hypothesis.txt").write_text("other")
            with self.assertRaisesRegex(ValueError, "exactly one hypothesis artifact"):
                judge._inputs(root, root)
