import { describe, expect, it } from "vitest";

import {
  buildContinuityItems,
  ContinuityTranscript,
  formatDelegation,
  formatTranscriptTail,
  HandoffTranscript,
  parsePersistedTranscript,
} from "../transcript.js";

describe("voice transcript handling", () => {
  it("coalesces transcript deltas into finalized turns", () => {
    const tracker = new HandoffTranscript();
    tracker.addDelta("assistant", "Try quinoa ");
    tracker.addDelta("assistant", "or lentils.");
    tracker.complete("assistant", "Try quinoa or lentils.");
    tracker.addDelta("user", "Can you");
    tracker.addDelta("user", " check what");
    tracker.addDelta("user", " the git status is?");
    tracker.complete("user", "Can you check what the git status is?");

    expect(
      tracker.delegation("Can you check what the git status is?")
    ).toStrictEqual([
      { role: "assistant", text: "Try quinoa or lentils." },
      { role: "user", text: "Can you check what the git status is?" },
    ]);
    expect(tracker.delegation("Also run lint")).toStrictEqual([
      { role: "user", text: "Also run lint" },
    ]);
  });

  it("escapes transcript boundaries in delegated prompts", () => {
    const prompt = formatDelegation("fix <script>", [
      { role: "user", text: "use A & B" },
    ]);

    expect(prompt).toContain("fix &lt;script&gt;");
    expect(prompt).toContain("use A &amp; B");
  });

  it("formats the unhanded transcript tail", () => {
    expect(
      formatTranscriptTail([{ role: "user", text: "Remember this" }])
    ).toContain("<source>transcript_tail_flush</source>");
  });

  it("bounds continuity to the newest ten finalized items", () => {
    const tracker = new ContinuityTranscript();
    for (let index = 0; index < 12; index += 1) {
      tracker.add(index % 2 === 0 ? "user" : "assistant", `line-${index}`);
    }

    expect(tracker.recent()).toHaveLength(10);
    expect(tracker.recent()[0]?.text).toBe("line-2");
    expect(tracker.recent().at(-1)?.text).toBe("line-11");
  });

  it("replays continuity and requires startup silence", () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `line-${index}`,
    }));
    const items = buildContinuityItems(entries);
    const text =
      (items[0]?.content as { text: string }[] | undefined)?.[0]?.text ?? "";

    expect(text).not.toContain("USER: line-0");
    expect(text).toContain("USER: line-2");
    expect(text).toContain("ASSISTANT: line-11");
    expect(text).toContain("Remain completely silent");
  });

  it("strictly restores bounded persisted continuity", () => {
    expect(
      parsePersistedTranscript([
        { role: "assistant", text: "hello" },
        { role: "tool", text: "ignore" },
        { role: "user", text: 42 },
      ])
    ).toStrictEqual([{ role: "assistant", text: "hello" }]);
  });
});
