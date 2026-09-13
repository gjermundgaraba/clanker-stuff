"""Shared trial artifact extraction; metrics are independent of task scoring."""

from __future__ import annotations
import json
import math
from datetime import datetime
from pathlib import Path
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


def json_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected object: {path}")
    return value


def trajectory_path(trial_dir: Path, result: dict[str, Any]) -> Path:
    steps = result.get("step_results") or []
    if steps:
        if not isinstance(steps, list) or not isinstance(steps[-1], dict):
            raise ValueError(f"invalid step_results: {trial_dir / 'result.json'}")
        name = steps[-1].get("step_name")
        if not isinstance(name, str) or not name:
            raise ValueError(f"invalid final step_name: {trial_dir / 'result.json'}")
        return trial_dir / "steps" / name / "agent" / "trajectory.json"
    return trial_dir / "agent" / "trajectory.json"


def previous_trajectory_path(trial_dir: Path, result: dict[str, Any]) -> Path | None:
    for step in reversed((result.get("step_results") or [])[:-1]):
        name = step.get("step_name") if isinstance(step, dict) else None
        if isinstance(name, str) and name:
            path = trial_dir / "steps" / name / "agent" / "trajectory.json"
            if path.exists():
                return path
    return None


def manifest(value: object, *, path: Path) -> dict[str, str | None]:
    try:
        return validate_manifest(value)
    except (TypeError, ValueError, KeyError) as error:
        raise ValueError(f"invalid pi_evals manifest: {path}: {error}") from error


def config_manifest(config: dict[str, Any], path: Path) -> dict[str, str | None]:
    agent = config.get("agent")
    if not isinstance(agent, dict):
        raise ValueError(f"missing agent config: {path}")
    kwargs = agent.get("kwargs")
    return manifest(
        kwargs.get("pi_evals") if isinstance(kwargs, dict) else None, path=path
    )


def trajectory_manifest(
    trajectory: dict[str, Any], path: Path
) -> dict[str, str | None]:
    agent = trajectory.get("agent")
    extra = agent.get("extra") if isinstance(agent, dict) else None
    return manifest(
        extra.get("pi_evals") if isinstance(extra, dict) else None, path=path
    )


def finite(value: object, *, name: str, exact: tuple[int, ...] | None = None) -> float:
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


def reward(result: dict[str, Any], path: Path) -> tuple[float, int, float]:
    verifier = result.get("verifier_result")
    if not isinstance(verifier, dict) or not isinstance(verifier.get("rewards"), dict):
        raise ValueError(f"missing final verifier result: {path}")
    rewards = verifier["rewards"]
    quality = finite(rewards.get("quality"), name="quality")
    valid = finite(
        rewards.get("valid_experiment"), name="valid_experiment", exact=(0, 1)
    )
    reward = finite(rewards.get("reward"), name="reward")
    if reward != quality:
        raise ValueError(f"reward must equal quality: {path}")
    return quality, int(valid), reward


