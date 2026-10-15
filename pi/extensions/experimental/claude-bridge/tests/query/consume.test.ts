// The consumer of one Claude Code query: recorded streams replayed end to end, and the
// failures, rate-limit rejections and stdin close a recording cannot produce on demand.

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import type { BridgeQuery } from "../../bridge.js";
import { consumeQuery, resultErrorText } from "../../query/consume.js";
import { QueryContext } from "../../query/context.js";
import { finalizeCurrentStream } from "../../query/events.js";
import { makePromptStream, userMessage } from "../../query/prompt-stream.js";
import { resolveServedTools } from "../../tools.js";
import {
  errorResult,
  inputJsonDelta,
  messageStart,
  rateLimitEvent,
  recordedStream,
  recordingStream,
  successResult,
  syntheticReport,
  thinkingDelta,
  thinkingStart,
  toolUseStart,
} from "../fixtures/sdk.js";
import type { RecordedStream, RecordingStream } from "../fixtures/sdk.js";
import { createFakeQuery, testModel } from "../helpers.js";

const model = testModel();

const served = (...names: string[]): ReadonlyMap<string, string> =>
  resolveServedTools(
    names.map((name) => ({ name, description: name, parameters: Type.Object({}) })),
  ).toPi;

function openTurn(log?: string[]): { c: QueryContext; pi: RecordingStream } {
  const c = new QueryContext();
  const pi = recordingStream(log);

  c.currentPiStream = pi.stream;
  c.resetTurnState(model);

  return { c, pi };
}

function scripted(messages: readonly SDKMessage[]): BridgeQuery {
  const query = createFakeQuery({ prompt: "", options: {} });

  for (const message of messages) query.push(message);

  query.end();

  return query;
}

interface Consumed {
  sessionId: string | undefined;
  notices: string[];
}

async function consume(
  c: QueryContext,
  query: BridgeQuery,
  toPi: ReadonlyMap<string, string> = served("read"),
): Promise<Consumed> {
  const notices: string[] = [];

  const sessionId = await consumeQuery(
    query,
    toPi,
    model,
    () => false,
    c,
    (message) => {
      notices.push(message);
    },
  );

  return { sessionId, notices };
}

const text = (c: QueryContext): string =>
  c.turnBlocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

const toolCalls = (c: QueryContext) => c.turnBlocks.filter((block) => block.type === "toolCall");

// Claude Code reports API failures (429 capacity, overload, prompt-too-long) as a result
// with is_error set while the subtype stays "success".
const RATE_LIMITED =
  "API Error: Server is temporarily limiting requests (not your usage limit): Rate limited";

const apiFailure = (): SDKMessage => successResult(RATE_LIMITED, true);

describe("resultErrorText", () => {
  it("treats is_error on a success-shaped result as a failure", () => {
    expect(resultErrorText(successResult(RATE_LIMITED, true))).toBe(RATE_LIMITED);
  });

  it("returns undefined for a genuine success", () => {
    expect(resultErrorText(successResult("a summary"))).toBeUndefined();
  });

  it("joins errors[] for the dedicated error subtypes", () => {
    expect(resultErrorText(errorResult("error_during_execution", ["boom", "bang"]))).toBe(
      "boom\nbang",
    );
  });

  // An empty message marks the turn errored with nothing to show the user.
  it("never returns an empty message for a failure", () => {
    expect(resultErrorText(successResult("", true))).toMatch(/\S/u);
    expect(resultErrorText(errorResult("error_max_budget_usd", []))).toMatch(/\S/u);
  });
});

// pi carries a failure only as errorMessage text, so whatever reacts to a rate limit
// pattern-matches it. These mirror pi-subagents' fallback gate: one pattern from its
// retryable list, and the tool-failure shape it refuses to retry.
const RATE_LIMIT = /rate\s*limit/iu;

const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:\(exit \d+\):|with exit code \d+)(?:\s|$)/iu;

describe("a rate-limited failure", () => {
  // Claude Code words a spent subscription with none of the vocabulary anyone matches
  // on, and sends the rejection as its own message just before the failure it caused.
  const rejection = (): SDKMessage =>
    rateLimitEvent({ status: "rejected", resetsAt: 1786141800, rateLimitType: "five_hour" });

  const OUT_OF_USAGE = "You're out of extra usage · resets 6:30pm (America/New_York)";

  it("is named as a rate limit so fallback chains fire", async () => {
    const { c } = openTurn();

    await consume(c, scripted([rejection(), successResult(OUT_OF_USAGE, true)]));

    const output = c.turnOutput;

    expect(output?.errorMessage).toMatch(RATE_LIMIT);
    expect(output?.errorMessage).not.toMatch(TOOL_FAILURE_PREFIX);
    // Claude Code's own wording, and which window ran out.
    expect(output?.errorMessage).toContain(OUT_OF_USAGE);
    expect(output?.errorMessage).toContain("five_hour");
    // A rejected window resets in hours: not retried as transient.
    expect(output === null ? undefined : isRetryableAssistantError(output)).toBe(false);
  });

  it("labels only the failure it caused, not a later one", async () => {
    const { c } = openTurn();

    await consume(c, scripted([rejection(), successResult(OUT_OF_USAGE, true), apiFailure()]));

    expect(c.turnOutput?.errorMessage).toBe(RATE_LIMITED);
  });

  it("leaves an unrelated failure alone", async () => {
    const { c } = openTurn();

    await consume(c, scripted([apiFailure()]));

    expect(c.turnOutput?.errorMessage).toBe(RATE_LIMITED);
  });
});

