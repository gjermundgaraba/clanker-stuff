import assert from "node:assert/strict";
import test from "node:test";

import { planDeployment } from "../src/deployment.js";

test("normalizes a basic deployment with the current policy", () => {
  assert.deepEqual(
    planDeployment({
      service: " API ",
      target: " PROD ",
      regions: ["eu", "us"],
    }),
    {
      attempts: 4,
      regions: ["us", "eu"],
      service: "api",
      target: "prod",
    }
  );
});
