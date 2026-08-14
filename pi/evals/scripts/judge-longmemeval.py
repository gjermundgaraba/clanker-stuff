#!/usr/bin/env python3
"""Apply LongMemEval's answer rubric to a Harbor job."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from argparse import ArgumentParser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from statistics import fmean
from threading import Lock
from typing import Any

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
        answer_name = "Correct Answer"
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
        answer_name = "Correct Answer"
    elif question_type == "knowledge-update":
        rule = (
            "If the response contains some previous information along with an updated "
            "answer, the response should be considered as correct as long as the updated "
            "answer is the required answer."
        )
        answer_name = "Correct Answer"
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
        f"{lead} {rule}\n\nQuestion: {question}\n\n{answer_name}: {answer}\n\n"
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
    items = []
    for trial in sorted(job_dir.iterdir()):
        config_path = trial / "config.json"
        if not config_path.exists():
            continue
        config = json.loads(config_path.read_text())
        task_path = Path(config["task"]["path"])
        if not task_path.is_absolute():
            task_path = evals_dir / task_path
        gold_paths = list(task_path.glob("steps/*/tests/gold.json"))
        hypotheses = list(trial.glob("steps/*/verifier/hypothesis.txt"))
        if len(gold_paths) != 1:
            continue
        gold = json.loads(gold_paths[0].read_text())
        hypothesis = hypotheses[0].read_text().strip() if len(hypotheses) == 1 else ""
        label = config["agent"].get("kwargs", {}).get(
            "agent_label", config["agent"].get("name", "unknown")
        )
        items.append(
            {
                "agent": label,
                "gold": gold,
                "hypothesis": hypothesis,
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
    evals_dir = Path(__file__).resolve().parents[1]
    judge_name = f"{args.backend}-{args.model}".replace("/", "-")
    output_path = args.job_dir / f"longmemeval-judge-{judge_name}.jsonl"
    cached: dict[str, dict[str, Any]] = {}
    if output_path.exists():
        for line in output_path.read_text().splitlines():
            item = json.loads(line)
            cached[item["trial"]] = item
    lock = Lock()

    def judge(item: dict[str, Any]) -> dict[str, Any]:
        if item["trial"] in cached:
            return cached[item["trial"]]
        gold = item.pop("gold")
        prompt = prompt_for(
            gold["question_type"],
            gold["question"],
            gold["answer"],
            item["hypothesis"],
            abstention=bool(gold["abstention"]),
        )
        response = (
            _post(prompt, api_key=api_key, model=args.model)
            if args.backend == "openai"
            else _codex(prompt, model=args.model)
        )
        result = {
            **item,
            "abstention": bool(gold["abstention"]),
            "judge_backend": args.backend,
            "judge_model": args.model,
            "judge_response": response,
            "label": "yes" in response.lower(),
            "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
            "question_id": gold["question_id"],
            "question_type": gold["question_type"],
            "tier": gold["tier"],
        }
        with lock:
            with output_path.open("a") as stream:
                stream.write(json.dumps(result, sort_keys=True) + "\n")
        return result

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(judge, _inputs(args.job_dir, evals_dir)))
    if not results:
        raise SystemExit("no generated LongMemEval trials found")
    grouped: dict[tuple[str, str], list[bool]] = {}
    for item in results:
        grouped.setdefault((item["agent"], item["tier"]), []).append(item["label"])
    score_name = "QA judge"
    print(f"| Agent | Tier | N | {score_name} |")
    print("| --- | --- | ---: | ---: |")
    for (agent, tier), labels in sorted(grouped.items()):
        print(f"| {agent} | {tier} | {len(labels)} | {fmean(labels):.3f} |")


if __name__ == "__main__":
    main()
