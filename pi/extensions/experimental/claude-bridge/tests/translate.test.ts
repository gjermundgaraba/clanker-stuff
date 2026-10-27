// Claude Code's messages mapped onto one pi turn. Recorded streams cover the shapes live
// Claude Code emits; hand-built ones cover what cannot be recorded on demand: a stall, a
// cut inside a tool call, a hallucinated tool name, a failure report.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import { resolveServedTools } from "../tools.js";
import { mapStopReason, Turn } from "../translate.js";
import type { TurnBlock } from "../translate.js";
import {
  assistantMessage,
  blockStop,
  errorResult,
  inputJsonDelta,
  messageDelta,
  messageStart,
  messageStop,
  recordedStream,
  recordingStream,
  successResult,
  syntheticReport,
  textBlock,
  textDelta,
  textStart,
  thinkingDelta,
  thinkingStart,
  toolUseStart,
} from "./fixtures/sdk.js";
import type { RecordedStream, RecordingStream } from "./fixtures/sdk.js";
import { testModel } from "./helpers.js";

const model = testModel();

const served = (...names: string[]): ReadonlySet<string> =>
  resolveServedTools(
    names.map((name) => ({
      name,
      description: name,
      parameters: Type.Object({}),
    }))
  ).names;

const BASH = "mcp__custom-tools__bash";

const NOTIFY = "mcp__custom-tools__notify_parent";

const READ = "mcp__custom-tools__read";

/** What the conversation machine does with each message for the turn it owns. A failed
 *  result fails the turn; a successful one delivers its text and finishes it. */
const feed = (turn: Turn, messages: readonly SDKMessage[]): void => {
  for (const message of messages) {
    if (message.type === "stream_event") {
      turn.streamEvent(message);
    } else if (message.type === "assistant") {
      turn.assistantMessage(message);
    } else if (message.type === "result") {
      if (message.subtype !== "success") {
        turn.fail(message.errors.join("\n"));
      } else if (message.is_error) {
        turn.fail(message.result);
      } else {
        turn.result(message);
        turn.finish();
      }
    }
  }
};

const open = (toPi: ReadonlySet<string> = served("read")) => {
  const pi = recordingStream();

  return { turn: new Turn(model, pi.stream, toPi), pi };
};

const run = (
  messages: readonly SDKMessage[],
  toPi?: ReadonlySet<string>
): { turn: Turn; pi: RecordingStream } => {
  const opened = open(toPi);

  feed(opened.turn, messages);

  return opened;
};

const describeBlock = (block: TurnBlock): Array<string | JsonObject> =>
  block.type === "toolCall"
    ? [block.type, block.id, block.arguments]
    : [block.type];

const terminalTypes = (pi: RecordingStream): string[] =>
  pi.events.flatMap((event) =>
    event.type === "done" || event.type === "error" ? [event.type] : []
  );

const text = (turn: Turn): string =>
  turn.output.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

const toolCalls = (turn: Turn) =>
  turn.output.content.filter((block) => block.type === "toolCall");

// Got as far as a thinking block and the start of a tool call, then stalled: no
// content_block_stop, no message_stop.
const stalledStream = (id: string): SDKMessage[] => [
  messageStart(id),
  thinkingStart(0),
  thinkingDelta(0, "Let me look"),
  toolUseStart(1, BASH, "toolu_dead"),
  inputJsonDelta(1, '{"comm'),
];

// Claude Code repeats the request without streaming; the answer arrives as one
// assistant message under a new id, with no stream events of its own.
const fallback = (id: string): SDKMessage =>
  assistantMessage(id, [
    { type: "thinking", thinking: "Let me look at both.", signature: "sig" },
    textBlock("Reading the log."),
    { type: "tool_use", name: BASH, id: "toolu_a", input: { command: "ls" } },
    {
      type: "tool_use",
      name: BASH,
      id: "toolu_b",
      input: { command: "pwd" },
    },
  ]);

