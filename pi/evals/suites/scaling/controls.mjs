// Additional scaling controls, run without a model service.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SETTINGS, fixture, createServices } from "/opt/codex-provider/services.mjs";
import { isRecord } from "./service-metrics.mjs";
import { oracle, score, serviceMetrics } from "./scoring.mjs";

assert.equal(fixture().ledger.length, SETTINGS.count);

/** @type {unknown} */
const summaries = JSON.parse(readFileSync("/logs/preflight.json", "utf8"));

assert.ok(isRecord(summaries));

assert.deepEqual(Object.keys(summaries).sort(), ["code", "direct"]);

for (const metrics of Object.values(summaries)) {
  assert.ok(isRecord(metrics));
  assert.equal(metrics.underlying_operations, Math.ceil(SETTINGS.count / SETTINGS.page_size) + 1);
  assert.equal(metrics.max_concurrency, 1);
  assert.equal(metrics.ledger_complete, true);
}

/** @type {import("./services.mjs").ServiceEvent[]} */
const events = [];

const b = createServices({
  latencyMs: 2,
  emit: (e) => {
    events.push(e);
  },
});

const responses = await Promise.all(
  Array.from({ length: 3 }, () => b.call("list_records", { collection: "ledger", cursor: null })),
);

const starts = events.filter((e) => e.type === "pi_eval_service_start"),
  ends = events.filter((e) => e.type === "pi_eval_service_end");

for (const [index, start] of starts.entries()) {
  if (index === 0) continue;
  const previous = ends[index - 1];
  assert.ok(previous, "every preceding operation finished");
  assert.ok(start.start_ms >= previous.end_ms, "operations actually serialize");
}

assert.equal(serviceMetrics(events).max_concurrency, 1);

assert.ok(responses.every((r) => "items" in r && r.items.length === 20 && r.next_cursor));

assert.ok(
  "error" in (await b.call("list_records", { collection: "ledger", cursor: "page-20" })),
  "arithmetic cursors denied",
);

for (let n = 0; n < SETTINGS.budget; n++)
  await b.call("list_records", { collection: "ledger", cursor: null });

assert.ok(events.some((e) => e.type === "pi_eval_service_end" && e.error === "budget_exceeded"));

assert.equal(score(oracle(), oracle(), events).within_budget, 0);

console.log(
  "Scaling count, operation budget, opaque cursors and real single-operation cap passed.",
);
