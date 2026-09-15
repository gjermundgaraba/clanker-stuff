import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import { historyFromEntries, historyItemFromEntry, normalizeHistory } from "../history.js";
import { nonPromptEntries, userEntry } from "./fixtures.js";

describe("prompt history", () => {
  it("extracts only user prompts and bash commands from session history", () => {
    const entries: SessionEntry[] = [
      userEntry("older", null, " Build Release ", 100),
      {
        id: "bash",
        message: {
          cancelled: false,
          command: "pnpm test",
          excludeFromContext: true,
          exitCode: 0,
          output: "",
          role: "bashExecution",
          timestamp: 200,
          truncated: false,
        },
        parentId: "older",
        timestamp: new Date(200).toISOString(),
        type: "message",
      },
      userEntry("newer", "bash", "Build Release", 300),
      ...nonPromptEntries("newer", 400),
    ];

    expect(normalizeHistory(historyFromEntries(entries))).toStrictEqual([
      { text: "Build Release", timestamp: 300 },
      { text: "!!pnpm test", timestamp: 200 },
    ]);
  });
  it.each([
    { role: "user", content: 123, timestamp: 2 },
    { role: "user", content: [null], timestamp: 2 },
    { role: "user", content: [{ type: "text", text: 123 }], timestamp: 2 },
    { role: "user", content: "text", timestamp: "invalid" },
    { role: "bashExecution", command: 123, timestamp: 2 },
    { role: "bashExecution", command: "ls", excludeFromContext: "true", timestamp: 2 },
    { role: "assistant", content: "not a prompt", timestamp: 2 },
  ])("skips unsupported or malformed messages: %j", (message) => {
    expect(historyItemFromEntry({ message })).toBeUndefined();
  });

  it("skips invalid entries while preserving multiline text and timestamp fallback", () => {
    const prompt = {
      type: "message",
      timestamp: new Date(200).toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "first\n" },
          { type: "image", data: "image" },
          { type: "text", text: "second" },
        ],
      },
    };
    const lines = [
      null,
      "",
      prompt,
      {
        type: "message",
        message: { role: "user", content: "no timestamp" },
      },
      userEntry("blank", null, "  ", 100),
    ];
    expect(lines.map(historyItemFromEntry).filter((item) => item !== undefined)).toEqual([
      { text: "first\nsecond", timestamp: 200 },
    ]);
  });
});
