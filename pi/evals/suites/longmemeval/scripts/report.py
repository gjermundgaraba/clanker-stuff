#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from pi_evals import report
from longmemeval_cache import load_cache


def _judge_cache(job_dir: Path, path: Path | None) -> Path:
    if path is not None:
        return path
    paths = sorted(job_dir.glob("longmemeval-judge-*.jsonl"))
    if len(paths) != 1:
        raise ValueError(
            "pass --judge-cache or keep exactly one LongMemEval judge cache"
        )
    return paths[0]


def rows(job_dir: Path, judge_cache: Path | None = None) -> list[dict[str, Any]]:
    values = report.rows(job_dir)
    labels = load_cache(_judge_cache(job_dir, judge_cache))
    trials = {row["trial"] for row in values if row["status"] == "completed"}
    if trials != set(labels):
        raise ValueError("LongMemEval result and judge trials must match one-to-one")
    return [
        row
        if row["status"] != "completed"
        else {
            **row,
            "condition": labels[row["trial"]]["condition"],
            "qa_quality": float(labels[row["trial"]]["label"]),
            "qa_quality_source": (
                f"{labels[row['trial']]['judge_backend']}:"
                f"{labels[row['trial']]['judge_model']}"
            ),
            "question_type": labels[row["trial"]]["question_type"],
            "tier": labels[row["trial"]]["tier"],
        }
        for row in values
    ]


def type_summaries(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return report.matched_summaries(
        [row for row in values if row["status"] == "completed"],
        score="qa_quality",
        group_keys=("condition", "tier", "platform", "mode", "question_type"),
    )


def qa_deltas(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    aggregate_keys = ("condition", "tier", "platform", "question_type")
    task_keys = (*aggregate_keys, "task")
    summaries = report.matched_summaries(
        [
            row
            for row in values
            if row["status"] == "completed" and row.get("condition") == "full"
        ],
        score="qa_quality",
        group_keys=(*aggregate_keys, "mode", "task"),
    )
    by_mode = {
        mode: {
            tuple(row[key] for key in task_keys): row
            for row in summaries
            if row["mode"] == mode and row["qa_quality"] is not None
        }
        for mode in ("off", "on")
    }
    matched = [
        {**by_mode[mode][key], "status": "completed", "valid": 1}
        for key in sorted(by_mode["off"].keys() & by_mode["on"].keys())
        for mode in ("off", "on")
    ]
    return report.matched_deltas(
        matched,
        score="qa_quality",
        group_keys=aggregate_keys,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("job_dir", type=Path)
    parser.add_argument("--judge-cache", type=Path)
    args = parser.parse_args()
    values = rows(args.job_dir, args.judge_cache)
    print(report.render(values))
    source = {row["qa_quality_source"] for row in values if "qa_quality_source" in row}
    if len(source) != 1:
        raise ValueError("LongMemEval report requires exactly one QA judge source")
    print(f"\nLongMemEval QA source: {source.pop()}")
    print("\nLongMemEval valid-trial QA quality by question type:\n")
    print(
        "| Condition | Tier | Platform | Mode | Type | Judged | Valid | "
        "Valid yield | QA quality |"
    )
    print("| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |")
    for row in type_summaries(values):
        quality = "—" if row["qa_quality"] is None else f"{row['qa_quality']:.3f}"
        print(
            "| {condition} | {tier} | {platform} | {mode} | {question_type} | "
            "{n} | {valid} | {valid_yield:.0%} | ".format(**row)
            + quality
            + " |"
        )
    deltas = qa_deltas(values)
    if deltas:
        print(
            "\nFull-history QA quality deltas "
            "(on minus off; common valid task set):\n"
        )
        print(
            "| Condition | Tier | Platform | Type | Matched tasks | QA quality |"
        )
        print("| --- | --- | --- | --- | ---: | ---: |")
        for row in deltas:
            quality = (
                "—" if row["qa_quality"] is None else f"{row['qa_quality']:+.3f}"
            )
            print(
                "| {condition} | {tier} | {platform} | {question_type} | "
                "{off_qa_quality_n} | ".format(**row)
                + quality
                + " |"
            )


if __name__ == "__main__":
    main()
