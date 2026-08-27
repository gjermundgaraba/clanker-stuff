from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from harbor.models.task.task import Task

SUITE_DIR = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("mem2act", SUITE_DIR / "mem2act.py")
assert SPEC and SPEC.loader
mem2act = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mem2act)

read_jsonl = mem2act.read_jsonl
resolve_records = mem2act.resolve_records
stratified_sample = mem2act.stratified_sample
write_tasks = mem2act.write_tasks


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
            self.assertIn("./mem2act describe", instruction)
            self.assertEqual(schema, qa("qa-one", "L1")["target_tool_schema"])
            self.assertNotIn("PRIVATE_GROUNDING", instruction)
            self.assertNotIn("PRIVATE_EVOLUTION", instruction)
            self.assertNotIn('"count":3', instruction)
            grader = (task / "tests" / "grade.mjs").read_text(encoding="utf-8")
            self.assertIn('\\"count\\":3', grader)
            self.assertIn("quality", grader)
            self.assertIn("valid_experiment", grader)
            self.assertNotIn("PRIVATE_GROUNDING", grader)
            self.assertNotIn("PRIVATE_EVOLUTION", grader)
            runtime = task / "environment" / "mem2act"
            self.assertTrue(runtime.is_file())
            self.assertTrue(os.access(runtime, os.X_OK))
            self.assertTrue(Task.is_valid_dir(task))
            self.assertEqual(Task(task).name, "pi-evals/mem2act-qa-one")

    def test_refuses_nonempty_generated_directory(self) -> None:
        with TemporaryDirectory() as directory:
            output = Path(directory) / "generated"
            output.mkdir()
            (output / ".gitignore").write_text("*\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "output directory is not empty"):
                write_tasks([(qa("qa-one", "L1"), session("session-one"))], output)

    def test_generated_grader_scores_json_semantics_and_rejects_bad_calls(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "tasks"
            record = qa("qa-one", "L1")
            gold = {
                "float": 175.0,
                "a/b": 1,
                "a~1b": 2,
                "flag": True,
                "empty_object": {},
                "empty_array": [],
                "shared": "yes",
                "__proto__": "top-level",
                "nested": {"__proto__": "nested"},
            }
            record["tool_call"]["arguments"] = gold
            write_tasks([(record, session("session-one"))], output)
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
            exact = json.dumps(
                {"arguments": {**gold, "float": 175}, "tool": "secret.tool"}
            )
            partial = json.dumps(
                {
                    "arguments": {
                        "float": 175,
                        "a": {"b": 1},
                        "a/b": 2,
                        "flag": 1,
                        "empty_object": {},
                        "empty_array": [],
                        "shared": "yes",
                    },
                    "tool": "secret.tool",
                }
            )
            # Only the float, empty containers, and shared string overlap. Escaped
            # keys do not collide with nested paths, and booleans differ from numbers.
            for contents, exact_score, f1_score in (
                (f"{exact}\n", 1, 1),
                (f"{partial}\n", 0, 1 / 2),
                (f"{exact}\n{exact}\n", 0, 0),
                ("not-json\n", 0, 0),
            ):
                calls.write_text(contents, encoding="utf-8")
                subprocess.run(["node", grader], check=True)
                score = json.loads(reward.read_text(encoding="utf-8"))
                self.assertEqual(
                    set(score), {"parameter_f1", "quality", "reward", "valid_experiment"}
                )
                self.assertEqual(score["quality"], exact_score)
                self.assertEqual(score["reward"], score["quality"])
                self.assertEqual(score["valid_experiment"], 1)
                self.assertAlmostEqual(score["parameter_f1"], f1_score)

    def test_runtime_describes_schema_and_appends_call(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "tasks"
            write_tasks([(qa("qa-one", "L1"), session("session-one"))], output)
            runtime = output / "qa-one" / "environment" / "mem2act"
            schema = root / "schema.json"
            calls = root / "calls.jsonl"
            schema.write_text('{"name":"lookup","z":1,"a":2}', encoding="utf-8")
            environment = {
                **os.environ,
                "MEM2ACT_SCHEMA_PATH": str(schema),
                "MEM2ACT_CALLS_PATH": str(calls),
            }

            described = subprocess.run(
                [runtime, "describe"],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )
            subprocess.run(
                [
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
            invalid_grammar = subprocess.run(
                [runtime, "call", "--arguments", "{}", "unexpected"],
                capture_output=True,
                text=True,
                env=environment,
            )
            self.assertEqual(invalid_grammar.returncode, 2)
            self.assertIn("usage: mem2act describe | mem2act call --arguments JSON", invalid_grammar.stderr)

            for arguments, message in (
                (
                    ["call", "--arguments", "not-json"],
                    "--arguments must be valid JSON",
                ),
                (["call", "--arguments", "[]"], "--arguments must be a JSON object"),
            ):
                failed = subprocess.run(
                    [runtime, *arguments],
                    capture_output=True,
                    text=True,
                    env=environment,
                )
                self.assertEqual(failed.returncode, 2)
                self.assertIn(message, failed.stderr)

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
