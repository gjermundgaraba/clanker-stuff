import copy
import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from harbor.models.task.task import Task

from suites.longmemeval.longmemeval import (
    generate_tasks,
    history_chunks,
    history_instruction,
    select_records,
    tier_indices,
)
from pi_evals.protocol import CONTROLLED_COMPACTION_MARKER


class CharacterEncoder:
    def encode(self, value: str) -> list[str]:
        return list(value)


def record(question_id: str, question_type: str, abstention: bool = False) -> dict:
    suffix = "_abs" if abstention else ""
    session_ids = [f"filler-{index:02d}" for index in range(11)] + ["evidence"]
    return {
        "answer": "Blue",
        "answer_session_ids": ["evidence"],
        "haystack_dates": [f"2026-01-{index + 1:02d}" for index in range(12)],
        "haystack_session_ids": session_ids,
        "haystack_sessions": [
            [
                {
                    "content": "blue" if session_id == "evidence" else "x" * 30,
                    "has_answer": session_id == "evidence",
                    "role": "user",
                }
            ]
            for session_id in session_ids
        ],
        "question": "What color?",
        "question_date": "2026-02-01",
        "question_id": question_id + suffix,
        "question_type": question_type,
    }


class LongMemEvalTest(TestCase):
    def test_selects_five_per_type_and_one_available_abstention(self) -> None:
        records = []
        for question_type in ("a", "b"):
            records.extend(
                record(f"{question_type}{index}", question_type) for index in range(6)
            )
        records.append(record("a0", "a", abstention=True))

        selected = select_records(records)

        self.assertEqual(
            [row["question_id"] for row in selected],
            [row["question_id"] for row in select_records(reversed(records))],
        )
        self.assertEqual({row["question_type"] for row in selected}, {"a", "b"})
        self.assertEqual(sum(row["question_id"].endswith("_abs") for row in selected), 1)
        self.assertEqual(len(selected), 10)

    def test_tiers_are_nested_and_retain_evidence(self) -> None:
        item = record("q", "type")
        tiers = tier_indices(
            item,
            ["evidence"],
            CharacterEncoder(),
            {1_000: 2, 2_000: 3},
        )

        small, large = map(set, tiers.values())
        self.assertLessEqual(small, large)
        self.assertIn(11, small)

    def test_history_uses_exact_balanced_session_chunks(self) -> None:
        item = record("q", "type")
        chunks = history_chunks(item, range(12), CharacterEncoder(), chunk_count=6)

        self.assertEqual(len(chunks), 6)
        self.assertTrue(all("HISTORY-RECORDED" in chunk for chunk in chunks))
        self.assertEqual(sum(chunk.count("### Prior chat") for chunk in chunks), 12)

    def test_generates_four_non_leaking_conditions_with_exact_boundaries(self) -> None:
        item = record("secret-qid", "secret-type")
        oracle = copy.deepcopy(item)
        oracle["haystack_dates"] = ["1999-01-01"] * 12
        with TemporaryDirectory() as directory:
            output = Path(directory)
            self.assertEqual(
                generate_tasks(
                    [item],
                    [oracle],
                    [item["question_id"]],
                    output,
                    CharacterEncoder(),
                ),
                4,
            )
            instructions = "\n".join(
                path.read_text(encoding="utf-8")
                for path in output.rglob("instruction.md")
            )
            tasks = list(output.rglob("task.toml"))
            gold = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in output.rglob("gold.json")
            ]
            full_64k = (output / "full/64k/00/task.toml").read_text(encoding="utf-8")
            full_115k = (output / "full/115k/00/task.toml").read_text(
                encoding="utf-8"
            )
            handoff = (output / "handoff/115k/00/task.toml").read_text(
                encoding="utf-8"
            )
            full_64k_query = (
                output / "full/64k/00/steps/query/instruction.md"
            ).read_text(encoding="utf-8")
            handoff_evidence = (
                output / "handoff/115k/00/steps/evidence/instruction.md"
            ).read_text(encoding="utf-8")
            evidence_only = (
                output / "evidence/00/steps/evidence/instruction.md"
            ).read_text(encoding="utf-8")

            self.assertEqual(len(tasks), 4)
            self.assertTrue(all(Task.is_valid_dir(path.parent) for path in tasks))

        self.assertNotIn("secret-qid", instructions)
        self.assertNotIn("secret-type", instructions)
        self.assertNotIn("has_answer", instructions)
        self.assertNotIn("evidence", instructions)
        self.assertNotIn("1999-01-01", instructions)
        self.assertEqual({row["condition"] for row in gold}, {"full", "evidence", "handoff"})
        self.assertIn('name = "history-06"', full_64k)
        self.assertNotIn('name = "history-07"', full_64k)
        self.assertIn("expected_compaction_after_segment = 5", full_64k)
        self.assertIn('name = "history-10"', full_115k)
        self.assertIn("expected_compaction_after_segment = 9", full_115k)
        self.assertIn('name = "evidence"', handoff)
        self.assertIn("expected_compaction_after_segment = 9", handoff)
        self.assertTrue(full_64k_query.startswith(CONTROLLED_COMPACTION_MARKER))
        self.assertTrue(handoff_evidence.startswith(CONTROLLED_COMPACTION_MARKER))
        self.assertFalse(evidence_only.startswith(CONTROLLED_COMPACTION_MARKER))
        self.assertIn("blue", history_instruction(item, [11]).lower())

    def test_grader_requires_one_success_at_the_exact_boundary(self) -> None:
        item = record("q", "type")
        with TemporaryDirectory() as directory:
            root = Path(directory)
            generated = root / "generated"
            generate_tasks([item], [item], ["q"], generated, CharacterEncoder())
            task = generated / "full/64k/00/steps/query"
            tests = root / "tests"
            logs = root / "logs"
            tests.mkdir()
            (logs / "agent").mkdir(parents=True)
            (logs / "verifier").mkdir()
            (tests / "gold.json").write_text(
                (task / "tests/gold.json").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            grader = (task / "tests/grade.mjs").read_text(encoding="utf-8")
            grader = grader.replace('"/tests/', f'"{tests.as_posix()}/').replace(
                '"/logs/', f'"{logs.as_posix()}/'
            )
            runnable = root / "grade.mjs"
            runnable.write_text(grader, encoding="utf-8")
            (root / "compaction.mjs").write_text(
                (task / "tests/compaction.mjs").read_text(encoding="utf-8"),
                encoding="utf-8",
            )

            def grade(
                boundaries: list[int],
                mode: str = "on",
                *,
                agent_error: bool = False,
            ) -> dict[str, int]:
                steps = [
                    {
                        "extra": {
                            "compacted_after_segment": boundary,
                            "event_type": "context_compaction",
                            "mechanism": "pi-builtin",
                            "protocol": None,
                            "state": "succeeded",
                        },
                        "source": "agent",
                    }
                    for boundary in boundaries
                ]
                if agent_error:
                    steps.append(
                        {
                            "extra": {"stop_reason": "error"},
                            "message": "",
                            "source": "agent",
                        }
                    )
                steps.extend(
                    [
                        {"source": "user"},
                        {"message": "Blue", "source": "agent"},
                    ]
                )
                (logs / "agent/trajectory.json").write_text(
                    json.dumps(
                        {
                            "agent": {
                                "extra": {
                                    "pi_evals": {
                                        "compaction_mode": mode,
                                        "expected_mechanism": "pi-builtin",
                                        "expected_protocol": None,
                                        "platform": "pi-vanilla",
                                    }
                                }
                            },
                            "steps": steps,
                        }
                    ),
                    encoding="utf-8",
                )
                subprocess.run(["node", runnable], check=True)
                return json.loads(
                    (logs / "verifier/reward.json").read_text(encoding="utf-8")
                )

            self.assertEqual(grade([5])["valid_experiment"], 1)
            self.assertEqual(grade([5])["reward"], grade([5])["quality"])
            self.assertNotIn("valid", grade([5]))
            self.assertEqual(grade([4])["valid_experiment"], 0)
            self.assertEqual(grade([5, 5])["valid_experiment"], 0)
            off = grade([], "off")
            self.assertEqual(off["valid_experiment"], 1)
            failed = grade([5], agent_error=True)
            self.assertEqual(failed["valid_experiment"], 1)
            self.assertEqual(failed["agent_errors"], 1)
