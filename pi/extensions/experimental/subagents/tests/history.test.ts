import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { forkHistory } from "../history.js";

const assistant = (text: string, stopReason: "stop" | "toolUse" = "stop") =>
  fauxAssistantMessage(
    [fauxThinking("private"), fauxText(text), fauxToolCall("read", { path: "secret" })],
    { responseId: "parent-response", stopReason },
  );

const user = (text: string): Message => ({
  content: text,
  role: "user",
  timestamp: Date.now(),
});

describe(forkHistory, () => {
  it("keeps only complete user/assistant text from the selected turns", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("old"));
    session.appendMessage(assistant("old answer"));
    session.appendMessage(user("new"));
    session.appendMessage(assistant("unfinished", "toolUse"));
    session.appendMessage(assistant("final"));

    const history = forkHistory(session.buildContextEntries(), 1);

    expect(history.map((message) => message.role)).toStrictEqual(["user", "assistant"]);
    expect(history[0]?.content).toBe("new");
    expect(history[1]?.content).toStrictEqual([{ text: "final", type: "text" }]);
    expect(history[1]).not.toHaveProperty("responseId");
    expect(history[1]).toHaveProperty("usage.cost.total", 0);
  });

  it("carries compacted context into full forks", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("old"));
    const kept = session.appendMessage(user("recent"));
    session.appendCompaction("Earlier decisions", kept, 100);

    const history = forkHistory(session.buildContextEntries(), "all");

    expect(history.map((message) => message.role)).toStrictEqual(["user", "user"]);
    expect(history[0]?.content).toBe("Previous conversation summary:\nEarlier decisions");
    expect(history[1]?.content).toBe("recent");
  });
  it("supports fresh and full forks", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("hello"));

    expect(forkHistory(session.buildContextEntries(), "none")).toStrictEqual([]);
    expect(forkHistory(session.buildContextEntries(), "all")).toHaveLength(1);
  });
});
