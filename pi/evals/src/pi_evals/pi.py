from __future__ import annotations

import json
import shlex
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)

from pi_evals.auth import require_auth_file

_REMOTE_PI_HOME = PurePosixPath("/tmp/pi-eval")
_REMOTE_EVENT_LOG = PurePosixPath("/logs/agent/pi-events.jsonl")
_REMOTE_STDERR_LOG = PurePosixPath("/logs/agent/pi-stderr.log")
_REMOTE_SESSION_DIR = PurePosixPath("/logs/agent/pi/sessions")
_REMOTE_COMPACTION_CONFIG = PurePosixPath("/tmp/pi-eval-compaction.json")
CONTROLLED_COMPACTION_MARKER = "<!-- pi-evals:compact-before -->\n"
_PI_EVENT_GUARD = (
    "let buffer='',completed=false,failed=false;"
    "const check=line=>{if(!line)return;try{const e=JSON.parse(line);"
    "if(e.type==='message_end'&&e.message?.role==='assistant'){completed=true;"
    "if(['error','aborted'].includes(e.message.stopReason))failed=true;}"
    "}catch{failed=true}};"
    "process.stdin.setEncoding('utf8');"
    "process.stdin.on('data',chunk=>{buffer+=chunk;let end;"
    "while((end=buffer.indexOf('\\n'))>=0){check(buffer.slice(0,end));"
    "buffer=buffer.slice(end+1);}});"
    "process.stdin.on('end',()=>{check(buffer);"
    "process.exitCode=completed&&!failed?0:1;});"
)


def _number(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _money(value: Any) -> float:
    return (
        float(value)
        if isinstance(value, (int, float)) and not isinstance(value, bool)
        else 0.0
    )


def _timestamp(value: Any) -> str | None:
    if not isinstance(value, (int, float)):
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )


def _text(content: Any, *, thinking: bool = False) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if thinking and block_type == "thinking" and isinstance(block.get("thinking"), str):
            parts.append(block["thinking"])
        elif not thinking and block_type == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif not thinking and block_type == "image":
            parts.append("[image omitted]")
    return "\n".join(part for part in parts if part)


def _arguments(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {"value": value}


def controlled_instruction(instruction: str, enabled: bool) -> tuple[str, bool]:
    marked = instruction.startswith(CONTROLLED_COMPACTION_MARKER)
    if CONTROLLED_COMPACTION_MARKER in instruction[len(CONTROLLED_COMPACTION_MARKER) :]:
        raise ValueError("controlled compaction marker must be the first line")
    if not marked and CONTROLLED_COMPACTION_MARKER in instruction:
        raise ValueError("controlled compaction marker must be the first line")
    return (
        instruction.removeprefix(CONTROLLED_COMPACTION_MARKER),
        marked and enabled,
    )


def _result_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, dict) and "content" in result:
        rendered = _text(result["content"])
        return rendered if rendered else json.dumps(result, ensure_ascii=False, default=str)
    return json.dumps(result, ensure_ascii=False, default=str)


def _usage(value: Any) -> tuple[Metrics | None, dict[str, int | float]]:
    if not isinstance(value, dict):
        return None, {
            "cache_read": 0,
            "cache_write": 0,
            "cost": 0.0,
            "input": 0,
            "output": 0,
            "reasoning": 0,
        }
    cache_read = _number(value.get("cacheRead"))
    cache_write = _number(value.get("cacheWrite"))
    input_tokens = _number(value.get("input"))
    output_tokens = _number(value.get("output"))
    reasoning_tokens = _number(value.get("reasoning"))
    cost = _money(
        value.get("cost", {}).get("total")
        if isinstance(value.get("cost"), dict)
        else None
    )
    totals: dict[str, int | float] = {
        "cache_read": cache_read,
        "cache_write": cache_write,
        "cost": cost,
        "input": input_tokens,
        "output": output_tokens,
        "reasoning": reasoning_tokens,
    }
    if not any(totals.values()):
        return None, totals
    return (
        Metrics(
            prompt_tokens=input_tokens + cache_read + cache_write,
            completion_tokens=output_tokens,
            cached_tokens=cache_read or None,
            cost_usd=cost or None,
            extra={
                "cache_write_tokens": cache_write,
                "reasoning_tokens": reasoning_tokens,
            },
        ),
        totals,
    )


