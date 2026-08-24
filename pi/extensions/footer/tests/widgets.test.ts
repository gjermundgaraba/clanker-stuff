import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { collectSessionTotals } from "../widgets.js";

const usage = (amount: number): Usage => ({
  cacheRead: amount,
  cacheWrite: amount,
  cost: {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    total: amount / 100,
  },
  input: amount,
  output: amount,
  totalTokens: amount * 2,
});

describe(collectSessionTotals, () => {
  it("sums usage from messages and summaries across all entries", () => {
    const base = (id: string) => ({
      id,
      parentId: null,
      timestamp: "2025-01-01T00:00:00.000Z",
    });
    const entries: SessionEntry[] = [
      {
        ...base("assistant"),
        message: {
          api: "faux",
          content: [],
          model: "faux",
          provider: "faux",
          role: "assistant",
          stopReason: "stop",
          timestamp: 0,
          usage: usage(1),
        },
        type: "message",
      },
      {
        ...base("tool"),
        message: {
          content: [],
          isError: false,
          role: "toolResult",
          timestamp: 0,
          toolCallId: "call",
          toolName: "test",
          usage: usage(2),
        },
        type: "message",
      },
      {
        ...base("compaction"),
        firstKeptEntryId: "assistant",
        summary: "summary",
        tokensBefore: 1,
        type: "compaction",
        usage: usage(3),
      },
      {
        ...base("branch"),
        fromId: "assistant",
        summary: "summary",
        type: "branch_summary",
        usage: usage(4),
      },
    ];
    const context = {
      sessionManager: {
        getEntries: () => entries,
        getHeader: () => ({
          timestamp: "2025-01-01T00:00:00.000Z",
        }),
        getSessionName: () => "demo",
      },
    };
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
