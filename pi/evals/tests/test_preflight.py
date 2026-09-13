"""A failed free control is retryable without changing inputs or model attempts."""

import json
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from pi_evals import frontier, scaling
from pi_evals.artifacts import EVALS, write_json


class PreflightTest(TestCase):
    def test_both_clis_retry_failed_controls_preserving_logs_and_cache_success(self):
        for driver in (frontier, scaling):
            with (
                self.subTest(driver=driver.__name__),
                TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                frozen = {"identity": "same"}
                calls = []

                def check(output, logs):
                    calls.append(logs)
                    (logs / "control.log").write_text(f"attempt {len(calls)}")
                    if len(calls) == 1:
                        raise RuntimeError("transient Docker failure")

                with (
                    patch.object(driver, "verify", return_value=frozen),
                    patch.object(driver, "_preflight", side_effect=check),
                    patch("sys.argv", ["eval", "preflight", "--output", str(root)]),
                ):
                    with self.assertRaisesRegex(RuntimeError, "Docker"):
                        driver.main()
                    self.assertFalse((root / "preflight-passed.json").exists())
                    first = {p.name: p.read_bytes() for p in calls[0].iterdir()}
                    driver.main()
                    driver.main()
                self.assertEqual(len(calls), 2)
                self.assertEqual(
                    [p.name for p in calls], ["attempt-0001", "attempt-0002"]
                )
                self.assertEqual(
                    {p.name: p.read_bytes() for p in calls[0].iterdir()}, first
                )
                self.assertEqual(
                    json.loads((calls[1] / "inputs.json").read_text()), frozen
                )
                self.assertEqual(
                    json.loads((calls[1] / "status.json").read_text()),
                    {"state": "succeeded"},
                )
                self.assertEqual(
                    json.loads((root / "preflight-passed.json").read_text()), frozen
                )
                self.assertFalse((root / "jobs").exists())
                self.assertFalse((root / "started").exists())
                with (
                    patch.object(
                        driver, "verify", side_effect=ValueError("changed inputs")
                    ),
                    self.assertRaisesRegex(ValueError, "changed"),
                ):
                    driver.preflight(root)

    def test_scaling_freeze_ignores_unrelated_and_presentation_sources(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "evals"
            for tree, files in scaling.source_hashes().items():
                for name in files:
                    target = source / tree / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(EVALS / tree / name, target)
            output = root / "series"
            output.mkdir()
            presentation = ("frontier_report.py", "scaling_report.py", "report.py")
            for name in presentation:
                shutil.copyfile(
                    EVALS / "src/pi_evals" / name, source / "src/pi_evals" / name
                )
            with (
                patch.object(scaling, "EVALS", source),
                patch.object(scaling, "ASSETS", source / "suites/scaling"),
            ):
                frozen = {"source_hashes": scaling.source_hashes(), "config_hashes": {}}
                write_json(output / "frozen.json", frozen)
                for name in (*presentation, "adapters/unrelated.py"):
                    target = source / "src/pi_evals" / name
                    if name == "report.py":
                        before = target.read_text()
                        after = before.replace("Matched-arm mean deltas", "Mean deltas")
                        self.assertNotEqual(before, after)
                        target.write_text(after)
                    else:
                        with target.open("a") as file:
                            file.write("\n# analysis-only edit\n")
                    with self.subTest(analysis=name):
                        self.assertEqual(scaling.verify(output), frozen)
                for name in (
                    "scaling.py",
                    "scaling_state.py",
                    "preflight.py",
                    "trials.py",
                    "adapters/services.py",
                ):
                    target = source / "src/pi_evals" / name
                    before = target.read_bytes()
                    target.write_bytes(before + b"\n# execution policy changed\n")
                    with (
                        self.subTest(name=name),
                        self.assertRaisesRegex(ValueError, "frozen source"),
                    ):
                        scaling.verify(output)
                    target.write_bytes(before)
