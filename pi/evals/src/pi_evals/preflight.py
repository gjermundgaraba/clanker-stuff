"""Repeatable no-model checks, independent of immutable model attempts."""

from pathlib import Path
import json

from pi_evals.artifacts import write_json


def run_preflight(output: Path, frozen: dict, check) -> None:
    passed = output / "preflight-passed.json"
    if passed.exists():
        if json.loads(passed.read_text()) != frozen:
            raise ValueError("preflight inputs changed")
        return

    root = output / "preflight"
    root.mkdir(exist_ok=True)
    attempts = sorted(root.glob("attempt-*"))
    number = int(attempts[-1].name.removeprefix("attempt-")) + 1 if attempts else 1
    attempt = root / f"attempt-{number:04d}"
    attempt.mkdir()
    write_json(attempt / "inputs.json", frozen)
    write_json(attempt / "status.json", {"state": "running"})
    try:
        check(attempt)
    except BaseException as error:
        write_json(attempt / "status.json", {"state": "failed", "error": str(error)})
        raise
    write_json(attempt / "status.json", {"state": "succeeded"})
    write_json(passed, frozen)
