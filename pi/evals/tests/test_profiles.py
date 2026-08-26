import asyncio
import unittest
from copy import deepcopy
from pathlib import Path
from re import search
from uuid import uuid4

import yaml
from harbor.job_plan import JobPlan
from harbor.models.job.config import JobConfig
from pi_evals.protocol import validate_manifest


EVALS = Path(__file__).parents[1]
PROFILES = EVALS / "profiles"
SMOKE_TASKS = EVALS / "suites" / "smoke" / "tasks" / "coding"
MODEL = "gpt-5.6-terra"
CODEX_THRESHOLD = 1_000_000_000


def without_mode(agent: dict) -> dict:
    value = deepcopy(agent)
    value["kwargs"]["pi_evals"]["compaction_mode"] = "controlled"
    return value


class ProfileTest(unittest.TestCase):
    def load(self, name: str):
        raw = yaml.safe_load((PROFILES / f"{name}.yaml").read_text())
        return raw, JobConfig.model_validate(raw).model_dump(
            mode="json", exclude_defaults=True
        )

    def assert_controls(self, agent: dict, manifest: dict):
        kwargs = agent["kwargs"]
        self.assertEqual(agent["model_name"].rsplit("/", 1)[-1], MODEL)

        if agent["import_path"] == "pi_evals.adapters.pi:PiEval":
            self.assertEqual(kwargs["thinking"], "medium")
            self.assertEqual(kwargs["settings"], {"compaction": {"enabled": False}})
            if kwargs.get("extensions"):
                self.assertEqual(kwargs["extensions"], ["/opt/codex-provider/index.ts"])
                self.assertEqual(
                    (
                        manifest["platform"],
                        manifest["expected_mechanism"],
                        manifest["expected_protocol"],
                    ),
                    (
                        "pi-provider",
                        "codex-provider",
                        "openai-responses-compaction-v2",
                    ),
                )
            else:
                self.assertEqual(
                    (
                        manifest["platform"],
                        manifest["expected_mechanism"],
                        manifest["expected_protocol"],
                    ),
                    ("pi-vanilla", "pi-builtin", None),
                )
            return

        if agent["import_path"] == "pi_evals.adapters.codex:CodexEval":
            self.assertEqual(kwargs["reasoning_effort"], "medium")
            self.assertEqual(
                kwargs["config"],
                {
                    "model_auto_compact_token_limit": CODEX_THRESHOLD,
                    "model_auto_compact_token_limit_scope": "body_after_prefix",
                },
            )
            self.assertEqual(
                (
                    manifest["platform"],
                    manifest["expected_mechanism"],
                    manifest["expected_protocol"],
                ),
                ("codex-native", "codex-native", None),
            )
            dockerfile = (EVALS / "runtime" / "Dockerfile").read_text()
            pinned = search(r"@openai/codex@(\d+\.\d+\.\d+)", dockerfile)
            self.assertIsNotNone(pinned)
            self.assertEqual(kwargs["version"], pinned.group(1))

    def resolve_profile_tasks(self, raw: dict):
        value = deepcopy(raw)
        value["datasets"] = [{"path": str(SMOKE_TASKS)}]
        config = JobConfig.model_validate(value)
        tasks = asyncio.run(JobPlan.resolve_task_configs(config))
        trials = JobPlan.build_trial_configs(config, tasks, job_id=uuid4())
        return tasks, trials

    def test_profiles_are_paired_and_self_consistent(self):
        profiles = {
            name: self.load(name) for name in ("paired", "off-only", "on-only")
        }
        arms = {}
        for name, (raw, resolved) in profiles.items():
            text = (PROFILES / f"{name}.yaml").read_text()
            self.assertEqual(raw["n_concurrent_trials"], len(raw["agents"]))
            self.assertEqual(raw["n_attempts"], 3)
            self.assertFalse(raw["quiet"])
            self.assertEqual(raw["environment"], {"type": "docker", "delete": True})
            self.assertNotIn("datasets", raw)
            self.assertNotIn("orchestrator", raw)
            for legacy in (
                "agent_label",
                "controlled_compaction",
                "include",
                "generator",
                "<<:",
            ):
                self.assertNotIn(legacy, text)
            self.assertEqual(resolved["agents"], raw["agents"])
            current = {}
            for agent in raw["agents"]:
                kwargs = agent["kwargs"]
                self.assertNotIn("agent_label", kwargs)
                self.assertNotIn("controlled_compaction", kwargs)
                self.assertEqual(
                    set(kwargs["pi_evals"]),
                    {
                        "platform",
                        "compaction_mode",
                        "expected_mechanism",
                        "expected_protocol",
                    },
                )
                manifest = validate_manifest(kwargs["pi_evals"])
                key = (manifest["platform"], manifest["compaction_mode"])
                self.assertNotIn(key, current)
                current[key] = agent
                self.assertTrue(agent["resume_trajectory"])
                self.assert_controls(agent, manifest)
            arms[name] = current

        platforms = {platform for platform, _ in arms["off-only"]}
        self.assertTrue(platforms)
        self.assertEqual(platforms, {platform for platform, _ in arms["on-only"]})
        self.assertEqual(
            set(arms["paired"]),
            {(platform, mode) for platform in platforms for mode in ("off", "on")},
        )
        for platform in platforms:
            off, on = (platform, "off"), (platform, "on")
            self.assertEqual(arms["off-only"][off], arms["paired"][off])
            self.assertEqual(arms["on-only"][on], arms["paired"][on])
            self.assertEqual(
                without_mode(arms["paired"][off]),
                without_mode(arms["paired"][on]),
            )

    def test_profiles_resolve_a_real_task(self):
        for name in ("paired", "off-only", "on-only"):
            raw, _ = self.load(name)
            with self.subTest(profile=name):
                tasks, trials = self.resolve_profile_tasks(raw)
                self.assertEqual([task.path.name for task in tasks], ["inventory-ledger"])
                self.assertEqual(len(trials), len(raw["agents"]) * raw["n_attempts"])

    def test_nonexistent_task_path_fails_discovery(self):
        raw, _ = self.load("paired")
        raw["datasets"] = [{"path": str(EVALS / "does-not-exist")}]
        config = JobConfig.model_validate(raw)
        with self.assertRaises(FileNotFoundError):
            asyncio.run(JobPlan.resolve_task_configs(config))

    def test_legacy_layout_is_absent(self):
        self.assertFalse((EVALS / "jobs").exists())
        self.assertFalse((EVALS / "datasets" / "coding").exists())
        self.assertFalse((EVALS / "datasets" / "tool-use").exists())
        smoke = yaml.safe_load(
            (EVALS / "suites" / "smoke" / "job.yaml").read_text()
        )
        manifest = {
            "platform": "oracle",
            "compaction_mode": "off",
            "expected_mechanism": "oracle",
            "expected_protocol": None,
        }
        self.assertEqual(
            smoke["agents"], [{"name": "oracle", "kwargs": {"pi_evals": manifest}}]
        )
        trajectory = yaml.safe_load(
            (
                EVALS
                / "suites/smoke/tasks/tool-use/read-write/solution/trajectory.json"
            ).read_text()
        )
        self.assertEqual(trajectory["agent"]["extra"]["pi_evals"], manifest)


if __name__ == "__main__":
    unittest.main()
