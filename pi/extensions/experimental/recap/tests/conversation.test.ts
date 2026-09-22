import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRecapPrompt,
  conversationProgress,
  normalizeRecap,
  RECAP_PROMPT_PREFIX,
  shouldGenerateRecap,
} from "../conversation.js";
import { RECAP_ENTRY_TYPE, RECAP_MAX_CHARS } from "../entry.js";
import { appendTurn, sessionWithTurns, userMessage } from "./fixtures.js";

describe("conversation progress", () => {
  it("recaps after every completed turn starting with the first, without duplicates", () => {
    const session = sessionWithTurns(0);
    expect(shouldGenerateRecap(conversationProgress(session.getBranch()))).toBe(false);

    for (let turn = 1; turn <= 4; turn += 1) {
      appendTurn(session, turn);
      const progress = conversationProgress(session.getBranch());
      expect(progress.completedTurns).toBe(turn);
      expect(shouldGenerateRecap(progress)).toBe(true);

      session.appendCustomEntry(RECAP_ENTRY_TYPE, {
        completedTurns: turn,
        recap: `Recap ${turn}`,
      });
      expect(shouldGenerateRecap(conversationProgress(session.getBranch()))).toBe(false);
    }
  });

  it.each(["error", "aborted", "toolUse"] as const)(
    "does not unlock a recap for a %s turn, before or after a recap",
    (stopReason) => {
      const session = sessionWithTurns(0);
      appendTurn(session, 1, stopReason);
      expect(shouldGenerateRecap(conversationProgress(session.getBranch()))).toBe(false);

      appendTurn(session, 2);
      session.appendCustomEntry(RECAP_ENTRY_TYPE, { completedTurns: 1, recap: "Done" });
      appendTurn(session, 3, stopReason);
      expect(shouldGenerateRecap(conversationProgress(session.getBranch()))).toBe(false);
    },
  );

  it("allows a recap after a first length-limited turn", () => {
    const session = sessionWithTurns(0);
    appendTurn(session, 1, "length");
    expect(shouldGenerateRecap(conversationProgress(session.getBranch()))).toBe(true);
  });

  it("counts completed results but not failed or incomplete turns", () => {
    const session = SessionManager.inMemory();
    appendTurn(session, 1, "error");
    appendTurn(session, 2, "aborted");
    appendTurn(session, 3, "length");
    session.appendMessage(userMessage("request 4"));
    session.appendMessage(fauxAssistantMessage("using a tool", { stopReason: "toolUse" }));
    session.appendMessage(fauxAssistantMessage("finished"));
    session.appendMessage(userMessage("request 5"));
    session.appendMessage(fauxAssistantMessage("still using a tool", { stopReason: "toolUse" }));

    expect(conversationProgress(session.getBranch()).completedTurns).toBe(2);
  });
});

describe("recap input", () => {
  it("keeps the latest eight textual user turns", () => {
    const session = sessionWithTurns(9);
    const prompt = buildRecapPrompt(session.getBranch());

    expect(prompt).not.toContain("request 1");
    expect(prompt).toContain("request 2");
    expect(prompt).toContain("request 9");
    expect(prompt).toContain("answer 9");
    expect(prompt?.match(/^User:/gmu)).toHaveLength(8);
  });

  it("keeps complete long ASCII and Unicode messages in chronological order without a byte budget", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage("old request"));
    session.appendMessage(fauxAssistantMessage("old answer"));
    session.appendMessage(userMessage("🦄".repeat(500)));
    session.appendMessage(fauxAssistantMessage("A".repeat(159)));

    const prompt = buildRecapPrompt(session.getBranch());

    expect(prompt).toBe(
      `${RECAP_PROMPT_PREFIX}User: old request\n\nAssistant: old answer\n\nUser: ${"🦄".repeat(500)}\n\nAssistant: ${"A".repeat(159)}`,
    );
  });

  it("returns no prompt without eligible text", () => {
    const session = SessionManager.inMemory();
    expect(buildRecapPrompt(session.getBranch())).toBeUndefined();
    session.appendMessage(userMessage("   "));
    session.appendMessage(fauxAssistantMessage("   "));
    expect(buildRecapPrompt(session.getBranch())).toBeUndefined();
  });

  it("ignores failed assistant text and earlier recaps", () => {
    const session = sessionWithTurns(1);
    session.appendCustomEntry(RECAP_ENTRY_TYPE, {
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

    const prompt = buildRecapPrompt(session.getBranch());
    expect(prompt).not.toContain("Do not repeat this");
    expect(prompt).not.toContain("internal provider failure");
    expect(prompt).toContain("User: latest");
  });

  it("uses compacted context for history but lifetime branch progress for cadence", () => {
    const session = SessionManager.inMemory();
    session.appendMessage(userMessage("COMPACTED_SECRET"));
    session.appendMessage(fauxAssistantMessage("old answer"));
    appendTurn(session, 2);
    const kept = session.appendMessage(userMessage("kept request"));
    session.appendMessage(fauxAssistantMessage("kept answer"));
    session.appendCompaction("SUMMARY_SECRET", kept, 100);
    appendTurn(session, 4);

    const prompt = buildRecapPrompt(session.buildContextEntries());

    expect(prompt).not.toContain("COMPACTED_SECRET");
    expect(prompt).not.toContain("SUMMARY_SECRET");
    expect(prompt).toContain("kept request");
    expect(prompt).toContain("request 4");
    expect(conversationProgress(session.getBranch()).completedTurns).toBe(4);
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
    expect(normalizeRecap(" one\u0007\n\u061c\u200e\u200f\u202Etwo\u202C\t ")).toBe("one\ntwo");
  });
});
