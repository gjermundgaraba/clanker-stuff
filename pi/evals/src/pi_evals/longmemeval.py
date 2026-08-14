from __future__ import annotations

import hashlib
import json
import os
import shutil
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

HF_REVISION = "98d7416c24c778c2fee6e6f3006e7a073259d48f"
HF_BASE_URL = (
    "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/"
    f"{HF_REVISION}"
)
SOURCE_FILES = {
    "longmemeval_oracle.json": (
        "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c"
    ),
    "longmemeval_s_cleaned.json": (
        "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442"
    ),
}
TIER_BUDGETS = (32_000, 64_000, 115_000)
HISTORY_CHUNK_TOKENS = 12_000
SELECTION_SEED = "clanker-stuff-longmemeval-v1"
HISTORY_PREFIX = (
    "The following dated chats are part of the user's prior conversation history. "
    "Retain all history blocks for the final question. Do not inspect or edit files. "
    "Reply only with "
    "`HISTORY-RECORDED`."
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


def _session_text(record: dict[str, Any], index: int) -> str:
    turns = "\n".join(
        f"{turn['role']}: {str(turn['content']).strip()}"
        for turn in record["haystack_sessions"][index]
    )
    return (
        f"\n\n### Session {index + 1}\n"
        f"Date: {record['haystack_dates'][index]}\n{turns}"
    )


def history_instruction(record: dict[str, Any], indices: Iterable[int]) -> str:
    return HISTORY_PREFIX + "".join(_session_text(record, index) for index in indices)


def history_chunks(
    record: dict[str, Any],
    indices: Iterable[int],
    encoder: Any,
    max_tokens: int = HISTORY_CHUNK_TOKENS,
) -> tuple[str, ...]:
    groups: list[list[int]] = []
    group: list[int] = []
    group_tokens = 0
    for index in indices:
        size = len(encoder.encode(_session_text(record, index)))
        if group and group_tokens + size > max_tokens:
            groups.append(group)
            group = []
            group_tokens = 0
        group.append(index)
        group_tokens += size
    if group:
        groups.append(group)
    return tuple(history_instruction(record, group_indices) for group_indices in groups)


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
    budgets: Iterable[int] = TIER_BUDGETS,
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

    def rendered_tokens(indices: set[int]) -> int:
        return sum(
            len(encoder.encode(instruction))
            for instruction in history_chunks(record, sorted(indices), encoder)
        ) + len(encoder.encode(query_instruction(record)))

    for budget in budgets:
        if rendered_tokens(selected) > budget:
            raise ValueError(f"evidence alone exceeds the {budget}-token tier")
        filler_indices = sorted(
            (index for index in range(len(session_ids)) if index not in required),
            key=lambda index: _rank(
                SELECTION_SEED, record["question_id"], session_ids[index]
            ),
        )
        for index in filler_indices:
            candidate = selected | {index}
            if index not in selected and rendered_tokens(candidate) <= budget:
                selected.add(index)
        indices = tuple(sorted(selected))
        actual = rendered_tokens(selected)
        if actual > budget:
            raise ValueError(f"rendered history exceeds the {budget}-token tier")
        output[budget] = indices
    return output


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_sources(cache_dir: Path) -> dict[str, Path]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for filename, expected_sha in SOURCE_FILES.items():
        path = cache_dir / filename
        if not path.exists() or _sha256(path) != expected_sha:
            temporary = path.with_suffix(path.suffix + ".part")
            try:
                with urllib.request.urlopen(f"{HF_BASE_URL}/{filename}") as source:
                    with temporary.open("wb") as destination:
                        shutil.copyfileobj(source, destination)
            except Exception as error:
                temporary.unlink(missing_ok=True)
                raise RuntimeError(
                    f"failed to download pinned LongMemEval {filename}: {error}"
                ) from error
            if _sha256(temporary) != expected_sha:
                temporary.unlink()
                raise RuntimeError(f"checksum mismatch for pinned LongMemEval {filename}")
            temporary.replace(path)
        paths[filename] = path
    return paths


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _task_toml(ordinal: int, tier: int, history_count: int) -> str:
    history_steps = "".join(
        f'''\n[[steps]]
name = "history-{index:02d}"
[steps.agent]
timeout_sec = 600.0
[steps.verifier]
timeout_sec = 60.0
'''
        for index in range(1, history_count + 1)
    )
    return f'''schema_version = "1.4"
multi_step_reward_strategy = "final"

[task]
name = "pi-evals/longmemeval-{tier // 1000}k-{ordinal:02d}"
description = "Retain a long dated chat history and answer one memory question."
keywords = ["long-context", "memory", "multi-step"]

[metadata]
difficulty = "hard"
category = "context-management"
tags = ["long-context", "memory"]

[environment]
docker_image = "clanker-pi-evals:node24"
workdir = "/app"
build_timeout_sec = 600.0
cpus = 2
memory_mb = 2048
storage_mb = 10240
gpus = 0
{history_steps}

[[steps]]
name = "query"
[steps.agent]
timeout_sec = 600.0
[steps.verifier]
timeout_sec = 60.0
'''


def _grader() -> str:
    return '''import { readFileSync, writeFileSync } from "node:fs";

let trajectory = {};
try {
  trajectory = JSON.parse(readFileSync("/logs/agent/trajectory.json", "utf-8"));
} catch {}
const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
const queryIndex = steps.findLastIndex((step) => step.source === "user");
const answerIndex = steps.findIndex(
  (step, index) =>
    index > queryIndex && step.source === "agent" && typeof step.message === "string"
);
const hypothesis =
  steps
    .slice(queryIndex + 1)
    .findLast(
      (step) =>
        step.source === "agent" &&
        typeof step.message === "string" &&
        step.message.trim().length > 0
    )?.message ?? "";
writeFileSync("/logs/verifier/hypothesis.txt", hypothesis);
const gold = JSON.parse(readFileSync("/tests/gold.json", "utf-8"));
const agentName = trajectory.agent?.name;
const policies = {
  "codex-cli-off": { expected: false, mechanism: "codex-cli" },
  "codex-cli-on": { expected: true, mechanism: "codex-cli" },
  "pi-provider-off": { expected: false, mechanism: "codex-provider" },
  "pi-provider-on": { expected: true, mechanism: "codex-provider" },
  "pi-vanilla-off": { expected: false, mechanism: "pi-builtin" },
  "pi-vanilla-on": { expected: true, mechanism: "pi-builtin" },
};
const policy = policies[agentName];
const attempts = steps.filter(
  (step) => step.extra?.event_type === "context_compaction"
);
const compactions = attempts.filter((step) => step.extra?.state === "succeeded");
const boundary = steps.some(
  (step, index) =>
    index > 0 &&
    index < queryIndex &&
    step.extra?.event_type === "context_compaction" &&
    step.extra?.state === "succeeded"
);
const mechanism =
  agentName === "oracle" ||
  Boolean(
    policy &&
      compactions.every(
        (step) =>
          step.extra?.mechanism === policy.mechanism &&
          (policy.mechanism !== "codex-provider" ||
            step.extra?.protocol === "openai-responses-compaction-v2")
      )
  );
const normalize = (value) =>
  String(value).normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\\s+/gu, " ");
const agentResponse = Number(hypothesis.trim().length > 0);
const exactNormalized = Number(agentResponse && normalize(hypothesis) === normalize(gold.answer));
const validExperiment = Number(
  agentName === "oracle" ||
    (policy &&
      agentResponse &&
      answerIndex > queryIndex &&
      (policy.expected
        ? attempts.length > 0 &&
          attempts.length === compactions.length &&
          boundary &&
          mechanism
        : attempts.length === 0))
);
writeFileSync(
  "/logs/verifier/reward.json",
  JSON.stringify({
    agent_response: agentResponse,
    compaction_attempts: attempts.length,
    compaction_boundary: Number(boundary),
    compaction_count: compactions.length,
    compaction_expected: Number(policy?.expected ?? false),
    compaction_failures: attempts.length - compactions.length,
    continuation: agentResponse,
    exact_normalized: exactNormalized,
    mechanism: Number(mechanism),
    reward: exactNormalized,
    valid_experiment: validExperiment,
  })
);
'''


def generate_tasks(
    records: Iterable[dict[str, Any]],
    oracle_records: Iterable[dict[str, Any]],
    question_ids: Iterable[str],
    output_dir: Path,
    encoder: Any,
) -> int:
    source = {record["question_id"]: record for record in records}
    oracle = {record["question_id"]: record for record in oracle_records}
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
            session_id: (date, session)
            for date, session_id, session in zip(
                record["haystack_dates"],
                record["haystack_session_ids"],
                record["haystack_sessions"],
                strict=True,
            )
        }
        oracle_sessions = {
            session_id: session
            for _date, session_id, session in zip(
                gold["haystack_dates"],
                gold["haystack_session_ids"],
                gold["haystack_sessions"],
                strict=True,
            )
        }
        for evidence_id in evidence_ids:
            source_evidence = source_sessions.get(evidence_id)
            if source_evidence is None or source_evidence[1] != oracle_sessions.get(
                evidence_id
            ):
                raise ValueError(
                    f"source/oracle evidence differs for {question_id}: {evidence_id}"
                )
        tiers = tier_indices(record, evidence_ids, encoder)

        for budget, indices in tiers.items():
            chunks = history_chunks(record, indices, encoder)
            task = output_dir / f"{budget // 1000}k" / f"{ordinal:02d}"
            shutil.rmtree(task, ignore_errors=True)
            (task / "environment").mkdir(parents=True, exist_ok=True)
            _write(task / "task.toml", _task_toml(ordinal, budget, len(chunks)))
            for index, instruction in enumerate(chunks, start=1):
                step = task / f"steps/history-{index:02d}"
                _write(step / "instruction.md", instruction)
                _write(step / "solution/solve.sh", "#!/usr/bin/env bash\ntrue\n")
                _write(
                    step / "tests/test.sh",
                    "#!/usr/bin/env bash\necho 1 > /logs/verifier/reward.txt\n",
                )
            _write(task / "steps/query/instruction.md", query_instruction(record))
            _write(
                task / "steps/query/solution/solve.sh",
                "#!/usr/bin/env bash\nset -eu\nmkdir -p /logs/agent\nnode -e 'const g=require(\"/tests/gold.json\");require(\"fs\").writeFileSync(\"/logs/agent/trajectory.json\",JSON.stringify({schema_version:\"ATIF-v1.7\",session_id:\"oracle\",agent:{name:\"oracle\",version:\"1\"},steps:[{step_id:1,source:\"user\",message:\"query\"},{step_id:2,source:\"agent\",message:String(g.answer)}]}))'\n",
            )
            _write(
                task / "steps/query/tests/gold.json",
                json.dumps(
                    {
                        "abstention": question_id.endswith("_abs"),
                        "answer": gold["answer"],
                        "question": gold["question"],
                        "question_id": question_id,
                        "question_type": gold["question_type"],
                        "tier": f"{budget // 1000}k",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
            )
            _write(task / "steps/query/tests/grade.mjs", _grader())
            _write(
                task / "steps/query/tests/test.sh",
                "#!/usr/bin/env bash\nset -eu\nnode /tests/grade.mjs\n",
            )
            for script in task.rglob("*.sh"):
                script.chmod(0o755)
            count += 1
    return count


def prepare(manifest_path: Path, output_dir: Path, cache_dir: Path | None = None) -> int:
    cache_dir = cache_dir or Path(
        os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")
    ) / "pi-evals/longmemeval"
    paths = download_sources(cache_dir)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("history_chunk_tokens") != HISTORY_CHUNK_TOKENS:
        raise ValueError("LongMemEval manifest history chunk size does not match")
    if manifest.get("tier_budgets") != list(TIER_BUDGETS):
        raise ValueError("LongMemEval manifest tier budgets do not match")
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
