import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { forkHistory } from "../history.js";

const usage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    total: 0,
  },
  input: 0,
  output: 0,
  totalTokens: 0,
};

const assistant = (text: string, stopReason: "stop" | "toolUse" = "stop") =>
  ({
    api: "faux",
    content: [
      { thinking: "private", type: "thinking" },
      { text, type: "text" },
      {
        arguments: { path: "secret" },
        id: "call-1",
        name: "read",
        type: "toolCall",
      },
    ],
    model: "faux-1",
    provider: "faux",
    responseId: "parent-response",
    role: "assistant",
    stopReason,
    timestamp: Date.now(),
    usage,
  }) as Parameters<SessionManager["appendMessage"]>[0];

const user = (text: string) =>
  ({ content: text, role: "user", timestamp: Date.now() }) as Parameters<
    SessionManager["appendMessage"]
  >[0];

describe(forkHistory, () => {
  it("keeps only complete user/assistant text from the selected turns", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("old"));
    session.appendMessage(assistant("old answer"));
    session.appendMessage(user("new"));
    session.appendMessage(assistant("unfinished", "toolUse"));
    session.appendMessage(assistant("final"));

    const history = forkHistory(session.buildContextEntries(), 1);

    expect(history.map((message) => message.role)).toStrictEqual([
      "user",
      "assistant",
    ]);
    expect(history[0]?.content).toBe("new");
    expect(history[1]?.content).toStrictEqual([
      { text: "final", type: "text" },
    ]);
    expect(history[1]).not.toHaveProperty("responseId");
    expect(history[1]).toHaveProperty("usage.cost.total", 0);
  });

  it("carries compacted context into full forks", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("old"));
    const kept = session.appendMessage(user("recent"));
    session.appendCompaction("Earlier decisions", kept, 100);

    const history = forkHistory(session.buildContextEntries(), "all");

    expect(history.map((message) => message.role)).toStrictEqual([
      "user",
      "user",
    ]);
    expect(history[0]?.content).toBe(
      "Previous conversation summary:\nEarlier decisions"
    );
    expect(history[1]?.content).toBe("recent");
  });
  it("supports fresh and full forks", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("hello"));

    expect(forkHistory(session.buildContextEntries(), "none")).toStrictEqual(
      []
    );
    expect(forkHistory(session.buildContextEntries(), "all")).toHaveLength(1);
  });
});