describe("a non-streaming fallback after a stalled stream", () => {
  it("delivers the fallback's tool calls and ends the pi turn on them", () => {
    const { turn, pi } = run(
      [...stalledStream("msg_dead"), fallback("msg_fallback")],
      served("bash")
    );

    expect(turn.toolCallIds).toStrictEqual(["toolu_a", "toolu_b"]);
    expect(turn.output.stopReason).toBe("toolUse");
    expect(turn.ended).toBe(true);
    expect(terminalTypes(pi)).toStrictEqual(["done"]);
    expect(pi.ended).toBe(true);
  });

  it("drops the dead stream's partial blocks instead of replaying them", () => {
    const { turn } = run(
      [...stalledStream("msg_dead"), fallback("msg_fallback")],
      served("bash")
    );

    expect(turn.output.content.map((block) => block.type)).toStrictEqual([
      "thinking",
      "text",
      "toolCall",
      "toolCall",
    ]);
    expect(turn.output.content[0]).toStrictEqual({
      type: "thinking",
      thinking: "Let me look at both.",
      thinkingSignature: "sig",
    });
  });

  it("drops the dead stream when Claude Code retries it as a new stream", () => {
    const { turn } = run(
      [
        ...stalledStream("msg_dead"),
        messageStart("msg_retry"),
        toolUseStart(0, BASH, "toolu_retry"),
        inputJsonDelta(0, '{"command":"ls"}'),
        blockStop(0),
        messageStop(),
      ],
      served("bash")
    );

    expect(turn.output.content.map(describeBlock)).toStrictEqual([
      ["toolCall", "toolu_retry", { command: "ls" }],
    ]);
    expect(turn.output.stopReason).toBe("toolUse");
  });

  it("still skips the assistant message that repeats a completed stream", () => {
    const { turn } = run([
      messageStart("msg_1"),
      textStart(0),
      textDelta(0, "hi"),
      blockStop(0),
      assistantMessage("msg_1", [textBlock("hi")]),
      messageStop(),
    ]);

    expect(turn.output.content).toStrictEqual([{ type: "text", text: "hi" }]);
  });
});

const cutInsideToolInput = (id: string): SDKMessage[] => [
  messageStart(id),
  textStart(0),
  textDelta(0, "Reporting both fixes now."),
  blockStop(0),
  toolUseStart(1, NOTIFY, "toolu_cut"),
  messageStop(),
];