def _add_totals(target: dict[str, int | float], source: dict[str, int | float]) -> None:
    for key, value in source.items():
        target[key] += value


def _compaction_extra(event: dict[str, Any]) -> dict[str, Any]:
    result = event.get("result") if isinstance(event.get("result"), dict) else {}
    entry = (
        result.get("compactionEntry")
        if isinstance(result.get("compactionEntry"), dict)
        else {}
    )
    details = result.get("details") if isinstance(result.get("details"), dict) else {}
    checkpoint = (
        details.get("checkpoint")
        if isinstance(details.get("checkpoint"), dict)
        else {}
    )
    protocol = checkpoint.get("protocol")
    succeeded = bool(result) and not event.get("errorMessage") and not event.get("aborted")
    state = "succeeded" if succeeded else "aborted" if event.get("aborted") else "failed"
    tokens_before = result.get("tokensBefore", entry.get("tokensBefore"))
    return {
        "aborted": bool(event.get("aborted")),
        "error_message": event.get("errorMessage"),
        "event_type": "context_compaction",
        "mechanism": "codex-provider" if protocol else "pi-builtin",
        "protocol": protocol if isinstance(protocol, str) else None,
        "reason": event.get("reason"),
        "state": state,
        "tokens_before": tokens_before if isinstance(tokens_before, int) else None,
        "will_retry": bool(event.get("willRetry")),
    }


