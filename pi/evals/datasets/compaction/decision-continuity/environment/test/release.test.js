import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRelease } from "../src/release.js";

test("normalizes a basic release", () => {
  assert.deepEqual(
    normalizeRelease({
      artifacts: ["app.zip"],
      channel: " STABLE ",
      regions: ["eu", "us"],
    }),
    {
      artifacts: ["app.zip"],
      channel: "stable",
      regions: ["us", "eu"],
      rolloutPercent: 100,
    }
  );
});
