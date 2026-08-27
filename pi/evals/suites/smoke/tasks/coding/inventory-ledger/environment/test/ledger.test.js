import assert from "node:assert/strict";
import test from "node:test";

import { applyEvents, parseEvents } from "../src/ledger.js";

void test("parses and applies normal events", () => {
  const events = parseEvents(
    '# seed\n{"type":"receive","sku":" a ","quantity":5}\n\n{"type":"ship","sku":"A","quantity":2}',
  );
  assert.deepEqual(events, [
    { type: "receive", sku: "A", quantity: 5, line: 2 },
    { type: "ship", sku: "A", quantity: 2, line: 4 },
  ]);
  assert.equal(applyEvents(events).get("A"), 3);
});
