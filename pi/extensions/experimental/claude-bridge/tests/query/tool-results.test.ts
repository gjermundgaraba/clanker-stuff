// A turn's tool results reach Claude Code by two independent routes: Claude calls each
// tool over MCP, and pi appends the results to its context and calls the provider again.
// Either can land first. These drive the real MCP handler through the real JSON-RPC
// layer: a hand-rolled model of the queue pairs by id by construction, so it cannot
// express the mispairing the design exists to prevent.

import { setImmediate as nextMacrotask } from "node:timers/promises";

import type { Message } from "@earendil-works/pi-ai";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import { QueryContext, newAssistantOutput } from "../../query/context.js";
import { makePromptStream } from "../../query/prompt-stream.js";
import {
  buildMcpServers,
  deliverToolResults,
  extractAllToolResults,
  toolResultToMcpContent,
} from "../../query/tool-results.js";
import type { McpResult } from "../../query/tool-results.js";
import { drainForAbort } from "../../stream.js";
import { MCP_SERVER_NAME } from "../../tools.js";
import { testModel } from "../helpers.js";

const TOOLS = ["alpha", "beta", "gamma"].map((name) => ({
  name,
  description: name,
  parameters: Type.Object({}),
}));

type CallTool = (name: string, toolUseId: string) => Promise<CallToolResult>;

/** A query's context and its real MCP server, connected over JSON-RPC. */
async function startQuery(): Promise<{ c: QueryContext; callTool: CallTool }> {
  const c = new QueryContext();
  const server = buildMcpServers(TOOLS, c)?.[MCP_SERVER_NAME];

  if (server === undefined) throw new Error("buildMcpServers served no tools");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });

  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    c,
    // Claude Code stamps every tools/call with the id of the tool_use block it came from.
    callTool: (name, toolUseId) =>
      client.request(
        {
          method: "tools/call",
          params: { name, arguments: {}, _meta: { "claudecode/toolUseId": toolUseId } },
        },
        CallToolResultSchema,
      ),
  };
}

const replyText = ({ content: [block] }: CallToolResult): string | undefined =>
  block?.type === "text" ? block.text : undefined;

const result = (toolCallId: string, text: string, isError?: boolean): McpResult => ({
  toolCallId,
  content: [{ type: "text", text }],
  ...(isError === undefined ? {} : { isError }),
});

interface Delivery {
  missedSteers: [QueryContext, string][];
  warnings: string[];
}

async function deliver(
  c: QueryContext,
  results: readonly McpResult[],
  steer?: ContentBlockParam[],
): Promise<Delivery> {
  const delivery: Delivery = { missedSteers: [], warnings: [] };

  await deliverToolResults(
    c,
    results,
    steer,
    (missed, text) => {
      delivery.missedSteers.push([missed, text]);
    },
    (warning) => {
      delivery.warnings.push(warning);
    },
  );

  return delivery;
}

describe("the tool result queue", () => {
  it("hands a handler the result that arrived before it, isError included", async () => {
    const { c, callTool } = await startQuery();

    await deliver(c, [result("toolu_1", "early", true)]);

    expect([...c.pendingResults.keys()]).toEqual(["toolu_1"]);

    const response = await callTool("alpha", "toolu_1");

    expect(replyText(response)).toBe("early");
    expect(response.isError).toBe(true);
    expect(c.pendingResults.size).toBe(0);
  });

  it("parks a handler that arrives before its result, then releases it", async () => {
    const { c, callTool } = await startQuery();
    const call = callTool("alpha", "toolu_1");

    await nextMacrotask();

    expect([...c.pendingToolCalls.keys()]).toEqual(["toolu_1"]);
    expect(c.pendingToolCalls.get("toolu_1")?.toolName).toBe("alpha");

    await deliver(c, [result("toolu_1", "late", false)]);

    const response = await call;

    expect(replyText(response)).toBe("late");
    expect(response.isError).toBe(false);
    expect(c.pendingToolCalls.size).toBe(0);
  });

  // Claude calls the tools in one order, pi delivers their results in another, and
  // neither matches the emission order. Only the id on each tools/call can pair them;
  // anything positional silently answers the wrong call.
  it("pairs parallel calls by tool_use id, not by call or delivery order", async () => {
    const { c, callTool } = await startQuery();
    const third = callTool("gamma", "toolu_3");
    const first = callTool("alpha", "toolu_1");
    const second = callTool("beta", "toolu_2");

    await nextMacrotask();

    expect(c.pendingToolCalls.size).toBe(3);

    await deliver(c, [result("toolu_2", "r2"), result("toolu_3", "r3"), result("toolu_1", "r1")]);

    expect(replyText(await first)).toBe("r1");
    expect(replyText(await second)).toBe("r2");
    expect(replyText(await third)).toBe("r3");
    expect(c.pendingToolCalls.size).toBe(0);
    expect(c.pendingResults.size).toBe(0);
  });

  // The invariant the two maps exist to keep: an id waits in at most one of them.
  it("moves an id between the maps without ever holding it in both", async () => {
    const { c, callTool } = await startQuery();

    const inBoth = (): string[] =>
      [...c.pendingToolCalls.keys()].filter((id) => c.pendingResults.has(id));

    const one = callTool("alpha", "toolu_1");

    await nextMacrotask();

    expect(inBoth()).toEqual([]);

    // Releases the parked handler rather than queueing.
    await deliver(c, [result("toolu_1", "r1")]);

    expect(replyText(await one)).toBe("r1");
    expect(c.pendingResults.size).toBe(0);

    // No handler yet: queued.
    await deliver(c, [result("toolu_2", "r2")]);

    expect([...c.pendingResults.keys()]).toEqual(["toolu_2"]);
    expect(inBoth()).toEqual([]);

    // Claimed from the queue.
    expect(replyText(await callTool("beta", "toolu_2"))).toBe("r2");
    expect(c.pendingResults.size).toBe(0);
    expect(c.pendingToolCalls.size).toBe(0);
  });

  it("leaves only the unanswered handler parked, and warns that it is stuck", async () => {
    const { c, callTool } = await startQuery();
    const answered = callTool("alpha", "toolu_1");

    void callTool("beta", "toolu_2");
    await nextMacrotask();

    const { warnings } = await deliver(c, [result("toolu_1", "r1")]);

    expect(replyText(await answered)).toBe("r1");
    expect([...c.pendingToolCalls.keys()]).toEqual(["toolu_2"]);
    expect(warnings).toEqual([
      "Claude bridge: 1 tool handler(s) still waiting; provider may be stuck",
    ]);
  });
});

