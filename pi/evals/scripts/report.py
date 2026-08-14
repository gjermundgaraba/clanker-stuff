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

ARM = re.compile(r"^(pi-vanilla|pi-provider|codex-cli)-(off|on)$")
METRICS = ("quality", "input", "cache", "output", "cost", "latency", "compactions")


def _agent_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    steps = result.get("step_results") or []
    usage = [step.get("agent_result") or {} for step in steps]
    if not usage and isinstance(result.get("agent_result"), dict):
        usage.append(result["agent_result"])
    return usage


def _quality(rewards: dict[str, Any]) -> float:
    for key in ("official_qa", "quality", "exact_tool_accuracy", "reward"):
        value = rewards.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return 0.0


def _judge_labels(job_dir: Path) -> dict[str, tuple[float, str, str | None]]:
    labels = {}
    paths = sorted(job_dir.glob("longmemeval-judge-*.jsonl"))
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            item = json.loads(line)
            labels[item["trial"]] = (
                float(bool(item["label"])),
                "qa_judge",
                item.get("question_type"),
            )
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
        usage = _agent_result(result)
        started = datetime.fromisoformat(result["started_at"].replace("Z", "+00:00"))
        finished = datetime.fromisoformat(result["finished_at"].replace("Z", "+00:00"))
        label = config["agent"].get("kwargs", {}).get(
            "agent_label", config["agent"].get("name", "unknown")
        )
        arm = ARM.fullmatch(label)
        quality, quality_source, question_type = judged.get(
            result_path.parent.name, (_quality(rewards), "verifier", None)
        )
        output.append(
            {
                "agent": label,
                "cache": sum(item.get("n_cache_tokens") or 0 for item in usage),
                "compactions": rewards.get("compaction_count", 0),
                "cost": sum(item.get("cost_usd") or 0 for item in usage),
                "input": sum(item.get("n_input_tokens") or 0 for item in usage),
                "latency": (finished - started).total_seconds(),
                "mode": arm.group(2) if arm else None,
                "output": sum(item.get("n_output_tokens") or 0 for item in usage),
                "platform": arm.group(1) if arm else label,
                "quality": quality,
                "quality_source": quality_source,
                "question_type": question_type,
                "task": str(result["task_name"]).removeprefix("pi-evals/"),
                "valid": rewards.get("valid_experiment", 1),
            }
        )
    return output


def longmemeval_type_summaries(
    values: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for row in values:
        if row.get("question_type") and row["mode"]:
            grouped[(row["platform"], row["question_type"])][row["mode"]].append(
                row
            )

    output = []
    for (platform, question_type), modes in sorted(grouped.items()):
        valid = {
            mode: [row for row in modes[mode] if row["valid"]]
            for mode in ("off", "on")
        }
        if not modes["off"] or not modes["on"]:
            continue
        output.append(
            {
                "delta": (
                    fmean(row["quality"] for row in valid["on"])
                    - fmean(row["quality"] for row in valid["off"])
                    if valid["off"] and valid["on"]
                    else float("nan")
                ),
                "off_quality": (
                    fmean(row["quality"] for row in valid["off"])
                    if valid["off"]
                    else float("nan")
                ),
                "off_valid": fmean(row["valid"] for row in modes["off"]),
                "on_quality": (
                    fmean(row["quality"] for row in valid["on"])
                    if valid["on"]
                    else float("nan")
                ),
                "on_valid": fmean(row["valid"] for row in modes["on"]),
                "platform": platform,
                "question_type": question_type,
                "tasks": len({row["task"] for row in modes["off"] + modes["on"]}),
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
        "| Agent | Task | Valid | Quality | Source | Compactions | Input | Cache | Output | Cost | Seconds |"
    )
    print("| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in values:
        print(
            "| {agent} | {task} | {valid} | {quality:.2f} | {quality_source} | {compactions} | "
            "{input} | {cache} | {output} | ${cost:.4f} | {latency:.1f} |".format(
                **row
            )
        )

    deltas = matched_deltas(values)
    if not deltas:
        return
    print("\nMatched-arm mean deltas (on minus off; not per-attempt paired estimates):\n")
    print(
        "| Platform | Task | N off/on | Valid off/on | Quality | Compactions | Input | Cache | Output | Cost | Seconds |"
    )
    print("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in deltas:
        print(
            "| {platform} | {task} | {off_n}/{on_n} | {off_valid:.0%}/{on_valid:.0%} | "
            "{quality:+.3f} | {compactions:+.2f} | {input:+.0f} | {cache:+.0f} | "
            "{output:+.0f} | ${cost:+.4f} | {latency:+.1f} |".format(**row)
        )

    summaries = longmemeval_type_summaries(values)
    if summaries:
        print("\nLongMemEval valid-trial quality by question type:\n")
        print("| Platform | Type | Tasks | Valid off/on | Quality off/on | Delta |")
        print("| --- | --- | ---: | ---: | ---: | ---: |")
        for row in summaries:
            print(
                "| {platform} | {question_type} | {tasks} | {off_valid:.0%}/{on_valid:.0%} | "
                "{off_quality:.3f}/{on_quality:.3f} | {delta:+.3f} |".format(**row)
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
