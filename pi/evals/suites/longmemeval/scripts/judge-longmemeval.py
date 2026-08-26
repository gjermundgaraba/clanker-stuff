#!/usr/bin/env python3
"""Apply LongMemEval's answer rubric to a Harbor job."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from typing import Any

from pi_evals import report
from longmemeval_cache import (
    condition_tier,
    label,
    load_cache,
    same_identity,
    write_cache,
)

MODEL = "gpt-5.6-sol"


def prompt_for(
    question_type: str,
    question: str,
    answer: str,
    response: str,
    *,
    abstention: bool,
) -> str:
    if abstention:
        lead = (
            "I will give you an unanswerable question, an explanation, and a response "
            "from a model. Please answer yes if the model correctly identifies the "
            "question as unanswerable. The model could say that the information is "
            "incomplete, or some other information is given but the asked information "
            "is not."
        )
        return (
            f"{lead}\n\nQuestion: {question}\n\nExplanation: {answer}\n\n"
            f"Model Response: {response}\n\nDoes the model correctly identify the "
            "question as unanswerable? Answer yes or no only."
        )
    if question_type in {
        "single-session-user",
        "single-session-assistant",
        "multi-session",
    }:
        rule = (
            "If the response is equivalent to the correct answer or contains all the "
            "intermediate steps to get the correct answer, you should also answer yes. "
            "If the response only contains a subset of the information required by the "
            "answer, answer no."
        )
    elif question_type == "temporal-reasoning":
        rule = (
            "If the response is equivalent to the correct answer or contains all the "
            "intermediate steps to get the correct answer, you should also answer yes. "
            "If the response only contains a subset of the information required by the "
            "answer, answer no. In addition, do not penalize off-by-one errors for the "
            "number of days. If the question asks for the number of days/weeks/months, "
            "etc., and the model makes off-by-one errors, the model's response is still "
            "correct."
        )
    elif question_type == "knowledge-update":
        rule = (
            "If the response contains some previous information along with an updated "
            "answer, the response should be considered as correct as long as the updated "
            "answer is the required answer."
        )
    elif question_type == "single-session-preference":
        lead = (
            "I will give you a question, a rubric for desired personalized response, and "
            "a response from a model. Please answer yes if the response satisfies the "
            "desired response. Otherwise, answer no. The model does not need to reflect "
            "all the points in the rubric. The response is correct as long as it recalls "
            "and utilizes the user's personal information correctly."
        )
        return (
            f"{lead}\n\nQuestion: {question}\n\nRubric: {answer}\n\nModel "
            f"Response: {response}\n\nIs the model response correct? Answer yes or no only."
        )
    else:
        raise ValueError(f"unsupported LongMemEval question type: {question_type}")
    lead = (
        "I will give you a question, a correct answer, and a response from a model. "
        "Please answer yes if the response contains the correct answer. Otherwise, "
        "answer no."
    )
    return (
        f"{lead} {rule}\n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\n"
        f"Model Response: {response}\n\nIs the model response correct? Answer yes or no only."
    )


def _post(prompt: str, *, api_key: str, model: str) -> str:
    request = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(
            {
                "max_tokens": 10,
                "messages": [{"content": prompt, "role": "user"}],
                "model": model,
                "n": 1,
                "temperature": 0,
            }
        ).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            **(
                {"OpenAI-Organization": os.environ["OPENAI_ORGANIZATION"]}
                if os.getenv("OPENAI_ORGANIZATION")
                else {}
            ),
        },
        method="POST",
    )
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                value = json.load(response)
            return value["choices"][0]["message"]["content"].strip()
        except urllib.error.HTTPError as error:
            if error.code not in {429, 500, 502, 503, 504} or attempt == 5:
                raise
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def _codex(prompt: str, *, model: str) -> str:
    with tempfile.TemporaryDirectory(prefix="longmemeval-judge-") as directory:
        codex_home = Path(directory) / "codex-home"
        codex_home.mkdir()
        source_home = Path(os.getenv("CODEX_HOME", Path.home() / ".codex"))
        shutil.copyfile(source_home / "auth.json", codex_home / "auth.json")
        output = Path(directory) / "answer.txt"
        process = subprocess.run(
            [
                "codex",
                "exec",
                "--model",
                model,
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "--color",
                "never",
                "--output-last-message",
                str(output),
                "-c",
                'model_reasoning_effort="low"',
                prompt,
            ],
            capture_output=True,
            cwd=directory,
            env={**os.environ, "CODEX_HOME": str(codex_home)},
            text=True,
        )
        if process.returncode or not output.exists():
            raise RuntimeError(process.stderr.strip() or "Codex judge produced no answer")
        return output.read_text().strip()


def _inputs(job_dir: Path, evals_dir: Path) -> list[dict[str, Any]]:
    completed = {
        row["trial"] for row in report.rows(job_dir) if row["status"] == "completed"
    }
    items = []
    for trial in sorted(job_dir.iterdir()):
        config_path = trial / "config.json"
        if trial.name not in completed or not config_path.exists():
            continue
        config = json.loads(config_path.read_text())
        task_path = Path(config["task"]["path"])
        if not task_path.is_absolute():
            task_path = evals_dir / task_path
        gold_paths = list(task_path.glob("steps/*/tests/gold.json"))
        hypotheses = list(trial.glob("steps/*/verifier/hypothesis.txt"))
        if len(gold_paths) != 1:
            raise ValueError(
                f"{task_path}: expected exactly one gold artifact, found "
                f"{len(gold_paths)}"
            )
        if len(hypotheses) != 1:
            raise ValueError(
                f"{trial}: expected exactly one hypothesis artifact, found "
                f"{len(hypotheses)}"
            )
        gold = json.loads(gold_paths[0].read_text())
        items.append(
            {
                "gold": gold,
                "hypothesis": hypotheses[0].read_text().strip(),
                "task": task_path.name,
                "trial": trial.name,
            }
        )
    return items


def main() -> None:
    parser = ArgumentParser()
    parser.add_argument("job_dir", type=Path)
    parser.add_argument("--backend", choices=("openai", "codex"), default="codex")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    api_key = os.getenv("OPENAI_API_KEY", "")
    if args.backend == "openai" and not api_key:
        raise SystemExit("OPENAI_API_KEY is required for the official LongMemEval judge")
    evals_dir = Path(__file__).resolve().parents[3]
    judge_name = f"{args.backend}-{args.model}".replace("/", "-")
    output_path = args.job_dir / f"longmemeval-judge-{judge_name}.jsonl"
    cached = load_cache(output_path, backend=args.backend, model=args.model)
    lock = Lock()

    def judge(item: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        gold = item["gold"]
        prompt = prompt_for(
            gold["question_type"],
            gold["question"],
            gold["answer"],
            item["hypothesis"],
            abstention=bool(gold["abstention"]),
        )
        prompt_sha256 = hashlib.sha256(prompt.encode()).hexdigest()
        condition, tier = condition_tier(gold)
        identity = {
            **{key: value for key, value in item.items() if key != "gold"},
            "abstention": bool(gold["abstention"]),
            "condition": condition,
            "judge_backend": args.backend,
            "judge_model": args.model,
            "prompt_sha256": prompt_sha256,
            "question_id": gold["question_id"],
            "question_type": gold["question_type"],
            "tier": tier,
        }
        previous = cached.get(item["trial"])
        if previous is not None and same_identity(previous, identity):
            return previous, True
        response = (
            _post(prompt, api_key=api_key, model=args.model)
            if args.backend == "openai"
            else _codex(prompt, model=args.model)
        )
        result = {
            **identity,
            "judge_response": response,
            "label": label(response),
        }
        with lock:
            cached[item["trial"]] = result
            write_cache(output_path, cached.values())
        return result, False

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(judge, _inputs(args.job_dir, evals_dir)))
    if not results:
        raise SystemExit("no generated LongMemEval trials found")
    current = [item for item, _was_cached in results]
    write_cache(output_path, current)
    hits = sum(was_cached for _item, was_cached in results)
    print(
        f"LongMemEval judge: cached={hits} new={len(results) - hits} "
        f"total={len(results)}"
    )


if __name__ == "__main__":
    main()