describe("error results", () => {
  it("mark the turn errored and finalize with an error event", async () => {
    const { c, pi } = openTurn();

    await consume(c, scripted([apiFailure()]));

    expect(c.turnOutput?.stopReason).toBe("error");
    expect(c.turnOutput?.errorMessage).toBe(RATE_LIMITED);

    finalizeCurrentStream(c);

    const terminal = pi.events.at(-1);

    expect(terminal?.type).toBe("error");
    expect(terminal?.type === "error" ? terminal.error.errorMessage : undefined).toBe(RATE_LIMITED);
    expect(pi.ended).toBe(true);
  });

  it("do not re-emit text the synthetic assistant message already delivered", async () => {
    const { c } = openTurn();

    await consume(c, scripted([syntheticReport(RATE_LIMITED), apiFailure()]));

    expect(text(c)).toBe(RATE_LIMITED);
  });

  // A consumer that fails over only before output commits, such as
  // pi-model-fallback-alias, commits on anything but a start or thinking event. If
  // Claude Code's own failure report counted as output, it could never fail over.
  it("keep a synthetic report off the stream, so failover is still possible", async () => {
    const { c, pi } = openTurn();

    await consume(c, scripted([syntheticReport(RATE_LIMITED), apiFailure()]));
    finalizeCurrentStream(c);

    const beforeTerminal = pi.events.slice(0, -1).map((event) => event.type);

    expect(
      beforeTerminal.filter((type) => type !== "start" && !type.startsWith("thinking_")),
    ).toEqual([]);
    expect(pi.events.at(-1)?.type).toBe("error");
    // The wording still reaches pi's transcript as the failed turn's content.
    expect(c.turnBlocks).toEqual([{ type: "text", text: RATE_LIMITED }]);
  });

  // A stalled stream whose non-streaming retry also failed: the report arrives while the
  // dead stream's unsigned thinking and undispatched tool call are still open. Left in,
  // pi would replay the abandoned call as one awaiting a result.
  it("drop the abandoned partial blocks of a stalled stream", async () => {
    const { c } = openTurn();

    await consume(
      c,
      scripted([
        messageStart("msg_stalled"),
        thinkingStart(0),
        thinkingDelta(0, "Let me look"),
        toolUseStart(1, "mcp__custom-tools__read", "toolu_dead"),
        inputJsonDelta(1, '{"pa'),
        syntheticReport(RATE_LIMITED),
        apiFailure(),
      ]),
    );

    expect(c.turnBlocks).toEqual([{ type: "text", text: RATE_LIMITED }]);
    expect(c.turnSawToolCall).toBe(false);
    expect(c.turnStreamOpen).toBe(false);
  });

  it("leave a successful result to stream and finalize normally", async () => {
    const { c, pi } = openTurn();

    await consume(c, scripted([successResult("done")]));

    expect(c.turnOutput?.stopReason).toBe("stop");
    expect(c.turnOutput?.errorMessage).toBeUndefined();
    expect(c.turnBlocks).toEqual([{ type: "text", text: "done" }]);

    finalizeCurrentStream(c);

    expect(pi.events.at(-1)?.type).toBe("done");
  });

  // A turn that ended on a tool call has already closed its pi stream. The failure a
  // later result carries is the only record that the turn failed at all.
  it("are recorded when they arrive after the turn ended on a tool call", async () => {
    const { c } = openTurn();

    c.currentPiStream = null;

    await consume(c, scripted([apiFailure()]));

    expect(c.turnOutput?.stopReason).toBe("error");
    expect(c.turnOutput?.errorMessage).toBe(RATE_LIMITED);
  });

  it("report the dedicated error subtypes", async () => {
    const { c } = openTurn();

    await consume(c, scripted([errorResult("error_max_turns", ["hit the cap"])]));

    expect(c.turnOutput?.stopReason).toBe("error");
    expect(c.turnOutput?.errorMessage).toBe("hit the cap");
  });
});

// Nothing else closes stdin for a streamed prompt, so a result that skipped it would
// leave the query hanging, including after a tool call ended the pi turn.
it("closes Claude Code's input on a result, even with no pi stream left", async () => {
  const { c } = openTurn();
  const promptStream = makePromptStream();

  c.promptStream = promptStream;
  c.currentPiStream = null;

  await consume(c, scripted([successResult("done")]));

  await expect(promptStream.push(userMessage("too late"))).rejects.toThrow("prompt stream closed");
  await expect(promptStream.stream.next()).resolves.toEqual({ done: true, value: undefined });
});

