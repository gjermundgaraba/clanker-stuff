from __future__ import annotations

from typing import Any


Manifest = dict[str, str | None]
_KEYS = {"platform", "compaction_mode", "expected_mechanism", "expected_protocol"}
CONTROLLED_COMPACTION_MARKER = "<!-- pi-evals:compact-before -->\n"


def controlled_instruction(instruction: str, mode: str) -> tuple[str, bool]:
    marked = instruction.startswith(CONTROLLED_COMPACTION_MARKER)
    if CONTROLLED_COMPACTION_MARKER in instruction[len(CONTROLLED_COMPACTION_MARKER) :]:
        raise ValueError("controlled compaction marker must be the first line")
    if not marked and CONTROLLED_COMPACTION_MARKER in instruction:
        raise ValueError("controlled compaction marker must be the first line")
    return (
        instruction.removeprefix(CONTROLLED_COMPACTION_MARKER),
        marked and mode == "on",
    )


def validate_manifest(value: Any) -> Manifest:
    """Validate the provenance contract recorded in every trajectory."""
    if not isinstance(value, dict) or set(value) != _KEYS:
        raise ValueError(
            f"pi_evals manifest must have exactly these keys: {sorted(_KEYS)}"
        )
    platform = value["platform"]
    mode = value["compaction_mode"]
    mechanism = value["expected_mechanism"]
    protocol = value["expected_protocol"]
    if not isinstance(platform, str) or not platform.strip():
        raise ValueError("pi_evals platform must be a nonempty string")
    if mode not in {"off", "on"}:
        raise ValueError("pi_evals compaction_mode must be 'off' or 'on'")
    if not isinstance(mechanism, str) or not mechanism.strip():
        raise ValueError("pi_evals expected_mechanism must be a nonempty string")
    if protocol is not None and (
        not isinstance(protocol, str) or not protocol.strip()
    ):
        raise ValueError("pi_evals expected_protocol must be a nonempty string or null")
    return {
        "platform": platform,
        "compaction_mode": mode,
        "expected_mechanism": mechanism,
        "expected_protocol": protocol,
    }
