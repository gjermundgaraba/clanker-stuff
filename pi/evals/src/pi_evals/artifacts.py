"""Small shared helpers for evaluation artifacts and provenance."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
from typing import Any

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
