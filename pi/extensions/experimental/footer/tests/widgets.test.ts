import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { buildBuiltinWidgets, collectSessionTotals } from "../widgets.js";
import { sessionReads } from "./helpers.js";

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
  it("sums usage from messages, summaries and standalone usage of any kind across all entries", () => {
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
      {
        ...base("warm"),
        type: "usage",
        kind: "cache_warm",
        provider: "faux",
        model: "faux",
        usage: usage(5),
      },
      {
        ...base("other"),
        type: "usage",
        kind: "future-operation",
        provider: "faux",
        model: "faux",
        usage: usage(6),
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
      cacheRead: 21,
      cacheWrite: 21,
      cost: 0.21000000000000002,
      input: 21,
      name: "demo",
      output: 21,
      startedAt: Date.parse("2025-01-01T00:00:00.000Z"),
    });
  });
});

describe(buildBuiltinWidgets, () => {
  const options = {
    branch: "main",
    details: { ahead: 0, behind: 0, staged: 0, unstaged: 2, untracked: 1 },
    now: 0,
    thinkingLevel: "high",
  };

  const build = (
    overrides: Parameters<ReturnType<typeof createExtensionHost>["createContext"]>[0],
  ) =>
    buildBuiltinWidgets(
      createExtensionHost(() => {}).createContext({
        cwd: "/tmp/project",
        sessionManager: sessionReads(SessionManager.inMemory()),
        ...overrides,
      }),
      options,
    );

  const text = (widgets: ReturnType<typeof buildBuiltinWidgets>, id: string) =>
    widgets
      .get(id)
      ?.content.map((span) => span.text)
      .join("");

  it("labels selected versus last executed model/effort and does not leak abandoned responses", () => {
    const session = SessionManager.inMemory();
    const original = session.appendMessage({ role: "user", content: "start", timestamp: 0 });
    session.appendMessage({
      ...fauxAssistantMessage("done"),
      provider: "anthropic",
      model: "physical",
      thinkingLevel: "high",
    });
    session.appendMessage({
      ...fauxAssistantMessage("", { stopReason: "error" }),
      provider: "radius",
    });

    const ctx = createExtensionHost(() => {}).createContext({
      model: {
        api: "pi-virtual",
        baseUrl: "",
        provider: "router",
        id: "auto",
        name: "Auto",
        input: ["text"],
        reasoning: true,
        contextWindow: 0,
        maxTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      sessionManager: sessionReads(session),
    });

    const content = (id: string) =>
      text(
        buildBuiltinWidgets(ctx, {
          ...options,
          branch: null,
          details: undefined,
          thinkingLevel: "low",
        }),
        id,
      );

    expect(content("footer.model")).toBe("selected: Auto · last: anthropic/physical");
    expect(content("footer.thinking")).toBe("selected: low · last: high");
    session.branch(original);
    expect(content("footer.model")).toBe("Auto");
    expect(content("footer.thinking")).toBe("low");
  });

  it.each([
    ["after compaction", { contextWindow: 200_000, percent: null, tokens: null }, " ?/200k"],
    ["without a context window", undefined, " ?"],
  ])("marks unknown context usage %s instead of reporting 0%%", (_name, usage, suffix) => {
    const widgets = build({ getContextUsage: () => usage });

    expect(text(widgets, "footer.context")).toBe(`${"─".repeat(12)}${suffix}`);
  });

  const tones = (percent: number, id: string) =>
    new Set(
      build({ getContextUsage: () => ({ contextWindow: 100, percent, tokens: percent }) })
        .get(id)
        ?.content.map((span) => span.tone),
    );

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
