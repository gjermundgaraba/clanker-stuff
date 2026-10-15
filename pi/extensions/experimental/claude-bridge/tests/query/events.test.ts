// Claude Code's stream mapped onto pi's turn, driven through the real consumeQuery. The
// streams here are hand-built on purpose: a stall, a cut inside a tool call and a
// hallucinated tool name cannot be recorded on demand.

import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { consumeQuery } from "../../query/consume.js";
import { QueryContext } from "../../query/context.js";
import type { TurnBlock } from "../../query/context.js";
import { resolveServedTools } from "../../tools.js";
import {
  recordingStream,
  assistantMessage,
  blockStop,
  inputJsonDelta,
  messageStart,
  messageStop,
  textBlock,
  textDelta,
  textStart,
  thinkingDelta,
  thinkingStart,
  toolUseStart,
} from "../fixtures/sdk.js";
import type { RecordingStream } from "../fixtures/sdk.js";
import { createFakeQuery, testModel } from "../helpers.js";

const model = testModel();

const served = (...names: string[]): ReadonlyMap<string, string> =>
  resolveServedTools(
    names.map((name) => ({ name, description: name, parameters: Type.Object({}) })),
  ).toPi;

const BASH = "mcp__custom-tools__bash";

// notify_parent rather than bash where arguments matter: bash gains a default timeout,
// which has nothing to do with the block lifecycle under test.
const NOTIFY = "mcp__custom-tools__notify_parent";

function openTurn(): { c: QueryContext; pi: RecordingStream } {
  const c = new QueryContext();
  const pi = recordingStream();

  c.currentPiStream = pi.stream;
  c.resetTurnState(model);

  return { c, pi };
}

async function consume(
  c: QueryContext,
  messages: readonly SDKMessage[],
  toPi: ReadonlyMap<string, string>,
): Promise<void> {
  const query = createFakeQuery({ prompt: "", options: {} });

  for (const message of messages) query.push(message);

  query.end();
  await consumeQuery(
    query,
    toPi,
    model,
    () => false,
    c,
    () => {},
  );
}

const describeBlock = (block: TurnBlock): (string | JsonObject)[] =>
  block.type === "toolCall" ? [block.type, block.id, block.arguments] : [block.type];

const terminalTypes = (pi: RecordingStream): string[] =>
  pi.events.flatMap((event) =>
    event.type === "done" || event.type === "error" ? [event.type] : [],
  );

describe("a non-streaming fallback after a stalled stream", () => {
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
      { type: "tool_use", name: BASH, id: "toolu_b", input: { command: "pwd" } },
    ]);

  it("delivers the fallback's tool calls and ends the pi turn on them", async () => {
    const { c, pi } = openTurn();

    await consume(c, [...stalledStream("msg_dead"), fallback("msg_fallback")], served("bash"));

    expect(c.turnBlocks.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))).toEqual([
      "toolu_a",
      "toolu_b",
    ]);
    expect(c.turnToolCallIds).toEqual(["toolu_a", "toolu_b"]);
    expect(c.turnOutput?.stopReason).toBe("toolUse");
    expect(c.currentPiStream).toBeNull();
    expect(pi.events.at(-1)?.type).toBe("done");
    expect(pi.ended).toBe(true);
  });

  it("drops the dead stream's partial blocks instead of replaying them", async () => {
    const { c } = openTurn();

    await consume(c, [...stalledStream("msg_dead"), fallback("msg_fallback")], served("bash"));

    expect(c.turnBlocks.map((block) => block.type)).toEqual([
      "thinking",
      "text",
      "toolCall",
      "toolCall",
    ]);
    expect(c.turnBlocks[0]).toEqual({
      type: "thinking",
      thinking: "Let me look at both.",
      thinkingSignature: "sig",
    });
    expect(c.openBlocks.size).toBe(0);
  });

  it("drops the dead stream when Claude Code retries it as a new stream", async () => {
    const { c } = openTurn();

    await consume(
      c,
      [
        ...stalledStream("msg_dead"),
        messageStart("msg_retry"),
        toolUseStart(0, BASH, "toolu_retry"),
        inputJsonDelta(0, '{"command":"ls"}'),
        blockStop(0),
        messageStop(),
      ],
      served("bash"),
    );

    expect(c.turnBlocks.map(describeBlock)).toEqual([
      ["toolCall", "toolu_retry", { command: "ls", timeout: 120 }],
    ]);
    expect(c.turnOutput?.stopReason).toBe("toolUse");
  });

  it("still skips the assistant message that repeats a completed stream", async () => {
    const { c } = openTurn();

    await consume(
      c,
      [
        messageStart("msg_1"),
        textStart(0),
        textDelta(0, "hi"),
        blockStop(0),
        assistantMessage("msg_1", [textBlock("hi")]),
        messageStop(),
      ],
      served("bash"),
    );

    expect(c.turnBlocks).toEqual([{ type: "text", text: "hi" }]);
  });
});

