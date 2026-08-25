#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from statistics import fmean
from typing import Any

ARM = re.compile(r"^(.+)-(off|on)$")
METRICS = (
    "quality",
    "input",
    "cache",
    "output",
    "ordinary_cost",
    "compaction_cost",
    "total_cost",
    "latency",
    "compactions",
)
CONDITION_TIERS = {
    "evidence": {None},
    "full": {"64k", "115k"},
    "handoff": {"115k"},
}


def _trajectory(trial_dir: Path, result: dict[str, Any]) -> dict[str, Any]:
    steps = result.get("step_results") or []
    path = (
        trial_dir / "steps" / steps[-1]["step_name"] / "agent" / "trajectory.json"
        if steps
        else trial_dir / "agent" / "trajectory.json"
    )
    if not path.exists():
        raise ValueError(f"missing final trajectory: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"invalid final trajectory: {path}")
    return value


def _usage(trajectory: dict[str, Any]) -> dict[str, int | float]:
    totals: dict[str, int | float] = {
        "cache": 0,
        "compaction_calls": 0,
        "compaction_cost": 0.0,
        "input": 0,
        "ordinary_calls": 0,
        "ordinary_cost": 0.0,
        "output": 0,
    }
    for step in trajectory.get("steps") or []:
        metrics = step.get("metrics") if isinstance(step, dict) else None
        if not isinstance(metrics, dict):
            continue
        compact = (step.get("extra") or {}).get("event_type") == "context_compaction"
        kind = "compaction" if compact else "ordinary"
        totals[f"{kind}_calls"] += int(step.get("llm_call_count") or 1)
        totals[f"{kind}_cost"] += float(metrics.get("cost_usd") or 0)
        totals["input"] += int(metrics.get("prompt_tokens") or 0)
        totals["cache"] += int(metrics.get("cached_tokens") or 0)
        totals["output"] += int(metrics.get("completion_tokens") or 0)
    totals["total_cost"] = totals["ordinary_cost"] + totals["compaction_cost"]

    final = trajectory.get("final_metrics") or {}
    expected = {
        "cache": final.get("total_cached_tokens"),
        "input": final.get("total_prompt_tokens"),
        "output": final.get("total_completion_tokens"),
        "total_cost": final.get("total_cost_usd"),
    }
    for key, value in expected.items():
        if value is not None and abs(float(totals[key]) - float(value)) > 1e-9:
            raise ValueError(f"trajectory {key} total does not match its request metrics")
    return totals


def _quality(rewards: dict[str, Any]) -> float:
    for key in ("official_qa", "quality", "exact_arguments", "reward"):
        value = rewards.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return 0.0


def _judge_labels(
    job_dir: Path,
) -> dict[str, tuple[float, str, str, str, str | None]]:
    labels = {}
    paths = sorted(job_dir.glob("longmemeval-judge-*.jsonl"))
    for path in paths:
        for line in path.read_text(encoding="utf-8").split("\n"):
            if not line:
                continue
            item = json.loads(line)
            try:
                condition = item["condition"]
                tier = item["tier"]
                if (
                    condition not in CONDITION_TIERS
                    or tier not in CONDITION_TIERS[condition]
                ):
                    raise ValueError(
                        f"{path}: invalid LongMemEval condition/tier: {condition}/{tier}"
                    )
                labels[item["trial"]] = (
                    float(bool(item["label"])),
                    "qa_judge",
                    item["question_type"],
                    condition,
                    tier,
                )
            except KeyError as error:
                raise ValueError(
                    f"{path}: obsolete judge row missing {error.args[0]}"
                ) from error
    return labels


def rows(job_dir: Path) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    judged = _judge_labels(job_dir)
    for result_path in sorted(job_dir.glob("*/result.json")):
        result = json.loads(result_path.read_text(encoding="utf-8"))
        config = json.loads(
            (result_path.parent / "config.json").read_text(encoding="utf-8")
        )
        rewards = (result.get("verifier_result") or {}).get("rewards") or {}
        usage = _usage(_trajectory(result_path.parent, result))
        started = datetime.fromisoformat(result["started_at"].replace("Z", "+00:00"))
        finished = datetime.fromisoformat(result["finished_at"].replace("Z", "+00:00"))
        label = config["agent"].get("kwargs", {}).get(
            "agent_label", config["agent"].get("name", "unknown")
        )
        arm = ARM.fullmatch(label)
        quality, quality_source, question_type, condition, tier = judged.get(
            result_path.parent.name, (_quality(rewards), "verifier", None, None, None)
        )
        output.append(
            {
                "agent": label,
                "cache": usage["cache"],
                "compaction_calls": usage["compaction_calls"],
                "compaction_cost": usage["compaction_cost"],
                "compactions": rewards.get("compaction_count", 0),
                "condition": condition,
                "input": usage["input"],
                "latency": (finished - started).total_seconds(),
                "mode": arm.group(2) if arm else None,
                "ordinary_calls": usage["ordinary_calls"],
                "ordinary_cost": usage["ordinary_cost"],
                "output": usage["output"],
                "platform": arm.group(1) if arm else label,
                "quality": quality,
                "quality_source": quality_source,
                "question_type": question_type,
                "task": str(result["task_name"]).removeprefix("pi-evals/"),
                "tier": tier,
                "total_cost": usage["total_cost"],
                "valid": rewards.get("valid_experiment", 1),
            }
        )
    return output


def longmemeval_type_summaries(
    values: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str | None, str, str, str], list[dict[str, Any]]] = (
        defaultdict(list)
    )
    for row in values:
        if row.get("question_type"):
            grouped[
                (
                    row["condition"],
                    row["tier"],
                    row["platform"],
                    row["question_type"],
                    row["mode"] or "base",
                )
            ].append(row)

    output = []
    for (condition, tier, platform, question_type, mode), rows in sorted(
        grouped.items()
    ):
        valid = [row for row in rows if row["valid"]]
        output.append(
            {
                "condition": condition,
                "mode": mode,
                "n": len(rows),
                "platform": platform,
                "quality": (
                    fmean(row["quality"] for row in valid)
                    if valid
                    else float("nan")
                ),
                "question_type": question_type,
                "tasks": len({row["task"] for row in rows}),
                "tier": tier,
                "valid": fmean(row["valid"] for row in rows),
            }
        )
    return output


