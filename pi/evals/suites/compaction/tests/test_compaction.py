import json
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase


EVALS_DIR = Path(__file__).parents[3]
TASKS_DIR = EVALS_DIR / "suites/compaction/tasks"
VERIFIER = EVALS_DIR / "verifiers/compaction.mjs"
TASKS = {
    "debugging-continuity": [7],
    "decision-continuity": [7],
    "superseded-decisions": [4, 9],
}


def manifest(mode="on", mechanism="future-mechanism", protocol=None):
    return {
        "platform": "future-platform",
        "compaction_mode": mode,
        "expected_mechanism": mechanism,
        "expected_protocol": protocol,
    }


def attempt(segment, mechanism="future-mechanism", protocol=None, state="succeeded"):
    return {
        "source": "agent",
        "extra": {
            "event_type": "context_compaction",
            "compacted_after_segment": segment,
            "mechanism": mechanism,
            "protocol": protocol,
            "state": state,
        },
    }


def trajectory(policy, attempts=(), tail=None):
    return {
        "agent": {"name": "anything", "extra": {"pi_evals": policy}},
        "steps": [*attempts, {"source": "user", "message": "implement"}]
        + (tail if tail is not None else [{"source": "agent", "message": "done"}]),
    }


class CompactionTest(TestCase):
    def _validate(self, value, expected_segments=(7,)):
        result = subprocess.run(
            [
                "node",
                "--input-type=module",
                "--eval",
                f"import {{ validateCompaction }} from {json.dumps(str(VERIFIER))}; "
                "console.log(JSON.stringify(validateCompaction(JSON.parse(process.argv[1]), JSON.parse(process.argv[2]))));",
                json.dumps(value),
                json.dumps({"expectedSegments": expected_segments}),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)

    def _grade(self, task, value, replacements=()):
        grader_path = TASKS_DIR / task / "steps/implement/tests/grade.mjs"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for path in [root / "app", root / "logs/agent", root / "logs/verifier"]:
                path.mkdir(parents=True, exist_ok=True)
            task_dir = TASKS_DIR / task
            shutil.copytree(task_dir / "environment", root / "app", dirs_exist_ok=True)
            for implementation in (task_dir / "steps/implement/solution").glob("*.js"):
                target = root / "app/src" / implementation.name
                target.parent.mkdir(parents=True, exist_ok=True)
                source = implementation.read_text(encoding="utf-8")
                for original, replacement in replacements:
                    source = source.replace(original, replacement)
                target.write_text(source, encoding="utf-8")
            (root / "logs/agent/trajectory.json").write_text(json.dumps(value), encoding="utf-8")
            grader = grader_path.read_text(encoding="utf-8")
            for original, replacement in [
                ('"/app/', f'"{root}/app/'),
                ('"/logs/', f'"{root}/logs/'),
            ]:
                grader = grader.replace(original, replacement)
            (root / "grade.mjs").write_text(grader, encoding="utf-8")
            (root / "compaction.mjs").write_bytes((grader_path.parent / "compaction.mjs").read_bytes())
            subprocess.run(["node", root / "grade.mjs"], check=True, capture_output=True, text=True)
            return json.loads((root / "logs/verifier/reward.json").read_text(encoding="utf-8"))

    def test_manifest_accepts_future_platform_and_oracle(self):
        future = trajectory(manifest(protocol="future-protocol"), [attempt(7, protocol="future-protocol")])
        oracle = trajectory(
            {**manifest(mechanism="oracle"), "platform": "oracle"}, [attempt(7, "oracle")]
        )
        self.assertEqual(self._validate(future)["valid_experiment"], 1)
        self.assertEqual(self._validate(oracle)["valid_experiment"], 1)

    def test_validator_rejects_invalid_experiments(self):
        cases = [
            trajectory({}, [attempt(7)]),
            trajectory({**manifest(), "extra": True}, [attempt(7)]),
            trajectory(manifest(mechanism=""), [attempt(7)]),
            trajectory(manifest(mechanism=None), [attempt(7)]),
            trajectory(manifest(protocol="  "), [attempt(7, protocol="  ")]),
            trajectory(manifest(), [attempt(6)]),
            trajectory(manifest(), [attempt(7, state="failed")]),
            trajectory(manifest(), [attempt(7), attempt(7)]),
            trajectory(manifest(), [{**attempt(7), "source": "system"}]),
            trajectory(manifest(), [attempt(7, mechanism="wrong")]),
            trajectory(manifest(protocol="required"), [attempt(7)]),
            {
                "agent": {"name": "anything", "extra": {"pi_evals": manifest()}},
                "steps": [attempt(7), {"source": "agent", "message": "done"}],
            },
        ]
        for value in cases:
            with self.subTest(value=value):
                self.assertEqual(self._validate(value)["valid_experiment"], 0)

    def test_order_is_exact(self):
        value = trajectory(manifest(), [attempt(9), attempt(4)])
        self.assertEqual(self._validate(value, (4, 9))["valid_experiment"], 0)

    def test_mechanism_and_boundary_are_independent(self):
        reward = self._validate(trajectory(manifest(), [attempt(6)]))
        self.assertEqual(reward["mechanism_valid"], 1)
        self.assertEqual(reward["boundary_valid"], 0)

    def test_attempt_diagnostics_and_quality_outcome_are_independent(self):
        failed = self._validate(trajectory(manifest(), [attempt(7, state="failed")]))
        self.assertEqual(
            set(failed),
            {
                "agent_continuation",
                "agent_errors",
                "boundary_valid",
                "compaction_attempts",
                "compaction_failures",
                "compaction_successes",
                "instruction_delivered",
                "manifest_valid",
                "mechanism_valid",
                "outcome_valid",
                "valid_experiment",
            },
        )
        self.assertEqual(failed["compaction_attempts"], 1)
        self.assertEqual(failed["compaction_successes"], 0)
        self.assertEqual(failed["compaction_failures"], 1)
        self.assertEqual(failed["outcome_valid"], 0)

    def test_requires_clean_agent_continuation_after_final_user(self):
        continuations = {
            "text": [{"source": "agent", "message": "done"}],
            "tool-only": [{"source": "agent", "extra": {"event_type": "tool_call"}}],
        }
        for name, tail in continuations.items():
            with self.subTest(name=name):
                reward = self._validate(trajectory(manifest(), [attempt(7)], tail))
                self.assertEqual(reward["agent_continuation"], 1)
                self.assertEqual(reward["valid_experiment"], 1)

        missing = {
            "none": [],
            "error": [{"source": "agent", "extra": {"stop_reason": "error"}}],
            "aborted": [{"source": "agent", "extra": {"stop_reason": "aborted"}}],
            "compaction-only": [attempt(7)],
            "tool-then-error": [
                {"source": "agent", "extra": {"event_type": "tool_call"}},
                {"source": "agent", "extra": {"stop_reason": "error"}},
            ],
        }
        for name, tail in missing.items():
            with self.subTest(name=name):
                reward = self._validate(trajectory(manifest(), [attempt(7)], tail))
                self.assertEqual(reward["agent_continuation"], 0)
                self.assertEqual(reward["valid_experiment"], 0)

        earlier_error = trajectory(
            manifest(),
            [attempt(7), {"source": "agent", "extra": {"stop_reason": "error"}}],
        )
        reward = self._validate(earlier_error)
        self.assertEqual(reward["agent_errors"], 1)
        self.assertEqual(reward["agent_continuation"], 1)
        self.assertEqual(reward["valid_experiment"], 1)

    def test_off_requires_no_attempts(self):
        reward = self._validate(trajectory(manifest("off")), (7,))
        self.assertEqual(reward["valid_experiment"], 1)
        self.assertEqual(reward["mechanism_valid"], 1)
        self.assertEqual(reward["boundary_valid"], 1)
        self.assertEqual(reward["outcome_valid"], 1)
        self.assertEqual(
            self._validate(trajectory(manifest("off"), [attempt(7)]), (7,))["valid_experiment"], 0
        )

    def test_instruction_must_follow_on_treatment(self):
        value = trajectory(manifest(), tail=[attempt(7)])
        self.assertEqual(self._validate(value)["instruction_delivered"], 0)
        self.assertEqual(self._validate(value)["valid_experiment"], 0)

    def test_oracle_trajectories_are_valid(self):
        for task, segments in TASKS.items():
            with self.subTest(task=task):
                oracle = TASKS_DIR / task / "steps/implement/solution/trajectory.json"
                self.assertEqual(
                    self._validate(json.loads(oracle.read_text()), segments)["valid_experiment"], 1
                )

    def test_graders_use_identical_validator_and_never_gate_quality(self):
        source = VERIFIER.read_bytes()
        for task, segments in TASKS.items():
            with self.subTest(task=task):
                grader_dir = TASKS_DIR / task / "steps/implement/tests"
                self.assertEqual((grader_dir / "compaction.mjs").read_bytes(), source)
                reward = self._grade(task, trajectory(manifest(), [attempt(segment) for segment in segments]))
                self.assertEqual(reward["valid_experiment"], 1)
                self.assertEqual(reward["reward"], reward["quality"])
                self.assertEqual(reward["quality"], 1)
                self.assertEqual(reward["tests"], 1)
                self.assertTrue(all(isinstance(value, (int, float)) for value in reward.values()))

    def test_graders_weight_isolated_fault_once(self):
        value = trajectory(manifest(), [attempt(7)])
        decision = self._grade(
            "decision-continuity",
            value,
            [
                ("const artifacts = config.artifacts", "const artifacts = config.artifacts.slice(0, 1)")
            ],
        )
        self.assertEqual(
            [decision[fact] for fact in ["artifacts", "channel", "regions", "rollout", "output_contract"]],
            [0, 1, 1, 1, 1],
        )
        self.assertEqual(decision["quality"], 0.8)

        superseded_value = trajectory(manifest(), [attempt(4), attempt(9)])
        superseded = self._grade(
            "superseded-decisions",
            superseded_value,
            [("attempts > 5", "attempts >= 5")],
        )
        self.assertEqual(
            [
                superseded[fact]
                for fact in [
                    "attempts_current",
                    "regions_early",
                    "service_early",
                    "output_contract",
                    "target_current",
                ]
            ],
            [0, 1, 1, 1, 1],
        )
        self.assertEqual(superseded["quality"], 0.8)

    def test_graders_weight_interaction_only_fault_once(self):
        value = trajectory(manifest(), [attempt(7)])
        decision = self._grade(
            "decision-continuity",
            value,
            [
                (
                    "return { artifacts, channel, regions, rolloutPercent };",
                    "return { artifacts, channel, regions, "
                    "rolloutPercent: artifacts.length && regions.length ? 100 : rolloutPercent };",
                )
            ],
        )
        self.assertEqual(
            [
                decision[fact]
                for fact in ["artifacts", "channel", "regions", "rollout", "output_contract"]
            ],
            [1, 1, 1, 0, 1],
        )
        self.assertEqual(decision["quality"], 0.8)

        superseded_value = trajectory(manifest(), [attempt(4), attempt(9)])
        superseded = self._grade(
            "superseded-decisions",
            superseded_value,
            [
                (
                    "return { attempts, regions, service, target };",
                    'if (attempts === 5 && service === "worker" && target === "staging") '
                    "regions.pop();\n  return { attempts, regions, service, target };",
                )
            ],
        )
        self.assertEqual(
            [
                superseded[fact]
                for fact in [
                    "attempts_current",
                    "regions_early",
                    "service_early",
                    "output_contract",
                    "target_current",
                ]
            ],
            [1, 0, 1, 1, 1],
        )
        self.assertEqual(superseded["quality"], 0.8)

    def test_graders_map_combined_shape_to_output_contract(self):
        value = trajectory(manifest(), [attempt(7)])
        decision = self._grade(
            "decision-continuity",
            value,
            [
                (
                    "return { artifacts, channel, regions, rolloutPercent };",
                    "return { artifacts, channel, regions, rolloutPercent, "
                    "...(config.ignored && artifacts.length && regions.length "
                    "? { extra: true } : {}) };",
                )
            ],
        )
        self.assertEqual(
            [
                decision[fact]
                for fact in ["artifacts", "channel", "regions", "rollout", "output_contract"]
            ],
            [1, 1, 1, 1, 0],
        )
        self.assertEqual(decision["quality"], 0.8)

        superseded_value = trajectory(manifest(), [attempt(4), attempt(9)])
        superseded = self._grade(
            "superseded-decisions",
            superseded_value,
            [
                (
                    "return { attempts, regions, service, target };",
                    "return { attempts, regions, service, target, "
                    '...(config.ignored && attempts === 5 && service === "worker" '
                    '&& target === "staging" '
                    "? { extra: true } : {}) };",
                )
            ],
        )
        self.assertEqual(
            [
                superseded[fact]
                for fact in [
                    "attempts_current",
                    "regions_early",
                    "service_early",
                    "output_contract",
                    "target_current",
                ]
            ],
            [1, 1, 1, 0, 1],
        )
        self.assertEqual(superseded["quality"], 0.8)