// A stream cut off inside a tool call's input: the block started, so its name and id are
// known, and then nothing. Claude Code drops the block from its own conversation and
// resumes the turn under a new message and tool_use id. Dispatching the half-built call
// sent pi `{}` under an id no MCP handler would ever claim, while Claude Code's resumed
// call waited on a handler pi never answered.
describe("a tool call whose content_block_stop never arrived", () => {
  const cutInsideToolInput = (id: string): SDKMessage[] => [
    messageStart(id),
    textStart(0),
    textDelta(0, "Reporting both fixes now."),
    blockStop(0),
    toolUseStart(1, NOTIFY, "toolu_cut"),
    messageStop(),
  ];

  it("is not dispatched to pi, and does not end pi's turn", async () => {
    const { c, pi } = openTurn();

    await consume(c, cutInsideToolInput("msg_cut"), served("notify_parent"));

    // Only the unfinished block goes; the text closed, and Claude Code keeps it too.
    expect(c.turnBlocks.map(describeBlock)).toEqual([["text"]]);
    expect(c.turnOutput?.stopReason).not.toBe("toolUse");
    expect(c.turnToolCallIds).toEqual([]);
    // Left open on purpose: Claude Code's resume is more of this same pi turn.
    expect(c.currentPiStream).toBe(pi.stream);
    expect(terminalTypes(pi)).toEqual([]);
    expect(pi.ended).toBe(false);
  });

  it("is replaced by the resumed message's call, which ends the turn", async () => {
    const { c, pi } = openTurn();

    await consume(
      c,
      [
        ...cutInsideToolInput("msg_cut"),
        messageStart("msg_resumed"),
        toolUseStart(0, NOTIFY, "toolu_resumed"),
        inputJsonDelta(0, '{"summary":"Both fixes done."}'),
        blockStop(0),
        messageStop(),
      ],
      served("notify_parent"),
    );

    expect(c.turnBlocks.map(describeBlock)).toEqual([
      ["text"],
      ["toolCall", "toolu_resumed", { summary: "Both fixes done." }],
    ]);
    expect(c.turnToolCallIds).toEqual(["toolu_resumed"]);
    expect(c.turnOutput?.stopReason).toBe("toolUse");
    expect(c.currentPiStream).toBeNull();
    expect(pi.events.at(-1)?.type).toBe("done");
    expect(pi.ended).toBe(true);
  });

  it("is replaced by a resume that arrives as an assistant message instead", async () => {
    const { c } = openTurn();

    await consume(
      c,
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
      served("notify_parent"),
    );

    expect(c.turnBlocks.map(describeBlock)).toEqual([
      ["text"],
      ["toolCall", "toolu_resumed", { summary: "Both fixes done." }],
    ]);
    expect(c.turnOutput?.stopReason).toBe("toolUse");
    expect(c.currentPiStream).toBeNull();
  });

  // Dropping the whole message would throw away a call Claude Code kept and dispatched:
  // the same deadlock the other way round.
  it("leaves a sibling call that did close to be dispatched", async () => {
    const { c } = openTurn();

    await consume(
      c,
      [
        messageStart("msg_pair"),
        toolUseStart(0, NOTIFY, "toolu_first"),
        inputJsonDelta(0, '{"summary":"First."}'),
        blockStop(0),
        toolUseStart(1, NOTIFY, "toolu_cut"),
        inputJsonDelta(1, '{"summ'),
        messageStop(),
      ],
      served("notify_parent"),
    );

    expect(c.turnBlocks.map(describeBlock)).toEqual([
      ["toolCall", "toolu_first", { summary: "First." }],
    ]);
    expect(c.turnToolCallIds).toEqual(["toolu_first"]);
    expect(c.turnOutput?.stopReason).toBe("toolUse");
    expect(c.currentPiStream).toBeNull();
  });

  // Negative control: refusing to dispatch anything at all passes every case above.
  it("still dispatches a tool call that does close, with its full arguments", async () => {
    const { c, pi } = openTurn();

    await consume(
      c,
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
      served("notify_parent"),
    );

    expect(c.turnBlocks.map(describeBlock)).toEqual([
      ["text"],
      ["toolCall", "toolu_whole", { summary: "Both fixes done." }],
    ]);
    expect(c.turnToolCallIds).toEqual(["toolu_whole"]);
    expect(c.turnOutput?.stopReason).toBe("toolUse");
    expect(c.currentPiStream).toBeNull();
    expect(pi.events.at(-1)?.type).toBe("done");
  });
});