def paired_flips(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for row in values:
        if row["mode"]:
            grouped[(row["platform"], row["task"])][row["mode"]].append(row)
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for (platform, _task), modes in grouped.items():
        if len(modes["off"]) != 1 or len(modes["on"]) != 1:
            continue
        off, on = modes["off"][0], modes["on"][0]
        if not off["valid"] or not on["valid"]:
            continue
        key = (int(bool(off["quality"])), int(bool(on["quality"])))
        counts[platform][f"{key[0]}{key[1]}"] += 1
    return [
        {
            "both_correct": modes["11"],
            "both_wrong": modes["00"],
            "off_only": modes["10"],
            "on_only": modes["01"],
            "pairs": sum(modes.values()),
            "platform": platform,
        }
        for platform, modes in sorted(counts.items())
    ]


def matched_deltas(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for row in values:
        if row["mode"]:
            grouped[(row["platform"], row["task"])][row["mode"]].append(row)

    output = []
    for (platform, task), modes in sorted(grouped.items()):
        if not modes["on"] or not modes["off"]:
            continue
        valid_modes = {
            mode: [row for row in modes[mode] if row["valid"]]
            for mode in ("off", "on")
        }
        item: dict[str, Any] = {
            "platform": platform,
            "task": task,
            "off_n": len(modes["off"]),
            "on_n": len(modes["on"]),
            "off_valid": fmean(float(row["valid"]) for row in modes["off"]),
            "on_valid": fmean(float(row["valid"]) for row in modes["on"]),
        }
        for metric in METRICS:
            metric_modes = (
                valid_modes if metric in {"quality", "compactions"} else modes
            )
            item[metric] = (
                fmean(float(row[metric]) for row in metric_modes["on"])
                - fmean(float(row[metric]) for row in metric_modes["off"])
                if metric_modes["on"] and metric_modes["off"]
                else float("nan")
            )
        output.append(item)
    return output


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: report.py JOB_DIR")
    values = rows(Path(sys.argv[1]))
    print(
        "| Agent | Task | Valid | Quality | Source | Calls ordinary/compact | Compactions | Input | Cache | Output | Ordinary API$ | Compact API$ | Total API$ | Seconds |"
    )
    print("| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in values:
        print(
            "| {agent} | {task} | {valid} | {quality:.2f} | {quality_source} | "
            "{ordinary_calls}/{compaction_calls} | {compactions} | {input} | {cache} | "
            "{output} | ${ordinary_cost:.4f} | ${compaction_cost:.4f} | "
            "${total_cost:.4f} | {latency:.1f} |".format(
                **row
            )
        )

    deltas = matched_deltas(values)
    if deltas:
        print(
            "\nMatched-arm mean deltas (on minus off; not per-attempt paired estimates):\n"
        )
        print(
            "| Platform | Task | N off/on | Valid off/on | Quality | Compactions | Input | Cache | Output | Ordinary API$ | Compact API$ | Total API$ | Seconds |"
        )
        print(
            "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
        )
        for row in deltas:
            print(
                "| {platform} | {task} | {off_n}/{on_n} | {off_valid:.0%}/{on_valid:.0%} | "
                "{quality:+.3f} | {compactions:+.2f} | {input:+.0f} | {cache:+.0f} | "
                "{output:+.0f} | ${ordinary_cost:+.4f} | ${compaction_cost:+.4f} | "
                "${total_cost:+.4f} | {latency:+.1f} |".format(**row)
            )

    summaries = longmemeval_type_summaries(values)
    if summaries:
        print("\nLongMemEval valid-trial quality by question type:\n")
        print(
            "| Condition | Tier | Platform | Arm | Type | Tasks | N | Valid | Quality |"
        )
        print("| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |")
        for row in summaries:
            print(
                "| {condition} | {tier} | {platform} | {mode} | {question_type} | "
                "{tasks} | {n} | {valid:.0%} | {quality:.3f} |".format(**row)
            )

    flips = paired_flips(values)
    if flips:
        print("\nSingle-attempt paired task outcomes (off/on):\n")
        print("| Platform | Valid pairs | Both correct | Off only | On only | Both wrong |")
        print("| --- | ---: | ---: | ---: | ---: | ---: |")
        for row in flips:
            print(
                "| {platform} | {pairs} | {both_correct} | {off_only} | "
                "{on_only} | {both_wrong} |".format(**row)
            )


if __name__ == "__main__":
    main()
