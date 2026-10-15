// The conversation machine against a scripted query: the query's lifetime follows the
// `active` state, tool results meet their handlers in either order, a steer reaches
// stdin before the results it rides with, and nothing a stopped query sends reaches the
// conversation.

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { createActor, SimulatedClock, waitFor } from "xstate";
import { describe, expect, it } from "vite-plus/test";

import type { QueryFunction } from "../../child.js";
import { CLOSE_GRACE_MS, conversationMachine, syncState } from "../../machine/conversation.js";
import type { ResolveToolCall } from "../../machine/conversation.js";
import type { McpResult } from "../../mcp-server.js";
import { makePromptStream, userMessage } from "../../query/prompt-stream.js";
import { fingerprint } from "../../sync.js";
import { resolveServedTools } from "../../tools.js";
import { Turn } from "../../translate.js";
import {
  assistantMessage,
  init,
  rateLimitEvent,
  recordingStream,
  successResult,
  textBlock,
} from "../fixtures/sdk.js";
import type { RecordingStream } from "../fixtures/sdk.js";
import { fakeQueryFunction, testModel } from "../helpers.js";
import type { FakeQuery } from "../helpers.js";

const model = testModel();

const { toPi } = resolveServedTools([
  { name: "read", description: "Read a file", parameters: Type.Object({}) },
]);

const READ = "mcp__custom-tools__read";

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 0 });

const prompt = user("read a");

const toolResult = (id: string, text: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 0,
});

const toolCall = (id: string) =>
  assistantMessage(`msg_${id}`, [{ type: "tool_use", id, name: READ, input: {} }]);

const textOf = (result: McpResult): string =>
  result.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("");

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

  const settle = async (
    state: "idle" | { active: "streaming" | "parked" | "delivering" | "closing" },
  ): Promise<void> => {
    await waitFor(actor, (snapshot) => snapshot.matches(state), { timeout: 1_000 });
  };

  /** A provider call's pi stream, as the turn it is answered through. */
  const turn = (): { turn: Turn; pi: RecordingStream } => {
    const pi = recordingStream();

    return { turn: new Turn(model, pi.stream, toPi), pi };
  };

  /** Start a query for `prompt`, the way the provider does. */
  function start(signal?: AbortSignal) {
    const opened = turn();
    const promptStream = makePromptStream();

    // Nothing reads this stdin unless a test does, so ending the query rejects the push.
    promptStream.push(userMessage("read a")).catch(() => {});
    actor.send({
      type: "pi.start",
      ...opened,
      params: { prompt: promptStream.stream, options: {} },
      promptStream,
      promptKey: "key",
      model,
      signal,
      sent: [fingerprint(prompt)],
    });

    return { ...opened, promptStream };
  }

  function deliver(results: ToolResultMessage[], steer: Message[] = [], signal?: AbortSignal) {
    const opened = turn();

    actor.send({ type: "pi.deliver", turn: opened.turn, results, steer, signal });

    return opened;
  }

  const sent = (): readonly string[] => actor.getSnapshot().context.sent;

  return { actor, notices, clock, query, settle, start, deliver, sent };
}

/** An MCP handler's side of a tool call: the promise Claude Code's tools/call awaits. */
function handler(id: string) {
  const answered = Promise.withResolvers<McpResult>();
  const resolve: ResolveToolCall = (result) => answered.resolve(result);

  return { event: { type: "cc.toolCall", id, resolve } as const, answer: answered.promise };
}

/** Read the query's stdin as the SDK's pump does: each read acks the message before. */
const stdin = (query: FakeQuery): AsyncIterator<SDKUserMessage> => {
  const { prompt: input } = query.params;

  if (typeof input === "string") throw new Error("expected a streamed prompt");

  return input[Symbol.asyncIterator]();
};

const lastEvent = (pi: RecordingStream) => pi.events.at(-1);

/** The assistant message a stream finished with. */
function lastDone(pi: RecordingStream) {
  const event = lastEvent(pi);

  if (event?.type !== "done") throw new Error(`expected done, got ${event?.type}`);

  return event.message;
}

