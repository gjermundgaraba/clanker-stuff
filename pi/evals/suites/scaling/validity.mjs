import { validateNativeAstra } from "./native-astra.mjs";
import { serviceMetrics } from "./scoring.mjs";
import { SERVICE_NAMES as names, FIXTURE as fixtureId } from "/opt/codex-provider/services.mjs";
export function validateNativeDiagnostic(trajectory, events) {
  const audit = trajectory?.agent?.extra?.native_diagnostic_audit ?? [];
  const starts = audit.filter((e) => e.type === "thread_started");
  const setups = events.filter((e) => e.type === "pi_eval_diagnostic");
  const finished = events.filter((e) => e.type === "native_finished");
  const calls = audit.filter(
    (e) =>
      e.method === "rawResponseItem/completed" &&
      ["function_call", "custom_tool_call"].includes(e.params?.item?.type),
  );
  return (
    validateNativeAstra(trajectory).valid_experiment === 1 &&
    serviceMetrics(events).ledger_complete &&
    starts.length === 1 &&
    starts[0].response.model === "gpt-6-astra" &&
    JSON.stringify(starts[0].response.thread.environments) === "[]" &&
    JSON.stringify(starts[0].dynamicTools.map((t) => t.name).sort()) === JSON.stringify(names) &&
    setups.length === 1 &&
    setups[0].fixture === fixtureId &&
    setups[0].mode === "native" &&
    setups[0].latency_ms === 150 &&
    JSON.stringify(setups[0].nestedTools) === JSON.stringify(names) &&
    finished.length === 1 &&
    finished[0].nativeVersion === starts[0].nativeVersion &&
    starts[0].nativeVersion === `codex-cli ${trajectory.agent.version}` &&
    !audit.some((e) => e.type === "runner_error" || e.method === "error") &&
    calls.length > 0 &&
    calls.every((e) => ["exec", "wait"].includes(e.params.item.name)) &&
    audit.some((e) => e.method === "turn/completed" && e.params?.turn?.status === "completed")
  );
}
