import { fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import {
  createSyntheticSourceInfo,
  estimateTokens,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { fixtureSnapshot } from "./fixtures/snapshot.js";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });

describe("snapshot", () => {
  it("includes only active definitions and counts the assembled prompt once, even with zero reported usage", () => {
    const tools = ["read", "bash"].map((name) => ({
      name,
      description: name,
      parameters: Type.Object({}),
      sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
    }));
    const prompt =
      "You are pi.\n# /repo/AGENTS.md\nUNIQUE PROJECT INSTRUCTIONS\n<available_skills>skill description</available_skills>";
    const snapshot = fixtureSnapshot({
      prompt,
      tools,
      activeTools: ["read"],
      usage: { tokens: 0, contextWindow: 200_000, percent: 0 },
    });
    expect(snapshot.tools.map((part) => part.label)).toEqual(["read"]);
    expect(snapshot.tools[0].estimatedTokens).toBeGreaterThan(0);
    expect(snapshot.system.body).toBe(prompt);
    expect(snapshot.system.body.match(/UNIQUE PROJECT INSTRUCTIONS/g)).toHaveLength(1);
    expect(snapshot.system.estimatedTokens).toBe(Math.ceil(prompt.length / 4));
    expect(snapshot.usage?.tokens).toBe(0);
  });

  it("reconstructs the active branch and compaction", () => {
    const session = SessionManager.inMemory();
    const first = session.appendMessage(user("old message"));
    session.appendMessage(user("abandoned message"));
    session.branchWithSummary(first, "BRANCH SUMMARY");
    const kept = session.appendMessage(user("retained message"));
    session.appendCompaction("COMPACTED SUMMARY", kept, 1000);
    session.appendMessage(user("latest message"));
    const snapshot = fixtureSnapshot({
      branch: session.getBranch(),
      usage: { tokens: null, contextWindow: 1000, percent: null },
    });
    expect(snapshot.messages.map((part) => part.body).join("\n")).toContain("COMPACTED SUMMARY");
    expect(snapshot.messages.map((part) => part.body).slice(1)).toEqual([
      "retained message",
      "latest message",
    ]);
    expect(snapshot.messages.map((part) => part.body).join("\n")).not.toContain("old message");
    expect(snapshot.messages.map((part) => part.body).join("\n")).not.toContain(
      "abandoned message",
    );
    expect(snapshot.usage?.tokens).toBeNull();
    session.branch(kept);
    expect(
      fixtureSnapshot({ branch: session.getBranch() })
        .messages.map((part) => part.body)
        .join("\n"),
    ).toContain("BRANCH SUMMARY");
  });

  it("uses Pi's conversion for custom messages and excludes !! executions", () => {
    const session = SessionManager.inMemory();
    session.appendCustomMessageEntry("test", "custom content", false);
    for (const excluded of [false, true]) {
      session.appendMessage({
        role: "bashExecution",
        command: "pwd",
        output: excluded ? "PRIVATE OUTPUT" : "VISIBLE OUTPUT",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 0,
        excludeFromContext: excluded,
      });
    }
    const snapshot = fixtureSnapshot({ branch: session.getBranch() });
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0].body).toBe("custom content");
    expect(snapshot.messages[1].body).toContain("VISIBLE OUTPUT");
    expect(snapshot.messages[1].body).not.toContain("PRIVATE OUTPUT");
  });

  it("retains text, thinking, tool calls, nested tool results and image metadata", () => {
    const session = SessionManager.inMemory();
    const assistant = fauxAssistantMessage([
      { type: "thinking", thinking: "reasoning" },
      { type: "text", text: "answer" },
      {
        type: "toolCall",
        id: "call",
        name: "read",
        namespace: "files",
        arguments: { path: "a.ts" },
      },
    ]);
    session.appendMessage(assistant);
    session.appendMessage({
      role: "toolResult",
      toolName: "read",
      toolCallId: "call",
      isError: true,
      timestamp: 0,
      content: [
        { type: "text", text: "FILE CONTENT" },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    });
    const snapshot = fixtureSnapshot({ branch: session.getBranch() });
    expect(snapshot.messages[0].body).toContain("[Thinking]\nreasoning");
    expect(snapshot.messages[0].body).toContain("answer");
    expect(snapshot.messages[0].body).toContain("files.read");
    expect(snapshot.messages[0].body).toContain('"path": "a.ts"');
    expect(snapshot.messages[0].estimatedTokens).toBe(estimateTokens(assistant));
    expect(snapshot.messages[1].body).toContain("FILE CONTENT");
    expect(snapshot.messages[1].body).toContain("[Image: image/png, 8 base64 characters]");
    expect(snapshot.messages[1].label).toContain("read (error)");
    expect(snapshot.messages[1].estimatedTokens).toBeGreaterThan(1000);
  });
});
