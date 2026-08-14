import json
import re
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase


EVALS_DIR = Path(__file__).parents[1]
JOB_PATH = EVALS_DIR / "jobs/compaction-matrix.yaml"
LONGMEM_CONTROLLED_JOB_PATH = (
    EVALS_DIR / "jobs/longmemeval-64k-single-compaction.yaml"
)
LONGMEM_115K_JOB_PATH = EVALS_DIR / "jobs/longmemeval-115k-single-compaction.yaml"
GRADERS = {
    "debugging-continuity": [6],
    "decision-continuity": [6],
    "superseded-decisions": [3, 8],
}
POLICIES = {
    "codex-cli-off": (False, "codex-cli"),
    "codex-cli-on": (True, "codex-cli"),
    "pi-provider-off": (False, "codex-provider"),
    "pi-provider-on": (True, "codex-provider"),
    "pi-vanilla-off": (False, "pi-builtin"),
    "pi-vanilla-on": (True, "pi-builtin"),
}


class CompactionPolicyTest(TestCase):
    def _grade(
        self,
        dataset: str,
        label: str,
        compactions: list[dict[str, object]],
        *,
        continued: bool = True,
    ) -> dict[str, object]:
        grader_path = (
            EVALS_DIR
            / f"datasets/compaction/{dataset}/steps/implement/tests/grade.mjs"
        )
        with TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "app"
            tests = root / "tests"
            logs = root / "logs"
            paths = [
                app / "src",
                app / "test",
                tests,
                logs / "agent",
                logs / "verifier",
            ]
            for path in paths:
                path.mkdir(parents=True, exist_ok=True)
            (app / "package.json").write_text('{"type":"module"}\n', encoding="utf-8")
            (app / "test/release.test.js").write_text("", encoding="utf-8")
            (app / "test/route.test.js").write_text("", encoding="utf-8")
            (app / "test/deployment.test.js").write_text("", encoding="utf-8")
            (tests / "hidden.test.js").write_text("", encoding="utf-8")
            if dataset == "decision-continuity":
                solution = (
                    EVALS_DIR
                    / "datasets/compaction/decision-continuity/steps/implement/solution/release.js"
                ).read_text(encoding="utf-8")
                (app / "src/release.js").write_text(solution, encoding="utf-8")

            steps = [
                {"extra": extra, "source": "system"} for extra in compactions
            ]
            steps.append({"source": "user"})
            if continued:
                steps.append({"source": "agent"})
            (logs / "agent/trajectory.json").write_text(
                json.dumps({"agent": {"name": label}, "steps": steps}),
                encoding="utf-8",
            )
            grader = grader_path.read_text(encoding="utf-8")
            for original, replacement in [
                ('"/app/', f'"{app.as_posix()}/'),
                ('"/tests/', f'"{tests.as_posix()}/'),
                ('"/logs/', f'"{logs.as_posix()}/'),
            ]:
                grader = grader.replace(original, replacement)
            runnable = root / "grade.mjs"
            runnable.write_text(grader, encoding="utf-8")
            subprocess.run(
                ["node", runnable],
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(
                (logs / "verifier/reward.json").read_text(encoding="utf-8")
            )

    def test_job_has_six_matched_arms(self) -> None:
        job = JOB_PATH.read_text(encoding="utf-8")
        blocks = {
            label: block
            for block in job.split("\n  - import_path:")[1:]
            if (match := re.search(r"agent_label: (\S+)", block))
            for label in [match.group(1)]
        }
        self.assertEqual(set(blocks), set(POLICIES))
        for off, on in [
            ("pi-vanilla-off", "pi-vanilla-on"),
            ("pi-provider-off", "pi-provider-on"),
            ("codex-cli-off", "codex-cli-on"),
        ]:
            effort = "reasoning_effort" if off.startswith("codex") else "thinking"
            for field in ["model_name", "version", effort]:
                pattern = rf"{field}: (\S+)"
                self.assertEqual(
                    re.search(pattern, blocks[off]).group(1),
                    re.search(pattern, blocks[on]).group(1),
                )
        self.assertIn("/opt/codex-provider/index.ts", blocks["pi-provider-off"])
        self.assertIn("enabled: false", blocks["pi-provider-off"])
        self.assertIn(
            "model_auto_compact_token_limit: 1000000000", blocks["codex-cli-off"]
        )
        self.assertIn(
            "model_auto_compact_token_limit: 45000", blocks["codex-cli-on"]
        )

    def test_pressure_is_embedded_and_tool_neutral(self) -> None:
        prompts = list(
            (EVALS_DIR / "datasets/compaction").glob(
                "*/steps/pressure*/instruction.md"
            )
        )
        self.assertEqual(len(prompts), 12)
        for prompt in prompts:
            text = prompt.read_text(encoding="utf-8")
            with self.subTest(prompt=prompt):
                self.assertNotIn("shell tool", text)
                self.assertNotIn("seq -f", text)
                self.assertEqual(
                    sum(line.startswith("c") for line in text.splitlines()), 5000
                )

    def test_longmemeval_controlled_job_targets_one_64k_boundary(self) -> None:
        job = LONGMEM_CONTROLLED_JOB_PATH.read_text(encoding="utf-8")
        self.assertEqual(job.count("reserveTokens: 209000"), 2)
        self.assertEqual(job.count("model_auto_compact_token_limit: 75000"), 1)
        self.assertEqual(job.count("datasets-generated/longmemeval/64k"), 1)
        self.assertNotIn("datasets-generated/longmemeval/32k", job)
        self.assertNotIn("datasets-generated/longmemeval/115k", job)

    def test_longmemeval_115k_job_uses_its_calibrated_boundary(self) -> None:
        job = LONGMEM_115K_JOB_PATH.read_text(encoding="utf-8")
        self.assertEqual(job.count("reserveTokens: 168800"), 2)
        self.assertEqual(job.count("model_auto_compact_token_limit: 115900"), 1)
        self.assertEqual(job.count("datasets-generated/longmemeval/115k"), 1)

    def test_all_graders_accept_each_arm_policy(self) -> None:
        for dataset, segments in GRADERS.items():
            for label, (expected, mechanism) in POLICIES.items():
                with self.subTest(dataset=dataset, label=label):
                    events = []
                    if expected:
                        events = [
                            {
                                "event_type": "context_compaction",
                                "mechanism": mechanism,
                                "protocol": (
                                    "openai-responses-compaction-v2"
                                    if mechanism == "codex-provider"
                                    else None
                                ),
                                "segment": segment,
                                "state": "succeeded",
                            }
                            for segment in segments
                        ]
                    reward = self._grade(dataset, label, events)
                    self.assertEqual(reward["valid_experiment"], 1)
                    self.assertEqual(reward["continuation"], 1)
                    self.assertEqual(reward["mechanism"], 1)
                    self.assertEqual(
                        reward.get(
                            "compaction_boundary",
                            reward.get("compaction_boundaries"),
                        ),
                        int(expected),
                    )
                    if dataset == "decision-continuity":
                        self.assertEqual(reward["reward"], reward["quality"])

    def test_invalid_attempts_do_not_pass_vacuously(self) -> None:
        agent_step_only = self._grade("decision-continuity", "pi-vanilla-on", [])
        self.assertEqual(agent_step_only["mechanism"], 0)
        self.assertEqual(agent_step_only["valid_experiment"], 0)

        attempted_off = self._grade(
            "decision-continuity",
            "pi-vanilla-off",
            [
                {
                    "event_type": "context_compaction",
                    "mechanism": "pi-builtin",
                    "segment": 6,
                    "state": "succeeded",
                }
            ],
        )
        self.assertEqual(attempted_off["valid_experiment"], 0)

        failed_attempt = self._grade(
            "decision-continuity",
            "pi-vanilla-on",
            [
                {
                    "event_type": "context_compaction",
                    "mechanism": "pi-builtin",
                    "segment": 5,
                    "state": "failed",
                },
                {
                    "event_type": "context_compaction",
                    "mechanism": "pi-builtin",
                    "segment": 6,
                    "state": "succeeded",
                },
            ],
        )
        self.assertEqual(failed_attempt["valid_experiment"], 0)

        bad_protocol = self._grade(
            "decision-continuity",
            "pi-provider-on",
            [
                {
                    "event_type": "context_compaction",
                    "mechanism": "codex-provider",
                    "segment": 6,
                    "state": "succeeded",
                }
            ],
        )
        self.assertEqual(bad_protocol["mechanism"], 0)
        self.assertEqual(bad_protocol["valid_experiment"], 0)

        no_continuation = self._grade(
            "decision-continuity", "codex-cli-off", [], continued=False
        )
        self.assertEqual(no_continuation["valid_experiment"], 0)

    def test_oracle_behavior_remains_valid(self) -> None:
        for dataset, segments in GRADERS.items():
            with self.subTest(dataset=dataset):
                events = [
                    {
                        "event_type": "context_compaction",
                        "mechanism": "oracle",
                        "segment": segment,
                        "state": "succeeded",
                    }
                    for segment in segments
                ]
                reward = self._grade(dataset, "oracle", events)
                self.assertEqual(reward["valid_experiment"], 1)
