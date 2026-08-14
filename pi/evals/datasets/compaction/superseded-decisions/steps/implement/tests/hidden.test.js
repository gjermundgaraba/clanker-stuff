import assert from "node:assert/strict";
import test from "node:test";

import { planDeployment } from "/app/src/deployment.js";

test("retains early rules and applies only current policies", () => {
  assert.deepEqual(
    planDeployment({
      attempts: 5,
      ignored: true,
      regions: ["APAC", " us ", "apac", "eu"],
      service: " Worker ",
      target: " Staging ",
    }),
    {
      attempts: 5,
      regions: ["us", "eu", "apac"],
      service: "worker",
      target: "staging",
    }
  );
});

test("validates current limits", () => {
  const base = { regions: [], service: "api", target: "prod" };
  assert.throws(() => planDeployment({ ...base, service: " " }), TypeError);
  for (const attempts of [-1, 6, 1.5, "2"]) {
    assert.throws(() => planDeployment({ ...base, attempts }), TypeError);
  }
});
