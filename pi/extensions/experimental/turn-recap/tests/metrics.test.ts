import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { collectMetrics, totalTokens } from "../metrics.js";
import { sampleUsage, userMessage } from "./fixtures.js";

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
