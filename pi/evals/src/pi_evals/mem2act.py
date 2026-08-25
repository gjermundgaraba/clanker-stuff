from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

PIN_PATH = Path(__file__).parents[2] / "benchmarks" / "mem2act.json"
LEVELS = ("L1", "L2", "L3", "L4")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
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


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_sources(pin: dict[str, Any], cache_dir: Path) -> dict[str, Path]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    result: dict[str, Path] = {}
    for filename, metadata in pin["files"].items():
        target = cache_dir / filename
        expected = metadata["sha256"]
        if not target.exists() or _sha256(target) != expected:
            request = urllib.request.Request(
                metadata["url"], headers={"User-Agent": "pi-evals-mem2act"}
            )
            with urllib.request.urlopen(request, timeout=120) as response:
                with tempfile.NamedTemporaryFile(dir=cache_dir, delete=False) as output:
                    temporary = Path(output.name)
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
            if _sha256(temporary) != expected:
                temporary.unlink()
                raise ValueError(f"sha256 mismatch for {filename}")
            temporary.replace(target)
        result[filename] = target
    return result


def resolve_records(
    qas: list[dict[str, Any]], sessions: list[dict[str, Any]]
) -> tuple[list[tuple[dict[str, Any], dict[str, Any]]], list[str]]:
    qa_ids = [qa.get("qa_id") for qa in qas]
    session_ids = [session.get("session_id") for session in sessions]
    if len(set(qa_ids)) != len(qa_ids) or not all(isinstance(x, str) for x in qa_ids):
        raise ValueError("qa_id values must be unique strings")
    if len(set(session_ids)) != len(session_ids) or not all(
        isinstance(x, str) for x in session_ids
    ):
        raise ValueError("session_id values must be unique strings")

    source_sets: list[set[str]] = []
    for session in sessions:
        declared = session.get("original_conversation_ids")
        turns = session.get("turns")
        if not isinstance(declared, list) or not isinstance(turns, list):
            raise ValueError(f"invalid session {session['session_id']}")
        actual = {
            turn.get("source_id")
            for turn in turns
            if isinstance(turn, dict) and isinstance(turn.get("source_id"), str)
        }
        source_sets.append(set(declared) & actual)

    resolved: list[tuple[dict[str, Any], dict[str, Any]]] = []
    skipped: list[str] = []
    for qa in qas:
        sources = qa.get("source_conversation_ids")
        if not isinstance(sources, list) or not sources or not all(
            isinstance(source, str) for source in sources
        ):
            skipped.append(qa["qa_id"])
            continue
        required = set(sources)
        matches = [index for index, available in enumerate(source_sets) if required <= available]
        if len(matches) == 1:
            resolved.append((qa, sessions[matches[0]]))
        else:
            skipped.append(qa["qa_id"])
    return resolved, skipped