// A stream cut off inside a tool call's input: the block started, so its name and id are
// known, and then nothing. Claude Code drops the block from its own conversation and
// resumes the turn under a new message and tool_use id. Dispatching the half-built call
// sent pi `{}` under an id no MCP handler would ever claim, while Claude Code's resumed
// call waited on a handler pi never answered.
describe("a tool call whose content_block_stop never arrived", () => {
  it("is not dispatched to pi, and does not end pi's turn", () => {
    const { turn, pi } = run(
      cutInsideToolInput("msg_cut"),
      served("notify_parent")
    );

    // Only the unfinished block goes; the text closed, and Claude Code keeps it too.
    expect(turn.output.content.map(describeBlock)).toStrictEqual([["text"]]);
    expect(turn.output.stopReason).not.toBe("toolUse");
    expect(turn.toolCallIds).toStrictEqual([]);
    // Left open on purpose: Claude Code's resume is more of this same pi turn.
    expect(turn.ended).toBe(false);
    expect(terminalTypes(pi)).toStrictEqual([]);
    expect(pi.ended).toBe(false);
  });

  it("is replaced by the resumed message's call, which ends the turn", () => {
    const { turn, pi } = run(
      [
        ...cutInsideToolInput("msg_cut"),
        messageStart("msg_resumed"),
        toolUseStart(0, NOTIFY, "toolu_resumed"),
        inputJsonDelta(0, '{"summary":"Both fixes done."}'),
        blockStop(0),
        messageStop(),
      ],
      served("notify_parent")
    );

    expect(turn.output.content.map(describeBlock)).toStrictEqual([
      ["text"],
      ["toolCall", "toolu_resumed", { summary: "Both fixes done." }],
    ]);
    expect(turn.toolCallIds).toStrictEqual(["toolu_resumed"]);
    expect(turn.output.stopReason).toBe("toolUse");
    expect(terminalTypes(pi)).toStrictEqual(["done"]);
    expect(pi.ended).toBe(true);
  });

  it("is replaced by a resume that arrives as an assistant message instead", () => {
    const { turn } = run(
      [
        ...cutInsideToolInput("msg_cut"),
        assistantMessage("msg_resumed", [
          {
            type: "tool_use",
            name: NOTIFY,
            id: "toolu_resumed",
            input: { summary: "Both fixes done." },
          },
        ]),
      ],
      served("notify_parent")
    );

    expect(turn.output.content.map(describeBlock)).toStrictEqual([
      ["text"],
      ["toolCall", "toolu_resumed", { summary: "Both fixes done." }],
    ]);
    expect(turn.output.stopReason).toBe("toolUse");
    expect(turn.ended).toBe(true);
  });

  // Dropping the whole message would throw away a call Claude Code kept and dispatched:
  // the same deadlock the other way round.
  it("leaves a sibling call that did close to be dispatched", () => {
    const { turn } = run(
      [
        messageStart("msg_pair"),
        toolUseStart(0, NOTIFY, "toolu_first"),
        inputJsonDelta(0, '{"summary":"First."}'),
        blockStop(0),
        toolUseStart(1, NOTIFY, "toolu_cut"),
        inputJsonDelta(1, '{"summ'),
        messageStop(),
      ],
      served("notify_parent")
    );

    expect(turn.output.content.map(describeBlock)).toStrictEqual([
      ["toolCall", "toolu_first", { summary: "First." }],
    ]);
    expect(turn.toolCallIds).toStrictEqual(["toolu_first"]);
    expect(turn.output.stopReason).toBe("toolUse");
    expect(turn.ended).toBe(true);
  });

  // pi renders a call's arguments as they stream.
  it("parses the arguments streamed so far", () => {
    const { turn } = run(
      [
        messageStart("msg_1"),
        toolUseStart(0, NOTIFY, "toolu_1"),
        inputJsonDelta(0, '{"summary":"Bo'),
      ],
      served("notify_parent")
    );

    expect(turn.output.content.map(describeBlock)).toStrictEqual([
      ["toolCall", "toolu_1", { summary: "Bo" }],
    ]);
  });

  // Negative control: refusing to dispatch anything at all passes every case above.
  it("still dispatches a tool call that does close, with its full arguments", () => {
    const { turn, pi } = run(
      [
        messageStart("msg_whole"),
        textStart(0),
        textDelta(0, "Reporting now."),
        blockStop(0),
        toolUseStart(1, NOTIFY, "toolu_whole"),
        inputJsonDelta(1, '{"summary":'),
        inputJsonDelta(1, '"Both fixes done."}'),
        blockStop(1),
        messageStop(),
      ],
      served("notify_parent")
    );

    expect(turn.output.content.map(describeBlock)).toStrictEqual([
      ["text"],
      ["toolCall", "toolu_whole", { summary: "Both fixes done." }],
    ]);
    expect(turn.toolCallIds).toStrictEqual(["toolu_whole"]);
    expect(turn.output.stopReason).toBe("toolUse");
    expect(pi.events.at(-1)?.type).toBe("done");
  });
});

