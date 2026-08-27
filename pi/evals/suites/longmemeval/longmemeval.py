from __future__ import annotations

import hashlib
import json
import os
import shutil
import urllib.request
from bisect import bisect_left
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from itertools import pairwise
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

from pi_evals.protocol import CONTROLLED_COMPACTION_MARKER

COMPACTION_VERIFIER = Path(__file__).resolve().parents[2] / "verifiers/compaction.mjs"

PROTOCOL_VERSION = 2
TIER_STEPS = {64_000: 6, 115_000: 10}
CONDITIONS = ("full", "evidence", "handoff")
SELECTION_SEED = "clanker-stuff-longmemeval-v1"
HISTORY_PREFIX = (
    "The following dated chats are part of the user's prior conversation history. "
    "Retain all history blocks for the final question. Do not inspect or edit files. "
    "Reply only with `HISTORY-RECORDED`."
)


def get_encoder() -> Any:
    try:
        import tiktoken
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "LongMemEval preparation requires tiktoken; run `uv sync` in pi/evals."
        ) from error
    return tiktoken.get_encoding("o200k_base")


def _rank(seed: str, *parts: str) -> bytes:
    return hashlib.sha256("\0".join((seed, *parts)).encode()).digest()


def select_records(
    records: Iterable[dict[str, Any]],
    per_type: int = 5,
    seed: str = SELECTION_SEED,
) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[record["question_type"]].append(record)

    selected = []
    for question_type in sorted(grouped):
        candidates = sorted(
            grouped[question_type],
            key=lambda row: _rank(seed, row["question_id"]),
        )
        abstentions = [
            row for row in candidates if row["question_id"].endswith("_abs")
        ]
        answerable = [
            row for row in candidates if not row["question_id"].endswith("_abs")
        ]
        chosen = abstentions[:1] + answerable[: per_type - bool(abstentions)]
        if len(chosen) != per_type:
            raise ValueError(f"{question_type} has fewer than {per_type} usable records")
        selected.extend(chosen)
    return selected


def _chronological_indices(
    record: dict[str, Any], indices: Iterable[int]
) -> tuple[int, ...]:
    return tuple(
        sorted(indices, key=lambda index: (record["haystack_dates"][index], index))
    )


def _session_text(record: dict[str, Any], index: int) -> str:
    turns = "\n".join(
        f"{turn['role']}: {str(turn['content']).strip()}"
        for turn in record["haystack_sessions"][index]
    )
    return f"\n\n### Prior chat\nDate: {record['haystack_dates'][index]}\n{turns}"


def history_instruction(record: dict[str, Any], indices: Iterable[int]) -> str:
    ordered = _chronological_indices(record, indices)
    return HISTORY_PREFIX + "".join(_session_text(record, index) for index in ordered)


def _balanced_groups(
    record: dict[str, Any],
    indices: Iterable[int],
    encoder: Any,
    chunk_count: int,
) -> tuple[tuple[int, ...], ...]:
    ordered = _chronological_indices(record, indices)
    if chunk_count < 1:
        raise ValueError("history chunk count must be positive")
    if len(ordered) < chunk_count:
        raise ValueError(
            f"cannot split {len(ordered)} history sessions into {chunk_count} chunks"
        )

    cumulative = [0]
    for index in ordered:
        cumulative.append(
            cumulative[-1] + len(encoder.encode(_session_text(record, index)))
        )

    cuts = []
    previous = 0
    total = cumulative[-1]
    for chunk_index in range(1, chunk_count):
        target = total * chunk_index / chunk_count
        minimum = previous + 1
        maximum = len(ordered) - (chunk_count - chunk_index)
        insertion = bisect_left(cumulative, target, minimum, maximum + 1)
        candidates = {
            min(maximum, max(minimum, insertion)),
            min(maximum, max(minimum, insertion - 1)),
        }
        cut = min(candidates, key=lambda value: (abs(cumulative[value] - target), value))
        cuts.append(cut)
        previous = cut

    boundaries = (0, *cuts, len(ordered))
    return tuple(
        ordered[start:end] for start, end in pairwise(boundaries)
    )


def history_chunks(
    record: dict[str, Any],
    indices: Iterable[int],
    encoder: Any,
    chunk_count: int,
) -> tuple[str, ...]:
    return tuple(
        history_instruction(record, group)
        for group in _balanced_groups(record, indices, encoder, chunk_count)
    )


def query_instruction(record: dict[str, Any]) -> str:
    return (
        "Using only the chat history from the previous steps, answer the question "
        "below. Put only the answer in your final response, with no explanation.\n\n"
        f"Current date: {record['question_date']}\n"
        f"Question: {record['question']}"
    )


