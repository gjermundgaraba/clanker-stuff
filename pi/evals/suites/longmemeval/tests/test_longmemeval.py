import copy
import hashlib
import json
import subprocess
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from harbor.models.task.task import Task

from suites.longmemeval.longmemeval import (
    _balanced_groups,
    download_sources,
    generate_tasks,
    history_chunks,
    history_instruction,
    prepare_history,
    query_instruction,
    select_records,
    tier_indices,
)
from pi_evals.protocol import CONTROLLED_COMPACTION_MARKER


class CharacterEncoder:
    def encode(self, value: str) -> list[str]:
        return list(value)


class PairEncoder:
    def encode(self, value: str) -> list[str]:
        return [value[index : index + 2] for index in range(0, len(value), 2)]


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
    def test_nonempty_destination_survives_invalid_generation(self) -> None:
        with TemporaryDirectory() as directory:
            output = Path(directory)
            prior = output / "existing-task"
            prior.mkdir()
            (prior / "instruction.md").write_text("keep me")
            source = record("question", "single-session-user")
            gold = copy.deepcopy(source)
            gold["answer"] = "mismatched"
            with self.assertRaisesRegex(ValueError, "output directory is not empty"):
                generate_tasks([source], [gold], [source["question_id"]], output, CharacterEncoder())
            self.assertEqual((prior / "instruction.md").read_text(), "keep me")
            self.assertEqual(list(output.iterdir()), [prior])

    def test_download_uses_manifest_pin(self) -> None:
        content = b"pinned source"
        checksum = hashlib.sha256(content).hexdigest()
        with (
            TemporaryDirectory() as directory,
            patch(
                "suites.longmemeval.longmemeval.urllib.request.urlopen",
                return_value=BytesIO(content),
            ) as urlopen,
        ):
            paths = download_sources(
                Path(directory),
                "https://example.test/dataset/",
                "revision",
                {"source.json": checksum},
            )
            downloaded = paths["source.json"].read_bytes()

        urlopen.assert_called_once_with(
            "https://example.test/dataset/resolve/revision/source.json"
        )
        self.assertEqual(downloaded, content)

    def test_download_rejects_source_paths_before_io(self) -> None:
        checksum = hashlib.sha256(b"pinned source").hexdigest()
        with TemporaryDirectory() as directory:
            root = Path(directory)
            victim = root / "victim.json"
            victim.write_text("untouched", encoding="utf-8")

            for filename in ("..", "../victim.json", str(victim.resolve())):
                with (
                    self.subTest(filename=filename),
                    patch(
                        "suites.longmemeval.longmemeval.urllib.request.urlopen"
                    ) as urlopen,
                ):
                    cache = root / "cache"
                    with self.assertRaisesRegex(ValueError, "must be a basename"):
                        download_sources(
                            cache,
                            "https://example.test/dataset",
                            "revision",
                            {"source.json": checksum, filename: checksum},
                        )

                    self.assertFalse(cache.exists())
                    self.assertEqual(victim.read_text(encoding="utf-8"), "untouched")
                    urlopen.assert_not_called()

    def test_download_does_not_follow_preexisting_temporary_symlink(self) -> None:
        content = b"pinned source"
        checksum = hashlib.sha256(content).hexdigest()
        with TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            cache.mkdir()
            victim = root / "victim.json"
            victim.write_text("untouched", encoding="utf-8")
            (cache / "source.json.part").symlink_to(victim)

            with patch(
                "suites.longmemeval.longmemeval.urllib.request.urlopen",
                return_value=BytesIO(content),
            ):
                source = download_sources(
                    cache,
                    "https://example.test/dataset",
                    "revision",
                    {"source.json": checksum},
                )["source.json"]

            self.assertEqual(victim.read_text(encoding="utf-8"), "untouched")
            self.assertEqual(source.read_bytes(), content)
            self.assertTrue(source.is_file())
            self.assertFalse(source.is_symlink())

    def test_download_replaces_cached_source_symlink(self) -> None:
        content = b"pinned source"
        checksum = hashlib.sha256(content).hexdigest()
        with TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / "cache"
            cache.mkdir()
            victim = root / "victim.json"
            victim.write_bytes(content)
            (cache / "source.json").symlink_to(victim)

            with patch(
                "suites.longmemeval.longmemeval.urllib.request.urlopen",
                return_value=BytesIO(content),
            ) as urlopen:
                source = download_sources(
                    cache,
                    "https://example.test/dataset",
                    "revision",
                    {"source.json": checksum},
                )["source.json"]

            urlopen.assert_called_once()
            self.assertEqual(victim.read_bytes(), content)
            self.assertEqual(source.read_bytes(), content)
            self.assertTrue(source.is_file())
            self.assertFalse(source.is_symlink())

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
            prepare_history(item, CharacterEncoder()),
            {1_000: 2, 2_000: 3},
        )

        small, large = map(set, tiers.values())
        self.assertLessEqual(small, large)
        self.assertIn(11, small)

    def test_history_uses_exact_balanced_session_chunks(self) -> None:
        item = record("q", "type")
        chunks = history_chunks(item, range(12), prepare_history(item, CharacterEncoder()), chunk_count=6)

        self.assertEqual(len(chunks), 6)
        self.assertTrue(all("HISTORY-RECORDED" in chunk for chunk in chunks))
        self.assertEqual(sum(chunk.count("### Prior chat") for chunk in chunks), 12)

    def test_tiers_use_joined_tokens_at_the_exact_budget(self) -> None:
        item = record("q", "type")
        for session in item["haystack_sessions"]:
            session[0]["content"] += "!"
        encoder = PairEncoder()
        sessions = prepare_history(item, encoder)
        self.assertLess(
            len(encoder.encode(sessions[0][0] + sessions[1][0])),
            sessions[0][1] + sessions[1][1],
        )

        tiers = tier_indices(item, ["evidence"], encoder, sessions, {381: 2, 382: 2})

        self.assertEqual(tiers, {381: (9, 11), 382: (6, 9, 11)})
        chunks = history_chunks(item, tiers[382], sessions, 2)
        self.assertEqual(
            sum(len(encoder.encode(chunk)) for chunk in chunks)
            + len(encoder.encode(query_instruction(item))),
            382,
        )
        with self.assertRaisesRegex(ValueError, "fewer sessions"):
            tier_indices(item, ["evidence"], encoder, sessions, {346: 2})

    def test_balanced_ties_choose_earlier_cut_and_preserve_index_order(self) -> None:
        item = record("q", "type")
        item["haystack_dates"] = ["2026-01-01"] * 12
        sessions = prepare_history(item, CharacterEncoder())

        self.assertEqual(
            _balanced_groups(item, reversed(range(5)), sessions, 2),
            ((0, 1), (2, 3, 4)),
        )

    def test_prepares_each_session_and_query_once_across_tiers(self) -> None:
        item = record("q", "type")
        encoder = PairEncoder()
        with patch.object(encoder, "encode", wraps=encoder.encode) as encode:
            sessions = prepare_history(item, encoder)
            tiers = tier_indices(
                item, ["evidence"], encoder, sessions, {380: 2, 600: 3}
            )
            for budget, indices in tiers.items():
                history_chunks(item, indices, sessions, {380: 2, 600: 3}[budget])
            encoded = [call.args[0] for call in encode.call_args_list]

        for text, _ in sessions:
            self.assertEqual(encoded.count(text), 1)
        self.assertEqual(encoded.count(query_instruction(item)), 1)

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
        self.assertIn("blue", history_instruction(item, [11], prepare_history(item, CharacterEncoder())).lower())

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

            valid = grade([5])
            self.assertEqual(valid["valid_experiment"], 1)
            self.assertEqual(valid["reward"], valid["quality"])
            self.assertNotIn("valid", valid)
            self.assertEqual(grade([4])["valid_experiment"], 0)
            self.assertEqual(grade([5, 5])["valid_experiment"], 0)
            off = grade([], "off")
            self.assertEqual(off["valid_experiment"], 1)
            failed = grade([5], agent_error=True)
            self.assertEqual(failed["valid_experiment"], 1)
            self.assertEqual(failed["agent_errors"], 1)
