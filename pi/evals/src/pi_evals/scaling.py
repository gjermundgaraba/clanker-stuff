"""Three sizes, two new matched seeds and all three harness arms (18 trials)."""

from __future__ import annotations
import argparse
from copy import deepcopy
import hashlib
from itertools import permutations
import json
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import yaml
from harbor.models.job.config import JobConfig
from string import Template
from pi_evals.runtime import ARMS, docker, image_info, pin_tag
from pi_evals.scaling_state import read_slot
from pi_evals import scaling_report
from pi_evals.preflight import run_preflight
from pi_evals.artifacts import EVALS, task_hashes, write_json
from pi_evals.trials import require_terminal_result

ASSETS = EVALS / "suites/scaling"
SIZES = {"small": 40, "medium": 240, "large": 960}


def generate_task(output: Path, size: str, seed: str, replicate: int) -> Path:
    settings = {
        "seed": seed,
        "count": SIZES[size],
        "page_size": 20,
        "budget": SIZES[size] // 20 + 2,
        "concurrency_limit": 1,
        "latency_ms": 150,
    }
    task = output / "tasks" / f"ledger-{size}-{replicate}"
    for directory in ("environment", "tests", "solution"):
        (task / directory).mkdir(parents=True)
    write_json(task / "environment/case.json", settings)
    for filename in ("services.mjs", "pi-eval-tools.mjs"):
        shutil.copy(ASSETS / filename, task / "environment")
    for filename in (
        "scoring.mjs",
        "service-metrics.mjs",
        "grade.mjs",
        "validity.mjs",
        "tool-mode.mjs",
        "preflight.mjs",
        "native-preflight.mjs",
        "controls.mjs",
        "test.sh",
    ):
        shutil.copy(ASSETS / filename, task / "tests")
    shutil.copy(EVALS / "verifiers/tool-mode.mjs", task / "tests/tool-mode-core.mjs")
    shutil.copy(EVALS / "verifiers/native-astra.mjs", task / "tests")
    shutil.copy(ASSETS / "solve.mjs", task / "solution")
    write_json(
        task / "tests/native-preflight.json",
        {"max_concurrency": 1, "underlying_operations": SIZES[size] // 20 + 1},
    )
    (task / "instruction.md").write_text(
        Template((ASSETS / "instruction.md.template").read_text()).substitute(settings)
    )
    return task


def build_image(output: Path, task: Path, version: str, base: str) -> str:
    context = output / "build" / task.name
    context.mkdir(parents=True)
    shutil.copytree(task / "environment", context / "environment")
    shutil.copy(EVALS / "runtime/service-codex.mjs", context)
    shutil.copy(EVALS / "runtime/codex-eval.mjs", context)
    (context / "Dockerfile").write_text(f"""FROM {base}
RUN npm install --global --ignore-scripts "@openai/codex@{version}" && test "$(codex --version)" = "codex-cli {version}"
COPY codex-eval.mjs /opt/codex-provider/codex-runner.mjs
COPY service-codex.mjs /usr/local/bin/codex-eval
COPY environment/ /opt/codex-provider/
RUN chmod 755 /usr/local/bin/codex-eval
WORKDIR /app
""")
    tag = f"clanker-pi-evals:{task.name}"
    docker("build", "--platform", "linux/amd64", "-t", tag, context)
    image = image_info(tag)["image_id"]
    immutable_tag = pin_tag(image)
    (task / "environment/Dockerfile").write_text(f"FROM {immutable_tag}\n")
    (task / "task.toml").write_text(
        Template((ASSETS / "task.toml.template").read_text()).substitute(
            task_name=task.name, image=immutable_tag
        )
    )
    return image


def source_hashes():
    selected = {
        "src": (
            "pi_evals/scaling.py",
            "pi_evals/scaling_state.py",
            "pi_evals/trials.py",
            "pi_evals/runtime.py",
            "pi_evals/artifacts.py",
            "pi_evals/preflight.py",
            "pi_evals/adapters/pi.py",
            "pi_evals/adapters/codex.py",
            "pi_evals/adapters/services.py",
            "pi_evals/adapters/auth.py",
            "pi_evals/protocol.py",
        ),
        "runtime": (
            "Dockerfile",
            "pi-eval-tools.mjs",
            "eval-journal.mjs",
            "service-tools.mjs",
            "service-codex.mjs",
            "codex-eval.mjs",
            "pi-eval-compact.mjs",
        ),
        "profiles": ("code-mode.yaml", "native-astra.yaml"),
        "verifiers": ("tool-mode.mjs", "native-astra.mjs"),
    }
    return {
        **{
            root: {
                name: hashlib.sha256((EVALS / root / name).read_bytes()).hexdigest()
                for name in names
            }
            for root, names in selected.items()
        },
        "suites/scaling": task_hashes(ASSETS),
    }


def prepare(output: Path, catalog: Path) -> None:
    if output.exists():
        raise FileExistsError(output)
    version = subprocess.check_output(
        ["npm", "view", "@openai/codex", "version"], text=True
    ).strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("invalid latest release")
    tag = subprocess.check_output(
        ["git", "-C", str(catalog.parent), "describe", "--tags", "--exact-match"],
        text=True,
    ).strip()
    if tag != f"rust-v{version}":
        raise ValueError("catalog must come from exact latest Codex tag")
    output.mkdir(parents=True)
    shutil.copy(catalog, output / "models.json")
    base = "clanker-pi-evals:scaling-runtime-base"
    docker(
        "build",
        "--platform",
        "linux/amd64",
        "-f",
        EVALS / "runtime/Dockerfile",
        "-t",
        base,
        EVALS.parents[1],
    )
    base_id = image_info(base)["image_id"]
    base = pin_tag(base_id)
    seeds = [secrets.token_hex(12) for _ in range(2)]
    orders = list(permutations(ARMS))
    schedule = []
    images = {}
    fixtures = {}
    for replicate, seed in enumerate(seeds, 1):
        for size in SIZES:
            task = generate_task(output, size, seed, replicate)
            images[task.name] = build_image(output, task, version, base)
            settings = json.loads((task / "environment/case.json").read_text())
            fixtures[task.name] = settings
            compose = output / f"{task.name}.compose.yaml"
            compose.write_text(
                yaml.safe_dump(
                    {
                        "services": {
                            "main": {
                                "image": images[task.name],
                                "platform": "linux/amd64",
                            }
                        }
                    }
                )
            )
            for arm in orders[len(fixtures) - 1]:
                config = deepcopy(
                    yaml.safe_load(
                        (
                            EVALS
                            / f"profiles/{'native-astra' if arm == 'native' else 'code-mode'}.yaml"
                        ).read_text()
                    )
                )
                if arm == "native":
                    agent = config["agents"][0]
                    agent["import_path"] = "pi_evals.adapters.services:ServiceCodexEval"
                    agent["kwargs"]["version"] = version
                    settings_native = agent["kwargs"]["config"]
                    settings_native["agents"] = {"enabled": False}
                    settings_native["orchestrator"] = {
                        "skills": {"enabled": False},
                        "mcp": {"enabled": False},
                    }
                    settings_native["features"].update(
                        multi_agent_v2=False,
                        goals=False,
                        plugins=False,
                        sleep_tool=False,
                        default_mode_request_user_input=False,
                        shell_tool=False,
                        view_image=False,
                    )
                else:
                    config["agents"] = [
                        config["agents"][0 if arm == "pi-direct" else 1]
                    ]
                    config["agents"][0]["import_path"] = (
                        "pi_evals.adapters.services:ServicePiEval"
                    )
                    config["agents"][0]["kwargs"]["pi_evals"]["pair_id"] = task.name
                name = f"{task.name}-{arm}"
                config.update(
                    job_name=name,
                    jobs_dir=str(output / "jobs"),
                    n_attempts=1,
                    n_concurrent_trials=1,
                    retry={"max_retries": 0},
                    tasks=[{"path": str(task)}],
                    environment={
                        "type": "docker",
                        "delete": True,
                        "extra_docker_compose": [str(compose)],
                    },
                )
                JobConfig.model_validate(config)
                path = output / f"{name}.yaml"
                path.write_text(yaml.safe_dump(config, sort_keys=False))
                schedule.append(
                    {
                        "task": task.name,
                        "size": size,
                        "replicate": replicate,
                        "seed": seed,
                        "arm": arm,
                        "job_name": name,
                        "config": str(path),
                    }
                )
    write_json(output / "schedule.json", schedule)
    write_json(
        output / "series.json",
        {
            "codex_version": version,
            "base_image_id": base_id,
            "images": images,
            "fixtures": fixtures,
            "arms": list(ARMS),
            "seeds": seeds,
            "sizes": SIZES,
            "model": "gpt-6-astra",
            "reasoning": "high",
            "design": "18 fresh sessions; six matched fixture blocks with all six arm-order permutations. Two new nested-prefix fixture seeds shared across sizes. Backend concurrency capped at one for every arm.",
            "limitation": "Record count, page count and total noise bytes grow together; this is volume scaling, not a factorial concurrency/latency/noise ablation. Two seeds are exploratory, not a precise reliability estimate.",
        },
    )
    write_json(
        output / "frozen.json",
        {
            "source_hashes": source_hashes(),
            "config_hashes": task_hashes(output),
            "analysis_provenance": task_hashes(EVALS / "src"),
        },
    )


def verify(output: Path):
    frozen = json.loads((output / "frozen.json").read_text())
    if frozen["source_hashes"] != source_hashes():
        raise ValueError("frozen source changed")
    for name, digest in frozen["config_hashes"].items():
        if hashlib.sha256((output / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"frozen artifact changed: {name}")
    return frozen


def preflight(output: Path):
    run_preflight(output, verify(output), lambda logs: _preflight(output, logs))


def _preflight(output: Path, attempt: Path):
    series = json.loads((output / "series.json").read_text())
    for task_name, image in series["images"].items():
        task = output / "tasks" / task_name
        for arm, script in (
            ("pi-direct-and-code", "preflight.mjs"),
            ("native", "native-preflight.mjs"),
        ):
            logs = attempt / f"{task_name}-{arm}"
            logs.mkdir(parents=True, exist_ok=False)
            command = [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--platform",
                "linux/amd64",
                "--cpus",
                "1",
                "--memory",
                "2g",
                "-e",
                "PI_CODING_AGENT_DIR=/tmp/pi-eval",
                "-v",
                f"{task / 'tests'}:/tests:ro",
                "-v",
                f"{task / 'solution'}:/solution:ro",
                "-v",
                f"{output}:/preflight:ro",
                "-v",
                f"{logs}:/logs",
                image,
            ]
            subprocess.run([*command, "node", f"/tests/{script}"], check=True)
            if arm != "native":
                subprocess.run([*command, "node", "/tests/controls.mjs"], check=True)
        pi = json.loads(
            (attempt / f"{task_name}-pi-direct-and-code" / "preflight.json").read_text()
        )
        native = json.loads(
            (attempt / f"{task_name}-native" / "preflight.json").read_text()
        )["metrics"]
        if (
            not pi["direct"]["response_bytes"]
            == pi["code"]["response_bytes"]
            == native["response_bytes"]
        ):
            raise ValueError("backend response-byte parity failed")


def run(output: Path):
    if json.loads((output / "preflight-passed.json").read_text()) != verify(output):
        raise ValueError("matching free preflight required")
    if (output / "jobs").exists():
        raise FileExistsError("refuse to rerun started series")
    for entry in json.loads((output / "schedule.json").read_text()):
        verify(output)
        completed = subprocess.run(
            ["harbor", "job", "start", "--config", entry["config"], "--yes"], cwd=EVALS
        )
        completed.check_returncode()
        require_terminal_result(read_slot(output, entry))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", choices=["prepare", "preflight", "run", "report"])
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--catalog", type=Path)
    a = p.parse_args()
    output = a.output.resolve()
    if a.command == "prepare":
        if a.catalog is None:
            p.error("prepare requires --catalog from latest Codex tag")
        prepare(output, a.catalog.resolve())
    elif a.command == "report":
        print(json.dumps(scaling_report.report(output), indent=2))
    elif a.command == "run":
        try:
            run(output)
        finally:
            scaling_report.report(output)
    else:
        preflight(output)


if __name__ == "__main__":
    main()
