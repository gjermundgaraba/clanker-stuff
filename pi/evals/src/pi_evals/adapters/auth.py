from __future__ import annotations

import json
from pathlib import Path


def require_auth_file(
    path: Path, credential_paths: tuple[tuple[str, ...], ...]
) -> Path:
    path = path.expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"Auth file not found: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Auth file is not valid JSON: {path}") from error
    for keys in credential_paths:
        credential = value
        for key in keys:
            if not isinstance(credential, dict):
                break
            credential = credential.get(key)
        if isinstance(credential, str) and credential.strip():
            return path
    raise ValueError(f"Auth file contains no usable credential: {path}")
