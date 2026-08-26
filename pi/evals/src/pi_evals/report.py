"""Manifest-driven reporting for Harbor evaluation jobs."""

from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from statistics import fmean
from typing import Any

from pi_evals.protocol import validate_manifest

METER_KEYS = (
    "ordinary_requests",
    "compaction_requests",
    "input",
    "cache",
    "output",
    "ordinary_cost",
    "compaction_cost",
    "total_cost",
)
COMPACTION_KEYS = (
    "compaction_attempts",
    "compaction_successes",
    "compaction_failures",
)
OPERATIONAL_KEYS = (*METER_KEYS, *COMPACTION_KEYS, "agent_seconds", "wall_seconds")


def _json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected object: {path}")
    return value


def _trajectory_path(trial_dir: Path, result: dict[str, Any]) -> Path:
    steps = result.get("step_results") or []
    if steps:
        if not isinstance(steps, list) or not isinstance(steps[-1], dict):
            raise ValueError(f"invalid step_results: {trial_dir / 'result.json'}")
        name = steps[-1].get("step_name")
        if not isinstance(name, str) or not name:
            raise ValueError(f"invalid final step_name: {trial_dir / 'result.json'}")
        return trial_dir / "steps" / name / "agent" / "trajectory.json"
    return trial_dir / "agent" / "trajectory.json"


def _previous_trajectory_path(
    trial_dir: Path, result: dict[str, Any]
) -> Path | None:
    for step in reversed((result.get("step_results") or [])[:-1]):
        name = step.get("step_name") if isinstance(step, dict) else None
        if isinstance(name, str) and name:
            path = trial_dir / "steps" / name / "agent" / "trajectory.json"
            if path.exists():
                return path
    return None


def _manifest(value: object, *, path: Path) -> dict[str, str | None]:
    try:
        return validate_manifest(value)
    except (TypeError, ValueError, KeyError) as error:
        raise ValueError(f"invalid pi_evals manifest: {path}: {error}") from error


def _config_manifest(config: dict[str, Any], path: Path) -> dict[str, str | None]:
    agent = config.get("agent")
    if not isinstance(agent, dict):
        raise ValueError(f"missing agent config: {path}")
    kwargs = agent.get("kwargs")
    return _manifest(
        kwargs.get("pi_evals") if isinstance(kwargs, dict) else None, path=path
    )


def _trajectory_manifest(
    trajectory: dict[str, Any], path: Path
) -> dict[str, str | None]:
    agent = trajectory.get("agent")
    extra = agent.get("extra") if isinstance(agent, dict) else None
    return _manifest(
        extra.get("pi_evals") if isinstance(extra, dict) else None, path=path
    )


def _finite(value: object, *, name: str, exact: tuple[int, ...] | None = None) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError(f"{name} must be a finite number")
    number = float(value)
    if not 0 <= number <= 1 or (exact is not None and number not in exact):
        raise ValueError(f"{name} must be {'0 or 1' if exact else 'between 0 and 1'}")
    return number


def _reward(result: dict[str, Any], path: Path) -> tuple[float, int, float]:
    verifier = result.get("verifier_result")
    if not isinstance(verifier, dict) or not isinstance(verifier.get("rewards"), dict):
        raise ValueError(f"missing final verifier result: {path}")
    rewards = verifier["rewards"]
    quality = _finite(rewards.get("quality"), name="quality")
    valid = _finite(
        rewards.get("valid_experiment"), name="valid_experiment", exact=(0, 1)
    )
    reward = _finite(rewards.get("reward"), name="reward")
    if reward != quality:
        raise ValueError(f"reward must equal quality: {path}")
    return quality, int(valid), reward


