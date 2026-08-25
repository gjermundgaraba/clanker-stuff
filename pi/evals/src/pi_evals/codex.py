from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    Trajectory,
)
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import format_trajectory_json

from pi_evals.auth import require_auth_file
from pi_evals.pi import controlled_instruction


_OUTPUT_USAGE_FILE = "codex-usage.jsonl"
_REMOTE_RUN_CONFIG = "/tmp/codex-eval-run.json"


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    if not path.exists():
        raise ValueError(f"missing exact Codex usage log: {path}")
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


def load_codex_usage(path: Path, *, output_log: bool = False) -> list[dict[str, Any]]:
    """Load exact, per-response usage captured from Codex app-server."""

    records = _load_jsonl(path)
    response_ids: set[str] = set()
    for number, record in enumerate(records, 1):
        if output_log and record.pop("type", None) != "eval_usage":
            raise ValueError(f"{path}:{number}: unexpected runner output")
        if record.get("kind") not in {"ordinary", "compaction"}:
            raise ValueError(f"{path}:{number}: invalid usage kind")
        response_id = record.get("responseId")
        usage = record.get("usage")
        if not isinstance(response_id, str) or not isinstance(usage, dict):
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
            not isinstance(usage[key], int) or usage[key] < 0 for key in expected
        ):
            raise ValueError(f"{path}:{number}: invalid exact usage payload")
        response_ids.add(response_id)
    return records


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
        agent_label: str = "codex-native",
        controlled_compaction: bool = False,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._agent_label = agent_label
        self._controlled_compaction = controlled_compaction

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
        if await self._installed_codex_satisfies_version(environment):
            return
        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"npm install -g @openai/codex{version_spec}; "
                "codex --version"
            ),
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

        records = load_codex_usage(self.logs_dir / _OUTPUT_USAGE_FILE)
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

        compactions = load_codex_compactions(session_dir)
        if len(compactions) != len(compact):
            raise ValueError(
                "Codex durable compactions do not match exact compaction usage "
                f"({len(compactions)} != {len(compact)})"
            )
        for event, record in zip(compactions, compact, strict=True):
            timestamp = event.pop("timestamp", None)
            trajectory.steps.append(
                Step(
                    step_id=1,
                    timestamp=timestamp if isinstance(timestamp, str) else None,
                    source="agent",
                    message="Codex context compaction succeeded",
                    observation=Observation(
                        results=[ObservationResult(content="succeeded")]
                    ),
                    metrics=self._metrics(record),
                    llm_call_count=1,
                    extra=event,
                )
            )

        trajectory.steps.sort(key=lambda step: step.timestamp or "")
        for index, step in enumerate(trajectory.steps, start=1):
            step.step_id = index
        all_metrics = [step.metrics for step in trajectory.steps if step.metrics]
        costs = [metrics.cost_usd for metrics in all_metrics]
        trajectory.final_metrics = FinalMetrics(
            total_prompt_tokens=sum(metrics.prompt_tokens or 0 for metrics in all_metrics),
            total_completion_tokens=sum(
                metrics.completion_tokens or 0 for metrics in all_metrics
            ),
            total_cached_tokens=sum(metrics.cached_tokens or 0 for metrics in all_metrics),
            total_cost_usd=(
                sum(cost for cost in costs if cost is not None)
                if all(cost is not None for cost in costs)
                else None
            ),
            total_steps=len(trajectory.steps),
            extra={
                "cost_basis": "api_list_price_estimate",
                "compaction_attempts": len(compactions),
                "compactions": len(compactions),
                "compaction_failures": 0,
                "total_cache_write_input_tokens": sum(
                    int((metrics.extra or {}).get("cache_write_input_tokens", 0))
                    for metrics in all_metrics
                ),
            },
        )
        trajectory.agent.name = self._agent_label
        return trajectory

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        instruction, compact_before = controlled_instruction(
            instruction, self._controlled_compaction
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
        await self._upload_effective_config(environment, effective_config, remote_config)

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
                        f"if [ -f {remote_home}/eval-usage.jsonl ]; then "
                        f"cp {remote_home}/eval-usage.jsonl "
                        f"{agent_dir}/{_OUTPUT_USAGE_FILE}; fi"
                    ),
                    env=env,
                )
            except Exception:
                pass

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

        current = load_codex_usage(
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