// Claude sometimes calls a Claude Code builtin by its bare name. The query runs with
// `tools: []`, so Claude Code rejects such a call itself and retries under a fresh
// tool_use id without dispatching to our MCP server. Forwarding it ran a tool Claude
// Code never asked for, and pi's result, keyed to the dead id, never released the
// retry's handler.
describe("tool_use for a tool we do not serve", () => {
  const toolUseTurn = (name: string, id: string): SDKMessage[] => [
    toolUseStart(0, name, id),
    inputJsonDelta(0, '{"command":"ls"}'),
    blockStop(0),
    messageStop(),
  ];

  it("is skipped, and only the retry under the served name reaches pi", async () => {
    const { c } = openTurn();

    await consume(
      c,
      [...toolUseTurn("bash", "toolu_phantom"), ...toolUseTurn(BASH, "toolu_retry")],
      served("bash"),
    );

    expect(c.turnBlocks.map(describeBlock)).toEqual([
      ["toolCall", "toolu_retry", { command: "ls", timeout: 120 }],
    ]);
    expect(c.turnToolCallIds).toEqual(["toolu_retry"]);
  });

  it("does not end the pi stream, so the turn continues into the retry", async () => {
    const { c, pi } = openTurn();

    await consume(c, toolUseTurn("Bash", "toolu_phantom"), served("bash"));

    expect(c.turnSawToolCall).toBe(false);
    expect(c.turnBlocks).toEqual([]);
    expect(terminalTypes(pi)).toEqual([]);
    expect(pi.ended).toBe(false);
  });

  // The assistant-message path has to make the same call, or the deadlock comes back
  // through the other door.
  it("is skipped on the assistant-message path too", async () => {
    const { c } = openTurn();

    await consume(
      c,
      [
        assistantMessage("msg_1", [
          { type: "tool_use", name: "bash", id: "toolu_phantom", input: { command: "ls" } },
          { type: "tool_use", name: BASH, id: "toolu_retry", input: { command: "ls" } },
        ]),
      ],
      served("bash"),
    );

    expect(c.turnBlocks.map(describeBlock)).toEqual([
      ["toolCall", "toolu_retry", { command: "ls", timeout: 120 }],
    ]);
  });
});