def convert_pi_events(
    events: list[dict[str, Any]],
    instructions: list[str],
    *,
    agent_version: str,
    model_name: str | None,
    fallback_session_id: str | None = None,
) -> Trajectory:
    """Convert Pi's JSON event stream into one ATIF trajectory."""
    steps: list[Step] = []
    calls: dict[str, Step] = {}
    totals: dict[str, int | float] = {
        "cache_read": 0,
        "cache_write": 0,
        "cost": 0.0,
        "input": 0,
        "output": 0,
        "reasoning": 0,
    }
    session_id = fallback_session_id
    compaction_attempts = 0
    compactions = 0
    tool_calls = 0
    segment = -1

    def append_step(**kwargs: Any) -> Step:
        step = Step(step_id=len(steps) + 1, **kwargs)
        steps.append(step)
        return step

    for event in events:
        event_type = event.get("type")
        if event_type == "session" and isinstance(event.get("id"), str):
            session_id = event["id"]
            continue
        if event_type == "harbor_instruction":
            index = event.get("index")
            if isinstance(index, int) and 0 <= index < len(instructions):
                segment = index
                append_step(
                    source="user",
                    message=instructions[index],
                    timestamp=_timestamp(event.get("timestamp")),
                    extra={"segment": segment},
                )
            continue
        if event_type == "compaction_end":
            compaction_attempts += 1
            result = event.get("result") if isinstance(event.get("result"), dict) else {}
            compaction_extra = _compaction_extra(event)
            if compaction_extra["state"] == "succeeded":
                compactions += 1
            compaction_metrics, compaction_usage = _usage(result.get("usage"))
            _add_totals(totals, compaction_usage)
            append_step(
                source="agent",
                message=f"Pi context compaction {compaction_extra['state']}",
                observation=Observation(
                    results=[
                        ObservationResult(
                            content=compaction_extra["state"]
                        )
                    ]
                ),
                metrics=compaction_metrics,
                llm_call_count=1 if compaction_metrics else None,
                extra={
                    **compaction_extra,
                    "compacted_after_segment": segment,
                },
            )
            continue
        if event_type == "message_end":
            message = event.get("message")
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            metrics, message_usage = _usage(message.get("usage"))
            _add_totals(totals, message_usage)
            content = message.get("content")
            message_calls: list[ToolCall] = []
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict) or block.get("type") != "toolCall":
                        continue
                    call_id = block.get("id")
                    name = block.get("name")
                    if not isinstance(call_id, str) or not isinstance(name, str):
                        continue
                    message_calls.append(
                        ToolCall(
                            tool_call_id=call_id,
                            function_name=name,
                            arguments=_arguments(block.get("arguments")),
                        )
                    )
            step = append_step(
                source="agent",
                message=_text(content),
                reasoning_content=_text(content, thinking=True) or None,
                model_name=(
                    message.get("model")
                    if isinstance(message.get("model"), str)
                    else model_name
                ),
                tool_calls=message_calls or None,
                metrics=metrics,
                llm_call_count=1,
                timestamp=_timestamp(message.get("timestamp")),
                extra={
                    "api": message.get("api"),
                    "error_message": message.get("errorMessage"),
                    "provider": message.get("provider"),
                    "segment": segment,
                    "stop_reason": message.get("stopReason"),
                },
            )
            for call in message_calls:
                calls[call.tool_call_id] = step
            tool_calls += len(message_calls)
            continue
        if event_type == "tool_execution_start":
            call_id = event.get("toolCallId")
            name = event.get("toolName")
            if not isinstance(call_id, str) or not isinstance(name, str) or call_id in calls:
                continue
            step = append_step(
                source="agent",
                message="",
                tool_calls=[
                    ToolCall(
                        tool_call_id=call_id,
                        function_name=name,
                        arguments=_arguments(event.get("args")),
                    )
                ],
                extra={"segment": segment},
            )
            calls[call_id] = step
            tool_calls += 1
            continue
        if event_type != "tool_execution_end":
            continue
        call_id = event.get("toolCallId")
        name = event.get("toolName")
        if not isinstance(call_id, str) or not isinstance(name, str):
            continue
        step = calls.get(call_id)
        if step is None:
            step = append_step(
                source="agent",
                message="",
                tool_calls=[ToolCall(tool_call_id=call_id, function_name=name, arguments={})],
                extra={"segment": segment},
            )
            calls[call_id] = step
            tool_calls += 1
        results = list(step.observation.results) if step.observation else []
        results.append(
            ObservationResult(
                source_call_id=call_id,
                content=_result_text(event.get("result")),
                extra={"is_error": bool(event.get("isError")), "tool_name": name},
            )
        )
        step.observation = Observation(results=results)

    if not steps:
        append_step(source="system", message="Pi produced no structured events")

    return Trajectory(
        schema_version="ATIF-v1.7",
        session_id=session_id,
        agent=Agent(name="pi-eval", version=agent_version, model_name=model_name),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=int(
                totals["input"] + totals["cache_read"] + totals["cache_write"]
            ),
            total_completion_tokens=int(totals["output"]),
            total_cached_tokens=int(totals["cache_read"]),
            total_cost_usd=float(totals["cost"]),
            total_steps=len(steps),
            extra={
                "cache_write_tokens": int(totals["cache_write"]),
                "cost_basis": "api_list_price_estimate",
                "compaction_attempts": compaction_attempts,
                "compactions": compactions,
                "compaction_failures": compaction_attempts - compactions,
                "reasoning_tokens": int(totals["reasoning"]),
                "tool_calls": tool_calls,
            },
        ),
    )


def load_pi_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if not path.exists():
        return events
    for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{number}: invalid JSON") from error
        if not isinstance(event, dict):
            raise ValueError(f"{path}:{number}: expected an object")
        events.append(event)
    return events