describe("a turn", () => {
  it("answers pi on the result, before Claude Code has exited", async () => {
    const { actor, query, settle, start, sent } = conversation();
    const { pi } = start();

    query().push(init("cc-session"));
    query().push(assistantMessage("msg_1", [textBlock("hello")]));
    query().push(successResult("hello"));
    await settle({ active: "closing" });

    expect(pi.ended).toBe(true);
    expect(lastEvent(pi)).toMatchObject({ type: "done", reason: "stop" });
    // Claude Code is still writing its session file.
    expect(query().closed).toBe(false);

    const recorded = sent();

    query().end();
    await settle("idle");

    expect(query().closed).toBe(true);
    expect(sent()).toBe(recorded);
    expect(sent()).toEqual([fingerprint(prompt), fingerprint(lastDone(pi))]);
    expect(actor.getSnapshot().context.ccSessionId).toBe("cc-session");
    expect(actor.getSnapshot().context.rotate).toBe(false);
  });

  it("kills a Claude Code that does not exit after its result", async () => {
    const { actor, clock, query, settle, start } = conversation();

    start();
    query().push(successResult("hello"));
    await settle({ active: "closing" });

    clock.increment(CLOSE_GRACE_MS - 1);
    expect(actor.getSnapshot().matches({ active: "closing" })).toBe(true);

    clock.increment(1);
    expect(actor.getSnapshot().matches("idle")).toBe(true);
    expect(query().closed).toBe(true);
    expect(actor.getSnapshot().context.rotate).toBe(true);
  });

  it("fails when the query ends without a result, and forgets what Claude Code holds", async () => {
    const { query, settle, start, sent } = conversation();
    const { pi } = start();

    query().end();
    await settle("idle");

    expect(lastEvent(pi)).toMatchObject({ type: "error", reason: "error" });
    expect(sent()).toEqual([]);
  });

  it("fails when the query throws", async () => {
    const { actor, query, settle, start, sent } = conversation();
    const { pi } = start();

    query().fail(new Error("Claude Code crashed"));
    await settle("idle");

    expect(lastEvent(pi)).toMatchObject({
      type: "error",
      error: { errorMessage: "Claude Code crashed" },
    });
    expect(sent()).toEqual([]);
    expect(actor.getSnapshot().context.rotate).toBe(true);
  });
});

describe("the tool loop", () => {
  it("parks on a tool call and continues the same query with pi's result", async () => {
    const { actor, query, settle, start, deliver, sent } = conversation();
    const first = start();
    const call = handler("toolu_1");

    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });

    expect(lastEvent(first.pi)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(syncState(actor.getSnapshot())).toEqual({
      sent: [fingerprint(prompt), fingerprint(lastDone(first.pi))],
      busy: true,
      parked: { promptKey: "key", waiting: new Set(["toolu_1"]) },
    });

    actor.send(call.event);

    const result = toolResult("toolu_1", "file contents");
    const second = deliver([result]);

    expect(textOf(await call.answer)).toBe("file contents");

    query().push(assistantMessage("msg_2", [textBlock("read it")]));
    query().push(successResult("read it"));
    await settle({ active: "closing" });

    expect(lastDone(second.pi).content).toEqual([{ type: "text", text: "read it" }]);
    expect(sent()).toEqual([
      fingerprint(prompt),
      fingerprint(lastDone(first.pi)),
      fingerprint(result),
      fingerprint(lastDone(second.pi)),
    ]);
  });

  it("answers a handler that asks after pi already delivered its result", async () => {
    const { actor, query, settle, start, deliver } = conversation();
    const call = handler("toolu_1");

    start();
    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });
    deliver([toolResult("toolu_1", "early")]);
    actor.send(call.event);

    expect(textOf(await call.answer)).toBe("early");
    expect(actor.getSnapshot().context.results.size).toBe(0);
  });

  it("warns when a delivery leaves a handler waiting", async () => {
    const { actor, notices, query, settle, start, deliver } = conversation();

    start();
    query().push(
      assistantMessage("msg_1", [
        { type: "tool_use", id: "toolu_1", name: READ, input: {} },
        { type: "tool_use", id: "toolu_2", name: READ, input: {} },
      ]),
    );
    await settle({ active: "parked" });
    actor.send(handler("toolu_1").event);
    actor.send(handler("toolu_2").event);
    deliver([toolResult("toolu_1", "one")]);
    await settle({ active: "streaming" });

    expect(notices).toEqual([
      "Claude bridge: 1 tool handler(s) still waiting; provider may be stuck",
    ]);
  });

  it("ends a delivery with no parked query to take it, rather than leave pi waiting", () => {
    const { deliver } = conversation();
    const { pi } = deliver([toolResult("toolu_1", "late")]);

    expect(pi.ended).toBe(true);
    expect(lastEvent(pi)).toMatchObject({ type: "error" });
  });
});

