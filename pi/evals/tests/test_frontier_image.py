"""Opt-in Docker smoke: generated Frontier runtime copies, no network or inference."""
import os
import subprocess
from unittest import TestCase, skipUnless

from pi_evals.frontier import agent_dockerfile


@skipUnless(os.environ.get("PI_EVAL_DOCKER_SMOKE") == "1", "requires built runtime image and Docker")
class FrontierImageTest(TestCase):
    def test_generated_runtime_copies_exist(self):
        image = os.environ.get("PI_EVAL_RUNTIME_IMAGE", "clanker-pi-evals:node26")
        recipe = agent_dockerfile(image, "scratch", "0.0.0", 60)
        copies = [line for line in recipe.splitlines() if line.startswith("COPY --from=runtime ")]
        self.assertTrue(copies)
        built = subprocess.run(
            ["docker", "build", "--network", "none", "-"],
            input=f"FROM {image} AS runtime\nFROM scratch\n" + "\n".join(copies) + "\n",
            text=True, capture_output=True, timeout=120,
        )
        self.assertEqual(built.returncode, 0, built.stderr)