// The other way a handler leaves the queue: abandoned. Claude Code's tools/call stays
// open until it gets a reply, and pi's turn waits behind it, so every exit from a query
// has to settle its handlers.
describe("abandoning a query", () => {
  it("answers every parked handler and forgets queued results", async () => {
    const { c, callTool } = await startQuery();
    const one = callTool("alpha", "toolu_1");
    const two = callTool("beta", "toolu_2");

    await nextMacrotask();
    // Queued; no handler ever comes for it.
    await deliver(c, [result("toolu_3", "r3")]);

    c.releasePendingToolCalls("Query ended");

    expect(replyText(await one)).toBe("Query ended");
    expect(replyText(await two)).toBe("Query ended");
    expect(c.pendingToolCalls.size).toBe(0);
    expect(c.pendingResults.size).toBe(0);
  });

  // The user aborts while delivery is parked on the steer's stdin ack. Without failing
  // the prompt stream the ack never settles, delivery never returns, and the handler it
  // was about to release waits on a subprocess that is already dead.
  it("unwedges a delivery parked on the steer ack, leaving no handler waiting", async () => {
    const { c, callTool } = await startQuery();
    const call = callTool("alpha", "toolu_1");

    await nextMacrotask();

    // No consumer: the push parks exactly as it does when the CLI stops reading stdin.
    const promptStream = makePromptStream();

    c.promptStream = promptStream;

    const delivery = deliver(c, [result("toolu_1", "r1")], [{ type: "text", text: "stop" }]);

    await nextMacrotask();

    expect(c.pendingToolCalls.size).toBe(1);

    drainForAbort(c, promptStream);

    // Resolves rather than throwing: the steer is lost, not the turn.
    const { missedSteers } = await delivery;

    expect(replyText(await call)).toBe("Operation aborted");
    expect(c.pendingToolCalls.size).toBe(0);
    expect(missedSteers).toEqual([[c, "stop"]]);
  });
});

describe("extracting a turn's tool results from pi's context", () => {
  const model = testModel();
  const user = (content: string): Message => ({ role: "user", content, timestamp: 0 });

  const assistant = (...ids: string[]): Message => ({
    ...newAssistantOutput(model, "toolUse"),
    content: ids.map((id) => ({ type: "toolCall", id, name: "alpha", arguments: {} })),
  });

  const toolResult = (toolCallId: string, text: string, isError = false): Message => ({
    role: "toolResult",
    toolCallId,
    toolName: "alpha",
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  });

  const texts = (results: readonly McpResult[]): (string | undefined)[] =>
    results.map(({ content: [block] }) => (block?.type === "text" ? block.text : undefined));

  it("collects only the current turn, stopping at the previous assistant message", () => {
    const results = extractAllToolResults([
      user("prompt"),
      assistant("toolu_1"),
      toolResult("toolu_1", "turn 1"),
      assistant("toolu_2", "toolu_3"),
      toolResult("toolu_2", "turn 2a"),
      toolResult("toolu_3", "turn 2b"),
    ]);

    expect(texts(results)).toEqual(["turn 2a", "turn 2b"]);
    expect(results.map((r) => r.toolCallId)).toEqual(["toolu_2", "toolu_3"]);
  });

  // pi injects user messages (steers, follow-ups) while the turn's tools still run,
  // anywhere among the results. Stopping at one strands every handler behind it.
  it("walks past user messages injected among the results, keeping isError", () => {
    const results = extractAllToolResults([
      user("prompt"),
      assistant("toolu_1", "toolu_2", "toolu_3"),
      user("steer before any result"),
      toolResult("toolu_1", "r1"),
      toolResult("toolu_2", "r2", true),
      user("steer between results"),
      toolResult("toolu_3", "r3"),
      user("steer after the last result"),
    ]);

    expect(texts(results)).toEqual(["r1", "r2", "r3"]);
    expect(results.map((r) => r.isError)).toEqual([false, true, false]);
  });

  it("finds nothing when the turn's tools have not reported yet", () => {
    expect(
      extractAllToolResults([
        user("prompt"),
        assistant("toolu_1", "toolu_2"),
        user("steer into the void"),
      ]),
    ).toEqual([]);
    expect(extractAllToolResults([])).toEqual([]);
  });

  // The whole loop: scrape the turn out of pi's context and hand it to handlers already
  // waiting, in yet another order.
  it("releases every parked handler for a turn scraped out of context", async () => {
    const { c, callTool } = await startQuery();
    const beta = callTool("beta", "toolu_2");
    const alpha = callTool("alpha", "toolu_1");

    await nextMacrotask();

    await deliver(
      c,
      extractAllToolResults([
        user("prompt"),
        assistant("toolu_1", "toolu_2"),
        toolResult("toolu_1", "read the file"),
        user("steer"),
        toolResult("toolu_2", "ran the command"),
      ]),
    );

    expect(replyText(await alpha)).toBe("read the file");
    expect(replyText(await beta)).toBe("ran the command");
    expect(c.pendingToolCalls.size).toBe(0);
  });
});