describe("a steer", () => {
  it("reaches Claude Code's stdin before the results it rides with", async () => {
    const { actor, query, settle, start, deliver, sent } = conversation();
    const call = handler("toolu_1");
    const order: string[] = [];

    start();

    const input = stdin(query());

    await input.next();
    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });
    actor.send(call.event);
    void call.answer.then(() => order.push("result"));

    const steer = user("use b instead");
    const result = toolResult("toolu_1", "a");

    deliver([result], [steer]);
    await settle({ active: "delivering" });

    const written = await input.next();

    order.push("steer written");
    expect(written.value).toMatchObject({ priority: "next" });
    expect(order).toEqual(["steer written"]);

    // The SDK's pump reads again only once the write completed: that is the ack.
    void input.next();
    await settle({ active: "streaming" });
    await call.answer;

    expect(order).toEqual(["steer written", "result"]);
    expect(sent().slice(-2)).toEqual([fingerprint(result), fingerprint(steer)]);
  });

  it("still releases the results when it never reached Claude Code, and is not recorded", async () => {
    const { actor, query, settle, start, deliver, sent } = conversation();
    const call = handler("toolu_1");
    const { promptStream } = start();

    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });
    actor.send(call.event);
    promptStream.fail(new Error("stdin gone"));

    const result = toolResult("toolu_1", "a");

    deliver([result], [user("use b instead")]);

    expect(textOf(await call.answer)).toBe("a");
    await settle({ active: "streaming" });
    expect(sent().at(-1)).toBe(fingerprint(result));
  });
});

describe("an abort", () => {
  it("stops the query while pi runs a tool, with no provider call open", async () => {
    const { actor, query, settle, start, sent } = conversation();
    const controller = new AbortController();
    const call = handler("toolu_1");

    start(controller.signal);
    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });
    actor.send(call.event);
    controller.abort();

    expect(textOf(await call.answer)).toBe("Claude Code query ended");
    expect(actor.getSnapshot().matches("idle")).toBe(true);
    expect(query().interrupted).toBe(true);
    expect(query().closed).toBe(true);
    expect(sent()).toEqual([]);
    expect(actor.getSnapshot().context.rotate).toBe(true);
  });

  it("ends the open provider call as aborted", async () => {
    const { query, settle, start } = conversation();
    const controller = new AbortController();
    const { pi } = start(controller.signal);

    query().push(assistantMessage("msg_1", [textBlock("partial")]));
    await settle({ active: "streaming" });
    controller.abort();
    await settle("idle");

    expect(lastEvent(pi)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("follows the signal of the call that delivered results", async () => {
    const { query, settle, start, deliver } = conversation();
    const controller = new AbortController();

    start();
    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });

    const { pi } = deliver([toolResult("toolu_1", "a")], [], controller.signal);

    await settle({ active: "streaming" });
    controller.abort();
    await settle("idle");

    expect(lastEvent(pi)).toMatchObject({ type: "error", reason: "aborted" });
  });

  it("drops what a stopped query still sends, so it cannot end the next turn", async () => {
    const { actor, query, settle, start } = conversation(true);
    const controller = new AbortController();

    start(controller.signal);
    await settle({ active: "streaming" });

    const stale = query();

    controller.abort();
    await settle("idle");

    const { pi } = start();

    stale.push(successResult("stale"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(actor.getSnapshot().matches({ active: "streaming" })).toBe(true);
    expect(pi.ended).toBe(false);

    query().push(successResult("fresh"));
    await settle({ active: "closing" });

    expect(lastDone(pi).content).toEqual([{ type: "text", text: "fresh" }]);
  });
});

it("discards a parked query pi's history moved on from", async () => {
  const { actor, query, settle, start, sent } = conversation();
  const call = handler("toolu_1");

  start();
  query().push(toolCall("toolu_1"));
  await settle({ active: "parked" });
  actor.send(call.event);
  actor.send({ type: "pi.discard" });

  expect(textOf(await call.answer)).toBe("Claude Code query ended");
  expect(query().closed).toBe(true);
  expect(sent()).toEqual([]);
  expect(actor.getSnapshot().context.rotate).toBe(true);
});

// pi carries a failure only as errorMessage text, so whatever reacts to a rate limit
// pattern-matches it. These mirror pi-subagents' fallback gate: one pattern from its
// retryable list, and the tool-failure shape it refuses to retry.
const RATE_LIMIT = /rate\s*limit/iu;

const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:\(exit \d+\):|with exit code \d+)(?:\s|$)/iu;