describe("completed tool-call arguments", () => {
  it.each(["streamed", "whole"])(
    "preserves a custom tool's declared parameters in a %s response",
    (mode) => {
      const tool = {
        name: "read",
        description: "Read a field from a file.",
        parameters: Type.Object({
          file_path: Type.String(),
          path: Type.String(),
        }),
      };

      const input = { file_path: "config.json", path: "settings.theme" };

      const messages =
        mode === "streamed"
          ? [
              messageStart("msg_custom"),
              toolUseStart(0, READ, "toolu_custom"),
              inputJsonDelta(0, JSON.stringify(input)),
              blockStop(0),
              messageStop(),
            ]
          : [
              assistantMessage("msg_custom", [
                { type: "tool_use", name: READ, id: "toolu_custom", input },
              ]),
            ];

      const { turn } = run(messages, resolveServedTools([tool]).names);
      const [call] = toolCalls(turn);

      if (call === undefined) {
        throw new Error("Missing completed tool call");
      }

      expect(call.arguments).toStrictEqual(input);
      expect(() => {
        validateToolArguments(tool, call);
      }).not.toThrow();
    }
  );

  it.each(['{"summary":"kept","other":', "[]", "null"])(
    "reports malformed final input instead of executing its parsed prefix: %s",
    (json) => {
      const { turn, pi } = run(
        [
          messageStart("msg_invalid"),
          toolUseStart(0, NOTIFY, "toolu_invalid"),
          inputJsonDelta(0, json),
          blockStop(0),
          messageStop(),
        ],
        served("notify_parent")
      );

      const [call] = toolCalls(turn);

      if (call === undefined) {
        throw new Error("Missing completed tool call");
      }

      expect(call.arguments).toStrictEqual({});
      expect(call.argumentsError).toContain(`Received arguments:\n${json}`);
      expect(
        pi.events.find((event) => event.type === "toolcall_end")
      ).toMatchObject({
        toolCall: call,
      });
      // Even a schema accepting {} must reject the malformed call before execution.
      expect(() => {
        validateToolArguments(
          {
            name: "notify_parent",
            description: "",
            parameters: Type.Object({}),
          },
          call
        );
      }).toThrow(`Received arguments:\n${json}`);
    }
  );

  it("repairs invalid escapes in complete arguments", () => {
    const { turn } = run([
      messageStart("msg_repaired"),
      toolUseStart(0, READ, "toolu_repaired"),
      inputJsonDelta(0, String.raw`{"path":"\usepackage","limit":7}`),
      blockStop(0),
      messageStop(),
    ]);

    const [call] = toolCalls(turn);

    expect(call?.arguments).toStrictEqual({
      path: String.raw`\usepackage`,
      limit: 7,
    });
    expect(call?.argumentsError).toBeUndefined();
  });

  it("keeps initial input when no JSON deltas arrive", () => {
    const start = toolUseStart(0, READ, "toolu_initial");

    start.event = {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_initial",
        name: READ,
        input: { path: "initial.txt" },
      },
    };

    const { turn } = run([
      messageStart("msg_initial"),
      start,
      blockStop(0),
      messageStop(),
    ]);

    expect(toolCalls(turn)[0]?.arguments).toStrictEqual({
      path: "initial.txt",
    });
  });
});

// pi runs no tool call from a truncated response; a cut-off call's arguments are whatever
// JSON survived, which would otherwise run as if complete.
describe("a tool call cut off at the output limit", () => {
  it("ends the turn as truncated, not on the call", () => {
    const { turn, pi } = run(
      [
        messageStart("msg_1"),
        toolUseStart(0, NOTIFY, "toolu_1"),
        inputJsonDelta(0, '{"summary":"only the first'),
        blockStop(0),
        messageDelta("max_tokens"),
        messageStop(),
      ],
      served("notify_parent")
    );

    expect(turn.output.stopReason).toBe("length");
    expect(pi.events.at(-1)).toMatchObject({ type: "done", reason: "length" });
  });

  it("ends the turn as truncated when the response arrived whole", () => {
    const whole = assistantMessage("msg_1", [
      {
        type: "tool_use",
        id: "toolu_1",
        name: NOTIFY,
        input: { summary: "only the first" },
      },
    ]);

    const { pi } = run(
      [
        {
          ...whole,
          message: { ...whole.message, stop_reason: "max_tokens" as const },
        },
      ],
      served("notify_parent")
    );

    expect(pi.events.at(-1)).toMatchObject({ type: "done", reason: "length" });
  });
});

const textOnly = (messages: readonly SDKMessage[]) => {
  const pi = recordingStream();
  const turn = new Turn(model, pi.stream, served(), { requireText: true });

  feed(turn, messages);

  return pi;
};

describe("a turn that must answer in text", () => {
  // An empty summary would let compaction drop context with nothing in its place.
  it("fails without text", () => {
    expect(textOnly([successResult("  ")]).events.at(-1)).toMatchObject({
      type: "error",
      error: { errorMessage: "Claude Code returned no text" },
    });
  });

  it("answers with text", () => {
    expect(
      textOnly([successResult("the summary")]).events.at(-1)
    ).toMatchObject({
      type: "done",
      reason: "stop",
    });
  });
});

