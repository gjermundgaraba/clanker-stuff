/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isRecord = (value) =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSONL telemetry and submitted answers are external object boundaries; exclude null and arrays before field access.
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {Record<string, unknown>} event @returns {event is import('./services.mjs').ServiceStart} */
/* oxlint-disable anti-slop/no-runtime-typeof -- Validate all service-start fields consumed by metric accounting; JSDoc predicates are not recognized by the syntax-only rule. */
const isStart = (event) =>
  event.type === "pi_eval_service_start" &&
  typeof event.operation === "number" &&
  Number.isSafeInteger(event.operation) &&
  event.operation > 0 &&
  typeof event.name === "string" &&
  typeof event.start_ms === "number" &&
  Number.isFinite(event.start_ms) &&
  typeof event.concurrent === "number" &&
  Number.isSafeInteger(event.concurrent) &&
  event.concurrent > 0;
/* oxlint-enable anti-slop/no-runtime-typeof */

/** @param {Record<string, unknown>} event @returns {event is import('./services.mjs').ServiceEnd} */
/* oxlint-disable anti-slop/no-runtime-typeof -- Validate the complete service-end accounting contract, rejecting nonfinite counters rather than poisoning independent metrics. */
const isEnd = (event) =>
  event.type === "pi_eval_service_end" &&
  typeof event.operation === "number" &&
  Number.isSafeInteger(event.operation) &&
  event.operation > 0 &&
  typeof event.name === "string" &&
  typeof event.start_ms === "number" &&
  Number.isFinite(event.start_ms) &&
  typeof event.end_ms === "number" &&
  Number.isFinite(event.end_ms) &&
  typeof event.success === "boolean" &&
  (event.error === null || typeof event.error === "string") &&
  typeof event.response_bytes === "number" &&
  Number.isSafeInteger(event.response_bytes) &&
  event.response_bytes >= 0;
/* oxlint-enable anti-slop/no-runtime-typeof */

/** @param {unknown[]} events Untrusted journal records; malformed rows invalidate completeness without hiding independent counts. */
export function serviceMetrics(events) {
  const records = events.filter(isRecord);
  const rawStarts = records.filter((e) => e.type === "pi_eval_service_start");
  const rawEnds = records.filter((e) => e.type === "pi_eval_service_end");
  const starts = rawStarts.filter(isStart);
  const ends = rawEnds.filter(isEnd);

  const complete =
    records.length === events.length &&
    starts.length === rawStarts.length &&
    ends.length === rawEnds.length &&
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
    underlying_operations: rawStarts.length,
    completed_operations: rawEnds.length,
    successful_operations: ends.filter((e) => e.success).length,
    transient_failures: ends.filter((e) => e.error === "temporarily_unavailable").length,
    other_failures: ends.filter((e) => !e.success && e.error !== "temporarily_unavailable").length,
    response_bytes: ends.reduce((sum, e) => sum + e.response_bytes, 0),
    max_concurrency: Math.max(0, ...starts.map((e) => e.concurrent)),
    service_elapsed_ms: ends.reduce((sum, e) => sum + e.end_ms - e.start_ms, 0),
    submissions: records.filter((e) => e.type === "pi_eval_submission").length,
  };
}