describe("a rate-limit rejection", () => {
  // Claude Code words a spent subscription with none of the vocabulary anyone matches
  // on, and sends the rejection as its own message just before the failure it caused.
  const rejection = () =>
    rateLimitEvent({ status: "rejected", resetsAt: 1786141800, rateLimitType: "five_hour" });

  const OUT_OF_USAGE = "You're out of extra usage · resets 6:30pm (America/New_York)";

  const UNRELATED = "API Error: Overloaded";

  it("names the failure it caused as a rate limit, so fallback chains fire", async () => {
    const { query, settle, start } = conversation();
    const { pi } = start();

    query().push(rejection());
    query().push(successResult(OUT_OF_USAGE, true));
    await settle({ active: "closing" });

    const event = lastEvent(pi);

    if (event?.type !== "error") throw new Error("expected an error");

    expect(event.error.errorMessage).toMatch(RATE_LIMIT);
    expect(event.error.errorMessage).not.toMatch(TOOL_FAILURE_PREFIX);
    // Claude Code's own wording, and which window ran out.
    expect(event.error.errorMessage).toContain(OUT_OF_USAGE);
    expect(event.error.errorMessage).toContain("five_hour");
    // A rejected window resets in hours: not retried as transient.
    expect(isRetryableAssistantError(event.error)).toBe(false);
  });

  it("announces itself once", async () => {
    const { notices, query, settle, start } = conversation();

    start();
    query().push(rejection());
    query().push(rejection());
    query().push(successResult("fine"));
    await settle({ active: "closing" });

    expect(notices).toEqual([
      `Claude subscription rate limit reached (five_hour); resets at ${new Date(1786141800 * 1000).toLocaleTimeString()}`,
    ]);
  });

  it("does not label a failure in a later query", async () => {
    const { query, settle, start } = conversation();

    start();
    query().push(rejection());
    query().push(successResult("fine"));
    query().end();
    await settle("idle");

    const { pi } = start();

    query().push(successResult(UNRELATED, true));
    await settle({ active: "closing" });

    expect(lastEvent(pi)).toMatchObject({ type: "error", error: { errorMessage: UNRELATED } });
  });

  it("leaves an unrelated failure alone, and forgets what Claude Code holds", async () => {
    const { query, settle, start, sent } = conversation();
    const { pi } = start();

    query().push(successResult(UNRELATED, true));
    await settle({ active: "closing" });

    expect(lastEvent(pi)).toMatchObject({ type: "error", error: { errorMessage: UNRELATED } });
    expect(sent()).toEqual([]);
  });
});
