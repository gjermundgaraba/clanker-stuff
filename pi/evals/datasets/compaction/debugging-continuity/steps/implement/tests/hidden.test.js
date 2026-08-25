import assert from "node:assert/strict";
import test from "node:test";

import { parseRoute } from "/app/src/route.js";

void test("normalizes both route parts", () => {
  assert.deepEqual(parseRoute(" API / EU-West-1 "), {
    region: "eu-west-1",
    service: "api",
  });
});

void test("rejects malformed routes", () => {
  for (const input of [null, 42, "api", "api/eu/extra", "api//eu", " /eu", "api/ "]) {
    assert.throws(() => parseRoute(input), TypeError);
  }
});
