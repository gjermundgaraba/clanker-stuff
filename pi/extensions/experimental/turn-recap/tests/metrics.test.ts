import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { collectMetrics, totalTokens } from "../metrics.js";
import { measuredResponse, sampleUsage, userMessage } from "./fixtures.js";

type Build = (session: SessionManager) => void;

const growth = (before: Build, run: Build) => {
  const session = SessionManager.inMemory();
  before(session);
  const runStart = session.getBranch().length;
  run(session);

  return collectMetrics(session.getBranch(), runStart).contextGrowth;
};

const respond = (session: SessionManager, ...args: Parameters<typeof measuredResponse>) =>
  session.appendMessage(measuredResponse(...args));

describe("context growth", () => {
  // Responses report 50 output tokens unless stated.
  it.each<{ name: string; before: Build; run: Build; expected: number }>([
    {
      name: "counts a fresh session from zero, prompt to prompt plus the last output",
      before: (s) => s.appendMessage(userMessage("first")),
      run: (s) => {
        respond(s, 7621);
        respond(s, 8556);
        respond(s, 8796, { output: 77 });
      },
      expected: 8873,
    },
    {
      name: "starts from the size the previous response reported",
      before: (s) => respond(s, 5000),
      run: (s) => {
        s.appendMessage(userMessage("next"));
        respond(s, 9920);
      },
      expected: 4920,
    },
    {
      name: "reads zero before the run's first response",
      before: (s) => respond(s, 5000),
      run: (s) => s.appendMessage(userMessage("next")),
      expected: 0,
    },
    {
      name: "adds nothing for a prompt that compaction shrank",
      before: (s) => respond(s, 1000),
      run: (s) => {
        s.appendCompaction("summary", respond(s, 1500), 1550);
        respond(s, 300);
        respond(s, 600);
      },
      expected: 800,
    },
    {
      name: "skips failed and empty responses",
      before: (s) => respond(s, 1000),
      run: (s) => {
        respond(s, 9000, { stopReason: "aborted" });
        respond(s, 9000, { stopReason: "error" });
        respond(s, 0, { output: 0 });
        respond(s, 1200);
      },
      expected: 200,
    },
    {
      name: "counts an unmeasured earlier run's additions in the next run",
      before: (s) => {
        respond(s, 5000);
        s.appendMessage(userMessage("aborted"));
        respond(s, 500, { stopReason: "aborted" });
      },
      run: (s) => respond(s, 6000),
      expected: 1000,
    },
    {
      name: "leaves out reasoning, which providers drop once a new prompt arrives",
      before: (s) => respond(s, 10_000, { output: 3000, reasoning: 2800 }),
      run: (s) => {
        s.appendMessage(userMessage("next"));
        respond(s, 10_350, { output: 100, reasoning: 60 });
      },
      expected: 190,
    },
    {
      name: "ignores provider totals that differ from the reported parts",
      before: (s) => respond(s, 1000, { totalTokens: 1 }),
      run: (s) => respond(s, 1200, { totalTokens: 99_999 }),
      expected: 200,
    },
  ])("$name", ({ before, run, expected }) => {
    expect(growth(before, run)).toBe(expected);
  });
});

describe("run metrics", () => {
  it("includes raw assistant, nested tool, compaction and attributed usage exactly once", () => {
    const session = SessionManager.inMemory();
    const user = session.appendMessage(userMessage("work"));

    const assistant = session.appendMessage({
      ...fauxAssistantMessage([fauxToolCall("test", {}, { id: "call-1" })]),
      usage: sampleUsage(),
    });

    session.appendMessage({
      role: "toolResult",
      toolName: "test",
      toolCallId: "call-1",
      content: [],
      isError: true,
      usage: sampleUsage(),
      timestamp: 0,
    });
    session.appendCompaction("summary", user, 100, undefined, false, sampleUsage());
    session.appendUsage("cache_warm", "provider", "model", sampleUsage());
    session.appendContextEdit(assistant, null);
    session.appendCustomEntry("ignored", { usage: sampleUsage() });
    const metrics = collectMetrics(session.getBranch());
    expect(metrics).toMatchObject({ toolCalls: 1, toolErrors: 1, responses: 1, compactions: 1 });
    expect(metrics.usage).toMatchObject({
      input: 400,
      output: 200,
      cacheRead: 800,
      cacheWrite: 80,
      reasoning: 40,
      reports: 4,
      reasoningReports: 4,
    });
    expect(metrics.usage.cost).toBeCloseTo(1.32);
    expect(totalTokens(metrics.usage)).toBe(1480);
  });

  it("counts codex-provider's inline checkpoints as compactions", () => {
    const session = SessionManager.inMemory();
    session.appendCustomEntry("codex-provider.checkpoint", {});
    session.appendCustomEntry("other", {});
    expect(collectMetrics(session.getBranch()).compactions).toBe(1);
  });

  it("keeps unknown reasoning distinct from a reported zero", () => {
    const session = SessionManager.inMemory();
    const usage = sampleUsage();
    const { reasoning: _reasoning, ...unreported } = usage;
    session.appendMessage({ ...fauxAssistantMessage("a"), usage: unreported });
    session.appendMessage({ ...fauxAssistantMessage("b"), usage: { ...usage, reasoning: 0 } });
    const metrics = collectMetrics(session.getBranch());
    expect(metrics.usage).toMatchObject({ reasoning: 0, reasoningReports: 1, reports: 2 });
    expect(metrics.models).toHaveLength(1);
  });
});
