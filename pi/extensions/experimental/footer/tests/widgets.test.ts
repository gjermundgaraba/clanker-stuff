import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { buildBuiltinWidgets, collectSessionTotals } from "../widgets.js";

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

describe(buildBuiltinWidgets, () => {
  const widgets = (percent: number) =>
    buildBuiltinWidgets(
      createExtensionHost(() => {}).createContext({
        cwd: "/tmp/project",
        getContextUsage: () => ({ contextWindow: 100, percent, tokens: percent }),
      }),
      {
        git: { ahead: 0, behind: 0, branch: "main", staged: 0, unstaged: 2, untracked: 1 },
        now: 0,
        session: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0 },
        thinkingLevel: "high",
      },
    );

  const tones = (percent: number, id: string) => {
    const snapshot = widgets(percent).get(id)?.snapshot;
    const icon = snapshot?.icon === false ? undefined : snapshot?.icon?.tone;

    return new Set([icon, ...(snapshot?.content.map((span) => span.tone) ?? [])]);
  };

  const LOUD = ["accent", "success", "warning", "error"] as const;

  it("spends no hue at rest, including on a dirty working tree", () => {
    for (const id of ["footer.cwd", "footer.git", "footer.git.details", "footer.context"]) {
      for (const tone of LOUD) expect(tones(10, id)).not.toContain(tone);
    }
  });

  it("drives the context meter from the shared usage ramp", () => {
    expect(tones(70, "footer.context")).toContain("warning");
    expect(tones(90, "footer.context")).toContain("error");
  });
});