// The fixtures are verbatim message sequences from live Claude Code turns, so they cover
// shapes nobody would hand-write, like `system/status` frames and the rate_limit_event
// every turn carries. Re-record on an SDK bump and the diff is the contract change.
describe("a recorded stream", () => {
  async function replay(
    name: RecordedStream,
    toPi: ReadonlyMap<string, string> = served("read"),
  ): Promise<{ c: QueryContext; pi: RecordingStream; sessionId: string | undefined }> {
    const { c, pi } = openTurn();
    const { sessionId } = await consume(c, scripted(recordedStream(name)), toPi);

    return { c, pi, sessionId };
  }

  it("of a text-only turn produces its text and a clean stop", async () => {
    const { c, pi } = await replay("text");

    expect(text(c).trim()).toBe("ALPHA");
    expect(c.turnOutput?.stopReason).toBe("stop");
    expect(c.turnSawToolCall).toBe(false);
    expect(pi.events.some((event) => event.type === "text_delta")).toBe(true);
  });

  it("reports usage and yields Claude Code's session id", async () => {
    const { c, sessionId } = await replay("text");
    const usage = c.turnOutput?.usage;

    expect(usage?.output).toBeGreaterThan(0);
    expect(
      (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
    ).toBeGreaterThan(0);
    expect(sessionId).toMatch(/^[\da-f-]{36}$/u);
  });

  /** Every thinking-token count in the stream's usage frames, in stream order. */
  function thinkingTokenCounts(messages: readonly SDKMessage[]): number[] {
    return messages.flatMap((message) => {
      let count: number | null | undefined;

      if (message.type === "assistant") {
        count = message.message.usage.output_tokens_details?.thinking_tokens;
      } else if (message.type === "stream_event" && message.event.type === "message_start") {
        count = message.event.message.usage.output_tokens_details?.thinking_tokens;
      } else if (message.type === "stream_event" && message.event.type === "message_delta") {
        count = message.event.usage.output_tokens_details?.thinking_tokens;
      }

      return count === null || count === undefined ? [] : [count];
    });
  }

  // The count this pi turn ends on is the first in the stream: a recording that ends on
  // a tool call spans several cycles, and every cycle after the first tool-call boundary
  // belongs to the next pi turn.
  it.each<RecordedStream>(["text", "single-tool", "parallel-tools"])(
    "of the %s turn surfaces its thinking tokens as usage.reasoning",
    async (name) => {
      const { c } = await replay(name);
      const [expected] = thinkingTokenCounts(recordedStream(name));

      expect(expected).toBeGreaterThan(0);
      expect(c.turnOutput?.usage.reasoning).toBe(expected);
      // The SDK documents thinking_tokens as a subset of output_tokens.
      expect(expected).toBeLessThanOrEqual(c.turnOutput?.usage.output ?? 0);
    },
  );

  it("ignores counts from cycles that belong to the next pi turn", async () => {
    const counts = thinkingTokenCounts(recordedStream("single-tool"));
    const { c } = await replay("single-tool");

    expect(counts.length).toBeGreaterThan(1);
    expect(new Set(counts).size).toBeGreaterThan(1);
    expect(c.turnOutput?.stopReason).toBe("toolUse");
    expect(c.turnOutput?.usage.reasoning).toBe(counts[0]);
  });

  it("of a single-tool turn surfaces the call under its pi name and ends the turn on it", async () => {
    const { c } = await replay("single-tool");
    const calls = toolCalls(c);

    expect(calls.map((call) => call.name)).toEqual(["read"]);
    expect(calls[0]?.id).toMatch(/^toolu_/u);
    expect(c.turnSawToolCall).toBe(true);
    expect(c.turnToolCallIds).toEqual(calls.map((call) => call.id));
  });

  it("of a parallel-tool turn keeps every call, in emission order", async () => {
    const { c } = await replay("parallel-tools");
    const calls = toolCalls(c);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Routing ids must match the emitted calls, in order, without duplicates.
    expect(c.turnToolCallIds).toEqual(calls.map((call) => call.id));
    expect(new Set(c.turnToolCallIds).size).toBe(calls.length);
    expect(new Set(calls.map((call) => call.name))).toEqual(new Set(["read"]));
  });

  // The names Claude Code really sends must be the ones the served map is keyed on.
  it("leaves nothing for pi when the served tool list is empty", async () => {
    const { c } = await replay("parallel-tools", served());

    expect(toolCalls(c)).toEqual([]);
    expect(c.turnSawToolCall).toBe(false);
  });
});

describe("rate-limit notices", () => {
  it("announce a rejection with its window", async () => {
    const { c } = openTurn();

    const info: SDKRateLimitInfo = {
      status: "rejected",
      resetsAt: 1786141800,
      rateLimitType: "five_hour",
    };

    const { notices } = await consume(c, scripted([rateLimitEvent(info)]));

    expect(notices).toEqual([
      `Claude subscription rate limit reached (five_hour); resets at ${new Date(1786141800 * 1000).toLocaleTimeString()}`,
    ]);
    expect(c.rateLimitRejection).toEqual({ rateLimitType: "five_hour", resetsAt: 1786141800 });
  });
});
