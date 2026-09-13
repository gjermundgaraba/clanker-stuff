"""API-only adapters; service attempts are counted at the backend boundary."""

import json

from pi_evals.adapters.pi import PiEval, load_pi_events
from pi_evals.adapters.codex import CodexEval


class ServicePiEval(PiEval):
    _TELEMETRY_FILENAME = "service-events.jsonl"

    def _session_args(self) -> list[str]:
        return [*super()._session_args(), "--no-builtin-tools"]

    def populate_context_post_run(self, context) -> None:
        super().populate_context_post_run(context)
        path = self.logs_dir / "trajectory.json"
        trajectory = json.loads(path.read_text())
        events = load_pi_events(self.logs_dir / "service-events.jsonl")
        starts = [e for e in events if e.get("type") == "pi_eval_service_start"]
        ends = {
            e["operation"]: e for e in events if e.get("type") == "pi_eval_service_end"
        }
        trajectory["agent"]["extra"]["tool_operations"] = [
            {
                "name": e["name"],
                "success": ends.get(e["operation"], {}).get("success", False),
            }
            for e in starts
        ]
        trajectory["final_metrics"]["extra"]["underlying_operations"] = len(starts)
        path.write_text(json.dumps(trajectory, indent=2) + "\n")


class ServiceCodexEval(CodexEval):
    def populate_context_post_run(self, context) -> None:
        super().populate_context_post_run(context)
        path = self.logs_dir / "trajectory.json"
        trajectory = json.loads(path.read_text())
        events = load_pi_events(self.logs_dir / "service-events.jsonl")
        starts = [e for e in events if e.get("type") == "pi_eval_service_start"]
        audit = load_pi_events(self.logs_dir / "native-audit.jsonl")
        calls = [
            e
            for e in audit
            if e.get("method") == "rawResponseItem/completed"
            and e.get("params", {}).get("item", {}).get("type")
            in {"function_call", "custom_tool_call"}
        ]
        trajectory["final_metrics"]["extra"].update(
            underlying_operations=len(starts), tool_calls=len(calls)
        )
        trajectory["agent"]["extra"]["native_diagnostic_audit"] = audit
        path.write_text(json.dumps(trajectory, indent=2) + "\n")
