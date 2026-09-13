import json
from pathlib import Path

MANIFEST = {
    "platform": "future",
    "compaction_mode": "on",
    "expected_mechanism": "native",
    "expected_protocol": None,
}


def completed_trajectory(manifest: dict = MANIFEST) -> dict:
    return {
        "agent": {"extra": {"pi_evals": manifest}},
        "steps": [
            {
                "llm_call_count": 1,
                "metrics": {
                    "cached_tokens": 2,
                    "completion_tokens": 3,
                    "cost_usd": 0.2,
                    "prompt_tokens": 5,
                },
            }
        ],
        "final_metrics": {
            "total_cached_tokens": 2,
            "total_completion_tokens": 3,
            "total_cost_usd": 0.2,
            "total_prompt_tokens": 5,
        },
    }


def write_trial(
    root: Path,
    *,
    trial_name: str = "trial",
    result: dict | None = None,
    manifest: dict = MANIFEST,
    trajectory: dict | None = None,
    write_result: bool = True,
) -> None:
    trial = root / trial_name
    trial.mkdir()
    (trial / "config.json").write_text(
        json.dumps(
            {
                "agent": {"kwargs": {"pi_evals": manifest}},
                "task": {"path": "suite/task"},
                "trial_name": trial_name,
            }
        )
    )
    if write_result:
        (trial / "result.json").write_text(
            json.dumps(
                result
                or {
                    "trial_name": trial_name,
                    "task_name": "task",
                    "verifier_result": {
                        "rewards": {
                            "quality": 1,
                            "valid_experiment": 1,
                            "reward": 1,
                        }
                    },
                }
            )
        )
    if trajectory is not None:
        steps = (result or {}).get("step_results") or []
        path = trial / "agent" / "trajectory.json"
        if steps:
            path = (
                trial / "steps" / steps[-1]["step_name"] / "agent" / "trajectory.json"
            )
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(trajectory))