// MCP requires at least one content block, and Claude reads images pi tools return.
it("converts pi tool content to MCP content, never leaving it empty", () => {
  expect(
    toolResultToMcpContent([
      { type: "text", text: "see" },
      { type: "text", text: "" },
      { type: "image", data: "iVBOR", mimeType: "image/png" },
    ]),
  ).toEqual([
    { type: "text", text: "see" },
    { type: "image", data: "iVBOR", mimeType: "image/png" },
  ]);
  expect(toolResultToMcpContent([{ type: "text", text: "" }])).toEqual([
    { type: "text", text: "" },
  ]);
});

// The steer and the MCP tool result travel back to Claude Code over the same stdin FIFO,
// so the steer must be written before any handler is released. Get that wrong and
// nothing throws: the steer silently degrades to a follow-up.
describe("a steer delivered with tool results", () => {
  const steer: ContentBlockParam[] = [{ type: "text", text: "actually stop" }];

  /** Stands in for the SDK's stdin pump: a message counts as written only once the pump
   *  asks for the next one, after its write finished. */
  function pumpPromptStream(
    c: QueryContext,
    order: string[],
  ): { sent: SDKUserMessage[]; stop: () => Promise<void> } {
    const promptStream = makePromptStream();
    const sent: SDKUserMessage[] = [];

    c.promptStream = promptStream;

    const pumping = (async () => {
      for await (const message of promptStream.stream) {
        sent.push(message);
        order.push("write started");
        await nextMacrotask();
        order.push("write finished");
      }
    })();

    return {
      sent,
      stop: async () => {
        promptStream.end();
        await pumping;
      },
    };
  }

  const handler = (order: string[], toolName: string) => ({
    toolName,
    resolve: () => {
      order.push(`resolve ${toolName}`);
    },
  });

  it("is written to stdin before any tool result is released", async () => {
    const order: string[] = [];
    const c = new QueryContext();
    const pump = pumpPromptStream(c, order);

    c.pendingToolCalls.set("call-1", handler(order, "read"));
    c.pendingToolCalls.set("call-2", handler(order, "bash"));

    await deliver(c, [result("call-1", "ok"), result("call-2", "ok")], steer);
    await pump.stop();

    expect(order).toEqual(["write started", "write finished", "resolve read", "resolve bash"]);
  });

  // Priority "next" is what makes Claude Code drain it at the tool boundary.
  it("is sent with priority next, images included", async () => {
    const c = new QueryContext();
    const pump = pumpPromptStream(c, []);

    const withImage: ContentBlockParam[] = [
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
    ];

    await deliver(c, [], withImage);
    await pump.stop();

    expect(pump.sent).toHaveLength(1);
    expect(pump.sent[0]?.priority).toBe("next");
    expect(pump.sent[0]?.message.content).toEqual(withImage);
  });

  // The caller already advanced the session cursor past the steer, so a steer that
  // never reached Claude Code would be skipped forever by a count-based sync.
  it("that is rejected is reported missed, and the results are still delivered", async () => {
    const order: string[] = [];
    const c = new QueryContext();
    const promptStream = makePromptStream();

    promptStream.fail(new Error("query ended"));
    c.promptStream = promptStream;
    c.pendingToolCalls.set("call-1", handler(order, "read"));

    const { missedSteers } = await deliver(c, [result("call-1", "ok")], steer);

    expect(missedSteers).toEqual([[c, "actually stop"]]);
    expect(order).toEqual(["resolve read"]);
  });

  it("with no prompt stream is reported missed", async () => {
    const c = new QueryContext();

    const { missedSteers } = await deliver(c, [], steer);

    expect(missedSteers).toEqual([[c, "actually stop"]]);
  });
});
