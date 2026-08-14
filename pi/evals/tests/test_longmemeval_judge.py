import importlib.util
from pathlib import Path
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