const toolUseTurn = (name: string, id: string): SDKMessage[] => [
  toolUseStart(0, name, id),
  inputJsonDelta(0, '{"command":"ls"}'),
  blockStop(0),
  messageStop(),
];

// Claude sometimes calls a Claude Code builtin by its bare name. The query runs with
// `tools: []`, so Claude Code rejects such a call itself and retries under a fresh
// tool_use id without dispatching to our MCP server. Forwarding it ran a tool Claude
// Code never asked for, and pi's result, keyed to the dead id, never released the
// retry's handler.
describe("tool_use for a tool we do not serve", () => {
  it("is skipped, and only the retry under the served name reaches pi", () => {
    const { turn } = run(
      [
        ...toolUseTurn("bash", "toolu_phantom"),
        ...toolUseTurn(BASH, "toolu_retry"),
      ],
      served("bash")
    );

    expect(turn.output.content.map(describeBlock)).toStrictEqual([
      ["toolCall", "toolu_retry", { command: "ls" }],
    ]);
    expect(turn.toolCallIds).toStrictEqual(["toolu_retry"]);
  });

  it("does not end the pi stream, so the turn continues into the retry", () => {
    const { turn, pi } = run(
      toolUseTurn("Bash", "toolu_phantom"),
      served("bash")
    );

    expect(turn.output.content).toStrictEqual([]);
    expect(turn.ended).toBe(false);
    expect(terminalTypes(pi)).toStrictEqual([]);
    expect(pi.ended).toBe(false);
  });

  // The assistant-message path has to make the same call, or the deadlock comes back
  // through the other door.
  it("is skipped on the assistant-message path too", () => {
    const { turn } = run(
      [
        assistantMessage("msg_1", [
          {
            type: "tool_use",
            name: "bash",
            id: "toolu_phantom",
            input: { command: "ls" },
          },
          {
            type: "tool_use",
            name: BASH,
            id: "toolu_retry",
            input: { command: "ls" },
          },
        ]),
      ],
      served("bash")
    );

    expect(turn.output.content.map(describeBlock)).toStrictEqual([
      ["toolCall", "toolu_retry", { command: "ls" }],
    ]);
  });
});

// Claude Code reports API failures (429 capacity, overload, prompt-too-long) as a result
// with is_error set while the subtype stays "success".
const RATE_LIMITED =
  "API Error: Server is temporarily limiting requests (not your usage limit): Rate limited";

