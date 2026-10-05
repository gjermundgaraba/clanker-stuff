import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import { inspectModelHistory } from "../index.js";

describe(inspectModelHistory, () => {
  it("distinguishes completed response history from physical attempts", () => {
    const session = SessionManager.inMemory();
    session.appendMessage({ role: "user", content: "start", timestamp: 0 });
    const first = { ...fauxAssistantMessage("done"), provider: "anthropic" };
    session.appendMessage(first);
    session.appendUsage("cache-warming", first.provider, first.model, first.usage);
    const failure = { ...fauxAssistantMessage("", { stopReason: "error" }), provider: "radius" };
    session.appendMessage(failure);
    expect(inspectModelHistory(session.getBranch())).toEqual({
      lastSuccessfulResponse: first,
      lastPhysicalAttempt: failure,
    });

    const newest = {
      ...fauxAssistantMessage("second", { stopReason: "toolUse" }),
      provider: "openai",
    };

    session.appendMessage(newest);
    expect(inspectModelHistory(session.getBranch())).toEqual({
      lastSuccessfulResponse: newest,
      lastPhysicalAttempt: newest,
    });
  });

  it.each(["error", "aborted", "deferred"] as const)(
    "counts %s as a physical attempt, not completed success",
    (stopReason) => {
      const session = SessionManager.inMemory();
      const newest = fauxAssistantMessage("", { stopReason });
      session.appendMessage(newest);
      expect(inspectModelHistory(session.getBranch())).toEqual({
        lastSuccessfulResponse: undefined,
        lastPhysicalAttempt: newest,
      });
    },
  );

  it("ignores pending messages, non-assistant messages and unresolved virtual routes", () => {
    const session = SessionManager.inMemory();
    const response = fauxAssistantMessage("done", { stopReason: "length" });
    const original = session.appendMessage(response);
    session.appendMessage({
      ...fauxAssistantMessage("", { stopReason: "error" }),
      api: "pi-virtual",
      provider: "router",
    });
    session.appendMessage(fauxAssistantMessage("", { stopReason: "pending" }));
    session.appendMessage({ role: "user", content: "next", timestamp: 0 });
    expect(inspectModelHistory(session.getBranch())).toEqual({
      lastSuccessfulResponse: response,
      lastPhysicalAttempt: response,
    });
    session.appendMessage(fauxAssistantMessage("other branch"));
    session.branch(original);
    expect(inspectModelHistory(session.getBranch())).toEqual({
      lastSuccessfulResponse: response,
      lastPhysicalAttempt: response,
    });
    expect(inspectModelHistory([])).toEqual({
      lastSuccessfulResponse: undefined,
      lastPhysicalAttempt: undefined,
    });
  });
});
