import asyncio
import json
from harbor.job_plan import JobPlan
from harbor.models.job.config import JobConfig
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
import yaml
from pi_evals.scaling import build_image, generate_task, prepare, verify, run, SIZES
from pi_evals.runtime import ARMS
from pi_evals.scaling_report import report


class ScalingTest(TestCase):
    def test_new_seeded_fixtures_reference_and_nested_prefixes(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            datasets = {}
            for i, (size, count) in enumerate(SIZES.items()):
                task = generate_task(root, size, "test-seed", 1)
                code = f"""
                  import {{fixture,createServices,SETTINGS}} from {json.dumps((task / "environment/services.mjs").as_uri())};
                  import {{solve}} from {json.dumps((task / "solution/solve.mjs").as_uri())};
                  const events=[];const backend=createServices({{latencyMs:0,emit:e=>events.push(e)}});
                  const answer=await solve(backend.call);
                  console.log(JSON.stringify({{data:fixture().ledger,answer,events,settings:SETTINGS}}));
                """
                result = json.loads(
                    subprocess.check_output(
                        ["node", "--input-type=module", "-e", code], text=True
                    )
                )
                datasets[size] = result["data"]
                self.assertEqual(len(result["data"]), count)
                self.assertEqual(
                    sum(e["type"] == "pi_eval_service_start" for e in result["events"]),
                    count // 20 + 1,
                )
                totals = {f"tenant-{n}": 0 for n in range(7)}
                for r in result["data"]:
                    if (
                        r["status"] == "posted"
                        and r["currency"] == "USD"
                        and 8 <= r["day"] <= 24
                    ):
                        totals[r["tenant"]] += r["amount_cents"] - r["refund_cents"]
                self.assertEqual(
                    result["answer"],
                    {
                        "rows": [
                            {"tenant": k, "net_cents": v}
                            for k, v in sorted(totals.items())
                        ],
                        "total_cents": sum(totals.values()),
                    },
                )
                self.assertIn(
                    f"budget of {count // 20 + 2} total",
                    (task / "instruction.md").read_text(),
                )
                self.assertEqual(
                    json.loads((task / "tests/native-preflight.json").read_text()),
                    {"max_concurrency": 1, "underlying_operations": count // 20 + 1},
                )
            self.assertEqual(datasets["small"], datasets["large"][:40])
            self.assertEqual(datasets["medium"], datasets["large"][:240])
            second = generate_task(root, "small", "different-seed", 2)
            data = json.loads(
                subprocess.check_output(
                    [
                        "node",
                        "--input-type=module",
                        "-e",
                        f"import {{fixture}} from {json.dumps((second / 'environment/services.mjs').as_uri())};console.log(JSON.stringify(fixture().ledger));",
                    ],
                    text=True,
                )
            )
            self.assertNotEqual(data, datasets["small"])

    def test_service_image_replaces_base_runner_symlink_explicitly(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            task = generate_task(root, "small", "test-seed", 1)
            with (
                patch("pi_evals.scaling.docker") as build,
                patch("pi_evals.scaling.image_info", return_value={"image_id": "sha256:test"}),
                patch("pi_evals.scaling.pin_tag", return_value="test:immutable"),
            ):
                image = build_image(root, task, "0.154.0", "base:immutable")
            self.assertEqual(image, "sha256:test")
            build.assert_called_once_with(
                "build", "--platform", "linux/amd64", "-t",
                f"clanker-pi-evals:{task.name}", root / "build" / task.name,
            )
            recipe = (root / "build" / task.name / "Dockerfile").read_text()
            self.assertIn("COPY codex-eval.mjs /opt/codex-provider/codex-runner.mjs", recipe)
            self.assertIn("COPY service-codex.mjs /opt/codex-provider/service-codex.mjs", recipe)
            self.assertIn(
                "ln -sfn /opt/codex-provider/service-codex.mjs /usr/local/bin/codex-eval",
                recipe,
            )
            self.assertNotIn("COPY service-codex.mjs /usr/local/bin/codex-eval", recipe)
            self.assertEqual((task / "environment/Dockerfile").read_text(), "FROM test:immutable\n")

    def test_18_runs_latest_release_full_order_balance_and_freeze(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "models.json"
            catalog.write_text("{}")
            output = root / "series"
            with (
                patch(
                    "pi_evals.scaling.subprocess.check_output",
                    side_effect=["0.154.0\n", "rust-v0.154.0\n"],
                ) as resolve,
                patch("pi_evals.scaling.docker"),
                patch(
                    "pi_evals.scaling.image_info",
                    return_value={"image_id": "sha256:base"},
                ),
                patch("pi_evals.scaling.pin_tag", return_value="base:immutable"),
                patch(
                    "pi_evals.scaling.secrets.token_hex",
                    side_effect=["new-seed-1", "new-seed-2"],
                ),
            ):
                prepare(output, catalog)
            self.assertEqual(
                resolve.call_args_list[0].args[0],
                ["npm", "view", "@openai/codex", "version"],
            )
            verify(output)
            schedule = json.loads((output / "schedule.json").read_text())
            self.assertEqual(len(schedule), 18)
            orders = [
                tuple(r["arm"] for r in schedule[i : i + 3]) for i in range(0, 18, 3)
            ]
            self.assertEqual(len(set(orders)), 6)
            for arm in ARMS:
                for position in range(3):
                    self.assertEqual(sum(order[position] == arm for order in orders), 2)
            for entry in schedule:
                config = yaml.safe_load(Path(entry["config"]).read_text())
                tasks = asyncio.run(
                    JobPlan.resolve_task_configs(JobConfig.model_validate(config))
                )
                self.assertEqual([task.path.name for task in tasks], [entry["task"]])
                self.assertEqual(config["n_attempts"], 1)
                self.assertEqual(config["retry"]["max_retries"], 0)
                if entry["arm"] == "native":
                    self.assertEqual(
                        config["agents"][0]["kwargs"]["version"], "0.154.0"
                    )
                else:
                    self.assertEqual(
                        config["agents"][0]["kwargs"]["pi_evals"]["tool_mode"],
                        "direct" if entry["arm"] == "pi-direct" else "code_mode_only",
                    )
            result = report(output)
            self.assertEqual(len(result["rows"]), 18)
            self.assertEqual(len(result["groups"]), 9)
            self.assertTrue(
                all(
                    g["scheduled"] == 2
                    and g["correct_valid"] == 0
                    and g["agent_seconds"] is None
                    for g in result["groups"]
                )
            )
            with self.assertRaises(FileNotFoundError):
                run(output)
            Path(schedule[0]["config"]).write_text("changed")
            with self.assertRaisesRegex(ValueError, "frozen artifact changed"):
                verify(output)
