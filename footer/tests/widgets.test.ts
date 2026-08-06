import { describe, expect, it } from "vitest";

import { collectSessionTotals } from "../widgets.js";

const usage = (amount: number) => ({
  cacheRead: amount,
  cacheWrite: amount,
  cost: { total: amount / 100 },
  input: amount,
  output: amount,
});

describe(collectSessionTotals, () => {
  it("sums usage from messages and summaries across all entries", () => {
    const context = {
      sessionManager: {
        getEntries: () => [
          {
            message: { role: "assistant", usage: usage(1) },
            type: "message",
          },
          {
            message: { role: "toolResult", usage: usage(2) },
            type: "message",
          },
          { type: "compaction", usage: usage(3) },
          { type: "branch_summary", usage: usage(4) },
        ],
        getHeader: () => ({
          timestamp: "2025-01-01T00:00:00.000Z",
        }),
        getSessionName: () => "demo",
      },
    } as never;
    expect(collectSessionTotals(context)).toStrictEqual({
      cacheRead: 10,
      cacheWrite: 10,
      cost: 0.1,
      input: 10,
      name: "demo",
      output: 10,
      startedAt: Date.parse("2025-01-01T00:00:00.000Z"),
    });
  });
});