def steps(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    steps = trajectory.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("trajectory steps must be a nonempty list")
    if not all(isinstance(step, dict) for step in steps):
        raise ValueError("trajectory steps must contain only objects")
    return steps


def nonnegative_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def usage(
    trajectory: dict[str, Any], *, allow_unavailable: bool = False
) -> dict[str, int | float | None]:
    totals: dict[str, int | float] = {
        "cache": 0,
        "input": 0,
        "output": 0,
        "ordinary_cost": 0.0,
        "compaction_cost": 0.0,
    }
    final = trajectory.get("final_metrics")
    final_cost = final.get("total_cost_usd") if isinstance(final, dict) else None
    unknown_costs: set[str] = set()
    ordinary_requests = 0
    ordinary_request_evidence = False
    ordinary_request_unknown = False
    compaction_requests: int | None = 0
    unmetered_compaction = False
    for step in steps(trajectory):
        compact = (step.get("extra") or {}).get("event_type") == "context_compaction"
        metrics = step.get("metrics")
        calls = step.get("llm_call_count")
        if calls is None:
            if compact:
                compaction_requests = None
            elif isinstance(metrics, dict):
                ordinary_request_unknown = True
        else:
            if not nonnegative_integer(calls):
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
            # ATIF may omit a zero step cost. A known final total disambiguates
            # that legacy representation; without it, missing pricing is unknown.
            if final_cost is None:
                unknown_costs.add("compaction_cost" if compact else "ordinary_cost")
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
            if not nonnegative_integer(value):
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
        if not nonnegative_integer(expected[key]):
            raise ValueError(f"trajectory {key} total must be a nonnegative integer")
    cost = expected["total_cost"]
    if cost is not None and (
        isinstance(cost, bool)
        or not isinstance(cost, (int, float))
        or not math.isfinite(cost)
        or cost < 0
    ):
        raise ValueError(
            "trajectory total_cost total must be a nonnegative finite number"
        )
    for key, value in expected.items():
        if value is not None and abs(totals[key] - value) > 1e-9:
            raise ValueError(f"trajectory {key} total does not match request metrics")
    measured: dict[str, int | float | None] = {**requests, **totals}
    for key in unknown_costs:
        measured[key] = None
    if cost is None:
        measured["total_cost"] = None
    manifest = ((trajectory.get("agent") or {}).get("extra") or {}).get(
        "pi_evals"
    ) or {}
    if (
        manifest.get("experiment") == "code-mode"
        and (final.get("extra") or {}).get("cost_available") is not True
    ):
        measured.update(ordinary_cost=None, total_cost=None)
    if unmetered_compaction:
        for key in ("cache", "input", "output", "compaction_cost", "total_cost"):
            measured[key] = None
    return measured


def compactions(trajectory: dict[str, Any]) -> dict[str, int]:
    states = []
    for step in steps(trajectory):
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


def seconds(timing: object) -> float | None:
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


def timings(result: dict[str, Any]) -> tuple[float | None, float | None]:
    steps = result.get("step_results") or []
    values = (
        [
            seconds(step.get("agent_execution")) if isinstance(step, dict) else None
            for step in steps
        ]
        if steps
        else [seconds(result.get("agent_execution"))]
    )
    return (
        sum(values) if all(value is not None for value in values) else None,
        seconds(
            {
                "started_at": result.get("started_at"),
                "finished_at": result.get("finished_at"),
            }
        ),
    )


def trial_rows(job: Path, *, export_reward: str) -> list[dict]:
    """Read export-only trials without making captures depend on telemetry.

    Malformed telemetry stays explicit and runtime-invalid. Artifact identity is
    still verified by each driver's frozen inputs and captured-source hashes.
    """
    result = []
    trial_dirs = sorted(
        {
            p.parent
            for pattern in ("*/result.json", "*/config.json")
            for p in job.glob(pattern)
        }
    )
    for trial in trial_dirs:
        path = trial / "result.json"
        raw = json_object(path) if path.exists() else {}
        errored = raw.get("exception_info") or any(
            s.get("exception_info") for s in raw.get("step_results") or []
        )
        rewards = (raw.get("verifier_result") or {}).get("rewards") or {}
        status = (
            "errored"
            if errored
            else "completed"
            if rewards.get(export_reward) == 1
            else "incomplete"
        )
        row = {
            "trial": trial.name,
            "status": status,
            "valid": rewards.get("valid_experiment", 0),
            **dict.fromkeys(METER_KEYS),
            **dict.fromkeys(COMPACTION_KEYS),
        }
        try:
            trajectory_file = trajectory_path(trial, raw)
            if trajectory_file.exists():
                trajectory = json_object(trajectory_file)
                config_path = trial / "config.json"
                if trajectory_manifest(trajectory, trajectory_file) != config_manifest(
                    json_object(config_path), config_path
                ):
                    raise ValueError("config/trajectory manifest mismatch")
                row.update(usage(trajectory))
                row.update(compactions(trajectory))
                extra = (trajectory.get("final_metrics") or {}).get("extra") or {}
                row.update(
                    tool_calls=extra.get("tool_calls"),
                    underlying_operations=extra.get("underlying_operations"),
                )
            elif row["valid"] == 1:
                raise ValueError("runtime-valid trial missing trajectory")
        except (ValueError, TypeError, KeyError, OSError) as error:
            row.update(valid=0, telemetry_error={"error": str(error)})
        row["agent_seconds"], row["wall_seconds"] = timings(raw)
        result.append(row)
    return result


def require_terminal_result(row: dict) -> None:
    """Task correctness is not a spending gate; runtime completion/validity is."""
    if row.get("status") != "completed" or row.get("valid") != 1:
        raise RuntimeError("runtime-invalid or incomplete current trial; stop spending")


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
        config = json_object(config_path)
        result = json_object(result_path) if result_path.exists() else None
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
        trajectory_file = trajectory_path(trial_dir, result)
        if status != "completed" and not trajectory_file.exists():
            trajectory_file = (
                previous_trajectory_path(trial_dir, result) or trajectory_file
            )
        trajectory = json_object(trajectory_file) if trajectory_file.exists() else None
        expected_manifest = config_manifest(config, trial_dir / "config.json")
        manifest = (
            trajectory_manifest(trajectory, trajectory_file)
            if trajectory is not None
            else expected_manifest
        )
        if trajectory is not None and manifest != expected_manifest:
            raise ValueError(
                f"config and trajectory manifests do not match: {trial_dir}"
            )
        if status == "completed":
            quality, valid, quality_reward = reward(result, result_path)
            if trajectory is None:
                if manifest["platform"] != "oracle":
                    raise ValueError(
                        f"completed {manifest['platform']} trial missing trajectory: "
                        f"{trial_dir}"
                    )
                measured_usage: dict[str, int | float | None] = {
                    key: None for key in METER_KEYS
                }
                compaction_counts: dict[str, int | None] = {
                    key: None for key in COMPACTION_KEYS
                }
            else:
                measured_usage = usage(
                    trajectory, allow_unavailable=manifest["platform"] == "oracle"
                )
                compaction_counts = compactions(trajectory)
        else:
            quality = valid = quality_reward = None
            try:
                measured_usage = (
                    usage(
                        trajectory,
                        allow_unavailable=manifest["platform"] == "oracle",
                    )
                    if trajectory is not None
                    else {key: None for key in METER_KEYS}
                )
            except ValueError:
                measured_usage = {key: None for key in METER_KEYS}
            try:
                compaction_counts = (
                    compactions(trajectory)
                    if trajectory is not None
                    else {key: None for key in COMPACTION_KEYS}
                )
            except ValueError:
                compaction_counts = {key: None for key in COMPACTION_KEYS}
        # In tool-mode experiments validity and artifact quality remain observable
        # even when the runtime failed. Completion is still required for success.
        if manifest.get("experiment") == "code-mode" and isinstance(
            result.get("verifier_result"), dict
        ):
            quality, valid, quality_reward = reward(result, result_path)
        agent_seconds, wall_seconds = timings(result)
        extra = ((trajectory or {}).get("final_metrics") or {}).get("extra") or {}
        exception_types = [
            error.get("exception_type", "")
            for error in [
                result.get("exception_info"),
                *(step.get("exception_info") for step in steps),
            ]
            if isinstance(error, dict)
        ]
        output.append(
            {
                "trial": trial_dir.name,
                "status": status,
                "platform": manifest["platform"],
                "mode": manifest.get("arm", manifest["compaction_mode"]),
                "experiment": manifest.get("experiment", "compaction"),
                "pair_id": manifest.get("pair_id"),
                "timed_out": any("Timeout" in name for name in exception_types),
                "tool_calls": extra.get("tool_calls"),
                "underlying_operations": extra.get("underlying_operations"),
                "mechanism": manifest["expected_mechanism"],
                "protocol": manifest["expected_protocol"],
                "task": result.get("task_name") or task_names.get(task_key, task_label),
                "quality": quality,
                "valid": valid,
                "reward": quality_reward,
                **measured_usage,
                **compaction_counts,
                "agent_seconds": agent_seconds,
                "wall_seconds": wall_seconds,
            }
        )
    return output
