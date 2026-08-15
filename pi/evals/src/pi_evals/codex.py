from __future__ import annotations

import json
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Agent, Observation, ObservationResult, Step
from harbor.utils.trajectory_utils import format_trajectory_json

from pi_evals.auth import require_auth_file


_REMOTE_PROMPT_PATH = "/tmp/codex-eval-instruction.md"


def _usage_delta[T: int | float](current: T | None, previous: T | None) -> T | None:
    return current - previous if current is not None and previous is not None else current


def _redirect_prompt(command: str, prompt_path: str) -> str:
    marker = "2>&1 </dev/null | tee"
    if marker not in command:
        raise ValueError("Codex command no longer has the expected stdin redirection")
    return command.replace(marker, f"2>&1 < {prompt_path} | tee", 1)


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
                        "mechanism": "codex-cli",
                        "state": "succeeded",
                        "timestamp": event.get("timestamp"),
                    }
                )
    return compactions


class CodexEval(Codex):
    """Pinned Harbor Codex runner with normalized native compaction evidence."""

    def __init__(self, *args: Any, agent_label: str = "codex-cli", **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._agent_label = agent_label
        self._prompt_path: str | None = None
        self._usage_session_id: str | None = None
        self._cumulative_usage: tuple[
            int | None, int | None, int | None, float | None
        ] | None = None

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

    def _normalize_context_usage(
        self, context: AgentContext, session_id: str
    ) -> None:
        current = (
            context.n_input_tokens,
            context.n_cache_tokens,
            context.n_output_tokens,
            context.cost_usd,
        )
        previous = self._cumulative_usage
        if self._usage_session_id == session_id and previous is not None:
            context.n_input_tokens = _usage_delta(current[0], previous[0])
            context.n_cache_tokens = _usage_delta(current[1], previous[1])
            context.n_output_tokens = _usage_delta(current[2], previous[2])
            context.cost_usd = _usage_delta(current[3], previous[3])
        self._usage_session_id = session_id
        self._cumulative_usage = current

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if await self._installed_codex_satisfies_version(environment):
            return
        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "test \"$(node --version | cut -d. -f1)\" = v24; "
                f"npm install -g @openai/codex{version_spec}; "
                "codex --version"
            ),
        )

    @override
    async def exec_as_agent(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:
        if self._prompt_path is not None and "codex exec " in command:
            command = _redirect_prompt(command, self._prompt_path)
        return await super().exec_as_agent(
            environment,
            command,
            env=env,
            cwd=cwd,
            timeout_sec=timeout_sec,
        )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self._upload_config_text(
            environment,
            content=self.render_instruction(instruction),
            remote_path=_REMOTE_PROMPT_PATH,
            filename="instruction.md",
        )
        self._prompt_path = _REMOTE_PROMPT_PATH
        try:
            await super().run("-", environment, context)
        finally:
            self._prompt_path = None

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        trajectory_path = self.logs_dir / "trajectory.json"
        session_dir = self._get_session_dir()
        if not trajectory_path.exists() or session_dir is None:
            return

        value = json.loads(trajectory_path.read_text(encoding="utf-8"))
        session_id = value.get("session_id")
        if isinstance(session_id, str):
            self._normalize_context_usage(context, session_id)
        steps = value.get("steps")
        if not isinstance(steps, list):
            return
        compactions = load_codex_compactions(session_dir)
        for event in compactions:
            timestamp = event.pop("timestamp", None)
            step = Step(
                step_id=1,
                timestamp=timestamp if isinstance(timestamp, str) else None,
                source="system",
                message="Codex context compaction succeeded",
                observation=Observation(
                    results=[ObservationResult(content="succeeded")]
                ),
                extra=event,
            )
            steps.append(step.model_dump(mode="json", exclude_none=True))
        steps.sort(key=lambda step: step.get("timestamp") or "")
        for index, step in enumerate(steps, start=1):
            step["step_id"] = index

        agent = value.get("agent")
        if isinstance(agent, dict):
            agent["name"] = self._agent_label
        else:
            value["agent"] = Agent(
                name=self._agent_label,
                version=self.version() or "unknown",
                model_name=self.model_name,
            ).model_dump(mode="json", exclude_none=True)
        metrics = value.get("final_metrics")
        if isinstance(metrics, dict):
            extra = metrics.setdefault("extra", {})
            if isinstance(extra, dict):
                extra["compaction_attempts"] = len(compactions)
                extra["compactions"] = len(compactions)
                extra["compaction_failures"] = 0
        trajectory_path.write_text(
            format_trajectory_json(value),
            encoding="utf-8",
        )
