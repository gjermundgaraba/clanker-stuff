from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from harbor.models.task.task import Task

from pi_evals.mem2act import (
    read_jsonl,
    resolve_records,
    score_call,
    stratified_sample,
    typed_leaves,
    write_tasks,
)


def qa(identifier: str, level: str, source: str = "source-1") -> dict:
    return {
        "qa_id": identifier,
        "source_conversation_ids": [source],
        "query": "PRIVATE_QUERY",
        "tool_call": {
            "name": "secret.tool",
            "arguments": {"count": 3, "enabled": True},
            "grounding_info": {"PRIVATE_GROUNDING": True},
        },
        "target_tool_schema": {
            "name": "secret.tool",
            "description": "public",
            "parameters": {"type": "dict", "properties": {}},
        },
        "evolution_chain": ["PRIVATE_EVOLUTION"],
        "complexity_metadata": {"level": level},
    }


def session(identifier: str, source: str = "source-1") -> dict:
    return {
        "session_id": identifier,
        "original_conversation_ids": [source],
        "turns": [{"role": "user", "content": "PRIVATE_MEMORY", "source_id": source}],
    }


class Mem2ActTest(TestCase):
    def test_jsonl_preserves_unicode_line_separators(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "data.jsonl"
            record = {"content": "before\u2028after"}
            path.write_text(
                json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8"
            )

            self.assertEqual(read_jsonl(path), [record])

    def test_resolves_only_one_complete_session_and_stratifies(self) -> None:
        records = [qa("qa-empty", "L1"), qa("qa-one", "L2"), qa("qa-many", "L3")]
        records[0]["source_conversation_ids"] = []
        records[2]["source_conversation_ids"] = ["shared"]
        sessions = [session("one"), session("many-a", "shared"), session("many-b", "shared")]

        resolved, skipped = resolve_records(records, sessions)

        self.assertEqual([item[0]["qa_id"] for item in resolved], ["qa-one"])
        self.assertEqual(skipped, ["qa-empty", "qa-many"])

        balanced = [(qa(f"{level}-{index}", level), session(f"{level}-{index}")) for level in ("L1", "L2", "L3", "L4") for index in range(3)]
        selected = stratified_sample(balanced, 8, "seed")
        self.assertEqual(
            {level: sum(item[0]["complexity_metadata"]["level"] == level for item in selected) for level in ("L1", "L2", "L3", "L4")},
            {"L1": 2, "L2": 2, "L3": 2, "L4": 2},
        )
        self.assertEqual(
            [item[0]["qa_id"] for item in selected],
            [item[0]["qa_id"] for item in stratified_sample(balanced, 8, "seed")],
        )

    def test_scores_typed_json_pointer_leaves(self) -> None:
        gold = {"name": "lookup", "arguments": {"a/b": 1, "flag": True}}
        self.assertIn(("/a~1b", "number", "1"), typed_leaves(gold["arguments"]))
        self.assertEqual(
            score_call(None, gold),
            {"exact_arguments": 0.0, "parameter_f1": 0.0},
        )
        score = score_call(
            {"tool": "lookup", "arguments": {"a/b": True, "flag": True}}, gold
        )
        self.assertEqual(score["exact_arguments"], 0.0)
        self.assertEqual(score["parameter_f1"], 0.5)
        self.assertEqual(
            score_call({"tool": "ignored", "arguments": gold["arguments"]}, gold),
            {"exact_arguments": 1.0, "parameter_f1": 1.0},
        )

    def test_generated_public_files_do_not_expose_private_qa_fields(self) -> None:
        with TemporaryDirectory() as directory:
            output = Path(directory) / "tasks"
            write_tasks([(qa("qa-one", "L1"), session("session-one"))], output)
            task = output / "qa-one"
            instruction = (task / "instruction.md").read_text(encoding="utf-8")
            schema = json.loads(
                (task / "environment" / ".mem2act-schema.json").read_text(encoding="utf-8")
            )

            self.assertIn("PRIVATE_MEMORY", instruction)
            self.assertIn("PRIVATE_QUERY", instruction)
            self.assertEqual(schema, qa("qa-one", "L1")["target_tool_schema"])
            self.assertNotIn("PRIVATE_GROUNDING", instruction)
            self.assertNotIn("PRIVATE_EVOLUTION", instruction)
            self.assertNotIn('"count":3', instruction)
            grader = (task / "tests" / "grade.mjs").read_text(encoding="utf-8")
            self.assertIn('"count":3', grader)
            self.assertIn("exact_arguments", grader)
            self.assertNotIn("PRIVATE_GROUNDING", grader)
            self.assertNotIn("PRIVATE_EVOLUTION", grader)
            self.assertTrue(Task.is_valid_dir(task))
            self.assertEqual(Task(task).name, "pi-evals/mem2act-qa-one")

    def test_generated_grader_rejects_multiple_or_malformed_calls(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "tasks"
            write_tasks([(qa("qa-one", "L1"), session("session-one"))], output)
            calls = root / "calls.jsonl"
            reward = root / "reward.json"
            grader = root / "grade.mjs"
            grader.write_text(
                (output / "qa-one" / "tests" / "grade.mjs")
                .read_text(encoding="utf-8")
                .replace('"/app/.mem2act-calls.jsonl"', json.dumps(str(calls)))
                .replace('"/logs/verifier/reward.json"', json.dumps(str(reward))),
                encoding="utf-8",
            )
            valid = json.dumps(
                {
                    "arguments": qa("qa-one", "L1")["tool_call"]["arguments"],
                    "tool": "secret.tool",
                }
            )
            for contents, expected in (
                (f"{valid}\n", 1),
                (f"{valid}\n{valid}\n", 0),
                ("not-json\n", 0),
            ):
                calls.write_text(contents, encoding="utf-8")
                subprocess.run(["node", grader], check=True)
                score = json.loads(reward.read_text(encoding="utf-8"))
                self.assertEqual(score["exact_arguments"], expected)
                self.assertEqual(score["parameter_f1"], expected)

    def test_runtime_describes_schema_and_appends_call(self) -> None:
        runtime = Path(__file__).parents[1] / "runtime" / "mem2act.mjs"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            schema = root / "schema.json"
            calls = root / "calls.jsonl"
            schema.write_text('{"name":"lookup","z":1,"a":2}', encoding="utf-8")
            environment = {
                **os.environ,
                "MEM2ACT_SCHEMA_PATH": str(schema),
                "MEM2ACT_CALLS_PATH": str(calls),
            }

            described = subprocess.run(
                ["node", runtime, "describe"],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )
            subprocess.run(
                [
                    "node",
                    runtime,
                    "call",
                    "--arguments",
                    '{"z":1,"nested":{"b":2,"a":1}}',
                ],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )

            self.assertEqual(
                json.loads(described.stdout), {"a": 2, "name": "lookup", "z": 1}
            )
            self.assertEqual(
                json.loads(calls.read_text(encoding="utf-8")),
                {
                    "arguments": {"nested": {"a": 1, "b": 2}, "z": 1},
                    "tool": "lookup",
                },
            )
