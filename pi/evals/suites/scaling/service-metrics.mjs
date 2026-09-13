export function serviceMetrics(events) {
  const starts = events.filter((e) => e.type === "pi_eval_service_start");
  const ends = events.filter((e) => e.type === "pi_eval_service_end");
  const complete =
    starts.length > 0 &&
    starts.length === ends.length &&
    new Set(starts.map((e) => e.operation)).size === starts.length &&
    new Set(ends.map((e) => e.operation)).size === ends.length &&
    starts.every((s) =>
      ends.some(
        (e) =>
          e.operation === s.operation &&
          e.name === s.name &&
          e.start_ms === s.start_ms &&
          e.end_ms >= s.start_ms,
      ),
    );
  return {
    ledger_complete: complete,
    underlying_operations: starts.length,
    completed_operations: ends.length,
    successful_operations: ends.filter((e) => e.success).length,
    transient_failures: ends.filter((e) => e.error === "temporarily_unavailable").length,
    other_failures: ends.filter((e) => !e.success && e.error !== "temporarily_unavailable").length,
    response_bytes: ends.reduce((sum, e) => sum + e.response_bytes, 0),
    max_concurrency: Math.max(0, ...starts.map((e) => e.concurrent)),
    service_elapsed_ms: ends.reduce((sum, e) => sum + e.end_ms - e.start_ms, 0),
    submissions: events.filter((e) => e.type === "pi_eval_submission").length,
  };
}
