// Additional scaling controls, run without a model service.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SETTINGS, fixture, createServices } from "/opt/codex-provider/services.mjs";
import { oracle, score, serviceMetrics } from "./scoring.mjs";
assert.equal(fixture().ledger.length, SETTINGS.count);
const summaries = JSON.parse(readFileSync("/logs/preflight.json", "utf8"));
for (const metrics of Object.values(summaries)) {
  assert.equal(metrics.underlying_operations, Math.ceil(SETTINGS.count / SETTINGS.page_size) + 1);
  assert.equal(metrics.max_concurrency, 1);
  assert.equal(metrics.ledger_complete, true);
}
const events = [],
  b = createServices({ latencyMs: 2, emit: (e) => events.push(e) });
const responses = await Promise.all(
  Array.from({ length: 3 }, () => b.call("list_records", { collection: "ledger", cursor: null })),
);
const starts = events.filter((e) => e.type === "pi_eval_service_start"),
  ends = events.filter((e) => e.type === "pi_eval_service_end");
for (let i = 1; i < starts.length; i++)
  assert.ok(starts[i].start_ms >= ends[i - 1].end_ms, "operations actually serialize");
assert.equal(serviceMetrics(events).max_concurrency, 1);
assert.ok(responses.every((r) => r.items.length === 20 && r.next_cursor));
assert.ok(
  (await b.call("list_records", { collection: "ledger", cursor: "page-20" })).error,
  "arithmetic cursors denied",
);
for (let n = 0; n < SETTINGS.budget; n++)
  await b.call("list_records", { collection: "ledger", cursor: null });
assert.ok(events.some((e) => e.error === "budget_exceeded"));
assert.equal(score(oracle(), oracle(), events).within_budget, 0);
console.log(
  "Scaling count, operation budget, opaque cursors and real single-operation cap passed.",
);
