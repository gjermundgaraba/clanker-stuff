import { isDeepStrictEqual as equal } from "node:util";
import { fixture, SETTINGS } from "/opt/codex-provider/services.mjs";

import { isRecord } from "./service-metrics.mjs";

export { serviceMetrics } from "./service-metrics.mjs";

export function oracle(data = fixture()) {
  const rows = [];

  for (let n = 0; n < 7; n++) {
    const tenant = `tenant-${n}`;
    rows.push({
      tenant,
      net_cents: data.ledger
        .filter(
          (r) =>
            r.tenant === tenant &&
            r.status === "posted" &&
            r.currency === "USD" &&
            r.day >= 8 &&
            r.day <= 24,
        )
        .reduce((s, r) => s + r.amount_cents - r.refund_cents, 0),
    });
  }

  return { rows, total_cents: rows.reduce((s, r) => s + r.net_cents, 0) };
}

/** @param {unknown} submitted @param {ReturnType<typeof oracle>} expected @param {unknown[]} events */
export function score(submitted, expected = oracle(), events = []) {
  const report = isRecord(submitted) ? submitted : undefined;
  /** @type {unknown[]} */
  const rows = Array.isArray(report?.rows) ? report.rows : [];

  const correct = expected.rows.filter((r) => rows.some((s) => equal(s, r))).length;

  const supplemental = {
    row_accuracy: correct / expected.rows.length,
    total_correct: Number(report?.total_cents === expected.total_cents),
    within_budget: Number(
      events.filter((e) => isRecord(e) && e.type === "pi_eval_service_start").length <=
        SETTINGS.budget,
    ),
  };

  const exact = Number(equal(submitted, expected)) * supplemental.within_budget;

  return { quality: exact, reward: exact, ...supplemental };
}
