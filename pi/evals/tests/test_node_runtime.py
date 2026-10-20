import subprocess
from pathlib import Path
from unittest import TestCase


class NodeRuntimeTests(TestCase):
    def test_node_runtime_tests_pass(self) -> None:
        """Vitest runs only `.test.ts` files, so the eval Node tests run here."""
        result = subprocess.run(
            ["node", "--test", "tests/*.test.mjs"],
            check=False,
            cwd=Path(__file__).parents[1],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
