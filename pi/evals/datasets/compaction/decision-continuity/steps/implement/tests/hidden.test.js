import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRelease } from "/app/src/release.js";

void test("applies all accumulated release decisions", () => {
  assert.deepEqual(
    normalizeRelease({
      artifacts: [" App.zip ", "app.ZIP", "symbols.tgz", ""],
      channel: " BETA ",
      regions: ["APAC", " us ", "eu"],
      rolloutPercent: "25",
    }),
    {
      artifacts: ["App.zip", "symbols.tgz"],
      channel: "beta",
      regions: ["us", "eu", "apac"],
      rolloutPercent: 25,
    },
  );
});

void test("validates channel and rollout", () => {
  assert.throws(() => normalizeRelease({ artifacts: [], channel: "edge", regions: [] }), TypeError);
  for (const rolloutPercent of [-1, 101, 1.5, "nope"]) {
    assert.throws(
      () =>
        normalizeRelease({
          artifacts: [],
          channel: "stable",
          regions: [],
          rolloutPercent,
        }),
      TypeError,
    );
  }
});
