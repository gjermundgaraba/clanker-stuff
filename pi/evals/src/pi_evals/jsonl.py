"""Strict object records separated by literal LF, with physical-line diagnostics."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def read_jsonl_objects(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{number}: invalid JSON") from error
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{number}: expected an object")
        records.append(value)
    return records
