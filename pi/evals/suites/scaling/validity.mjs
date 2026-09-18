import { validateNativeAstra } from "./native-astra.mjs";
import { isRecord, serviceMetrics } from "./service-metrics.mjs";
import { SERVICE_NAMES as names, FIXTURE as fixtureId } from "/opt/codex-provider/services.mjs";

/** @param {unknown} trajectory @param {unknown[]} events */
export function validateNativeDiagnostic(trajectory, events) {
  const agent = isRecord(trajectory) && isRecord(trajectory.agent) ? trajectory.agent : undefined;
  const extra = isRecord(agent?.extra) ? agent.extra : undefined;
  /** @type {unknown[]} */
  const audit = Array.isArray(extra?.native_diagnostic_audit) ? extra.native_diagnostic_audit : [];
  const records = audit.filter(isRecord);
  const starts = records.filter((e) => e.type === "thread_started");
  const setups = events.filter(isRecord).filter((e) => e.type === "pi_eval_diagnostic");
  const finished = events.filter(isRecord).filter((e) => e.type === "native_finished");

  const [start] = starts,
    [setup] = setups,
    [finish] = finished;

  const response = isRecord(start?.response) ? start.response : undefined;
  const thread = isRecord(response?.thread) ? response.thread : undefined;
  /** @type {unknown[]} */
  const dynamicTools = Array.isArray(start?.dynamicTools) ? start.dynamicTools : [];

  const calls = records.flatMap((e) => {
    const item = isRecord(e.params) && isRecord(e.params.item) ? e.params.item : undefined;

    return e.method === "rawResponseItem/completed" &&
      (item?.type === "function_call" || item?.type === "custom_tool_call")
      ? [item]
      : [];
  });

  return (
    validateNativeAstra(trajectory).valid_experiment === 1 &&
    serviceMetrics(events).ledger_complete &&
    records.length === audit.length &&
    starts.length === 1 &&
    start !== undefined &&
    response?.model === "gpt-6-astra" &&
    JSON.stringify(thread?.environments) === "[]" &&
    dynamicTools.every(isRecord) &&
    JSON.stringify(
      dynamicTools.map((t) => t.name).sort((a, b) => String(a).localeCompare(String(b))),
    ) === JSON.stringify(names) &&
    setups.length === 1 &&
    setup !== undefined &&
    setup.fixture === fixtureId &&
    setup.mode === "native" &&
    setup.latency_ms === 150 &&
    JSON.stringify(setup.nestedTools) === JSON.stringify(names) &&
    finished.length === 1 &&
    finish !== undefined &&
    finish.nativeVersion === start.nativeVersion &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Match the audited native CLI version to the actual string version in the external trajectory.
    typeof agent?.version === "string" &&
    start.nativeVersion === `codex-cli ${agent.version}` &&
    !records.some((e) => e.type === "runner_error" || e.method === "error") &&
    calls.length > 0 &&
    calls.every((e) => e.name === "exec" || e.name === "wait") &&
    records.some(
      (e) =>
        e.method === "turn/completed" &&
        isRecord(e.params) &&
        isRecord(e.params.turn) &&
        e.params.turn.status === "completed",
    )
  );
}
