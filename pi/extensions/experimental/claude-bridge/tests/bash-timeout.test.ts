import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  BashToolCallEvent,
  ReadToolCallEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { giveBashTimeout } from "../bash-timeout.js";
import { assistant } from "./session/messages.js";

const call = (input: BashToolCallEvent["input"]): BashToolCallEvent => ({
  type: "tool_call",
  toolCallId: "toolu_1",
  toolName: "bash",
  input,
});

const branchWith = (message: AssistantMessage): SessionEntry[] => [
  {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: "2026-11-23T00:00:00.000Z",
    message,
  },
];

const calling = (provider: string, id = "toolu_1"): SessionEntry[] =>
  branchWith({
    ...assistant([
      { type: "toolCall", id, name: "bash", arguments: { command: "ls" } },
    ]),
    provider,
  });

const timeoutAfter = (event: BashToolCallEvent, branch: SessionEntry[]) => {
  giveBashTimeout(event, branch);

  return event.input.timeout;
};

describe(giveBashTimeout, () => {
  it("gives a claude-bridge bash call that sets none Claude Code's 120 seconds", () => {
    expect(
      timeoutAfter(call({ command: "ls" }), calling("claude-bridge"))
    ).toBe(120);
  });

  it("keeps a timeout the call set", () => {
    expect(
      timeoutAfter(
        call({ command: "make", timeout: 900 }),
        calling("claude-bridge")
      )
    ).toBe(900);
  });

  it("leaves another provider's call, another tool, and a call no message made", () => {
    expect(
      timeoutAfter(call({ command: "ls" }), calling("anthropic"))
    ).toBeUndefined();

    const read: ReadToolCallEvent = {
      type: "tool_call",
      toolCallId: "toolu_1",
      toolName: "read",
      input: { path: "a" },
    };

    giveBashTimeout(read, calling("claude-bridge"));
    expect(read.input).toStrictEqual({ path: "a" });
    expect(
      timeoutAfter(call({ command: "ls" }), calling("claude-bridge", "toolu_2"))
    ).toBeUndefined();
  });
});
