"""Strict LongMemEval judge-cache I/O shared by judging and reporting."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

CONDITION_TIERS = {
    "evidence": {None},
    "full": {"64k", "115k"},
    "handoff": {"115k"},
}
QUESTION_TYPES = {
    "knowledge-update",
    "multi-session",
    "single-session-assistant",
    "single-session-preference",
    "single-session-user",
    "temporal-reasoning",
}
BACKENDS = {"codex", "openai"}
ROW_KEYS = {
    "abstention",
    "condition",
    "hypothesis",
    "judge_backend",
    "judge_model",
    "judge_response",
    "label",
    "prompt_sha256",
    "question_id",
    "question_type",
    "task",
    "tier",
    "trial",
}
IDENTITY_KEYS = ROW_KEYS - {"judge_response", "label"}


def condition_tier(item: Mapping[str, Any]) -> tuple[str, str | None]:
    condition, tier = item.get("condition"), item.get("tier")
    if condition not in CONDITION_TIERS or tier not in CONDITION_TIERS[condition]:
        raise ValueError(f"invalid LongMemEval condition/tier: {condition}/{tier}")
    return condition, tier


def label(response: str) -> bool:
    value = response.strip().casefold()
    if value == "yes":
        return True
    if value == "no":
        return False
    raise ValueError(f"judge response must be exactly yes or no, got {response!r}")


def _nonempty_string(row: Mapping[str, Any], key: str) -> None:
    if not isinstance(row.get(key), str) or not row[key].strip():
        raise ValueError(f"judge cache {key} must be a non-empty string")


def validate_row(
    value: object,
    *,
    backend: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("judge cache row must be an object")
    if set(value) != ROW_KEYS:
        missing, extra = sorted(ROW_KEYS - set(value)), sorted(set(value) - ROW_KEYS)
        raise ValueError(f"invalid judge cache keys: missing={missing}, extra={extra}")
    row = dict(value)
    condition_tier(row)
    for key in (
        "judge_backend",
        "judge_model",
        "judge_response",
        "question_id",
        "question_type",
        "task",
        "trial",
    ):
        _nonempty_string(row, key)
    if not isinstance(row["hypothesis"], str):
        raise ValueError("judge cache hypothesis must be a string")
    if row["judge_backend"] not in BACKENDS:
        raise ValueError(f"unsupported judge backend: {row['judge_backend']!r}")
    if row["question_type"] not in QUESTION_TYPES:
        raise ValueError(
            f"unsupported LongMemEval question type: {row['question_type']!r}"
        )
    if not isinstance(row["abstention"], bool):
        raise ValueError("judge cache abstention must be boolean")
    if not isinstance(row["label"], bool):
        raise ValueError("judge cache label must be boolean")
    if not isinstance(row["prompt_sha256"], str) or not re.fullmatch(
        r"[0-9a-f]{64}", row["prompt_sha256"]
    ):
        raise ValueError("judge cache prompt_sha256 must be lowercase SHA-256")
    if label(row["judge_response"]) is not row["label"]:
        raise ValueError("judge response and label disagree")
    if backend is not None and row["judge_backend"] != backend:
        raise ValueError(
            f"judge cache backend is {row['judge_backend']!r}, expected {backend!r}"
        )
    if model is not None and row["judge_model"] != model:
        raise ValueError(
            f"judge cache model is {row['judge_model']!r}, expected {model!r}"
        )
    return row


def same_identity(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    return all(left.get(key) == right.get(key) for key in IDENTITY_KEYS)


def load_cache(
    path: Path,
    *,
    backend: str | None = None,
    model: str | None = None,
) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    observed_backend, observed_model = backend, model
    if not path.exists():
        return rows
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            row = validate_row(
                json.loads(line),
                backend=observed_backend,
                model=observed_model,
            )
        except (json.JSONDecodeError, ValueError) as error:
            raise ValueError(f"{path}:{number}: {error}") from error
        observed_backend, observed_model = row["judge_backend"], row["judge_model"]
        trial = row["trial"]
        if trial in rows:
            raise ValueError(f"{path}: duplicate judge trial {trial}")
        rows[trial] = row
    return rows


def write_cache(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    values, trials = [], set()
    for item in rows:
        row = validate_row(dict(item))
        if row["trial"] in trials:
            raise ValueError(f"duplicate judge trial {row['trial']}")
        trials.add(row["trial"])
        values.append(row)
    values.sort(key=lambda row: row["trial"])
    if values:
        backend, model = values[0]["judge_backend"], values[0]["judge_model"]
        for row in values[1:]:
            validate_row(row, backend=backend, model=model)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in values),
        encoding="utf-8",
    )
    temporary.replace(path)
