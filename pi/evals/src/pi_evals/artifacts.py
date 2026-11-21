from __future__ import annotations
import hashlib
import json
from pathlib import Path
from typing import Any

from harbor.lint import LintRule, lint_task
from harbor.lint.models import DEFAULT_RULES

EVALS = Path(__file__).resolve().parents[2]


def write_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def task_hashes(task: Path) -> dict[str, str]:
    return {
        str(path.relative_to(task)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(task.rglob("*"))
        if path.is_file() and "__pycache__" not in path.parts
    }


def require_frozen_sources(
    frozen: dict[str, dict[str, str]], current: dict[str, dict[str, str]]
) -> None:
    """Name each execution source that changed since the series was prepared."""

    def paths(sources: dict[str, dict[str, str]]) -> dict[str, str]:
        return {
            Path(root, name).as_posix(): digest
            for root, files in sources.items()
            for name, digest in files.items()
        }

    before, after = paths(frozen), paths(current)
    changed = sorted(
        path for path in before.keys() | after.keys() if before.get(path) != after.get(path)
    )
    if changed:
        raise ValueError(
            f"frozen source changed: {', '.join(changed)}. This series cannot "
            "continue; prepare a new series in a new output directory."
        )


def lint_generated_task(task: Path) -> None:
    """Fail on Harbor's default `harbor lint` findings before any trial runs."""
    # Our verifiers check the agent's runtime evidence, so they share its sandbox.
    findings = lint_task(task, selected_rules=DEFAULT_RULES - {LintRule.SHARED_VERIFIER})
    if findings:
        raise ValueError(
            f"harbor lint rejected {task}: "
            + "; ".join(f"[{f.rule}] {f.path}: {f.message}" for f in findings)
        )
