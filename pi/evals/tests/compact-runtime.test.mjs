import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateCompaction } from "../runtime/pi-eval-compact.mjs";

/** @typedef {Parameters<typeof validateCompaction>[0][number]} CompactionTerminal */

/** @type {CompactionTerminal} */
const succeeded = { type: "compaction_end", aborted: false, result: { usage: {} } };

/** @type {CompactionTerminal} */
const failed = { type: "compaction_end", aborted: false, errorMessage: "failed" };

/** @type {CompactionTerminal} */
const aborted = { type: "compaction_end", aborted: true };

const commandError = new Error("compaction command failed");

void describe("validateCompaction", () => {
  void it("classifies one terminal event consistent with the compact command", () => {
    assert.equal(validateCompaction([succeeded], undefined, false), "succeeded");
    assert.equal(validateCompaction([failed], commandError, false), "failed");
    assert.equal(validateCompaction([aborted], commandError, false), "aborted");
    assert.equal(validateCompaction([failed], undefined, true), "failed");
  });

  void it("rejects missing, repeated, malformed, or inconsistent terminal events", () => {
    for (const [terminals, error] of /** @type {const} */ ([
      [[], undefined],
      [[succeeded, succeeded], undefined],
      [[{ type: "compaction_end", aborted: false }], undefined],
      [[failed], undefined],
      [[succeeded], commandError],
    ])) {
      assert.throws(() => validateCompaction([...terminals], error, false));
    }
  });
});