def _steps(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    steps = trajectory.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("trajectory steps must be a nonempty list")
    if not all(isinstance(step, dict) for step in steps):
        raise ValueError("trajectory steps must contain only objects")
    return steps


def _nonnegative_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _usage(
    trajectory: dict[str, Any], *, allow_unavailable: bool = False
) -> dict[str, int | float | None]:
    totals: dict[str, int | float] = {
        "cache": 0,
        "input": 0,
        "output": 0,
        "ordinary_cost": 0.0,
        "compaction_cost": 0.0,
    }
    ordinary_requests = 0
    ordinary_request_evidence = False
    ordinary_request_unknown = False
    compaction_requests: int | None = 0
    unmetered_compaction = False
    for step in _steps(trajectory):
        compact = (step.get("extra") or {}).get("event_type") == "context_compaction"
        metrics = step.get("metrics")
        calls = step.get("llm_call_count")
        if calls is None:
            if compact:
                compaction_requests = None
            elif isinstance(metrics, dict):
                ordinary_request_unknown = True
        else:
            if not _nonnegative_integer(calls):
                raise ValueError(
                    "trajectory llm_call_count must be a nonnegative integer"
                )
            if compact:
                if compaction_requests is not None:
                    compaction_requests += calls
            else:
                ordinary_request_evidence = True
                ordinary_requests += calls
        if not isinstance(metrics, dict):
            unmetered_compaction |= compact
            continue
        cost = metrics.get("cost_usd")
        if cost is None:
            cost = 0
        tokens = {
            "cache": metrics.get("cached_tokens"),
            "input": metrics.get("prompt_tokens"),
            "output": metrics.get("completion_tokens"),
        }
        if tokens["cache"] is None:
            tokens["cache"] = 0
        if (
            isinstance(cost, bool)
            or not isinstance(cost, (int, float))
            or not math.isfinite(cost)
            or cost < 0
        ):
            raise ValueError("trajectory cost must be a nonnegative finite number")
        for key, value in tokens.items():
            if not _nonnegative_integer(value):
                raise ValueError(
                    f"trajectory {key} tokens must be nonnegative integers"
                )
            totals[key] += value
        totals["compaction_cost" if compact else "ordinary_cost"] += cost
    totals["total_cost"] = totals["ordinary_cost"] + totals["compaction_cost"]
    requests = {
        "ordinary_requests": (
            None
            if ordinary_request_unknown or not ordinary_request_evidence
            else ordinary_requests
        ),
        "compaction_requests": compaction_requests,
    }
    final = trajectory.get("final_metrics")
    if not isinstance(final, dict):
        if allow_unavailable:
            return {key: None for key in METER_KEYS}
        raise ValueError("trajectory missing final_metrics")
    expected = {
        "cache": final.get("total_cached_tokens"),
        "input": final.get("total_prompt_tokens"),
        "output": final.get("total_completion_tokens"),
        "total_cost": final.get("total_cost_usd"),
    }
    for key in ("cache", "input", "output"):
        if not _nonnegative_integer(expected[key]):
            raise ValueError(f"trajectory {key} total must be a nonnegative integer")
    cost = expected["total_cost"]
    if (
        isinstance(cost, bool)
        or not isinstance(cost, (int, float))
        or not math.isfinite(cost)
        or cost < 0
    ):
        raise ValueError("trajectory total_cost total must be a nonnegative finite number")
    for key, value in expected.items():
        if abs(totals[key] - value) > 1e-9:
            raise ValueError(f"trajectory {key} total does not match request metrics")
    measured: dict[str, int | float | None] = {**requests, **totals}
    if unmetered_compaction:
        for key in ("cache", "input", "output", "compaction_cost", "total_cost"):
            measured[key] = None
    return measured


def _compactions(trajectory: dict[str, Any]) -> dict[str, int]:
    states = []
    for step in _steps(trajectory):
        extra = step.get("extra")
        if (
            not isinstance(extra, dict)
            or extra.get("event_type") != "context_compaction"
        ):
            continue
        state = extra.get("state")
        if state not in {"succeeded", "failed", "aborted"}:
            raise ValueError("compaction step has an invalid terminal state")
        states.append(state)
    successes = states.count("succeeded")
    return {
        "compaction_attempts": len(states),
        "compaction_successes": successes,
        "compaction_failures": len(states) - successes,
    }


def _seconds(timing: object) -> float | None:
    if not isinstance(timing, dict):
        return None
    started, finished = timing.get("started_at"), timing.get("finished_at")
    if not isinstance(started, str) or not isinstance(finished, str):
        return None
    try:
        seconds = (
            datetime.fromisoformat(finished.replace("Z", "+00:00"))
            - datetime.fromisoformat(started.replace("Z", "+00:00"))
        ).total_seconds()
    except (TypeError, ValueError):
        return None
    return seconds if seconds >= 0 else None


def _timings(result: dict[str, Any]) -> tuple[float | None, float | None]:
    steps = result.get("step_results") or []
    values = (
        [
            _seconds(step.get("agent_execution")) if isinstance(step, dict) else None
            for step in steps
        ]
        if steps
        else [_seconds(result.get("agent_execution"))]
    )
    return (
        sum(values) if all(value is not None for value in values) else None,
        _seconds(
            {
                "started_at": result.get("started_at"),
                "finished_at": result.get("finished_at"),
            }
        ),
    )


def _task(config: dict[str, Any], path: Path) -> tuple[str, str]:
    task = config.get("task")
    if not isinstance(task, dict):
        raise ValueError(f"missing task config: {path}")
    label = task.get("name") or task.get("path")
    if not isinstance(label, str) or not label:
        raise ValueError(f"missing task identity: {path}")
    return json.dumps(task, sort_keys=True), label


def rows(job_dir: Path) -> list[dict[str, Any]]:
    trial_dirs = sorted(
        {
            path.parent
            for pattern in ("*/config.json", "*/result.json")
            for path in job_dir.glob(pattern)
        }
    )
    records = []
    task_names: dict[str, str] = {}
    for trial_dir in trial_dirs:
        config_path = trial_dir / "config.json"
        result_path = trial_dir / "result.json"
        config = _json(config_path)
        result = _json(result_path) if result_path.exists() else None
        if config.get("trial_name") != trial_dir.name:
            raise ValueError(f"trial_name does not match directory: {config_path}")
        if result is not None and result.get("trial_name") != trial_dir.name:
            raise ValueError(f"trial_name does not match directory: {result_path}")
        task_key, task_label = _task(config, config_path)
        result_task = result.get("task_name") if result is not None else None
        if isinstance(result_task, str) and result_task:
            previous = task_names.setdefault(task_key, result_task)
            if previous != result_task:
                raise ValueError(f"conflicting task names for task config: {trial_dir}")
        records.append((trial_dir, config, result, task_key, task_label))

    output = []
    for trial_dir, config, maybe_result, task_key, task_label in records:
        result = maybe_result or {}
        result_path = trial_dir / "result.json"
        steps = result.get("step_results") or []
        if maybe_result is None:
            status = "incomplete"
        elif result.get("exception_info") is not None or any(
            isinstance(step, dict) and step.get("exception_info") is not None
            for step in steps
        ):
            status = "errored"
        elif not isinstance(result.get("verifier_result"), dict):
            status = "incomplete"
        else:
            status = "completed"
        trajectory_path = _trajectory_path(trial_dir, result)
        if status != "completed" and not trajectory_path.exists():
            trajectory_path = (
                _previous_trajectory_path(trial_dir, result) or trajectory_path
            )
        trajectory = _json(trajectory_path) if trajectory_path.exists() else None
        config_manifest = _config_manifest(config, trial_dir / "config.json")
        manifest = (
            _trajectory_manifest(trajectory, trajectory_path)
            if trajectory is not None
            else config_manifest
        )
        if trajectory is not None and manifest != config_manifest:
            raise ValueError(
                f"config and trajectory manifests do not match: {trial_dir}"
            )
        if status == "completed":
            quality, valid, reward = _reward(result, result_path)
            if trajectory is None:
                if manifest["platform"] != "oracle":
                    raise ValueError(
                        f"completed {manifest['platform']} trial missing trajectory: "
                        f"{trial_dir}"
                    )
                usage: dict[str, int | float | None] = {key: None for key in METER_KEYS}
                compactions: dict[str, int | None] = {
                    key: None for key in COMPACTION_KEYS
                }
            else:
                usage = _usage(
                    trajectory, allow_unavailable=manifest["platform"] == "oracle"
                )
                compactions = _compactions(trajectory)
        else:
            quality = valid = reward = None
            try:
                usage = (
                    _usage(
                        trajectory,
                        allow_unavailable=manifest["platform"] == "oracle",
                    )
                    if trajectory is not None
                    else {key: None for key in METER_KEYS}
                )
            except ValueError:
                usage = {key: None for key in METER_KEYS}
            try:
                compactions = (
                    _compactions(trajectory)
                    if trajectory is not None
                    else {key: None for key in COMPACTION_KEYS}
                )
            except ValueError:
                compactions = {key: None for key in COMPACTION_KEYS}
        agent_seconds, wall_seconds = _timings(result)
        output.append(
            {
                "trial": trial_dir.name,
                "status": status,
                "platform": manifest["platform"],
                "mode": manifest["compaction_mode"],
                "mechanism": manifest["expected_mechanism"],
                "protocol": manifest["expected_protocol"],
                "task": result.get("task_name") or task_names.get(task_key, task_label),
                "quality": quality,
                "quality_source": "verifier" if quality is not None else None,
                "valid": valid,
                "reward": reward,
                **usage,
                **compactions,
                "agent_seconds": agent_seconds,
                "wall_seconds": wall_seconds,
            }
        )
    return output


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
        "| Trial | Status | Platform | Mode | Task | Valid | Quality | Source | "
        "Requests ordinary/compact | Compactions attempt/success/failure | Input | "
        "Cache | Output | Ordinary $ | Compact $ | Total $ | Agent s | Wall s |",
        "| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | "
        "---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    lines.extend(
        f"| {row['trial']} | {row['status']} | {row['platform']} | {row['mode']} | "
        f"{row['task']} | {_display(row['valid'], 0)} | {_display(row['quality'])} | "
        f"{_display(row['quality_source'])} | "
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
    print(render(rows(Path(sys.argv[1]))))


if __name__ == "__main__":
    main()
