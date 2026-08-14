#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path


def rows(job_dir: Path) -> list[dict[str, object]]:
    output: list[dict[str, object]] = []
    for result_path in sorted(job_dir.glob("*/result.json")):
        result = json.loads(result_path.read_text(encoding="utf-8"))
        config = json.loads(
            (result_path.parent / "config.json").read_text(encoding="utf-8")
        )
        rewards = (result.get("verifier_result") or {}).get("rewards") or {}
        steps = result.get("step_results") or []
        usage = [step.get("agent_result") or {} for step in steps]
        started = datetime.fromisoformat(result["started_at"].replace("Z", "+00:00"))
        finished = datetime.fromisoformat(result["finished_at"].replace("Z", "+00:00"))
        output.append(
            {
                "agent": config["agent"].get("kwargs", {}).get(
                    "agent_label", config["agent"].get("name", "unknown")
                ),
                "cache": sum(item.get("n_cache_tokens") or 0 for item in usage),
                "compactions": rewards.get("compaction_count", 0),
                "cost": sum(item.get("cost_usd") or 0 for item in usage),
                "input": sum(item.get("n_input_tokens") or 0 for item in usage),
                "latency": (finished - started).total_seconds(),
                "output": sum(item.get("n_output_tokens") or 0 for item in usage),
                "quality": rewards.get("quality", 0),
                "task": result["task_name"].removeprefix("pi-evals/compaction-"),
                "valid": rewards.get("valid_experiment", 0),
            }
        )
    return output


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: report.py JOB_DIR")
    values = rows(Path(sys.argv[1]))
    print("| Agent | Task | Valid | Quality | Compactions | Input | Cache | Output | Cost | Seconds |")
    print("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in values:
        print(
            "| {agent} | {task} | {valid} | {quality:.2f} | {compactions} | "
            "{input} | {cache} | {output} | ${cost:.4f} | {latency:.1f} |".format(
                **row
            )
        )


if __name__ == "__main__":
    main()
