import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from pi_evals.jsonl import read_jsonl_objects


class JsonlTest(TestCase):
    def test_keeps_unicode_separators_and_skips_only_empty_lines(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            record = {"text": "a\u2028b\u2029c"}
            path.write_text("\n" + json.dumps(record, ensure_ascii=False) + "\n\n{}\n", encoding="utf-8")
            self.assertEqual(read_jsonl_objects(path), [record, {}])

    def test_reports_physical_line_and_rejects_nonobjects(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            for invalid, message in [("{", "invalid JSON"), (" ", "invalid JSON"), ("[]", "expected an object"), ("null", "expected an object")]:
                with self.subTest(invalid=invalid):
                    path.write_text("{}\n\n" + invalid, encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, f":3: {message}"):
                        read_jsonl_objects(path)

    def test_leaves_missing_file_policy_to_the_caller(self) -> None:
        with TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                read_jsonl_objects(Path(directory) / "missing.jsonl")
