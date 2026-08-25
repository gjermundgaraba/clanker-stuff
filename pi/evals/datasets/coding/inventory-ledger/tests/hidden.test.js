import assert from "node:assert/strict";
import test from "node:test";

import { applyEvents, parseEvents } from "/app/src/ledger.js";

void test("handles empty input, adjustment, and physical error lines", () => {
  assert.deepEqual(parseEvents("  \n # none\n"), []);
  assert.equal(applyEvents(parseEvents('{"type":"adjust","sku":"x","quantity":0}')).get("X"), 0);
  assert.throws(() => parseEvents('# x\n\n{"type":'), {
    name: "SyntaxError",
    message: /^line 3:/,
  });
});

void test("rejects invalid events and negative stock", () => {
  for (const source of [
    "null",
    '{"type":"ship","sku":"x","quantity":0}',
    '{"type":"wat","sku":"x","quantity":1}',
    '{"type":"adjust","sku":" ","quantity":1}',
  ]) {
    assert.throws(() => parseEvents(source), { message: /^line 1:/ });
  }
  assert.throws(() => applyEvents([{ type: "ship", sku: "X", quantity: 1, line: 9 }]), {
    name: "RangeError",
    message: /X.*9|9.*X/,
  });
});