describe("a failed turn", () => {
  it("ends the stream with an error event carrying the failure", () => {
    const { turn, pi } = run([successResult(RATE_LIMITED, true)]);

    expect(turn.output.stopReason).toBe("error");
    expect(turn.output.errorMessage).toBe(RATE_LIMITED);

    const terminal = pi.events.at(-1);

    expect(terminal?.type).toBe("error");
    expect(
      terminal?.type === "error" ? terminal.error.errorMessage : undefined
    ).toBe(RATE_LIMITED);
    expect(pi.ended).toBe(true);
  });

  it("reports the dedicated error subtypes", () => {
    const { turn } = run([errorResult("error_max_turns", ["hit the cap"])]);

    expect(turn.output.stopReason).toBe("error");
    expect(turn.output.errorMessage).toBe("hit the cap");
  });

  it("ends with an aborted event when it was aborted", () => {
    const { turn, pi } = open();

    turn.fail("Operation aborted", "aborted");

    const terminal = pi.events.at(-1);

    expect(terminal?.type === "error" ? terminal.reason : undefined).toBe(
      "aborted"
    );
    expect(turn.output.stopReason).toBe("aborted");
  });

  it("does not re-emit text the synthetic assistant message already carried", () => {
    const { turn } = run([
      syntheticReport(RATE_LIMITED),
      successResult(RATE_LIMITED, true),
    ]);

    expect(text(turn)).toBe(RATE_LIMITED);
  });

  // A consumer that fails over only before output commits, such as
  // pi-model-fallback-alias, commits on anything but a start or thinking event. If
  // Claude Code's own failure report counted as output, it could never fail over.
  it("keeps a synthetic report off the stream, so failover is still possible", () => {
    const { turn, pi } = run([
      syntheticReport(RATE_LIMITED),
      successResult(RATE_LIMITED, true),
    ]);

    const beforeTerminal = pi.events.slice(0, -1).map((event) => event.type);

    expect(
      beforeTerminal.filter(
        (type) => type !== "start" && !type.startsWith("thinking_")
      )
    ).toStrictEqual([]);
    expect(pi.events.at(-1)?.type).toBe("error");
    // The wording still reaches pi's transcript as the failed turn's content.
    expect(turn.output.content).toStrictEqual([
      { type: "text", text: RATE_LIMITED },
    ]);
  });

  // A stalled stream whose non-streaming retry also failed: the report arrives while the
  // dead stream's unsigned thinking and undispatched tool call are still open. Left in,
  // pi would replay the abandoned call as one awaiting a result.
  it("drops the abandoned partial blocks of a stalled stream", () => {
    const { turn } = run([
      messageStart("msg_stalled"),
      thinkingStart(0),
      thinkingDelta(0, "Let me look"),
      toolUseStart(1, READ, "toolu_dead"),
      inputJsonDelta(1, '{"pa'),
      syntheticReport(RATE_LIMITED),
      successResult(RATE_LIMITED, true),
    ]);

    expect(turn.output.content).toStrictEqual([
      { type: "text", text: RATE_LIMITED },
    ]);
    expect(turn.toolCallIds).toStrictEqual([]);
    expect(turn.output.stopReason).toBe("error");
  });
});

describe("a result's text", () => {
  it("is the answer when nothing else delivered one", () => {
    const { turn, pi } = run([successResult("done")]);

    expect(turn.output.stopReason).toBe("stop");
    expect(turn.output.errorMessage).toBeUndefined();
    expect(turn.output.content).toStrictEqual([{ type: "text", text: "done" }]);
    expect(pi.events.at(-1)?.type).toBe("done");
  });

  // Claude Code repeats the final text in the result after an assistant message that
  // arrived without stream events already delivered it.
  it("is not delivered again after an assistant message carried it", () => {
    const { turn, pi } = run([
      assistantMessage("msg_1", [textBlock("Hello")]),
      successResult("Hello"),
    ]);

    expect(turn.output.content).toStrictEqual([
      { type: "text", text: "Hello" },
    ]);
    expect(
      pi.events
        .filter((event) => event.type.startsWith("text_"))
        .map((event) => event.type)
    ).toStrictEqual(["text_start", "text_delta", "text_end"]);
  });

  it("is delivered after a turn that streamed only thinking", () => {
    const { turn } = run([
      messageStart("msg_1"),
      thinkingStart(0),
      thinkingDelta(0, "hmm"),
      blockStop(0),
      messageStop(),
      successResult("the answer"),
    ]);

    expect(turn.output.content.map(describeBlock)).toStrictEqual([
      ["thinking"],
      ["text"],
    ]);
    expect(text(turn)).toBe("the answer");
  });

  it("adds nothing when it is empty", () => {
    const { turn } = run([successResult("")]);

    expect(turn.output.content).toStrictEqual([]);
  });

  // A response that arrived whole had no message_delta to say it was cut off; pi refuses
  // to keep a truncated summary only if it learns so.
  it.each(["max_tokens", "model_context_window_exceeded"])(
    "reports a %s cut-off it carries for a response that arrived whole",
    (stopReason) => {
      const { pi } = run([
        assistantMessage("msg_1", [textBlock("half an ans")]),
        { ...successResult("half an ans"), stop_reason: stopReason },
      ]);

      expect(pi.events.at(-1)).toMatchObject({
        type: "done",
        reason: "length",
      });
    }
  );
});

describe("mapStopReason", () => {
  it("maps Claude Code's stop reasons onto pi's", () => {
    expect(mapStopReason("tool_use")).toBe("toolUse");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("model_context_window_exceeded")).toBe("length");
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason(null)).toBe("stop");
  });
});

