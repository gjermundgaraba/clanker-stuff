"""Execute generated programs, including all three runtime validity boundaries."""

from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase
from pi_evals.artifacts import EVALS
from pi_evals import scaling


class ServiceGenerationTest(TestCase):
    def test_generated_grader_definitions_serialized_solution_and_budget(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            tasks = [
                scaling.generate_task(root, size, "behavioral-test", 1)
                for size in scaling.SIZES
            ]
            for task in tasks:
                with self.subTest(task=task.name):
                    logs = root / "logs" / task.name
                    logs.mkdir(parents=True)
                    result = subprocess.run(
                        [
                            "node",
                            str(EVALS / "tests/fixtures/service-task-controls.mjs"),
                            str(task),
                            str(EVALS / "runtime"),
                            str(logs),
                        ],
                        text=True,
                        capture_output=True,
                        timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