def tier_indices(
    record: dict[str, Any],
    evidence_session_ids: Iterable[str],
    encoder: Any,
    tier_steps: Mapping[int, int] = TIER_STEPS,
) -> dict[int, tuple[int, ...]]:
    session_ids = record["haystack_session_ids"]
    evidence = set(evidence_session_ids)
    missing = evidence.difference(session_ids)
    if missing:
        raise ValueError(f"missing evidence sessions: {sorted(missing)}")

    required = {
        index for index, session_id in enumerate(session_ids) if session_id in evidence
    }
    selected = set(required)
    output = {}
    tiers = sorted(tier_steps.items())

    def rendered_tokens(indices: set[int], history_steps: int) -> int:
        history = 0
        if indices:
            history = sum(
                len(encoder.encode(instruction))
                for instruction in history_chunks(
                    record,
                    indices,
                    encoder,
                    min(history_steps, len(indices)),
                )
            )
        return history + len(encoder.encode(query_instruction(record)))

    for budget, history_steps in tiers:
        if rendered_tokens(selected, history_steps) > budget:
            raise ValueError(f"evidence alone exceeds the {budget}-token tier")
        filler_indices = sorted(
            (index for index in range(len(session_ids)) if index not in required),
            key=lambda index: _rank(
                SELECTION_SEED, record["question_id"], session_ids[index]
            ),
        )
        for index in filler_indices:
            if index in selected:
                continue
            candidate = selected | {index}
            if rendered_tokens(candidate, history_steps) <= budget:
                selected.add(index)
        if len(selected) < history_steps:
            raise ValueError(
                f"{budget}-token tier has fewer sessions than its {history_steps} steps"
            )
        output[budget] = _chronological_indices(record, selected)
    return output


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_sources(
    cache_dir: Path,
    data_repo: str,
    data_revision: str,
    source_files: Mapping[str, str],
) -> dict[str, Path]:
    for filename in source_files:
        if filename in {"", ".", ".."} or Path(filename).name != filename:
            raise ValueError(
                f"LongMemEval source filename must be a basename: {filename}"
            )

    cache_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    base_url = f"{data_repo.rstrip('/')}/resolve/{data_revision}"
    for filename, expected_sha in source_files.items():
        path = cache_dir / filename
        if path.is_symlink() or not path.exists() or _sha256(path) != expected_sha:
            temporary = None
            try:
                with urllib.request.urlopen(f"{base_url}/{filename}") as source:
                    with NamedTemporaryFile(
                        "wb",
                        dir=cache_dir,
                        prefix=f".{filename}.",
                        suffix=".part",
                        delete=False,
                    ) as destination:
                        temporary = Path(destination.name)
                        shutil.copyfileobj(source, destination)
            except Exception as error:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
                raise RuntimeError(
                    f"failed to download pinned LongMemEval {filename}: {error}"
                ) from error
            try:
                if _sha256(temporary) != expected_sha:
                    raise RuntimeError(
                        f"checksum mismatch for pinned LongMemEval {filename}"
                    )
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        paths[filename] = path
    return paths


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _task_toml(
    ordinal: int,
    condition: str,
    tier: str | None,
    step_names: Sequence[str],
    expected_compaction_after_segment: int | None,
) -> str:
    suffix = f"-{tier}" if tier else ""
    metadata = f'condition = "{condition}"\n'
    if tier:
        metadata += f'tier = "{tier}"\n'
    if expected_compaction_after_segment is not None:
        metadata += (
            "expected_compaction_after_segment = "
            f"{expected_compaction_after_segment}\n"
        )
    steps = "".join(
        f'''\n[[steps]]
name = "{name}"
[steps.agent]
timeout_sec = 600.0
[steps.verifier]
timeout_sec = 60.0
'''
        for name in step_names
    )
    return f'''schema_version = "1.4"
multi_step_reward_strategy = "final"

[task]
name = "pi-evals/longmemeval-{condition}{suffix}-{ordinal:02d}"
description = "Answer one memory question from a supplied dated chat history."
keywords = ["long-context", "memory", "multi-step"]

[metadata]
difficulty = "hard"
category = "context-management"
tags = ["long-context", "memory"]
{metadata}
[environment]
docker_image = "clanker-pi-evals:node26"
workdir = "/app"
build_timeout_sec = 600.0
cpus = 2
memory_mb = 2048
storage_mb = 10240
gpus = 0
{steps}

[[steps]]
name = "query"
[steps.agent]
timeout_sec = 600.0
[steps.verifier]
timeout_sec = 60.0
'''


