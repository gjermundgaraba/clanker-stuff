from __future__ import annotations

import json
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    Trajectory,
)
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import format_trajectory_json

from pi_evals.adapters.auth import require_auth_file
from pi_evals.protocol import controlled_instruction, validate_manifest

_OUTPUT_EVENTS_FILE = "codex-events.jsonl"
_REMOTE_RUN_CONFIG = "/tmp/codex-eval-run.json"


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    if not path.exists():
        raise ValueError(f"missing Codex event journal: {path}")
    for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{number}: invalid JSON") from error
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{number}: expected an object")
        values.append(value)
    return values


def load_codex_journal(
    path: Path, *, output_log: bool = False
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Load exact response usage and terminal compaction attempts."""

    records = _load_jsonl(path)
    usage_records: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []
    response_ids: set[str] = set()
    attempt_turn_ids: set[str] = set()
    for number, record in enumerate(records, 1):
        if output_log and record.pop("type", None) != "eval_event":
            raise ValueError(f"{path}:{number}: unexpected runner output")
        kind = record.get("kind")
        if kind == "compaction_attempt":
            expected = {
                "compactedAfterSegment",
                "kind",
                "state",
                "threadId",
                "timestamp",
                "turnId",
            }
            turn_id = record.get("turnId")
            thread_id = record.get("threadId")
            timestamp = record.get("timestamp")
            if (
                set(record) != expected
                or record.get("state") not in {"aborted", "failed", "succeeded"}
                or not isinstance(thread_id, str)
                or not thread_id
                or not isinstance(timestamp, str)
                or not timestamp
                or not isinstance(turn_id, str)
                or not turn_id
                or type(record.get("compactedAfterSegment")) is not int
                or record["compactedAfterSegment"] < -1
            ):
                raise ValueError(f"{path}:{number}: invalid compaction attempt")
            if turn_id in attempt_turn_ids:
                raise ValueError(f"{path}:{number}: duplicate compaction turn id")
            attempt_turn_ids.add(turn_id)
            attempts.append(record)
            continue
        if kind not in {"ordinary", "compaction"}:
            raise ValueError(f"{path}:{number}: invalid usage kind")
        response_id = record.get("responseId")
        thread_id = record.get("threadId")
        turn_id = record.get("turnId")
        usage = record.get("usage")
        if (
            set(record) != {"kind", "responseId", "threadId", "turnId", "usage"}
            or not isinstance(response_id, str)
            or not response_id
            or not isinstance(thread_id, str)
            or not thread_id
            or not isinstance(turn_id, str)
            or not turn_id
            or not isinstance(usage, dict)
        ):
            raise ValueError(f"{path}:{number}: incomplete usage record")
        if response_id in response_ids:
            raise ValueError(f"{path}:{number}: duplicate response id")
        expected = {
            "cacheWriteInputTokens",
            "cachedInputTokens",
            "inputTokens",
            "outputTokens",
            "reasoningOutputTokens",
            "totalTokens",
        }
        if set(usage) != expected or any(
            type(usage[key]) is not int or usage[key] < 0 for key in expected
        ):
            raise ValueError(f"{path}:{number}: invalid exact usage payload")
        response_ids.add(response_id)
        usage_records.append(record)
    return usage_records, attempts


def load_codex_compactions(session_dir: Path) -> list[dict[str, Any]]:
    """Read persisted Codex replacement events, the durable success evidence."""

    completed_segment = -1
    compactions: list[dict[str, Any]] = []
    for path in sorted(session_dir.glob("rollout-*.jsonl")):
        for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{number}: invalid JSON") from error
            if not isinstance(event, dict):
                raise ValueError(f"{path}:{number}: expected an object")
            payload = event.get("payload")
            if (
                event.get("type") == "event_msg"
                and isinstance(payload, dict)
                and payload.get("type") == "user_message"
            ):
                completed_segment += 1
            elif event.get("type") == "compacted" and isinstance(payload, dict):
                compactions.append(
                    {
                        "compacted_after_segment": completed_segment,
                        "event_type": "context_compaction",
                        "mechanism": "codex-native",
                        "protocol": None,
                        "state": "succeeded",
                        "timestamp": event.get("timestamp"),
                    }
                )
    return compactions


class CodexEval(Codex):
    """Pinned native Codex runner with exact request-level usage accounting."""

    SUPPORTS_LOAD_NATIVE_TRAJECTORY = False
    SUPPORTS_LOAD_ATIF_TRAJECTORY = False

    def __init__(
        self,
        *args: Any,
        pi_evals: dict[str, Any],
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._completed_segment = -1
        self._pi_evals = validate_manifest(pi_evals)
        if tuple(
            self._pi_evals[key]
            for key in ("platform", "expected_mechanism", "expected_protocol")
        ) != ("codex-native", "codex-native", None):
            raise ValueError("pi_evals manifest does not match Codex native")

    @override
    def _resolve_auth_json_path(self) -> Path:
        return require_auth_file(
            super()._resolve_auth_json_path() or Path.home() / ".codex" / "auth.json",
            (
                ("OPENAI_API_KEY",),
                ("tokens", "access_token"),
                ("tokens", "refresh_token"),
            ),
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if self._version is None:
            raise ValueError("CodexEval requires a pinned Codex version")
        if not await self._installed_codex_satisfies_version(environment):
            raise RuntimeError(
                f"evaluation image does not contain Codex {self._version}"
            )

    def _metrics(self, record: dict[str, Any]) -> Metrics:
        usage = record["usage"]
        cost = self._compute_cost_from_pricing(
            prompt_tokens=usage["inputTokens"],
            completion_tokens=usage["outputTokens"],
            cached_tokens=usage["cachedInputTokens"],
            cache_write_tokens=usage["cacheWriteInputTokens"],
        )
        return Metrics(
            prompt_tokens=usage["inputTokens"],
            completion_tokens=usage["outputTokens"],
            cached_tokens=usage["cachedInputTokens"] or None,
            cost_usd=cost,
            extra={
                "cache_write_input_tokens": usage["cacheWriteInputTokens"],
                "reasoning_output_tokens": usage["reasoningOutputTokens"],
                "response_id": record["responseId"],
                "usage_kind": record["kind"],
            },
        )

    @override
    def _convert_events_to_trajectory(self, session_dir: Path) -> Trajectory | None:
        trajectory = super()._convert_events_to_trajectory(session_dir)
        if trajectory is None:
            return None

        records, attempts = load_codex_journal(self.logs_dir / _OUTPUT_EVENTS_FILE)
        ordinary = [record for record in records if record["kind"] == "ordinary"]
        compact = [record for record in records if record["kind"] == "compaction"]
        metered_steps = [step for step in trajectory.steps if step.metrics is not None]
        if len(metered_steps) != len(ordinary):
            raise ValueError(
                "Codex durable responses do not match exact ordinary usage "
                f"({len(metered_steps)} != {len(ordinary)})"
            )
        for step, record in zip(metered_steps, ordinary, strict=True):
            step.metrics = self._metrics(record)

        durable = load_codex_compactions(session_dir)
        succeeded = [attempt for attempt in attempts if attempt["state"] == "succeeded"]
        if len(durable) != len(succeeded):
            raise ValueError(
                "Codex durable compactions do not match successful attempts "
                f"({len(durable)} != {len(succeeded)})"
            )
        compact_by_turn = {record["turnId"]: record for record in compact}
        if len(compact_by_turn) != len(compact):
            raise ValueError("Codex compaction usage has an invalid turn id")

        durable_iterator = iter(durable)
        for attempt in attempts:
            record = compact_by_turn.pop(attempt["turnId"], None)
            if record is not None and record.get("threadId") != attempt["threadId"]:
                raise ValueError(
                    "Codex compaction usage thread does not match its attempt"
                )
            event: dict[str, Any] | None = None
            if attempt["state"] == "succeeded":
                event = next(durable_iterator)
                if record is None:
                    raise ValueError("successful Codex compaction omitted exact usage")
                if event["compacted_after_segment"] != attempt["compactedAfterSegment"]:
                    raise ValueError(
                        "Codex durable compaction boundary does not match its attempt"
                    )
            timestamp = event.get("timestamp") if event else attempt["timestamp"]
            extra = {
                "compacted_after_segment": attempt["compactedAfterSegment"],
                "event_type": "context_compaction",
                "mechanism": "codex-native",
                "protocol": None,
                "state": attempt["state"],
                "turn_id": attempt["turnId"],
            }
            trajectory.steps.append(
                Step(
                    step_id=1,
                    timestamp=timestamp if isinstance(timestamp, str) else None,
                    source="agent",
                    message=f"Codex context compaction {attempt['state']}",
                    observation=Observation(
                        results=[ObservationResult(content=attempt["state"])]
                    ),
                    metrics=self._metrics(record) if record else None,
                    llm_call_count=1 if record else None,
                    extra=extra,
                )
            )
        if compact_by_turn:
            raise ValueError("Codex compaction usage has no matching attempt")

        trajectory.steps.sort(key=lambda step: step.timestamp or "")
        for index, step in enumerate(trajectory.steps, start=1):
            step.step_id = index
        all_metrics = [step.metrics for step in trajectory.steps if step.metrics]
        costs = [metrics.cost_usd for metrics in all_metrics]
        trajectory.final_metrics = FinalMetrics(
            total_prompt_tokens=sum(
                metrics.prompt_tokens or 0 for metrics in all_metrics
            ),
            total_completion_tokens=sum(
                metrics.completion_tokens or 0 for metrics in all_metrics
            ),
            total_cached_tokens=sum(
                metrics.cached_tokens or 0 for metrics in all_metrics
            ),
            total_cost_usd=(
                sum(cost for cost in costs if cost is not None)
                if all(cost is not None for cost in costs)
                else None
            ),
            total_steps=len(trajectory.steps),
            extra={
                "cost_basis": "api_list_price_estimate",
                "total_cache_write_input_tokens": sum(
                    int((metrics.extra or {}).get("cache_write_input_tokens", 0))
                    for metrics in all_metrics
                ),
            },
        )
        trajectory.agent.extra = {
            **(trajectory.agent.extra or {}),
            "pi_evals": self._pi_evals,
        }
        return trajectory

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        instruction, compact_before = controlled_instruction(
            instruction, self._pi_evals["compaction_mode"]
        )
        if not self.model_name:
            raise ValueError("Model name is required")
        if self._load:
            raise ValueError("CodexEval does not support loading a prior trajectory")

        model = self.model_name.split("/")[-1]
        remote_home = self._REMOTE_CODEX_HOME.as_posix()
        remote_secrets = self._REMOTE_CODEX_SECRETS_DIR.as_posix()
        remote_auth = (self._REMOTE_CODEX_SECRETS_DIR / "auth.json").as_posix()
        remote_config = (self._REMOTE_CODEX_HOME / "config.toml").as_posix()
        agent_dir = EnvironmentPaths.agent_dir.as_posix()
        env = {"CODEX_HOME": remote_home}

        await self.exec_as_agent(
            environment,
            command=f"mkdir -p {remote_home} {remote_secrets} {agent_dir}",
            env=env,
        )
        auth_path = self._resolve_auth_json_path()
        await environment.upload_file(auth_path, remote_auth)
        if environment.default_user is not None:
            await self.exec_as_root(
                environment,
                command=f"chown {environment.default_user} {remote_auth}",
            )
        setup = f"ln -sf {remote_auth} {remote_home}/auth.json"

        access = self.model_connection
        openai_base_url = access.configured_base_url
        if openai_base_url:
            env["OPENAI_BASE_URL"] = openai_base_url
        effective_config = self._build_effective_config(openai_base_url)
        features = effective_config.setdefault("features", {})
        if not isinstance(features, dict):
            raise ValueError("Invalid Codex config: features must be a TOML table")
        features["unified_exec"] = True
        web_search = self._resolved_flags.get("web_search")
        if web_search is not None:
            effective_config["web_search"] = web_search
        await self._upload_effective_config(
            environment, effective_config, remote_config
        )

        skills_command = self._build_register_skills_command()
        if skills_command:
            setup += f"\n{skills_command}"
        await self.exec_as_agent(environment, command=setup, env=env)

        instruction_path = f"{remote_home}/instruction.md"
        await self._upload_config_text(
            environment,
            content=self.render_instruction(instruction),
            remote_path=instruction_path,
            filename="instruction.md",
        )
        await self._upload_config_text(
            environment,
            content=json.dumps(
                {
                    "compactBefore": compact_before,
                    "compactedAfterSegment": self._completed_segment,
                    "effort": self._resolved_flags.get("reasoning_effort"),
                    "instructionPath": instruction_path,
                    "model": model,
                    "summary": self._resolved_flags.get("reasoning_summary"),
                }
            ),
            remote_path=_REMOTE_RUN_CONFIG,
            filename="run.json",
        )

        try:
            await self.exec_as_agent(
                environment,
                command=(
                    "set -o pipefail; "
                    f"codex-eval {_REMOTE_RUN_CONFIG} 2>&1 | "
                    f"tee {agent_dir}/{self._OUTPUT_FILENAME}"
                ),
                env=env,
            )
        finally:
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        f"if [ -d {remote_home}/sessions ]; then "
                        f"rm -rf {agent_dir}/sessions; "
                        f"cp -R {remote_home}/sessions {agent_dir}/sessions; fi; "
                        f"if [ -f {remote_home}/eval-events.jsonl ]; then "
                        f"cp {remote_home}/eval-events.jsonl "
                        f"{agent_dir}/{_OUTPUT_EVENTS_FILE}; fi"
                    ),
                    env=env,
                )
            except Exception:
                pass
        self._completed_segment += 1

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        session_dir = self._get_session_dir()
        if session_dir is None:
            raise ValueError("Codex produced no durable session")
        trajectory = self._convert_events_to_trajectory(session_dir)
        if trajectory is None:
            raise ValueError("Codex produced no trajectory")
        (self.logs_dir / "trajectory.json").write_text(
            format_trajectory_json(trajectory.to_json_dict()),
            encoding="utf-8",
        )

        current, _ = load_codex_journal(
            self.logs_dir / self._OUTPUT_FILENAME,
            output_log=True,
        )
        metrics = [self._metrics(record) for record in current]
        costs = [metric.cost_usd for metric in metrics]
        context.n_input_tokens = sum(metric.prompt_tokens or 0 for metric in metrics)
        context.n_cache_tokens = sum(metric.cached_tokens or 0 for metric in metrics)
        context.n_output_tokens = sum(
            metric.completion_tokens or 0 for metric in metrics
        )
        context.cost_usd = (
            sum(cost for cost in costs if cost is not None)
            if all(cost is not None for cost in costs)
            else None
        )
