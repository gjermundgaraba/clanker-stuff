import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import { historyItemFromEntry } from "../history.js";
import { nonPromptEntries, userEntry } from "./fixtures.js";

const skillBlock = (name: string) =>
  `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n# ${name}\nInstructions.\n</skill>`;

describe("prompt history", () => {
  it("extracts only user prompts and bash commands from session entries", () => {
    const entries: SessionEntry[] = [
      userEntry("prompt", null, " Build Release ", 100),
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
        parentId: "prompt",
        timestamp: new Date(200).toISOString(),
        type: "message",
      },
      ...nonPromptEntries("bash", 400),
    ];

    expect(entries.map(historyItemFromEntry)).toStrictEqual([
      { text: "Build Release", timestamp: 100 },
      { text: "!!pnpm test", timestamp: 200 },
      undefined,
      undefined,
      undefined,
    ]);
  });

  it.each([
    [skillBlock("pdf"), "/skill:pdf"],
    [`${skillBlock("pdf")}\n\nextract report.pdf`, "/skill:pdf extract report.pdf"],
    [`${skillBlock("pdf")}\n\nextract it as $pdf says`, "/skill:pdf extract it as $pdf says"],
    // Earlier dollah-skills versions prepended one block per $mention to the typed text.
    [`${skillBlock("a")}\n\n${skillBlock("b")}\n\nuse $a and $b`, "/skill:a use $a and $b"],
  ])("recovers the typed prompt from an expanded skill: %#", (content, typed) => {
    expect(historyItemFromEntry(userEntry("skill", null, content, 100))).toEqual({
      text: typed,
      timestamp: 100,
    });
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

    expect(
      lines.flatMap((entry) => {
        const item = historyItemFromEntry(entry);

        return item === undefined ? [] : [item];
      }),
    ).toEqual([{ text: "first\nsecond", timestamp: 200 }]);
  });
});