def _grader() -> str:
    return '''import { readFileSync, writeFileSync } from "node:fs";
import { validateCompaction } from "./compaction.mjs";

let trajectory = {};
try {
  trajectory = JSON.parse(readFileSync("/logs/agent/trajectory.json", "utf-8"));
} catch {}
const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
const queryIndex = steps.findLastIndex((step) => step.source === "user");
const answerIndex = steps.findIndex(
  (step, index) =>
    index > queryIndex &&
    step.source === "agent" &&
    step.extra?.event_type === undefined &&
    typeof step.message === "string"
);
const hypothesis =
  steps
    .slice(queryIndex + 1)
    .findLast(
      (step) =>
        step.source === "agent" &&
        step.extra?.event_type === undefined &&
        typeof step.message === "string" &&
        step.message.trim().length > 0
    )?.message ?? "";
writeFileSync("/logs/verifier/hypothesis.txt", hypothesis);
const gold = JSON.parse(readFileSync("/tests/gold.json", "utf-8"));
const normalize = (value) =>
  String(value).normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\\s+/gu, " ");
const agentResponse = Number(hypothesis.trim().length > 0);
const quality = Number(agentResponse && normalize(hypothesis) === normalize(gold.answer));
const compaction = validateCompaction(trajectory, {
  expectedSegments: gold.expected_compaction_after_segment === null
    ? []
    : [gold.expected_compaction_after_segment],
});
writeFileSync(
  "/logs/verifier/reward.json",
  JSON.stringify({
    agent_response: agentResponse,
    answer_after_query: Number(answerIndex > queryIndex),
    quality,
    reward: quality,
    ...compaction,
  })
);
'''


