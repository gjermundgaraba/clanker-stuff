from __future__ import annotations

import json
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Agent, Observation, ObservationResult, Step
from harbor.utils.trajectory_utils import format_trajectory_json

def load_codex_compactions(session_dir: Path) -> list[dict[str, Any]]:
    """Read persisted Codex replacement events, the durable success evidence."""

    segment = -1
    compactions: list[dict[str, Any]] = []
    for path in sorted(session_dir.glob("rollout-*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = event.get("payload")
            if (
                event.get("type") == "event_msg"
                and isinstance(payload, dict)
                and payload.get("type") == "user_message"
            ):
                segment += 1
            elif event.get("type") == "compacted" and isinstance(payload, dict):
                compactions.append(
                    {
                        "event_type": "context_compaction",
                        "mechanism": "codex-cli",
                        "segment": segment,
                        "state": "succeeded",
                        "timestamp": event.get("timestamp"),
                        "window_number": payload.get("window_number"),
                    }
                )
    return compactions


class CodexEval(Codex):
    """Pinned Harbor Codex runner with normalized native compaction evidence."""

    def __init__(self, *args: Any, agent_label: str = "codex-cli", **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._agent_label = agent_label

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
    def populate_context_post_run(self, context: AgentContext) -> None:
        super().populate_context_post_run(context)
        trajectory_path = self.logs_dir / "trajectory.json"
        session_dir = self._get_session_dir()
        if not trajectory_path.exists() or session_dir is None:
            return

        value = json.loads(trajectory_path.read_text(encoding="utf-8"))
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
