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

    const history = forkHistory(session.buildSessionProjection().messages, 1);

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

    const history = forkHistory(session.buildSessionProjection().messages, "all");

    expect(history.map((message) => message.role)).toStrictEqual(["user", "user"]);
    expect(history[0]?.content).toBe("Previous conversation summary:\nEarlier decisions");
    expect(history[1]?.content).toBe("recent");
  });
  it("supports fresh and full forks", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("hello"));

    expect(forkHistory(session.buildSessionProjection().messages, "none")).toStrictEqual([]);
    expect(forkHistory(session.buildSessionProjection().messages, "all")).toHaveLength(1);
  });

  it("forks edited context without resurrecting omitted history", () => {
    const session = SessionManager.inMemory();
    const old = session.appendMessage(user("original request"));
    const abandoned = session.appendMessage(assistant("abandoned answer"));
    session.appendMessage(user("recent request"));
    session.appendContextEdit(old, { content: "corrected request" });
    session.appendContextEdit(abandoned, null);

    const history = forkHistory(session.buildSessionProjection().messages, "all");
    expect(history.map(({ content }) => content)).toStrictEqual([
      "corrected request",
      "recent request",
    ]);
    expect(forkHistory(session.buildSessionProjection().messages, 1)).toHaveLength(1);
    expect(session.getEntry(abandoned)).toHaveProperty(
      "message.content.1.text",
      "abandoned answer",
    );

    session.branch(abandoned);
    expect(forkHistory(session.buildSessionProjection().messages, "all")).toHaveLength(2);
  });

  it("forks only the summary after retain-none compaction", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(user("old request"));
    session.appendCompaction("all earlier decisions", null, 100);

    expect(forkHistory(session.buildSessionProjection().messages, "all")).toMatchObject([
      { content: "Previous conversation summary:\nall earlier decisions", role: "user" },
    ]);
  });
});
