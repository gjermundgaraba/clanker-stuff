"""Manifest-driven reporting for Harbor evaluation jobs."""

from __future__ import annotations

import math
import sys
from collections import defaultdict
from pathlib import Path
from statistics import fmean
from typing import Any


from pi_evals import trials
from pi_evals.trials import OPERATIONAL_KEYS


def _number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def matched_summaries(
    values: list[dict[str, Any]],
    *,
    score: str = "quality",
    group_keys: tuple[str, ...] = ("platform", "mode", "task"),
) -> list[dict[str, Any]]:
    grouped: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in values:
        grouped[tuple(row[key] for key in group_keys)].append(row)
    output = []
    for identity, group in sorted(grouped.items()):
        valid_rows = [
            row for row in group if row["status"] == "completed" and row["valid"] == 1
        ]
        scores = [row[score] for row in valid_rows if _number(row.get(score))]
        completed = sum(row["status"] == "completed" for row in group)
        output.append(
            {
                **dict(zip(group_keys, identity, strict=True)),
                "n": len(group),
                "completed": completed,
                "errored": sum(row["status"] == "errored" for row in group),
                "incomplete": sum(row["status"] == "incomplete" for row in group),
                "valid": len(valid_rows),
                "completion_yield": completed / len(group),
                "valid_yield": len(valid_rows) / len(group),
                score: fmean(scores) if scores else None,
                f"{score}_n": len(scores),
                **{
                    key: fmean(row[key] for row in group if _number(row.get(key)))
                    if any(_number(row.get(key)) for row in group)
                    else None
                    for key in OPERATIONAL_KEYS
                },
                **{
                    f"{key}_n": sum(_number(row.get(key)) for row in group)
                    for key in OPERATIONAL_KEYS
                },
            }
        )
    return output


