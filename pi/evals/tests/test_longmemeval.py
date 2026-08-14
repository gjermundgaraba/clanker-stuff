import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from harbor.models.task.task import Task

from pi_evals.longmemeval import (
    generate_tasks,
    history_chunks,
    history_instruction,
    select_records,
    tier_indices,
)


class CharacterEncoder:
    def encode(self, value: str) -> list[str]:
        return list(value)


def record(question_id: str, question_type: str, abstention: bool = False) -> dict:
    suffix = "_abs" if abstention else ""
    return {
        "answer": "Blue",
        "answer_session_ids": ["evidence"],
        "haystack_dates": ["2026-01-01", "2026-01-02", "2026-01-03"],
        "haystack_session_ids": ["filler-a", "evidence", "filler-b"],
        "haystack_sessions": [
            [{"role": "user", "content": "a" * 30}],
            [{"role": "user", "content": "blue", "has_answer": True}],
            [{"role": "assistant", "content": "b" * 30}],
        ],
        "question": "What color?",
        "question_date": "2026-01-04",
        "question_id": question_id + suffix,
        "question_type": question_type,
    }


class LongMemEvalTest(TestCase):
    def test_selects_five_per_type_and_one_available_abstention(self) -> None:
        records = []
        for question_type in ("a", "b"):
            records.extend(record(f"{question_type}{index}", question_type) for index in range(6))
        records.append(record("a0", "a", abstention=True))

        selected = select_records(records)
        reversed_selection = select_records(reversed(records))

        self.assertEqual(
            [row["question_id"] for row in selected],
            [row["question_id"] for row in reversed_selection],
        )
        self.assertEqual({row["question_type"] for row in selected}, {"a", "b"})
        self.assertEqual(sum(row["question_id"].endswith("_abs") for row in selected), 1)
        self.assertEqual(len(selected), 10)

    def test_tiers_are_nested_and_retain_evidence(self) -> None:
        item = record("q", "type")
        tiers = tier_indices(item, ["evidence"], CharacterEncoder(), (430, 500, 600))

        small, medium, large = map(set, tiers.values())
        self.assertLessEqual(small, medium)
        self.assertLessEqual(medium, large)
        self.assertIn(1, small)

    def test_history_is_split_at_session_boundaries(self) -> None:
        item = record("q", "type")
        chunks = history_chunks(item, range(3), CharacterEncoder(), max_tokens=120)

        self.assertEqual(len(chunks), 2)
        self.assertTrue(all("HISTORY-RECORDED" in chunk for chunk in chunks))
        self.assertEqual(sum(chunk.count("### Session") for chunk in chunks), 3)

    def test_generated_public_instructions_hide_gold_metadata(self) -> None:
        item = record("secret-qid", "secret-type")
        with TemporaryDirectory() as directory:
            output = Path(directory)
            generate_tasks([item], [item], [item["question_id"]], output, CharacterEncoder())
            instructions = "\n".join(
                path.read_text(encoding="utf-8") for path in output.rglob("instruction.md")
            )
            gold = json.loads(next(output.rglob("gold.json")).read_text(encoding="utf-8"))
            generated = list(output.glob("*/*"))
            harbor_valid = bool(generated) and all(
                Task.is_valid_dir(task) for task in generated
            )
            task_toml = next(output.rglob("task.toml")).read_text(encoding="utf-8")

        self.assertNotIn("secret-qid", instructions)
        self.assertNotIn("secret-type", instructions)
        self.assertNotIn("has_answer", instructions)
        self.assertNotIn("evidence", instructions)
        self.assertEqual(gold["question_id"], "secret-qid")
        self.assertEqual(gold["question_type"], "secret-type")
        self.assertIn("blue", history_instruction(item, [1]).lower())
        self.assertIn('name = "history-01"', task_toml)
        self.assertTrue(harbor_valid)
