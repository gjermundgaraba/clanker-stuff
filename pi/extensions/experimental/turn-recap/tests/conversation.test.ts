import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRecapPrompt,
  normalizeRecap,
  RECAP_PROMPT_PREFIX,
  RECAP_PROMPT_MAX_CHARS,
} from "../conversation.js";
import { ENTRY_TYPE } from "../entry.js";
import { RECAP_MAX_CHARS } from "../conversation.js";
import { appendTurn, sessionWithTurns, userMessage } from "./fixtures.js";

describe("recap input", () => {
  it("uses replacements and omissions from the projected conversation", () => {
    const session = sessionWithTurns(2);
    const messages = session.getBranch().filter((entry) => entry.type === "message");
    const first = messages[0];
    const last = messages.at(-1);

    if (!first || !last) throw new Error("Expected conversation entries");
    session.appendContextEdit(first.id, { content: "corrected request" });
    session.appendContextEdit(last.id, null);

    const prompt = buildRecapPrompt(session.buildSessionProjection().entries, "completed");
    expect(prompt).toContain("corrected request");
    expect(prompt).not.toContain("request 1");
    expect(prompt).not.toContain("answer 2");

    session.branch(last.id);
    expect(buildRecapPrompt(session.buildSessionProjection().entries, "completed")).toContain(
      "answer 2",
    );
    session.appendCompaction("summary only", null, 100);
    expect(buildRecapPrompt(session.buildSessionProjection().entries, "completed")).toBeUndefined();
  });

  it("keeps recent text chronologically without an arbitrary turn-count cutoff", () => {
    const session = sessionWithTurns(9);
    const prompt = buildRecapPrompt(session.buildSessionProjection().entries, "completed");
    expect(prompt).toContain("request 1");
    expect(prompt).toContain("answer 9");
    expect(prompt?.match(/^User:/gmu)).toHaveLength(9);
    expect(prompt?.indexOf("request 1")).toBeLessThan(prompt?.indexOf("answer 9") ?? 0);
  });

  it.each(["A", "🦄"])(
    "bounds oversized %s input including instructions, labels and outcome",
    (character) => {
      const session = sessionWithTurns(1);
      session.appendMessage(userMessage(character.repeat(RECAP_PROMPT_MAX_CHARS * 2)));
      session.appendMessage(fauxAssistantMessage("newest answer"));
      const prompt = buildRecapPrompt(session.buildSessionProjection().entries, "aborted");
      expect(prompt?.length).toBeLessThanOrEqual(RECAP_PROMPT_MAX_CHARS);
      expect(prompt?.isWellFormed()).toBe(true);
      expect(prompt).toContain(RECAP_PROMPT_PREFIX);
      expect(prompt).toContain("[message excerpt; remainder omitted]");
      expect(prompt).toContain("Assistant: newest answer");
      expect(prompt).toContain("Latest run outcome: aborted");
      expect(prompt).not.toContain("request 1");
    },
  );

  it("bounds many individually small messages, preferring the newest", () => {
    const session = sessionWithTurns(1000);
    const prompt = buildRecapPrompt(session.buildSessionProjection().entries, "error");
    expect(prompt?.length).toBeLessThanOrEqual(RECAP_PROMPT_MAX_CHARS);
    expect(prompt).toContain("request 1000");
    expect(prompt).toContain("answer 1000");
    expect(prompt).not.toContain("User: request 1\n");
    expect(prompt).toContain("Latest run outcome: error");
  });

  it("returns no prompt without eligible text", () => {
    const session = SessionManager.inMemory();
    expect(buildRecapPrompt(session.buildSessionProjection().entries, "completed")).toBeUndefined();
    session.appendMessage(userMessage("   "));
    session.appendMessage(fauxAssistantMessage("   "));
    expect(buildRecapPrompt(session.buildSessionProjection().entries, "completed")).toBeUndefined();
  });

  it("ignores failed assistant text and earlier recaps", () => {
    const session = sessionWithTurns(1);
    session.appendCustomEntry(ENTRY_TYPE, {
      completedTurns: 1,
      recap: "Do not repeat this",
    });
    session.appendMessage(userMessage("latest"));
    session.appendMessage(
      fauxAssistantMessage("internal provider failure", {
        errorMessage: "failed",
        stopReason: "error",
      }),
    );

    const prompt = buildRecapPrompt(session.buildSessionProjection().entries, "completed");
    expect(prompt).not.toContain("Do not repeat this");
    expect(prompt).not.toContain("internal provider failure");
    expect(prompt).toContain("User: latest");
  });

  it("uses compacted context without summarizing compaction summaries", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage("COMPACTED_SECRET"));
    session.appendMessage(fauxAssistantMessage("old answer"));
    appendTurn(session, 2);
    const kept = session.appendMessage(userMessage("kept request"));
    session.appendMessage(fauxAssistantMessage("kept answer"));
    session.appendCompaction("SUMMARY_SECRET", kept, 100);
    appendTurn(session, 4);

    const prompt = buildRecapPrompt(session.buildSessionProjection().entries, "completed");

    expect(prompt).not.toContain("COMPACTED_SECRET");
    expect(prompt).not.toContain("SUMMARY_SECRET");
    expect(prompt).toContain("kept request");
    expect(prompt).toContain("request 4");
  });
});

describe(normalizeRecap, () => {
  it("trims, rejects empty output, and caps Unicode characters", () => {
    expect(normalizeRecap("   ")).toBeUndefined();
    expect(normalizeRecap("  ready  ")).toBe("ready");
    expect(normalizeRecap("🦄".repeat(RECAP_MAX_CHARS + 1))).toBe("🦄".repeat(RECAP_MAX_CHARS));
  });

  it("removes terminal and bidi controls before durable normalization", () => {
    expect(normalizeRecap("\u001B[31m \u0007ready\u200E\u202E\u202C \u001B[0m")).toBe("ready");
    expect(normalizeRecap(" one\u0007\n\u061c\u200e\u200f\u202Etwo\u202C\t ")).toBe("one two");
  });
});