const replay = (
  name: RecordedStream,
  toPi: ReadonlySet<string> = served("read")
) => run(recordedStream(name), toPi);

/** Every thinking-token count in the stream's usage frames, in stream order. */
const thinkingTokenCounts = (messages: readonly SDKMessage[]): number[] =>
  messages.flatMap((message) => {
    let count: number | null | undefined;

    if (message.type === "assistant") {
      count = message.message.usage.output_tokens_details?.thinking_tokens;
    } else if (
      message.type === "stream_event" &&
      message.event.type === "message_start"
    ) {
      count =
        message.event.message.usage.output_tokens_details?.thinking_tokens;
    } else if (
      message.type === "stream_event" &&
      message.event.type === "message_delta"
    ) {
      count = message.event.usage.output_tokens_details?.thinking_tokens;
    }

    return count === null || count === undefined ? [] : [count];
  });

// The fixtures are verbatim message sequences from live Claude Code turns, so they cover
// shapes nobody would hand-write, like `system/status` frames and the rate_limit_event
// every turn carries. Re-record on an SDK bump and the diff is the contract change.
describe("a recorded stream", () => {
  it("of a text-only turn produces its text and a clean stop", () => {
    const { turn, pi } = replay("text");

    expect(text(turn).trim()).toBe("ALPHA");
    expect(turn.output.stopReason).toBe("stop");
    expect(turn.toolCallIds).toStrictEqual([]);
    expect(pi.events.some((event) => event.type === "text_delta")).toBe(true);
    expect(pi.events.at(-1)?.type).toBe("done");
  });

  it("reports usage", () => {
    const { usage } = replay("text").turn.output;

    expect(usage.output).toBeGreaterThan(0);
    expect(usage.input + usage.cacheRead + usage.cacheWrite).toBeGreaterThan(0);
  });

  // The count this pi turn ends on is the first in the stream: a recording that ends on
  // a tool call spans several cycles, and every cycle after the first tool-call boundary
  // belongs to the next pi turn.
  it.each<RecordedStream>(["text", "single-tool", "parallel-tools"])(
    "of the %s turn surfaces its thinking tokens as usage.reasoning",
    (name) => {
      const { turn } = replay(name);
      const [expected] = thinkingTokenCounts(recordedStream(name));

      expect(expected).toBeGreaterThan(0);
      expect(turn.output.usage.reasoning).toBe(expected);
      // The SDK documents thinking_tokens as a subset of output_tokens.
      expect(expected).toBeLessThanOrEqual(turn.output.usage.output);
    }
  );

  it("ignores counts from cycles that belong to the next pi turn", () => {
    const counts = thinkingTokenCounts(recordedStream("single-tool"));
    const { turn } = replay("single-tool");

    expect(counts.length).toBeGreaterThan(1);
    expect(new Set(counts).size).toBeGreaterThan(1);
    expect(turn.output.stopReason).toBe("toolUse");
    expect(turn.output.usage.reasoning).toBe(counts[0]);
  });

  it("of a single-tool turn surfaces the call under its pi name and ends the turn on it", () => {
    const { turn, pi } = replay("single-tool");
    const calls = toolCalls(turn);

    expect(calls.map((call) => call.name)).toStrictEqual(["read"]);
    expect(calls[0]?.id).toMatch(/^toolu_/u);
    expect(turn.toolCallIds).toStrictEqual(calls.map((call) => call.id));
    expect(terminalTypes(pi)).toStrictEqual(["done"]);
  });

  it("of a parallel-tool turn keeps every call, in emission order", () => {
    const { turn } = replay("parallel-tools");
    const calls = toolCalls(turn);

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(turn.toolCallIds).toStrictEqual(calls.map((call) => call.id));
    expect(new Set(turn.toolCallIds).size).toBe(calls.length);
    expect(new Set(calls.map((call) => call.name))).toStrictEqual(
      new Set(["read"])
    );
  });

  // The names Claude Code really sends must be the ones the served map is keyed on.
  it("leaves nothing for pi when the served tool list is empty", () => {
    const { turn } = replay("parallel-tools", served());

    expect(toolCalls(turn)).toStrictEqual([]);
  });
});