def stratified_sample(
    resolved: list[tuple[dict[str, Any], dict[str, Any]]], size: int, seed: str
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    groups: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {
        level: [] for level in LEVELS
    }
    for pair in resolved:
        level = pair[0].get("complexity_metadata", {}).get("level")
        if level not in groups:
            raise ValueError(f"unknown complexity level: {level}")
        groups[level].append(pair)
    for level, group in groups.items():
        group.sort(
            key=lambda pair: (
                hashlib.sha256(
                    f"{seed}:{level}:{pair[0]['qa_id']}".encode()
                ).hexdigest(),
                pair[0]["qa_id"],
            )
        )

    selected: list[tuple[dict[str, Any], dict[str, Any]]] = []
    index = 0
    while len(selected) < size:
        before = len(selected)
        for level in LEVELS:
            if index < len(groups[level]) and len(selected) < size:
                selected.append(groups[level][index])
        if len(selected) == before:
            raise ValueError(f"cannot select {size} records from {len(resolved)}")
        index += 1
    return selected


def _pointer(part: str) -> str:
    return part.replace("~", "~0").replace("/", "~1")


def typed_leaves(value: Any, path: str = "") -> set[tuple[str, str, str]]:
    if isinstance(value, dict):
        if not value:
            return {(path, "object", "{}")}
        leaves: set[tuple[str, str, str]] = set()
        for key, child in value.items():
            leaves |= typed_leaves(child, f"{path}/{_pointer(str(key))}")
        return leaves
    if isinstance(value, list):
        if not value:
            return {(path, "array", "[]")}
        leaves = set()
        for index, child in enumerate(value):
            leaves |= typed_leaves(child, f"{path}/{index}")
        return leaves
    kind = (
        "null"
        if value is None
        else "boolean"
        if isinstance(value, bool)
        else "number"
        if isinstance(value, (int, float))
        else "string"
    )
    rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return {(path, kind, rendered)}


def score_call(predicted: dict[str, Any] | None, gold: dict[str, Any]) -> dict[str, float]:
    predicted_arguments = predicted.get("arguments") if predicted else None
    if not isinstance(predicted_arguments, dict):
        return {"exact_arguments": 0.0, "parameter_f1": 0.0}
    actual = typed_leaves(predicted_arguments)
    expected = typed_leaves(gold["arguments"])
    if not actual and not expected:
        parameter_f1 = 1.0
    else:
        overlap = len(actual & expected)
        parameter_f1 = 2 * overlap / (len(actual) + len(expected))
    exact = float(
        json.dumps(predicted_arguments, sort_keys=True, separators=(",", ":"))
        == json.dumps(gold["arguments"], sort_keys=True, separators=(",", ":"))
    )
    return {"exact_arguments": exact, "parameter_f1": parameter_f1}


def _grader(gold: dict[str, Any]) -> str:
    encoded = json.dumps(gold, ensure_ascii=False, separators=(",", ":"))
    return f'''import {{ existsSync, readFileSync, writeFileSync }} from "node:fs";

const gold = {encoded};
const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const pointer = (part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1");
function leaves(value, path = "", result = new Set()) {{
  if (Array.isArray(value)) {{
    if (value.length === 0) result.add(JSON.stringify([path, "array", "[]"]));
    value.forEach((child, index) => leaves(child, `${{path}}/${{index}}`, result));
  }} else if (value && typeof value === "object") {{
    const keys = Object.keys(value);
    if (keys.length === 0) result.add(JSON.stringify([path, "object", "{{}}"]));
    keys.forEach((key) => leaves(value[key], `${{path}}/${{pointer(key)}}`, result));
  }} else {{
    const type = value === null ? "null" : typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
    result.add(JSON.stringify([path, type, JSON.stringify(value)]));
  }}
  return result;
}}
let predicted = null;
if (existsSync("/app/.mem2act-calls.jsonl")) {{
  const lines = readFileSync("/app/.mem2act-calls.jsonl", "utf8").trim().split("\\n");
  if (lines.length === 1) try {{ predicted = JSON.parse(lines[0]); }} catch {{}}
}}
let parameterF1 = 0;
let exactArguments = 0;
if (predicted?.arguments && !Array.isArray(predicted.arguments) && typeof predicted.arguments === "object") {{
  const actual = leaves(predicted.arguments);
  const expected = leaves(gold);
  const overlap = [...actual].filter((leaf) => expected.has(leaf)).length;
  parameterF1 = actual.size + expected.size === 0 ? 1 : 2 * overlap / (actual.size + expected.size);
  exactArguments = Number(JSON.stringify(canonical(predicted.arguments)) === JSON.stringify(canonical(gold)));
}}
writeFileSync("/logs/verifier/reward.json", JSON.stringify({{
  reward: exactArguments,
  exact_arguments: exactArguments,
  parameter_f1: parameterF1,
}}));
'''


def write_tasks(
    selected: list[tuple[dict[str, Any], dict[str, Any]]], output: Path
) -> None:
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError(f"output directory is not empty: {output}")
    for qa, session in selected:
        task = output / qa["qa_id"]
        (task / "environment").mkdir(parents=True)
        (task / "tests").mkdir()
        (task / "task.toml").write_text(
            f'''schema_version = "1.4"

[task]
name = "pi-evals/mem2act-{qa['qa_id']}"
description = "Ground arguments for a known tool from raw conversation memory."
keywords = ["memory", "argument-grounding"]

[metadata]
category = "mem2act"
tags = ["memory", "argument-grounding"]

[agent]
timeout_sec = 300.0

[verifier]
timeout_sec = 120.0

[environment]
docker_image = "clanker-pi-evals:node26"
workdir = "/app"
build_timeout_sec = 600.0
cpus = 2
memory_mb = 2048
storage_mb = 10240
gpus = 0
''',
            encoding="utf-8",
        )
        memory = json.dumps(session["turns"], ensure_ascii=False, separators=(",", ":"))
        (task / "instruction.md").write_text(
            "Use the raw conversation memory below to answer the current query. "
            "Inspect the public tool schema with `mem2act describe`, then make exactly "
            "one call with `mem2act call --arguments JSON`.\n\n"
            f"Raw memory:\n```json\n{memory}\n```\n\nCurrent query:\n{qa['query']}\n",
            encoding="utf-8",
        )
        (task / "environment" / ".mem2act-schema.json").write_text(
            json.dumps(
                qa["target_tool_schema"],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        (task / "tests" / "grade.mjs").write_text(
            _grader(qa["tool_call"]["arguments"]),
            encoding="utf-8",
        )
        test_script = task / "tests" / "test.sh"
        test_script.write_text(
            "#!/usr/bin/env bash\nset -eu\nnode /tests/grade.mjs\n", encoding="utf-8"
        )
        test_script.chmod(0o755)


def prepare(selection: str, output: Path, cache_dir: Path, pin_path: Path = PIN_PATH) -> None:
    pin = json.loads(pin_path.read_text(encoding="utf-8"))
    paths = download_sources(pin, cache_dir)
    qas = read_jsonl(paths["qa_dataset.jsonl"])
    sessions = read_jsonl(paths["toolmem_conversation.jsonl"])
    resolved, skipped = resolve_records(qas, sessions)
    if len(resolved) != pin["resolved_count"] or skipped != pin["skipped_qa_ids"]:
        raise ValueError("upstream Mem2Act join no longer matches pinned selection")
    print(f"skipped unresolved QA IDs ({len(skipped)}): {','.join(skipped)}", file=sys.stderr)
    selected = (
        resolved
        if selection == "full"
        else stratified_sample(resolved, pin["sample_size"], pin["sample_seed"])
    )
    if selection == "sample" and [pair[0]["qa_id"] for pair in selected] != pin["sample_qa_ids"]:
        raise ValueError("sample no longer matches pinned selection")
    write_tasks(selected, output)
    print(f"generated {len(selected)} Mem2Act tasks in {output}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and prepare pinned Mem2Act tasks")
    parser.add_argument("--selection", choices=("sample", "full"), default="sample")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path.home() / ".cache" / "pi-evals" / "mem2act",
    )
    args = parser.parse_args()
    prepare(args.selection, args.output, args.cache_dir)


if __name__ == "__main__":
    main()