class PiEval(Pi):
    """An isolated Harbor Pi runner with raw JSON and ATIF output."""

    SUPPORTS_ATIF = True
    _OUTPUT_FILENAME = _REMOTE_EVENT_LOG.name

    def __init__(
        self,
        *args: Any,
        auth_json_path: str | Path | None = None,
        agent_label: str = "pi-eval",
        controlled_compaction: bool = False,
        extensions: list[str] | None = None,
        isolated: bool = True,
        settings: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._auth_json_path = Path(auth_json_path).expanduser() if auth_json_path else None
        self._agent_label = agent_label
        self._controlled_compaction = controlled_compaction
        self._extensions = extensions or []
        self._isolated = isolated
        self._settings = settings or {}
        self._instructions: list[str] = []
        json.dumps(self._settings, allow_nan=False)

    @staticmethod
    @override
    def name() -> str:
        return "pi-eval"

    def _resolve_auth_json_path(self, provider: str) -> Path:
        path = self._auth_json_path
        if path is None and (configured := self._get_env("PI_EVAL_AUTH_JSON_PATH")):
            path = Path(configured)
        return require_auth_file(
            path or Path.home() / ".pi" / "agent" / "auth.json",
            (
                (provider, "access"),
                (provider, "refresh"),
                (provider, "key"),
            ),
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        installed = await self.exec_as_agent(
            environment,
            command='test "$(node --version | cut -d. -f1)" = v24 && pi --version',
        )
        installed_version = self.parse_version(installed.stdout or "")
        if installed.return_code != 0 or not installed_version:
            raise RuntimeError("evaluation image does not contain a working Pi runtime")
        if self._version and installed_version != self._version:
            raise RuntimeError(
                f"evaluation image has Pi {installed_version}, expected {self._version}"
            )
        self._version = installed_version
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {_REMOTE_PI_HOME.as_posix()} {_REMOTE_SESSION_DIR.as_posix()}",
        )
        provider = self.model_name.split("/", 1)[0] if self.model_name else ""
        auth_path = self._resolve_auth_json_path(provider)
        await environment.upload_file(auth_path, (_REMOTE_PI_HOME / "auth.json").as_posix())
        await self.exec_as_root(
            environment,
            command=f"chmod 600 {(_REMOTE_PI_HOME / 'auth.json').as_posix()}",
        )
        if self._settings:
            await self._upload_config_text(
                environment,
                content=f"{json.dumps(self._settings, indent=2)}\n",
                remote_path=(_REMOTE_PI_HOME / "settings.json").as_posix(),
                filename="settings.json",
            )
        if environment.default_user is not None:
            owner = shlex.quote(str(environment.default_user))
            await self.exec_as_root(
                environment,
                command=(
                    f"chown -R {owner} {_REMOTE_PI_HOME.as_posix()} "
                    f"{_REMOTE_SESSION_DIR.parent.as_posix()}"
                ),
            )
        for extension in self._extensions:
            await self.exec_as_agent(
                environment,
                command=f"test -e {shlex.quote(extension)}",
            )

    def _session_args(self) -> list[str]:
        args = [
            "--session-dir",
            _REMOTE_SESSION_DIR.as_posix(),
            *(["--continue"] if self._resume else []),
        ]
        cli_flags = self.build_cli_flags()
        if cli_flags:
            args.extend(shlex.split(cli_flags))
        if self._isolated:
            args.extend(
                [
                    "--no-extensions",
                    "--no-prompt-templates",
                    "--no-themes",
                    "--no-context-files",
                    "--no-approve",
                ]
            )
            if not self.skills_dir:
                args.append("--no-skills")
        for extension in self._extensions:
            args.extend(["--extension", extension])
        return args

    async def _compact(
        self,
        environment: BaseEnvironment,
        *,
        env: dict[str, str],
        model: str,
        provider: str,
    ) -> None:
        await self._upload_config_text(
            environment,
            content=json.dumps(
                {
                    "args": self._session_args(),
                    "cwd": "/app",
                    "model": model,
                    "provider": provider,
                }
            ),
            remote_path=_REMOTE_COMPACTION_CONFIG.as_posix(),
            filename="compaction.json",
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -o pipefail; "
                f"pi-eval-compact {_REMOTE_COMPACTION_CONFIG.as_posix()} "
                f"2>> {_REMOTE_STDERR_LOG.as_posix()} | "
                f"stdbuf -oL tee -a {_REMOTE_EVENT_LOG.as_posix()}"
            ),
            env=env,
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        instruction, compact_before = controlled_instruction(
            instruction, self._controlled_compaction
        )
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        provider, model = self.model_name.split("/", 1)
        access = self.model_connection
        provider = access.provider or provider
        env = {**access.env, "PI_CODING_AGENT_DIR": _REMOTE_PI_HOME.as_posix()}
        if provider == "anthropic" and (
            oauth_token := self._get_env("ANTHROPIC_OAUTH_TOKEN")
        ):
            env["ANTHROPIC_OAUTH_TOKEN"] = oauth_token

        if self.skills_dir:
            await self.exec_as_agent(
                environment, command=self._build_register_skills_command() or "true"
            )

        session_args = self._session_args()
        args = [
            "--print",
            "--mode",
            "json",
            "--provider",
            provider,
            "--model",
            model,
            *session_args,
        ]

        index = len(self._instructions)
        if compact_before:
            await self._compact(
                environment,
                env=env,
                model=model,
                provider=provider,
            )
        self._instructions.append(instruction)
        marker = json.dumps(
            {
                "index": index,
                "timestamp": int(time.time() * 1000),
                "type": "harbor_instruction",
            }
        )
        prompt_path = (_REMOTE_PI_HOME / "instruction.md").as_posix()
        await self._upload_config_text(
            environment,
            content=instruction,
            remote_path=prompt_path,
            filename="instruction.md",
        )
        reset = f": > {_REMOTE_EVENT_LOG.as_posix()}; " if not self._resume else ""
        command = (
            "set -o pipefail; "
            f"{reset}: > {_REMOTE_STDERR_LOG.as_posix()}; "
            f"printf '%s\\n' {shlex.quote(marker)} >> {_REMOTE_EVENT_LOG.as_posix()}; "
            f"pi {shlex.join(args)} "
            f"2>> {_REMOTE_STDERR_LOG.as_posix()} < {prompt_path} | "
            f"stdbuf -oL tee -a {_REMOTE_EVENT_LOG.as_posix()} | "
            f"node -e {shlex.quote(_PI_EVENT_GUARD)}"
        )
        await self.exec_as_agent(environment, command=command, env=env)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        events = load_pi_events(self.logs_dir / self._OUTPUT_FILENAME)
        trajectory = convert_pi_events(
            events,
            self._instructions,
            agent_version=self.version() or "unknown",
            model_name=self.model_name,
            fallback_session_id=self.session_id,
        )
        trajectory.agent.name = self._agent_label
        (self.logs_dir / "trajectory.json").write_text(
            json.dumps(trajectory.to_json_dict(), indent=2) + "\n",
            encoding="utf-8",
        )

        marker_indexes = [
            index for index, event in enumerate(events) if event.get("type") == "harbor_instruction"
        ]
        current_events = events[marker_indexes[-1] :] if marker_indexes else events
        totals: dict[str, int | float] = {
            "cache_read": 0,
            "cache_write": 0,
            "cost": 0.0,
            "input": 0,
            "output": 0,
            "reasoning": 0,
        }
        for event in current_events:
            usage: Any = None
            if event.get("type") == "message_end" and isinstance(event.get("message"), dict):
                usage = event["message"].get("usage")
            elif event.get("type") == "compaction_end" and isinstance(event.get("result"), dict):
                usage = event["result"].get("usage")
            _, event_totals = _usage(usage)
            _add_totals(totals, event_totals)
        context.n_input_tokens = int(
            totals["input"] + totals["cache_read"] + totals["cache_write"]
        )
        context.n_output_tokens = int(totals["output"])
        context.n_cache_tokens = int(totals["cache_read"])
        context.cost_usd = float(totals["cost"]) or None
