"""Scaling presentation; never consulted to authorize model spending."""

import json
from pathlib import Path
from statistics import fmean
from pi_evals.artifacts import EVALS, task_hashes, write_json
from pi_evals.runtime import ARMS, LABELS
from pi_evals.scaling_state import read_slot


def report(output: Path):
    result = {
        "rows": [
            read_slot(output, entry)
            for entry in json.loads((output / "schedule.json").read_text())
        ],
        "analysis_provenance": task_hashes(EVALS / "src"),
        "series": json.loads((output / "series.json").read_text()),
    }
    metrics = (
        "agent_seconds",
        "wall_seconds",
        "total_cost",
        "ordinary_requests",
        "input",
        "cache",
        "output",
        "underlying_operations",
    )
    groups = []
    for size in result["series"]["sizes"]:
        for arm in ARMS:
            selected = [
                r for r in result["rows"] if r["size"] == size and r["arm"] == arm
            ]
            groups.append(
                {
                    "size": size,
                    "arm": arm,
                    "label": LABELS[arm],
                    "scheduled": len(selected),
                    "correct_valid": sum(
                        r["status"] == "completed"
                        and r["valid"] == 1
                        and r["quality"] == 1
                        for r in selected
                    ),
                    **{
                        k: fmean(r[k] for r in selected)
                        if all(r.get(k) is not None for r in selected)
                        else None
                        for k in metrics
                    },
                }
            )
    result["groups"] = groups
    result["caveats"] = [
        "Two matched fixture seeds per size; exploratory evidence, not precise confidence intervals.",
        "All three arms share each fixture and image. All six order permutations used across fixture blocks.",
        "Concurrency is capped at one. Record count, pages and total noise grow jointly; not an independent noise/concurrency ablation.",
        "Pi Code Mode sees parsed objects; direct/native see JSON strings. Native prompts and helpers differ.",
        "API list-price costs are estimates, not billing. Failed or incomplete trials are retained.",
    ]
    write_json(output / "report.json", result)
    return result
