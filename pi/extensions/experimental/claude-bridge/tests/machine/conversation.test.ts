// The conversation machine against a scripted query: the query's lifetime follows the
// `active` state, tool results meet their handlers in either order, and nothing a
// stopped query sends reaches the conversation.

import { createActor, SimulatedClock, waitFor } from "xstate";
import { describe, expect, it } from "vite-plus/test";

import type { QueryFunction } from "../../bridge.js";
import { conversationMachine } from "../../machine/conversation.js";
import type { ResolveToolCall, ToolResult, TurnSink } from "../../machine/conversation.js";
import { assistantMessage, successResult, textBlock } from "../fixtures/sdk.js";
import { fakeQueryFunction } from "../helpers.js";
import type { FakeQuery } from "../helpers.js";

const params = { prompt: "hi", options: {} };

/** A pi stream stand-in that records what reached it. */
function recordingSink(log: string[]): TurnSink {
  return {
    text: (text) => log.push(`text ${text}`),
    toolUse: () => log.push("toolUse"),
    done: () => log.push("done"),
    fail: (message) => log.push(`fail ${message}`),
  };
}

/** `ignoresClose` models a query whose output is still in flight after it was told to
 *  stop, which only XState's drop of a stopped child's events can contain. */
function conversation(ignoresClose = false) {
  const fake = fakeQueryFunction();
  const run: QueryFunction = ignoresClose ? (p) => ({ ...fake.run(p), close: () => {} }) : fake.run;
  const notices: string[] = [];
  const clock = new SimulatedClock();

  const actor = createActor(conversationMachine, {
    input: { run, notify: (message: string) => notices.push(message) },
    clock,
  }).start();

  const query = (): FakeQuery => {
    const [latest] = fake.queries.slice(-1);

    if (latest === undefined) throw new Error("no query started");

    return latest;
  };

  const settle = (state: "idle" | { active: "streaming" | "parked" }) =>
    waitFor(actor, (snapshot) => snapshot.matches(state), { timeout: 1_000 });

  return { actor, fake, notices, clock, query, settle };
}

const toolCall = (id: string) =>
  assistantMessage(`msg_${id}`, [{ type: "tool_use", id, name: "read", input: {} }]);

/** An MCP handler's side of a tool call: the promise Claude Code's tools/call awaits. */
function handler(id: string) {
  const answered = Promise.withResolvers<ToolResult>();
  const resolve: ResolveToolCall = (result) => answered.resolve(result);

  return { event: { type: "cc.toolCall", id, resolve } as const, answer: answered.promise };
}

describe("conversation machine", () => {
  it("streams a turn and closes the query when it ends", async () => {
    const { actor, query, settle } = conversation();
    const log: string[] = [];

    actor.send({ type: "pi.prompt", sink: recordingSink(log), params });
    query().push(assistantMessage("msg_1", [textBlock("hello")]));
    query().push(successResult("hello"));
    await settle("idle");

    expect(log).toEqual(["text hello", "done"]);
    expect(query().closed).toBe(true);
  });

  it("parks on a tool call and hands pi's result to the waiting handler", async () => {
    const { actor, fake, query, settle } = conversation();
    const first: string[] = [];
    const second: string[] = [];
    const call = handler("toolu_1");

    actor.send({ type: "pi.prompt", sink: recordingSink(first), params });
    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });
    actor.send(call.event);
    actor.send({
      type: "pi.toolResults",
      sink: recordingSink(second),
      results: new Map([["toolu_1", { text: "file contents" }]]),
    });

    expect(await call.answer).toEqual({ text: "file contents" });

    query().push(assistantMessage("msg_2", [textBlock("read it")]));
    query().push(successResult("read it"));
    await settle("idle");

    expect(first).toEqual(["toolUse"]);
    expect(second).toEqual(["text read it", "done"]);
    // One query served the whole turn: delivery continued it rather than starting anew.
    expect(fake.queries).toHaveLength(1);
  });

  it("answers a handler that asks after pi already delivered its result", async () => {
    const { actor, query, settle } = conversation();
    const call = handler("toolu_1");

    actor.send({ type: "pi.prompt", sink: recordingSink([]), params });
    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });
    actor.send({
      type: "pi.toolResults",
      sink: recordingSink([]),
      results: new Map([["toolu_1", { text: "early" }]]),
    });
    actor.send(call.event);

    expect(await call.answer).toEqual({ text: "early" });
    expect(actor.getSnapshot().context.results.size).toBe(0);
  });

  it("on abort, releases parked handlers and closes the query", async () => {
    const { actor, query, settle } = conversation();
    const call = handler("toolu_1");

    actor.send({ type: "pi.prompt", sink: recordingSink([]), params });
    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });
    actor.send(call.event);
    actor.send({ type: "abort" });

    expect(await call.answer).toEqual({ text: "Claude Code query ended" });
    expect(query().closed).toBe(true);
    expect(actor.getSnapshot().matches("idle")).toBe(true);
  });

  it("drops what an aborted query still sends, so it cannot end the next turn", async () => {
    const { actor, query, settle } = conversation(true);

    actor.send({ type: "pi.prompt", sink: recordingSink([]), params });
    await settle({ active: "streaming" });
    const stale = query();

    actor.send({ type: "abort" });

    const log: string[] = [];

    actor.send({ type: "pi.prompt", sink: recordingSink(log), params });
    stale.push(successResult("stale"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(actor.getSnapshot().matches({ active: "streaming" })).toBe(true);
    expect(log).toEqual([]);

    query().push(successResult("fresh"));
    await settle("idle");

    expect(log).toEqual(["done"]);
  });

  it("fails the turn when the query throws", async () => {
    const { actor, query, settle } = conversation();
    const log: string[] = [];

    actor.send({ type: "pi.prompt", sink: recordingSink(log), params });
    query().fail(new Error("Claude Code crashed"));
    await settle("idle");

    expect(log).toEqual(["fail Claude Code crashed"]);
  });

  it("warns once a parked tool call has waited too long", async () => {
    const { actor, notices, clock, query, settle } = conversation();

    actor.send({ type: "pi.prompt", sink: recordingSink([]), params });
    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });
    actor.send(handler("toolu_1").event);

    clock.increment(29_999);
    expect(notices).toEqual([]);

    clock.increment(1);
    expect(notices).toEqual(["claude-bridge: 1 tool call(s) still waiting"]);
  });
});
