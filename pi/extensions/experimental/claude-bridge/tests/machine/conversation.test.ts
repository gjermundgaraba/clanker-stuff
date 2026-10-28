import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type {
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";
import { createActor, SimulatedClock, waitFor } from "xstate";

import type { QueryFunction } from "../../child.js";
import {
  CLOSE_GRACE_MS,
  conversationMachine,
  syncState,
} from "../../machine/conversation.js";
import type { ResolveToolCall } from "../../machine/conversation.js";
import type { McpResult } from "../../mcp-server.js";
import { makePromptStream, userMessage } from "../../query/prompt-stream.js";
import { resolveServedTools } from "../../tools.js";
import { Turn } from "../../translate.js";
import {
  assistantMessage,
  blockStop,
  init,
  messageDelta,
  messageStart,
  messageStop,
  rateLimitEvent,
  recordingStream,
  successResult,
  textBlock,
  toolUseStart,
} from "../fixtures/sdk.js";
import type { RecordingStream } from "../fixtures/sdk.js";
import { fakeQueryFunction, testModel } from "../helpers.js";
import type { FakeQuery } from "../helpers.js";

const model = testModel();

const { names: served } = resolveServedTools([
  { name: "read", description: "Read a file", parameters: Type.Object({}) },
]);

const READ = "mcp__custom-tools__read";

const user = (text: string): UserMessage => ({
  role: "user",
  content: text,
  timestamp: 0,
});

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
  assistantMessage(`msg_${id}`, [
    { type: "tool_use", id, name: READ, input: {} },
  ]);

const textOf = (result: McpResult): string =>
  result.content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("");

const turn = () => {
  const pi = recordingStream();

  return { turn: new Turn(model, pi.stream, served), pi };
};

const conversation = (ignoresClose = false) => {
  const fake = fakeQueryFunction();

  const run: QueryFunction = ignoresClose
    ? (p) => ({ ...fake.run(p), close: () => {} })
    : fake.run;

  const notices: string[] = [];
  const clock = new SimulatedClock();

  const actor = createActor(conversationMachine, {
    input: {
      run,
      notify: (message: string) => {
        notices.push(message);
      },
    },
    clock,
  }).start();

  const query = (): FakeQuery => {
    const [latest] = fake.queries.slice(-1);

    if (latest === undefined) {
      throw new Error("no query started");
    }

    return latest;
  };

  const settle = async (
    state:
      | "idle"
      | { active: "streaming" | "parked" | "delivering" | "closing" }
  ): Promise<void> => {
    await waitFor(actor, (snapshot) => snapshot.matches(state), {
      timeout: 1000,
    });
  };

  const start = (signal?: AbortSignal) => {
    const opened = turn();
    const promptStream = makePromptStream();

    promptStream.push(userMessage("read a")).catch(() => {});
    actor.send({
      type: "pi.start",
      ...opened,
      params: { prompt: promptStream.stream, options: {} },
      promptStream,
      key: "key",
      model,
      signal,
      held: [prompt],
    });

    return { ...opened, promptStream };
  };

  const deliver = (
    results: ToolResultMessage[],
    steer: Message[] = [],
    signal?: AbortSignal
  ) => {
    const opened = turn();

    actor.send({
      type: "pi.deliver",
      turn: opened.turn,
      results,
      steer,
      signal,
    });

    return opened;
  };

  const held = (): readonly Message[] => actor.getSnapshot().context.held;

  return { actor, notices, clock, query, settle, start, deliver, held };
};

const handler = (id: string) => {
  const answered = Promise.withResolvers<McpResult>();

  const resolve: ResolveToolCall = (result) => {
    answered.resolve(result);
  };

  return {
    event: { type: "cc.toolCall", id, resolve } as const,
    answer: answered.promise,
  };
};

const stdin = (query: FakeQuery): AsyncIterator<SDKUserMessage> => {
  const { prompt: input } = query.params;

  if (typeof input === "string") {
    throw new TypeError("expected a streamed prompt");
  }

  return input[Symbol.asyncIterator]();
};

const lastEvent = (pi: RecordingStream) => pi.events.at(-1);

const lastDone = (pi: RecordingStream) => {
  const event = lastEvent(pi);

  if (event?.type !== "done") {
    throw new Error(`expected done, got ${event?.type}`);
  }

  return event.message;
};

const rejection = () =>
  rateLimitEvent({
    status: "rejected",
    resetsAt: 1_786_141_800,
    rateLimitType: "five_hour",
  });

describe("the conversation machine", () => {
  describe("a turn", () => {
    it("answers pi on the result, before Claude Code has exited", async () => {
      const { actor, query, settle, start, held } = conversation();
      const { pi } = start();

      query().push(init("cc-session"));
      query().push(assistantMessage("msg_1", [textBlock("hello")]));
      query().push(successResult("hello"));
      await settle({ active: "closing" });

      expect(pi.ended).toBe(true);
      expect(lastEvent(pi)).toMatchObject({ type: "done", reason: "stop" });
      expect(query().closed).toBe(false);

      query().end();
      await settle("idle");

      expect(query().closed).toBe(true);
      expect(held()).toStrictEqual([prompt, lastDone(pi)]);
      expect(held()[1]).not.toBe(lastDone(pi));
      expect(syncState(actor.getSnapshot()).session).toBe("cc-session");
    });

    it("kills a Claude Code that does not exit after its result, and forgets what it holds", async () => {
      const { actor, clock, query, settle, start, held } = conversation();

      start();
      query().push(successResult("hello"));
      await settle({ active: "closing" });

      clock.increment(CLOSE_GRACE_MS - 1);
      expect(actor.getSnapshot().matches({ active: "closing" })).toBe(true);

      clock.increment(1);
      expect(actor.getSnapshot().matches("idle")).toBe(true);
      expect(query().closed).toBe(true);
      expect(held()).toStrictEqual([]);
    });

    it("fails when the query ends without a result, and forgets what Claude Code holds", async () => {
      const { query, settle, start, held } = conversation();
      const { pi } = start();

      query().end();
      await settle("idle");

      expect(lastEvent(pi)).toMatchObject({ type: "error", reason: "error" });
      expect(held()).toStrictEqual([]);
    });

    it("fails when the query throws", async () => {
      const { query, settle, start, held } = conversation();
      const { pi } = start();

      query().fail(new Error("Claude Code crashed"));
      await settle("idle");

      expect(lastEvent(pi)).toMatchObject({
        type: "error",
        error: { errorMessage: "Claude Code crashed" },
      });
      expect(held()).toStrictEqual([]);
    });
  });

  it("fails the turn when the query cannot start", async () => {
    const pi = recordingStream();

    const actor = createActor(conversationMachine, {
      input: {
        run: () => {
          throw new Error("Claude Code executable not found");
        },
        notify: () => {},
      },
    }).start();

    actor.send({
      type: "pi.start",
      turn: new Turn(model, pi.stream, served),
      params: { prompt: "read a", options: {} },
      promptStream: makePromptStream(),
      key: "key",
      model,
      signal: undefined,
      held: [prompt],
    });

    await waitFor(actor, (snapshot) => snapshot.matches("idle"), {
      timeout: 1000,
    });

    expect(lastEvent(pi)).toMatchObject({
      type: "error",
      error: { errorMessage: "Claude Code executable not found" },
    });
  });

  describe("the tool loop", () => {
    it("parks on a tool call and continues the same query with pi's result", async () => {
      const { actor, query, settle, start, deliver, held } = conversation();
      const first = start();
      const call = handler("toolu_1");

      query().push(toolCall("toolu_1"));
      await settle({ active: "parked" });

      expect(lastEvent(first.pi)).toMatchObject({
        type: "done",
        reason: "toolUse",
      });
      expect(syncState(actor.getSnapshot())).toStrictEqual({
        held: [prompt, lastDone(first.pi)],
        session: undefined,
        busy: true,
        parked: { key: "key", waiting: new Set(["toolu_1"]) },
      });

      actor.send(call.event);

      const result = toolResult("toolu_1", "file contents");
      const second = deliver([result]);

      expect(textOf(await call.answer)).toBe("file contents");

      query().push(assistantMessage("msg_2", [textBlock("read it")]));
      query().push(successResult("read it"));
      await settle({ active: "closing" });

      expect(lastDone(second.pi).content).toStrictEqual([
        { type: "text", text: "read it" },
      ]);
      expect(held()).toStrictEqual([
        prompt,
        lastDone(first.pi),
        result,
        lastDone(second.pi),
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
    });

    it("warns when a delivery leaves a handler waiting", async () => {
      const { actor, notices, query, settle, start, deliver } = conversation();

      start();
      query().push(
        assistantMessage("msg_1", [
          { type: "tool_use", id: "toolu_1", name: READ, input: {} },
          { type: "tool_use", id: "toolu_2", name: READ, input: {} },
        ])
      );
      await settle({ active: "parked" });
      actor.send(handler("toolu_1").event);
      actor.send(handler("toolu_2").event);
      deliver([toolResult("toolu_1", "one")]);
      await settle({ active: "streaming" });

      expect(notices).toStrictEqual([
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
      const { actor, query, settle, start, deliver, held } = conversation();
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
      expect(order).toStrictEqual(["steer written"]);

      void input.next();
      await settle({ active: "streaming" });
      await call.answer;

      expect(order).toStrictEqual(["steer written", "result"]);
      expect(held().slice(-2)).toStrictEqual([result, steer]);
    });

    it("still releases the results when it never reached Claude Code, and is not recorded", async () => {
      const { actor, query, settle, start, deliver, held } = conversation();
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
      expect(held().at(-1)).toStrictEqual(result);
    });
  });

  describe("an abort", () => {
    it("stops the query while pi runs a tool, with no provider call open", async () => {
      const { actor, query, settle, start, held } = conversation();
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
      expect(held()).toStrictEqual([]);
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

      const { pi } = deliver(
        [toolResult("toolu_1", "a")],
        [],
        controller.signal
      );

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
      await yieldToEventLoop();

      expect(actor.getSnapshot().matches({ active: "streaming" })).toBe(true);
      expect(pi.ended).toBe(false);

      query().push(successResult("fresh"));
      await settle({ active: "closing" });

      expect(lastDone(pi).content).toStrictEqual([
        { type: "text", text: "fresh" },
      ]);
    });
  });

  it("stops the query when its tool calls were cut off at the output limit", async () => {
    const { query, settle, start, held } = conversation();
    const { pi } = start();

    query().push(messageStart("msg_1"));
    query().push(toolUseStart(0, READ, "toolu_1"));
    query().push(blockStop(0));
    query().push(messageDelta("max_tokens"));
    query().push(messageStop());
    await settle("idle");

    expect(lastEvent(pi)).toMatchObject({ type: "done", reason: "length" });
    expect(query().closed).toBe(true);
    expect(held()).toStrictEqual([]);
  });

  it("discards a parked query pi's history moved on from", async () => {
    const { actor, query, settle, start, held } = conversation();
    const call = handler("toolu_1");

    start();
    query().push(toolCall("toolu_1"));
    await settle({ active: "parked" });
    actor.send(call.event);
    actor.send({ type: "pi.discard" });

    expect(textOf(await call.answer)).toBe("Claude Code query ended");
    expect(query().closed).toBe(true);
    expect(held()).toStrictEqual([]);
  });

  const RATE_LIMIT = /rate\s*limit/iu;

  const TOOL_FAILURE_PREFIX =
    /^[\w.:@/-]+ failed (?:\(exit \d+\):|with exit code \d+)(?:\s|$)/iu;

  describe("a rate-limit rejection", () => {
    const OUT_OF_USAGE =
      "You're out of extra usage · resets 6:30pm (America/New_York)";

    const UNRELATED = "API Error: Overloaded";

    it("names the failure it caused as a rate limit, so fallback chains fire", async () => {
      const { query, settle, start } = conversation();
      const { pi } = start();

      query().push(rejection());
      query().push(successResult(OUT_OF_USAGE, true));
      await settle({ active: "closing" });

      const event = lastEvent(pi);

      if (event?.type !== "error") {
        throw new Error("expected an error");
      }

      expect(event.error.errorMessage).toMatch(RATE_LIMIT);
      expect(event.error.errorMessage).not.toMatch(TOOL_FAILURE_PREFIX);
      expect(event.error.errorMessage).toContain(OUT_OF_USAGE);
      expect(event.error.errorMessage).toContain("five_hour");
      expect(isRetryableAssistantError(event.error)).toBe(false);
    });

    it("announces itself once", async () => {
      const { notices, query, settle, start } = conversation();

      start();
      query().push(rejection());
      query().push(rejection());
      query().push(successResult("fine"));
      await settle({ active: "closing" });

      expect(notices).toStrictEqual([
        `Claude subscription rate limit reached (five_hour); resets at ${new Date(1_786_141_800 * 1000).toLocaleTimeString()}`,
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

      expect(lastEvent(pi)).toMatchObject({
        type: "error",
        error: { errorMessage: UNRELATED },
      });
    });

    it("leaves an unrelated failure alone, and forgets what Claude Code holds", async () => {
      const { query, settle, start, held } = conversation();
      const { pi } = start();

      query().push(successResult(UNRELATED, true));
      await settle({ active: "closing" });

      expect(lastEvent(pi)).toMatchObject({
        type: "error",
        error: { errorMessage: UNRELATED },
      });
      expect(held()).toStrictEqual([]);
    });
  });
});
