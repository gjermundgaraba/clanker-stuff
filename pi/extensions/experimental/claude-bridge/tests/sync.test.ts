// The sync decision against the histories pi actually sends: ordinary turns, the tool
// loop, another provider's turns, compaction, rewrites, retries and side calls.

import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import type { BridgeContext } from "../prompt.js";
import { fingerprint, plan, promptKey } from "../sync.js";
import type { SyncState } from "../sync.js";
import { testModel } from "./helpers.js";

const model = testModel();

let clock = 0;

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: clock++ });

function assistant(
  content: AssistantMessage["content"],
  provider = model.provider,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: clock++,
  };
}

const say = (text: string, provider?: string): AssistantMessage =>
  assistant([{ type: "text", text }], provider);

const call = (id: string, provider?: string): AssistantMessage =>
  assistant([{ type: "toolCall", id, name: "read", arguments: { path: "a" } }], provider);

const result = (id: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text: `contents for ${id}` }],
  isError: false,
  timestamp: clock++,
});

const readTool = { name: "read", description: "Read a file", parameters: Type.Object({}) };

const context = (messages: Message[], description = readTool.description): BridgeContext => ({
  messages,
  tools: [{ ...readTool, description }],
});

/** What a conversation records once Claude Code holds `messages`. */
const holding = (messages: readonly Message[], extra: Partial<SyncState> = {}): SyncState => ({
  sent: messages.map(fingerprint),
  busy: false,
  ...extra,
});

describe("ordinary turns", () => {
  it("starts a first turn clean, with nothing to rebuild from", () => {
    const u1 = user("hi");

    expect(plan(holding([]), context([u1]))).toEqual({
      kind: "rebuild",
      reason: "none",
      priors: [],
      turn: [u1],
    });
  });

  it("resumes when the history is what Claude Code holds plus a new user turn", () => {
    const [u1, a1, u2] = [user("hi"), say("hello"), user("again")];

    expect(plan(holding([u1, a1]), context([u1, a1, u2]))).toEqual({ kind: "resume", turn: [u2] });
  });

  // Claude Code's session gains no message pi lacks, so the next turn still resumes.
  it("resumes after a turn that continued from tool results without a user turn", () => {
    const history = [user("go"), call("t1"), result("t1")];
    const reply = say("done");
    const next = user("thanks");

    expect(plan(holding([...history, reply]), context([...history, reply, next]))).toEqual({
      kind: "resume",
      turn: [next],
    });
  });
});

describe("the tool loop", () => {
  const u1 = user("read a");
  const a1 = call("t1");

  const parked = (messages: Message[], description?: string): SyncState =>
    holding(messages, {
      busy: true,
      parked: { promptKey: promptKey(context(messages, description)), waiting: new Set(["t1"]) },
    });

  it("delivers the results the parked query waits on", () => {
    const r1 = result("t1");

    expect(plan(parked([u1, a1]), context([u1, a1, r1]))).toEqual({
      kind: "deliver",
      results: [r1],
      steer: [],
    });
  });

  it("delivers a steer pi queued after the results with them", () => {
    const [r1, steer] = [result("t1"), user("use b instead")];

    expect(plan(parked([u1, a1]), context([u1, a1, r1, steer]))).toEqual({
      kind: "deliver",
      results: [r1],
      steer: [steer],
    });
  });

  it("rebuilds instead of delivering a result for a call nobody waits on", () => {
    const r2 = result("t2");

    expect(plan(parked([u1, a1]), context([u1, a1, r2]))).toMatchObject({
      kind: "rebuild",
      reason: "tail",
      priors: [u1, a1, r2],
      turn: [],
    });
  });

  // The parked query's MCP server and prompt are fixed, so it cannot see the change.
  it("rebuilds when the tools changed while the query was parked", () => {
    const r1 = result("t1");

    expect(plan(parked([u1, a1], "an older description"), context([u1, a1, r1]))).toMatchObject({
      kind: "rebuild",
      reason: "tail",
      turn: [],
    });
  });
});

describe("history Claude Code does not hold", () => {
  it("rebuilds with another provider's turns, tool calls included", () => {
    const [u1, a1, u2] = [user("hi"), say("hello"), user("now you, faux")];
    const faux = [call("f1", "faux"), result("f1"), say("faux done", "faux")];
    const u3 = user("back to claude");

    expect(plan(holding([u1, a1]), context([u1, a1, u2, ...faux, u3]))).toEqual({
      kind: "rebuild",
      reason: "tail",
      priors: [u1, a1, u2, ...faux],
      turn: [u3],
    });
  });

  it("rebuilds after compaction replaced the start of the history", () => {
    const [u1, a1, u2, a2] = [user("one"), say("1"), user("two"), say("2")];
    const summary = user("<summary>one and two</summary>");
    const u3 = user("three");

    expect(plan(holding([u1, a1, u2, a2]), context([summary, u2, a2, u3]))).toMatchObject({
      kind: "rebuild",
      reason: "diverged",
      priors: [summary, u2, a2],
    });
  });

  it("rebuilds when a message was rewritten without changing the count", () => {
    const [u1, a1] = [user("look at this image"), say("a cat")];
    const blocked = { ...u1, content: "look at this image [image omitted]" };
    const u2 = user("and now?");

    expect(plan(holding([u1, a1]), context([blocked, a1, u2]))).toMatchObject({
      kind: "rebuild",
      reason: "diverged",
    });
  });

  // pi hides a failed attempt and resends the turn; its history must come along.
  it("rebuilds a retried turn with the history before it", () => {
    const [u1, a1, u2] = [user("one"), say("1"), user("two")];

    expect(plan(holding([u1, a1, u2]), context([u1, a1, u2]))).toEqual({
      kind: "rebuild",
      reason: "tail",
      priors: [u1, a1],
      turn: [u2],
    });
  });

  it("rebuilds when a steer never reached Claude Code", () => {
    const [u1, a1, r1] = [user("read a"), call("t1"), result("t1")];
    const [steer, a2, u3] = [user("use b"), say("read it"), user("next")];

    expect(plan(holding([u1, a1, r1, a2]), context([u1, a1, r1, steer, a2, u3]))).toMatchObject({
      kind: "rebuild",
      reason: "diverged",
    });
  });
});

describe("a request while a query runs", () => {
  it("is a side call when it is not the running query's continuation", () => {
    const [u1, a1] = [user("read a"), call("t1")];

    const state = holding([u1, a1], {
      busy: true,
      parked: { promptKey: promptKey(context([u1, a1])), waiting: new Set(["t1"]) },
    });

    expect(plan(state, context([user("summarize this for a status line")]))).toEqual({
      kind: "side",
    });
  });

  // pi's own retry after compacting mid-turn ends in the tool results, not a user turn.
  it("rebuilds pi's own continuation that no longer matches", () => {
    const [u1, a1, r1] = [user("read a"), call("t1"), result("t1")];
    const summary = user("<summary>read a</summary>");

    expect(plan(holding([u1, a1], { busy: true }), context([summary, a1, r1]))).toMatchObject({
      kind: "rebuild",
      reason: "diverged",
      turn: [],
    });
  });
});

describe(fingerprint, () => {
  it("ignores timestamps and usage but not content or the call a result answers", () => {
    const original = say("same words");

    expect(fingerprint({ ...original, timestamp: 99, stopReason: "length" })).toBe(
      fingerprint(original),
    );
    expect(fingerprint(say("other words"))).not.toBe(fingerprint(original));
    expect(fingerprint({ ...result("t1"), toolCallId: "t2" })).not.toBe(fingerprint(result("t1")));
  });
});
