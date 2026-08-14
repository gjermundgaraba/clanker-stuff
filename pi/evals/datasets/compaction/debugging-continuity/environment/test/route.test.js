import assert from "node:assert/strict";
import test from "node:test";

import { parseRoute } from "../src/route.js";

test("parses a basic route", () => {
  assert.deepEqual(parseRoute("api/us-east-1"), {
    region: "us-east-1",
    service: "api",
  });
});