def _write_task(
    task: Path,
    *,
    ordinal: int,
    condition: str,
    tier: str | None,
    steps: Sequence[tuple[str, str]],
    expected_compaction_after_segment: int | None,
    record: dict[str, Any],
    gold: dict[str, Any],
) -> None:
    shutil.rmtree(task, ignore_errors=True)
    (task / "environment").mkdir(parents=True, exist_ok=True)
    _write(
        task / "task.toml",
        _task_toml(
            ordinal,
            condition,
            tier,
            [name for name, _instruction in steps],
            expected_compaction_after_segment,
        ),
    )
    compact_before = (
        expected_compaction_after_segment + 1
        if expected_compaction_after_segment is not None
        else None
    )
    for index, (name, instruction) in enumerate(steps):
        step = task / f"steps/{name}"
        if index == compact_before:
            instruction = f"{CONTROLLED_COMPACTION_MARKER}{instruction}"
        _write(step / "instruction.md", instruction)
        _write(step / "solution/solve.sh", "#!/usr/bin/env bash\ntrue\n")
        _write(
            step / "tests/test.sh",
            "#!/usr/bin/env bash\necho 1 > /logs/verifier/reward.txt\n",
        )

    query = task / "steps/query"
    instruction = query_instruction(record)
    if compact_before == len(steps):
        instruction = f"{CONTROLLED_COMPACTION_MARKER}{instruction}"
    _write(query / "instruction.md", instruction)
    _write(
        query / "solution/solve.sh",
        "#!/usr/bin/env bash\nset -eu\nmkdir -p /logs/agent\n"
        "node -e 'const g=require(\"/tests/gold.json\");"
        "const expected=g.expected_compaction_after_segment;"
        "const pi_evals=expected===null?{platform:\"oracle\",compaction_mode:\"off\",expected_mechanism:\"oracle\",expected_protocol:null}:{platform:\"oracle\",compaction_mode:\"on\",expected_mechanism:\"oracle\",expected_protocol:null};"
        "const steps=expected===null?[]:[{step_id:1,source:\"agent\",extra:{event_type:\"context_compaction\",state:\"succeeded\",compacted_after_segment:expected,mechanism:\"oracle\",protocol:null}}];"
        "require(\"fs\").writeFileSync(\"/logs/agent/trajectory.json\","
        "JSON.stringify({schema_version:\"ATIF-v1.7\",session_id:\"oracle\","
        "agent:{name:\"oracle\",version:\"1\",extra:{pi_evals}},steps:[...steps,{step_id:2,source:\"user\","
        "message:\"query\"},{step_id:3,source:\"agent\",message:String(g.answer)}]}))'\n",
    )
    _write(
        query / "tests/gold.json",
        json.dumps(
            {
                "abstention": record["question_id"].endswith("_abs"),
                "answer": gold["answer"],
                "condition": condition,
                "expected_compaction_after_segment": (
                    expected_compaction_after_segment
                ),
                "question": gold["question"],
                "question_id": record["question_id"],
                "question_type": gold["question_type"],
                "tier": tier,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
    )
    _write(query / "tests/grade.mjs", _grader())
    _write(
        query / "tests/compaction.mjs",
        COMPACTION_VERIFIER.read_text(encoding="utf-8"),
    )
    _write(
        query / "tests/test.sh",
        "#!/usr/bin/env bash\nset -eu\nnode /tests/grade.mjs\n",
    )
    for script in task.rglob("*.sh"):
        script.chmod(0o755)


def generate_tasks(
    records: Iterable[dict[str, Any]],
    oracle_records: Iterable[dict[str, Any]],
    question_ids: Iterable[str],
    output_dir: Path,
    encoder: Any,
) -> int:
    source = {record["question_id"]: record for record in records}
    oracle = {record["question_id"]: record for record in oracle_records}
    shutil.rmtree(output_dir, ignore_errors=True)
    count = 0

    for ordinal, question_id in enumerate(question_ids):
        record = source[question_id]
        gold = oracle[question_id]
        for field in ("answer", "question", "question_type"):
            if record[field] != gold[field]:
                raise ValueError(f"source/oracle mismatch for {question_id}: {field}")
        evidence_ids = gold["answer_session_ids"]
        if set(record["answer_session_ids"]) != set(evidence_ids):
            raise ValueError(f"source/oracle evidence IDs differ for {question_id}")
        source_sessions = {
            session_id: session
            for session_id, session in zip(
                record["haystack_session_ids"],
                record["haystack_sessions"],
                strict=True,
            )
        }
        oracle_sessions = {
            session_id: session
            for session_id, session in zip(
                gold["haystack_session_ids"],
                gold["haystack_sessions"],
                strict=True,
            )
        }
        for evidence_id in evidence_ids:
            if source_sessions.get(evidence_id) != oracle_sessions.get(evidence_id):
                raise ValueError(
                    f"source/oracle evidence differs for {question_id}: {evidence_id}"
                )

        selected = tier_indices(record, evidence_ids, encoder)
        full_chunks = {
            budget: history_chunks(
                record,
                indices,
                encoder,
                TIER_STEPS[budget],
            )
            for budget, indices in selected.items()
        }
        for budget, chunks in full_chunks.items():
            tier = f"{budget // 1000}k"
            steps = [
                (f"history-{index:02d}", instruction)
                for index, instruction in enumerate(chunks, start=1)
            ]
            _write_task(
                output_dir / "full" / tier / f"{ordinal:02d}",
                ordinal=ordinal,
                condition="full",
                tier=tier,
                steps=steps,
                expected_compaction_after_segment=len(chunks) - 1,
                record=record,
                gold=gold,
            )
            count += 1

        evidence_indices = tuple(
            index
            for index, session_id in enumerate(record["haystack_session_ids"])
            if session_id in set(evidence_ids)
        )
        evidence_instruction = history_instruction(record, evidence_indices)
        _write_task(
            output_dir / "evidence" / f"{ordinal:02d}",
            ordinal=ordinal,
            condition="evidence",
            tier=None,
            steps=(("evidence", evidence_instruction),),
            expected_compaction_after_segment=None,
            record=record,
            gold=gold,
        )
        count += 1

        handoff_chunks = full_chunks[115_000]
        handoff_steps = [
            (f"history-{index:02d}", instruction)
            for index, instruction in enumerate(handoff_chunks, start=1)
        ]
        handoff_steps.append(("evidence", evidence_instruction))
        _write_task(
            output_dir / "handoff" / "115k" / f"{ordinal:02d}",
            ordinal=ordinal,
            condition="handoff",
            tier="115k",
            steps=handoff_steps,
            expected_compaction_after_segment=len(handoff_chunks) - 1,
            record=record,
            gold=gold,
        )
        count += 1
    return count


def prepare(manifest_path: Path, output_dir: Path, cache_dir: Path | None = None) -> int:
    cache_dir = cache_dir or Path(
        os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")
    ) / "pi-evals/longmemeval"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_tiers = {
        "64k": {"history_steps": 6, "token_budget": 64_000},
        "115k": {"history_steps": 10, "token_budget": 115_000},
    }
    if manifest.get("protocol_version") != PROTOCOL_VERSION:
        raise ValueError("LongMemEval manifest protocol version does not match")
    if manifest.get("tiers") != expected_tiers:
        raise ValueError("LongMemEval manifest tiers do not match")
    if manifest.get("conditions") != list(CONDITIONS):
        raise ValueError("LongMemEval manifest conditions do not match")
    paths = download_sources(
        cache_dir,
        manifest["data_repo"],
        manifest["data_revision"],
        manifest["files"],
    )
    records = json.loads(paths["longmemeval_s_cleaned.json"].read_text(encoding="utf-8"))
    oracle = json.loads(paths["longmemeval_oracle.json"].read_text(encoding="utf-8"))
    expected = [
        record["question_id"]
        for record in select_records(records, seed=manifest["selection_seed"])
    ]
    if manifest["question_ids"] != expected:
        raise ValueError("LongMemEval manifest does not match its deterministic selection")
    return generate_tasks(
        records,
        oracle,
        manifest["question_ids"],
        output_dir,
        get_encoder(),
    )
