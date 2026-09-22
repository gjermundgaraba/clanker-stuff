import { fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import {
  createSyntheticSourceInfo,
  estimateTokens,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { fixtureSnapshot } from "./fixtures/snapshot.js";
import { buildTree, filterTree } from "../tree.js";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });

describe("snapshot", () => {
  it("shows original and effective content with branch-local edit provenance and effective token counts", () => {
    const session = SessionManager.inMemory();
    const retained = session.appendMessage(user("unchanged"));
    const replaced = session.appendMessage(user("old request"));
    const omitted = session.appendMessage(fauxAssistantMessage("abandoned attempt"));
    session.appendContextEdit(replaced, { content: "superseded replacement" });
    const edit = session.appendContextEdit(replaced, { content: "corrected request" });
    const omission = session.appendContextEdit(omitted, null);
    const snapshot = fixtureSnapshot({ branch: session.getBranch() });

    expect(snapshot.messages).toMatchObject([
      {
        sourceEntryId: retained,
        format: "text",
      },
      {
        sourceEntryId: replaced,
        format: "text",
      },
      {
        sourceEntryId: omitted,
        format: "text",
        estimatedTokens: 0,
      },
    ]);
    expect(snapshot.messages[0]?.body).toContain(
      "State: unchanged\n\nEffective content:\nunchanged",
    );
    expect(snapshot.messages[0]?.body).not.toContain("Original content:");
    expect(snapshot.messages[0]?.body).not.toContain("Context edit:");
    expect(snapshot.messages[1]?.body).toContain(`State: replaced\nContext edit: ${edit}`);
    expect(snapshot.messages[1]?.body).toContain(
      "Effective content:\ncorrected request\n\nOriginal content:\nold request",
    );
    expect(snapshot.messages[1]?.body).not.toContain("superseded replacement");
    expect(snapshot.messages[2]?.body).toContain(`State: omitted\nContext edit: ${omission}`);
    expect(snapshot.messages[2]?.body).toContain(
      "Effective content:\n(omitted from model context)\n\nOriginal content:\nabandoned attempt",
    );
    expect(snapshot.messages[0]?.estimatedTokens).toBe(estimateTokens(user("unchanged")));
    expect(snapshot.messages[1]?.estimatedTokens).toBe(estimateTokens(user("corrected request")));

    const tree = buildTree(snapshot);
    const changes = filterTree(tree, "old request");
    expect(changes[0]?.children[0]?.body).toContain(`Source entry: ${replaced}`);
    expect(changes[0]?.children[0]?.body).toContain(`Context edit: ${edit}`);
    expect(changes[0]?.children[0]?.body).toContain("Effective content:\ncorrected request");
    expect(changes[0]?.children[0]?.body).toContain("Original content:\nold request");
    expect(filterTree(tree, "abandoned attempt")[0]?.children[0]?.estimatedTokens).toBe(0);
    expect(tree[2]?.estimatedTokens).toBe(
      snapshot.messages.reduce((sum, part) => sum + part.estimatedTokens, 0),
    );
    expect(tree[2]?.body).toContain("before transient extension/provider transformations");

    session.branch(omitted);
    const branched = fixtureSnapshot({ branch: session.getBranch() });
    expect(branched.messages.map((part) => part.sourceEntryId)).toEqual([
      retained,
      replaced,
      omitted,
    ]);

    for (const part of branched.messages) {
      expect(part.body).toContain("State: unchanged");
      expect(part.body).not.toContain("Original content:");
      expect(part.body).not.toContain("Context edit:");
    }

    expect(branched.messages[1]?.body).toContain("Effective content:\nold request");
    session.appendCompaction("summary only", null, 100);
    expect(fixtureSnapshot({ branch: session.getBranch() }).messages).toHaveLength(1);
  });

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
    expect(snapshot.tools[0]?.estimatedTokens).toBeGreaterThan(0);
    expect(snapshot.system.body).toBe(prompt);
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
      expect.stringContaining("Effective content:\nretained message"),
      expect.stringContaining("Effective content:\nlatest message"),
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

  it("keeps persisted system messages out of the conversation", () => {
    const session = SessionManager.inMemory();
    const read = { name: "read", description: "read", parameters: Type.Object({}) };
    session.appendMessage({
      role: "system",
      content: "",
      sections: { preamble: "You are pi.", tools: "<tools>read</tools>" },
      toolsAdded: [read],
      timestamp: 0,
    });
    session.appendMessage(user("first message"));
    session.appendMessage({
      role: "system",
      content: "",
      sections: { skills: "<skills>alpha</skills>", tools: null },
      toolsRemoved: [{ name: "read" }],
      timestamp: 0,
    });
    const kept = session.appendMessage(user("retained message"));
    session.appendCompaction("COMPACTED SUMMARY", kept, 1000);
    session.appendMessage(user("latest message"));

    const snapshot = fixtureSnapshot({ prompt: "EFFECTIVE PROMPT", branch: session.getBranch() });

    expect(snapshot.system.body).toBe("EFFECTIVE PROMPT");
    expect(snapshot.messages.map((part) => part.label.replace(/^\d+\. /, ""))).toEqual([
      "user",
      "user",
      "user",
    ]);
    expect(snapshot.messages.map((part) => part.body).slice(1)).toEqual([
      expect.stringContaining("Effective content:\nretained message"),
      expect.stringContaining("Effective content:\nlatest message"),
    ]);
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
    expect(snapshot.messages[0]?.body).toContain("Effective content:\ncustom content");
    expect(snapshot.messages[1]?.body).toContain("VISIBLE OUTPUT");
    expect(snapshot.messages[1]?.body).not.toContain("PRIVATE OUTPUT");
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
    expect(snapshot.messages[0]?.body).toContain("[Thinking]\nreasoning");
    expect(snapshot.messages[0]?.body).toContain("answer");
    expect(snapshot.messages[0]?.body).toContain("files.read");
    expect(snapshot.messages[0]?.body).toContain('"path": "a.ts"');
    expect(snapshot.messages[0]?.estimatedTokens).toBe(estimateTokens(assistant));
    expect(snapshot.messages[1]?.body).toContain("FILE CONTENT");
    expect(snapshot.messages[1]?.body).toContain("[Image: image/png, 8 base64 characters]");
    expect(snapshot.messages[1]?.label).toContain("read (error)");
    expect(snapshot.messages[1]?.estimatedTokens).toBeGreaterThan(1000);
  });
});
