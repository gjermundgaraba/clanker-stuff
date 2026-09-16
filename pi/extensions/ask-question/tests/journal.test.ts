import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { Journal, persistedEntries } from "../journal.js";
import { createInteraction, transition } from "../interaction.js";
import { answerResult, answerMessage, isDelivered } from "../delivery.js";

const request = {
  questions: [
    { id: "q", header: "Question", question: "Choose?", options: [{ id: "yes", label: "Yes" }] },
  ],
};
const host = createExtensionHost(() => {});
describe("journal persistence and recovery", () => {
  it("rejects ephemeral/unflushed/partial histories and verifies disk checkpoints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "question-journal-"));
    try {
      expect(() =>
        persistedEntries(host.createContext({ sessionManager: SessionManager.inMemory() })),
      ).toThrow("file-backed");
      const sm = SessionManager.create(dir, dir);
      const ctx = host.createContext({ sessionManager: sm });
      expect(() => persistedEntries(ctx)).toThrow("not initialized");
      sm.appendMessage(fauxAssistantMessage("Ready"));
      const journal = new Journal(
        {
          appendEntry: (type, data) => {
            sm.appendCustomEntry(type, data);
          },
        },
        ctx,
      );
      const item = createInteraction("q_test", request, "c", "async");
      await journal.checkpoint(item, () => {});
      expect(journal.replay().get(item.id)).toMatchObject({
        paused: true,
        draft: { answers: { q: { selected: [] } } },
      });
      const file = sm.getSessionFile()!;
      const text = readFileSync(file, "utf8");
      writeFileSync(file, text.slice(0, -2));
      expect(() => journal.verify()).toThrow("Incomplete");
      writeFileSync(file, text.split("\n").slice(0, -2).join("\n") + "\n");
      expect(() => journal.verify()).toThrow("does not match");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reconciles canonical blocking results on either side of a missing delivery checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "question-result-"));
    try {
      const sm = SessionManager.create(dir, dir);
      sm.appendMessage(fauxAssistantMessage("Ready"));
      const ctx = host.createContext({ sessionManager: sm });
      const journal = new Journal(
        {
          appendEntry: (type, data) => {
            sm.appendCustomEntry(type, data);
          },
        },
        ctx,
      );
      let item = createInteraction("q_result", request, "call1", "blocking");
      item = transition(item, item.version, { type: "select", question: "q", option: "yes" });
      item = transition(item, item.version, { type: "submit" });
      await journal.checkpoint(item, () => {});
      const submission = item.submissions[0];
      expect(isDelivered(item, submission, sm.getBranch())).toBe(false);
      const result = answerResult(item, submission);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call1",
        toolName: "request_user_input",
        ...result,
        isError: false,
        timestamp: Date.now(),
      });
      const restored = journal.replay().get(item.id)!;
      expect(isDelivered(restored, submission, sm.getBranch())).toBe(true);
      expect(isDelivered(restored, { ...submission, tool_call_id: "wrong" }, sm.getBranch())).toBe(
        false,
      );
      const fork = SessionManager.open(sm.createBranchedSession(sm.getLeafId()!)!);
      expect(persistedEntries(host.createContext({ sessionManager: fork }))).toHaveLength(
        sm.getEntries().length,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("recognizes full async envelopes restored alongside unrelated text, not ID substrings", async () => {
    const sm = SessionManager.inMemory();
    let item = createInteraction("q_async", request, "call", "async");
    item = transition(item, item.version, { type: "select", question: "q", option: "yes" });
    item = transition(item, item.version, { type: "submit" });
    const submission = item.submissions[0];
    sm.appendMessage({ role: "user", content: `Mention ${item.id} only`, timestamp: Date.now() });
    expect(isDelivered(item, submission, sm.getBranch())).toBe(false);
    sm.appendMessage({
      role: "user",
      content: `${answerMessage(item, submission)}\n\nUnrelated queued text`,
      timestamp: Date.now(),
    });
    expect(isDelivered(item, submission, sm.getBranch())).toBe(true);
  });
  it("accepts initialized explicit session files without assistant messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "question-initialized-"));
    try {
      const file = join(dir, "explicit.jsonl");
      writeFileSync(file, "");
      const fork = SessionManager.open(file);
      expect(
        fork.getBranch().some((e) => e.type === "message" && e.message.role === "assistant"),
      ).toBe(false);
      const journal = new Journal(
        {
          appendEntry: (type, data) => {
            fork.appendCustomEntry(type, data);
          },
        },
        host.createContext({ sessionManager: fork }),
      );
      await journal.checkpoint(
        createInteraction("q_initialized", request, "call", "async"),
        () => {},
      );
      expect(journal.replay().has("q_initialized")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not publish a receipt after a failed append", async () => {
    const dir = mkdtempSync(join(tmpdir(), "question-failure-"));
    try {
      const sm = SessionManager.create(dir, dir);
      sm.appendMessage(fauxAssistantMessage("Ready"));
      const journal = new Journal(
        {
          appendEntry: () => {
            throw new Error("disk full");
          },
        },
        host.createContext({ sessionManager: sm }),
      );
      await expect(
        journal.checkpoint(createInteraction("q_failure", request, "c", "async"), () => {}),
      ).rejects.toThrow("checkpoint failed");
      expect(() => journal.verify()).toThrow("checkpoint failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
