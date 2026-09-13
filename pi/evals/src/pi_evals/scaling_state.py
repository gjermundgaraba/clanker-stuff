"""Scaling trial evidence used by execution gates and reports."""

import json
from pathlib import Path
from pi_evals.trials import rows
from pi_evals.runtime import LABELS


def read_slot(output: Path, entry: dict) -> dict:
    job = output / "jobs" / entry["job_name"]
    found = rows(job)
    if len(found) > 1:
        raise ValueError("multiple trials for scheduled entry")
    row = (
        found[0] if found else {"status": "incomplete", "quality": None, "valid": None}
    )
    row.update(
        {
            key: entry[key]
            for key in ("job_name", "task", "arm", "size", "replicate", "seed")
        }
    )
    row["label"] = LABELS[entry["arm"]]
    for name, key in (("reward", "scores"), ("metrics", "service_metrics")):
        files = list(job.glob(f"*/verifier/{name}.json"))
        row[key] = json.loads(files[0].read_text()) if len(files) == 1 else {}
    return row