def matched_deltas(
    values: list[dict[str, Any]],
    *,
    score: str = "quality",
    group_keys: tuple[str, ...] = ("platform", "task"),
) -> list[dict[str, Any]]:
    if "mode" in group_keys:
        raise ValueError("matched delta group keys must not include mode")
    grouped: dict[tuple[Any, ...], dict[str, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for row in values:
        if row.get("mode") in {"off", "on"}:
            grouped[tuple(row[key] for key in group_keys)][row["mode"]].append(row)

    output = []
    for identity, modes in sorted(grouped.items()):
        if not modes["off"] or not modes["on"]:
            continue
        item: dict[str, Any] = dict(zip(group_keys, identity, strict=True))
        for mode in ("off", "on"):
            rows_for_mode = modes[mode]
            valid_rows = [
                row
                for row in rows_for_mode
                if row["status"] == "completed" and row["valid"] == 1
            ]
            item[f"{mode}_n"] = len(rows_for_mode)
            item[f"{mode}_valid"] = len(valid_rows)
            item[f"{mode}_valid_yield"] = len(valid_rows) / len(rows_for_mode)
        for metric in (score, *OPERATIONAL_KEYS):
            measured: dict[str, list[int | float]] = {}
            for mode in ("off", "on"):
                candidates = (
                    [
                        row
                        for row in modes[mode]
                        if row["status"] == "completed" and row["valid"] == 1
                    ]
                    if metric == score
                    else modes[mode]
                )
                measured[mode] = [
                    row[metric] for row in candidates if _number(row.get(metric))
                ]
                item[f"{mode}_{metric}_n"] = len(measured[mode])
            item[metric] = (
                fmean(measured["on"]) - fmean(measured["off"])
                if measured["off"] and measured["on"]
                else None
            )
        output.append(item)
    return output


def _display(value: object, digits: int = 3, *, grouped: bool = False) -> str:
    if value is None:
        return "—"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f"{value:,.{digits}f}" if grouped else f"{value:.{digits}f}"
    return str(value)


def _delta(value: object, digits: int = 3) -> str:
    if value is None:
        return "—"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f"{value:+.{digits}f}"
    return str(value)


def render(values: list[dict[str, Any]]) -> str:
    lines = [
        "| Trial | Status | Platform | Mode | Task | Valid | Quality | "
        "Requests ordinary/compact | Compactions attempt/success/failure | Input | "
        "Cache | Output | Ordinary $ | Compact $ | Total $ | Agent s | Wall s |",
        "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | "
        "---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    lines.extend(
        f"| {row['trial']} | {row['status']} | {row['platform']} | {row['mode']} | "
        f"{row['task']} | {_display(row['valid'], 0)} | {_display(row['quality'])} | "
        f"{_display(row['ordinary_requests'], 0)}/"
        f"{_display(row['compaction_requests'], 0)} | "
        f"{_display(row['compaction_attempts'], 0)}/"
        f"{_display(row['compaction_successes'], 0)}/"
        f"{_display(row['compaction_failures'], 0)} | "
        f"{_display(row['input'], 0, grouped=True)} | "
        f"{_display(row['cache'], 0, grouped=True)} | "
        f"{_display(row['output'], 0, grouped=True)} | "
        f"{_display(row['ordinary_cost'], 4)} | "
        f"{_display(row['compaction_cost'], 4)} | {_display(row['total_cost'], 4)} | "
        f"{_display(row['agent_seconds'], 1)} | {_display(row['wall_seconds'], 1)} |"
        for row in values
    )
    summaries = matched_summaries(values)
    if summaries:
        lines += [
            "",
            "| Platform | Mode | Task | N | Completed | Errored | Incomplete | "
            "Valid | Completion yield | Valid yield | Quality | Requests "
            "ordinary/compact | Compactions attempt/success/failure | Input | "
            "Cache | Output | Ordinary $ | Compact $ | Total $ | Agent s | Wall s |",
            "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | "
            "---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | "
            "---: | ---: | ---: |",
        ]
        lines.extend(
            f"| {row['platform']} | {row['mode']} | {row['task']} | {row['n']} | "
            f"{row['completed']} | {row['errored']} | {row['incomplete']} | "
            f"{row['valid']} | "
            f"{row['completion_yield']:.0%} | {row['valid_yield']:.0%} | "
            f"{_display(row['quality'])} | "
            f"{_display(row['ordinary_requests'])}/"
            f"{_display(row['compaction_requests'])} | "
            f"{_display(row['compaction_attempts'])}/"
            f"{_display(row['compaction_successes'])}/"
            f"{_display(row['compaction_failures'])} | "
            f"{_display(row['input'], 0, grouped=True)} | "
            f"{_display(row['cache'], 0, grouped=True)} | "
            f"{_display(row['output'], 0, grouped=True)} | "
            f"{_display(row['ordinary_cost'], 4)} | "
            f"{_display(row['compaction_cost'], 4)} | "
            f"{_display(row['total_cost'], 4)} | {_display(row['agent_seconds'], 1)} | "
            f"{_display(row['wall_seconds'], 1)} |"
            for row in summaries
        )
    deltas = matched_deltas(values)
    if deltas:
        lines += [
            "",
            "Matched-arm mean deltas (on minus off):",
            "",
            "| Platform | Task | N off/on | Valid off/on | Quality | Requests "
            "ordinary/compact | Compactions attempt/success/failure | Input | Cache | "
            "Output | Ordinary $ | Compact $ | Total $ | Agent s | Wall s |",
            "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | "
            "---: | ---: | ---: | ---: | ---: | ---: |",
        ]
        lines.extend(
            f"| {row['platform']} | {row['task']} | {row['off_n']}/{row['on_n']} | "
            f"{row['off_valid']}/{row['on_valid']} | {_delta(row['quality'])} | "
            f"{_delta(row['ordinary_requests'])}/"
            f"{_delta(row['compaction_requests'])} | "
            f"{_delta(row['compaction_attempts'])}/"
            f"{_delta(row['compaction_successes'])}/"
            f"{_delta(row['compaction_failures'])} | {_delta(row['input'], 0)} | "
            f"{_delta(row['cache'], 0)} | {_delta(row['output'], 0)} | "
            f"{_delta(row['ordinary_cost'], 4)} | "
            f"{_delta(row['compaction_cost'], 4)} | "
            f"{_delta(row['total_cost'], 4)} | {_delta(row['agent_seconds'], 1)} | "
            f"{_delta(row['wall_seconds'], 1)} |"
            for row in deltas
        )
    return "\n".join(lines)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m pi_evals.report JOB_DIR")
    print(render(trials.rows(Path(sys.argv[1]))))


if __name__ == "__main__":
    main()
