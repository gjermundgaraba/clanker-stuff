// The provider stream across turns: which Claude Code query a call starts or continues,
// which conversation it resumes, and how a query parked at a tool boundary is discarded
// when pi rewrites the history under it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Message,
  SimpleStreamOptions,
  Tool,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { getSessionPath } from "cc-session-io";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { patchEnv } from "../../../../tests/helpers/env.js";
import { createTempDir } from "../../../../tests/helpers/fs.js";
import { Bridge } from "../bridge.js";
import type { BridgeQuery } from "../bridge.js";
import { PI_PREAMBLE, PromptCaptures } from "../prompt/capture.js";
import { newAssistantOutput, QueryContext } from "../query/context.js";
import { makePromptStream, userMessage } from "../query/prompt-stream.js";
import { deliverToolResults } from "../query/tool-results.js";
import type { McpResult } from "../query/tool-results.js";
import {
  CONTINUE_AFTER_RESUME_PROMPT,
  CONTINUE_AFTER_REWRITE_PROMPT,
  createProviderStream,
  discardRewrittenQuery,
} from "../stream.js";
import { assistantMessage, init, successResult } from "./fixtures/sdk.js";
import { createFakeQuery, fakeQueryFunction, testModel, transcript } from "./helpers.js";
import type { FakeQuery } from "./helpers.js";

const model = testModel();

// --- Claude Code's side: a served `read` call the turn parks on ---

const readCall = (toolCallId: string): SDKMessage =>
  assistantMessage(`msg_${toolCallId}`, [
    { type: "tool_use", id: toolCallId, name: "mcp__custom-tools__read", input: { path: "a" } },
  ]);

// --- pi's side: the history it hands the provider ---

const readTool: Tool = {
  name: "read",
  description: "Read a file",
  parameters: Type.Object({ path: Type.String() }),
};

let clock = 0;

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: clock++ });

const say = (text: string): AssistantMessage => ({
  ...newAssistantOutput(model, "stop", text),
  timestamp: clock++,
});

const toolCall = (id: string): AssistantMessage => ({
  ...newAssistantOutput(model, "toolUse"),
  content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
  timestamp: clock++,
});

const toolResult = (id: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text: "file" }],
  isError: false,
  timestamp: clock++,
});

const replyText = (message: AssistantMessage): string =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 20);
  });

// --- the provider under test ---

function provider(captures = new PromptCaptures()) {
  const fake = fakeQueryFunction();
  const bridge = new Bridge(fake.run, captures);
  const stream = createProviderStream(bridge);

  const call = (
    sessionId: string,
    messages: Message[],
    options: Omit<SimpleStreamOptions, "sessionId"> = {},
  ) => stream(model, transcript({ messages, tools: [readTool] }), { sessionId, ...options });

  const latest = (): FakeQuery => {
    const query = fake.queries.at(-1);

    if (query === undefined) throw new Error("no query started");

    return query;
  };

  /** Script the latest query: init on its resumed conversation (as Claude Code reports a
   *  resume) or on `fresh`, then `messages`, then end it. */
  const answer = (fresh: string, ...messages: SDKMessage[]): void => {
    const query = latest();

    query.push(init(query.params.options.resume ?? fresh));

    for (const message of messages) query.push(message);

    query.end();
  };

  return { fake, bridge, stream, call, latest, answer };
}

/** The text a query was started with. Read before the query ends, which closes it. */
async function promptText(query: FakeQuery): Promise<string> {
  const { prompt } = query.params;

  if (typeof prompt === "string") return prompt;

  const first = await prompt[Symbol.asyncIterator]().next();

  if (first.done === true) throw new Error("prompt stream ended before its first message");

  const { content } = first.value.message;

  return typeof content === "string"
    ? content
    : content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

let claudeDir: string;

let restoreEnv: () => void;

beforeEach(async () => {
  // Rebuilds write Claude Code session files; keep them out of the real config dir.
  claudeDir = await createTempDir("claude-bridge-stream-");
  restoreEnv = patchEnv({ CLAUDE_CONFIG_DIR: claudeDir });
});

afterEach(async () => {
  restoreEnv();
  await rm(claudeDir, { recursive: true, force: true });
});

describe("discardRewrittenQuery", () => {
  /** A query parked mid-turn, logging how it is torn down. */
  function parked(bridge: Bridge, toolCallId = "call_1", piSessionId = "pi-parent") {
    const events: string[] = [];
    const fake = createFakeQuery({ prompt: "", options: {} });

    const sdkQuery: BridgeQuery = {
      [Symbol.asyncIterator]: () => fake[Symbol.asyncIterator](),
      interrupt: () => {
        events.push("interrupt");

        return fake.interrupt();
      },
      close: () => {
        events.push("close");
        fake.close();
      },
    };

    const c = new QueryContext();
    const promptStream = makePromptStream();

    c.activeQuery = sdkQuery;
    c.piSessionId = piSessionId;
    c.turnToolCallIds = [toolCallId];
    c.pendingToolCalls.set(toolCallId, {
      toolName: "read",
      resolve: (result) => {
        events.push(`release:${JSON.stringify(result.content)}`);
      },
    });
    c.promptStream = promptStream;
    bridge.activeQueries.add(c);

    // An ack parked in the prompt stream, as a steer awaiting stdin would be.
    const ack = promptStream.push(userMessage([{ type: "text", text: "steer" }]));

    return { c, sdkQuery, events, ack };
  }

  const results: McpResult[] = [
    { toolCallId: "call_1", content: [{ type: "text", text: "file contents" }] },
  ];

  it("stops the parked query being a routing target for the turn's result", async () => {
    const { bridge } = provider();
    const { c, ack } = parked(bridge);

    expect(bridge.contextForToolResults(results)).toBe(c);

    discardRewrittenQuery(bridge, c);

    // A result routed here would answer over the conversation pi just discarded.
    expect(bridge.contextForToolResults(results)).toBeUndefined();
    expect(c.activeQuery).toBeNull();
    expect(bridge.activeQueries.has(c)).toBe(false);
    await expect(ack).rejects.toThrow("conversation rewritten");
  });

  it("settles everything awaiting the subprocess before killing it", async () => {
    const { bridge } = provider();
    const { c, events, ack } = parked(bridge);

    discardRewrittenQuery(bridge, c);

    const released = events.findIndex((event) => event.startsWith("release:"));

    // A handler left awaiting a dead subprocess wedges pi's turn behind it.
    expect(released).not.toBe(-1);
    expect(events.indexOf("interrupt")).toBeGreaterThan(released);
    // Interrupt alone lets the current API call finish.
    expect(events).toContain("close");
    // The parked ack has nothing left to resume it.
    await expect(ack).rejects.toThrow("conversation rewritten");
    expect(c.promptStream).toBeNull();
    expect(c.pendingToolCalls.size).toBe(0);
  });

  it("marks the query abandoned so its completion cannot overwrite the rebuild", async () => {
    const { bridge } = provider();
    const { c, sdkQuery, ack } = parked(bridge);

    expect(bridge.abandonedQueries.has(sdkQuery)).toBe(false);

    discardRewrittenQuery(bridge, c);

    expect(bridge.abandonedQueries.has(sdkQuery)).toBe(true);
    await expect(ack).rejects.toThrow();
  });

  it("consumes the mark for its pi session, leaving sibling sessions armed", async () => {
    const { bridge } = provider();
    const { c, ack } = parked(bridge, "call_1", "pi-b");
    const sibling = parked(bridge, "call_2", "pi-c");

    bridge.markRebuild("pi-c", "session_compact:threshold");
    bridge.markRebuild("pi-b", "session_compact:threshold");

    discardRewrittenQuery(bridge, c);

    expect(bridge.mirrors.rewritten.has("pi-b")).toBe(false);
    expect(bridge.mirrors.rewritten.has("pi-c")).toBe(true);
    expect(sibling.c.historyStale).toBe(true);
    await expect(ack).rejects.toThrow();
  });

  it("rotates its own session's mirror, because the rebuild follows the kill immediately", async () => {
    // The killed CLI may still flush a record into the session file.
    const { bridge } = provider();

    bridge.mirrors.set("pi-parent", {
      sessionId: "abc",
      cursor: 3,
      cwd: "/tmp",
      piSessionId: "pi-parent",
    });

    const { c, ack } = parked(bridge, "call_1", "pi-parent");

    discardRewrittenQuery(bridge, c);

    expect(bridge.mirrors.get("pi-parent")).toMatchObject({
      forceRotate: true,
      needsRebuild: true,
    });
    await expect(ack).rejects.toThrow();
  });

  it("leaves a foreign session's mirror untouched", async () => {
    const { bridge } = provider();
    const parentMirror = { sessionId: "parent", cursor: 3, cwd: "/tmp", piSessionId: "pi-parent" };

    bridge.mirrors.set("pi-parent", parentMirror);

    const { c, ack } = parked(bridge, "call_1", "pi-b");

    bridge.markRebuild("pi-b", "session_compact:threshold");
    discardRewrittenQuery(bridge, c);

    // The parent's conversation is intact: neither rebuilt nor rotated.
    expect(bridge.mirrors.get("pi-parent")).toEqual(parentMirror);
    // The child never had a mirror to rotate.
    expect(bridge.mirrors.get("pi-b")).toBeUndefined();
    await expect(ack).rejects.toThrow();
  });

  it("is safe on a context whose query already ended", () => {
    const { bridge } = provider();
    const c = new QueryContext();

    bridge.activeQueries.add(c);

    discardRewrittenQuery(bridge, c);

    expect(c.activeQuery).toBeNull();
    expect(bridge.activeQueries.has(c)).toBe(false);
  });
});

describe("a tool result for a query whose history was rewritten", () => {
  it("discards the parked query and continues the turn in a fresh one", async () => {
    const { bridge, call, latest, answer } = provider();
    const ask = user("read a");
    const turn = call("pi-compacted", [ask]);
    const parkedQuery = latest();

    parkedQuery.push(init("cc-old"));
    parkedQuery.push(readCall("toolu_1"));

    const parkedReply = await turn.result();

    expect(parkedReply.stopReason).toBe("toolUse");

    bridge.markRebuild("pi-compacted", "session_compact:threshold:willRetry=false");

    const continued = call("pi-compacted", [ask, parkedReply, toolResult("toolu_1")]);
    const replacement = latest();

    expect(replacement).not.toBe(parkedQuery);
    expect(parkedQuery.closed).toBe(true);
    expect(await promptText(replacement)).toBe(CONTINUE_AFTER_REWRITE_PROMPT);

    answer("cc-new", successResult("continued"));

    expect(replyText(await continued.result())).toBe("continued");

    await settle();

    // The replacement resumed a conversation rebuilt from pi's rewritten history, and the
    // discarded query's completion left the session to it.
    const rebuilt = replacement.params.options.resume;

    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe("cc-old");
    expect(bridge.mirrors.get("pi-compacted")?.sessionId).toBe(rebuilt);
  });
});

describe("a tool result with no parked query", () => {
  it("after a restart, starts a fresh query that answers the turn", async () => {
    // A new process: the history ends at a checkpointed tool result no query of this
    // process ever parked on.
    const { fake, call, latest, answer } = provider();

    const reply = call("pi-restarted", [
      user("read a"),
      toolCall("toolu_1"),
      toolResult("toolu_1"),
    ]);

    expect(fake.queries).toHaveLength(1);
    expect(await promptText(latest())).toBe(CONTINUE_AFTER_RESUME_PROMPT);

    answer("cc-resumed", successResult("answer after restart"));

    expect(replyText(await reply.result())).toBe("answer after restart");
  });

  it("after compaction rewrote the history, tells Claude Code its context was compacted", async () => {
    // An overflow: pi compacts with no query parked, then retries from the rewritten
    // history, which ends at a tool result.
    const { bridge, fake, call, latest, answer } = provider();

    bridge.markRebuild("pi-compacted", "session_compact:overflow:willRetry=true");

    const reply = call("pi-compacted", [
      user("read a"),
      toolCall("toolu_7"),
      toolResult("toolu_7"),
    ]);

    expect(fake.queries).toHaveLength(1);
    expect(await promptText(latest())).toBe(CONTINUE_AFTER_REWRITE_PROMPT);

    answer("cc-rebuilt", successResult("continued"));
    await reply.result();
  });

  /** A turn parked on a tool call, then aborted. */
  async function abortParkedTurn(
    p: ReturnType<typeof provider>,
    sessionId: string,
    toolCallId: string,
  ): Promise<AbortController> {
    const controller = new AbortController();
    const turn = p.call(sessionId, [user("read a")], { signal: controller.signal });
    const query = p.latest();

    query.push(init(`cc-${sessionId}`));
    query.push(readCall(toolCallId));

    expect((await turn.result()).stopReason).toBe("toolUse");

    controller.abort();
    await settle();

    expect(query.closed).toBe(true);
    expect(p.bridge.activeQueries.size).toBe(0);

    return controller;
  }

  it("after an abort, ends the turn without a query", async () => {
    const p = provider();
    const controller = await abortParkedTurn(p, "pi-aborted", "toolu_2");

    // pi calls back with the run's signal, which the abort left aborted.
    const reply = await p
      .call("pi-aborted", [user("read a"), toolCall("toolu_2"), toolResult("toolu_2")], {
        signal: controller.signal,
      })
      .result();

    expect(p.fake.queries).toHaveLength(1);
    expect(reply.stopReason).toBe("stop");
    expect(replyText(reply)).toBe("");
  });

  it("resumes a later retry in a session that was aborted earlier", async () => {
    const p = provider();

    await abortParkedTurn(p, "pi-retry", "toolu_5");

    // A later run (fresh signal) retries after an overflow or quota error.
    const reply = p.call("pi-retry", [user("read b"), toolCall("toolu_6"), toolResult("toolu_6")], {
      signal: new AbortController().signal,
    });

    expect(p.fake.queries).toHaveLength(2);

    p.answer("cc-retry", successResult("resumed"));

    expect(replyText(await reply.result())).toBe("resumed");
  });

  it("resumes pi's retry after a parked query fails, even after an earlier abort", async () => {
    const p = provider();

    await abortParkedTurn(p, "pi-failed", "toolu_8");

    // The query parks on a tool call, then fails (a quota error) once its result arrives.
    const ask = user("read b");
    const parkedTurn = p.call("pi-failed", [ask], { signal: new AbortController().signal });
    const failingQuery = p.latest();

    failingQuery.push(init("cc-failing"));
    failingQuery.push(readCall("toolu_9"));

    const parkedReply = await parkedTurn.result();

    expect(parkedReply.stopReason).toBe("toolUse");

    const history = [ask, parkedReply, toolResult("toolu_9")];
    const failing = p.call("pi-failed", history, { signal: new AbortController().signal });

    expect(p.fake.queries).toHaveLength(2);

    failingQuery.fail(new Error("rate limit (five_hour)"));

    expect((await failing.result()).stopReason).toBe("error");

    await settle();

    // pi retries the same history on a fresh signal.
    const reply = p.call("pi-failed", history, { signal: new AbortController().signal });

    expect(p.fake.queries).toHaveLength(3);

    p.answer("cc-retry", successResult("answer after retry"));

    expect(replyText(await reply.result())).toBe("answer after retry");
  });

  it("does not orphan another session's resumed result after an abort", async () => {
    const p = provider();

    await abortParkedTurn(p, "pi-other", "toolu_3");

    const reply = p.call("pi-mine", [user("read a"), toolCall("toolu_4"), toolResult("toolu_4")]);

    expect(p.fake.queries).toHaveLength(2);

    p.answer("cc-mine", successResult("mine"));

    expect(replyText(await reply.result())).toBe("mine");
  });
});

describe("cross-session conversation isolation", () => {
  // One process serves several pi sessions (subagents run their own AgentSessions
  // through the same provider). A session's Claude Code conversation belongs to it: a
  // foreign session can never claim, resume, rewrite or delete it.

  it("keeps the parent's conversation when a foreground child completes inside its first turn", async () => {
    const p = provider();
    const u1 = user("research X");

    // The parent's first turn parks on a tool call.
    const parentTurn = p.call("pi-parent", [u1]);
    const parentQuery = p.latest();

    parentQuery.push(init("cc-P"));
    parentQuery.push(readCall("toolu_P1"));

    const a1 = await parentTurn.result();

    // A foreground child runs to completion while the parent is parked.
    const child = p.call("pi-child", [user("child task")]);

    p.answer("cc-C", successResult("child answer"));
    await child.result();

    // The parent's query continues past its tool call and completes.
    parentQuery.push(successResult("parent answer"));
    parentQuery.end();
    await settle();

    const next = p.call("pi-parent", [
      u1,
      a1,
      toolResult("toolu_P1"),
      say("parent answer"),
      user("now fix it"),
    ]);

    expect(p.latest().params.options.resume).toBe("cc-P");

    p.answer("cc-P2", successResult("ok"));
    await next.result();
  });

  it("leaves the parent's conversation in place when a background child finishes after it", async () => {
    const p = provider();
    const u1 = user("research X");
    const first = p.call("pi-parent", [u1]);

    p.answer("cc-P", successResult("parent answer"));
    await first.result();

    expect(p.bridge.mirrors.get("pi-parent")?.sessionId).toBe("cc-P");

    // A background child starts and stays open; the parent proceeds without it.
    const child = p.call("pi-child", [user("child task")]);
    const childQuery = p.latest();

    childQuery.push(init("cc-C"));

    const second = p.call("pi-parent", [u1, say("parent answer"), user("now fix it")]);

    expect(p.latest().params.options.resume).toBe("cc-P");

    p.answer("cc-P2", successResult("ok"));
    await second.result();

    childQuery.push(successResult("child answer"));
    childQuery.end();
    await child.result();

    expect(p.bridge.mirrors.get("pi-parent")?.sessionId).toBe("cc-P");
    expect(p.bridge.mirrors.get("pi-child")).toMatchObject({
      sessionId: "cc-C",
      piSessionId: "pi-child",
    });
  });

  it("does not hand a child the parent's conversation between parent turns", async () => {
    const p = provider();
    const u1 = user("research X");
    const first = p.call("pi-parent", [u1]);

    p.answer("cc-P", successResult("parent answer"));
    await first.result();

    const child = p.call("pi-child", [user("child task")]);

    expect(p.latest().params.options.resume).toBeUndefined();

    p.answer("cc-C", successResult("child answer"));
    await child.result();

    const second = p.call("pi-parent", [u1, say("parent answer"), user("now fix it")]);

    expect(p.latest().params.options.resume).toBe("cc-P");

    p.answer("cc-P2", successResult("ok"));
    await second.result();
  });

  /** The live query's context for `piSessionId`, its prompt stream already closed, so a
   *  steer delivered now never reaches Claude Code. */
  function closedQueryContext(p: ReturnType<typeof provider>, piSessionId: string) {
    const c = [...p.bridge.activeQueries].find((context) => context.piSessionId === piSessionId);

    if (c?.promptStream == null) throw new Error(`no live query for ${piSessionId}`);

    c.promptStream.fail(new Error("prompt stream closed"));

    return c;
  }

  const deliverMissedSteer = (p: ReturnType<typeof provider>, c: QueryContext, text: string) =>
    deliverToolResults(
      c,
      [],
      [{ type: "text", text }],
      (target, steer) => {
        p.bridge.missedSteer(target, steer);
      },
      () => {},
    );

  it("keeps a missed steer through successful completion and rebuilds the next turn", async () => {
    const p = provider();
    const u1 = user("first");
    const a1 = say("first answer");
    const u2 = user("second");
    const first = p.call("pi-parent", [u1]);

    p.answer("cc-missed", successResult("first answer"));
    await first.result();

    const second = p.call("pi-parent", [u1, a1, u2]);
    const secondQuery = p.latest();

    expect(secondQuery.params.options.resume).toBe("cc-missed");

    secondQuery.push(init("cc-missed"));
    await settle();

    // The CLI stopped accepting input but still returns a successful result. The
    // tool-result path has already counted the steer, so a cursor-based sync alone
    // cannot recover it.
    const c = closedQueryContext(p, "pi-parent");

    await deliverMissedSteer(p, c, "missed steer");

    const mirror = p.bridge.mirrors.get("pi-parent");

    if (mirror === undefined) throw new Error("the first turn left no mirror");

    mirror.cursor = 4;
    c.latestCursor = 4;

    expect(p.bridge.mirrors.get("pi-parent")?.needsRebuild).toBe(true);

    secondQuery.push(successResult("second answer"));
    secondQuery.end();
    await second.result();

    // Completion must not forget the missed steer.
    expect(p.bridge.mirrors.get("pi-parent")?.needsRebuild).toBe(true);

    const sessionFile = getSessionPath("cc-missed", process.cwd(), claudeDir);

    expect(existsSync(sessionFile)).toBe(false);

    const third = p.call("pi-parent", [
      u1,
      a1,
      u2,
      user("missed steer"),
      say("second answer"),
      user("third"),
    ]);

    p.answer("cc-P3", successResult("third answer"));
    await third.result();

    // The next turn imports pi's history rather than reusing the incomplete session.
    expect(readFileSync(sessionFile, "utf8")).toContain("missed steer");
    expect(p.bridge.mirrors.get("pi-parent")?.needsRebuild).toBeFalsy();
  });

  it("rebuilds after a missed steer in the first turn, before any mirror exists", async () => {
    const p = provider();
    const u1 = user("first");
    const first = p.call("pi-first-miss", [u1]);
    const firstQuery = p.latest();

    firstQuery.push(init("cc-first-missed"));
    await settle();

    expect(p.bridge.mirrors.get("pi-first-miss")).toBeUndefined();

    const c = closedQueryContext(p, "pi-first-miss");

    await deliverMissedSteer(p, c, "missed first-turn steer");
    c.latestCursor = 2;

    firstQuery.push(successResult("first answer"));
    firstQuery.end();
    await first.result();

    // Completion records the miss despite having had no earlier mirror to mark.
    expect(p.bridge.mirrors.get("pi-first-miss")?.needsRebuild).toBe(true);

    const sessionFile = getSessionPath("cc-first-missed", process.cwd(), claudeDir);

    expect(existsSync(sessionFile)).toBe(false);

    const second = p.call("pi-first-miss", [
      u1,
      user("missed first-turn steer"),
      say("first answer"),
      user("second"),
    ]);

    p.answer("cc-first-missed", successResult("second answer"));
    await second.result();

    expect(readFileSync(sessionFile, "utf8")).toContain("missed first-turn steer");
    expect(p.bridge.mirrors.get("pi-first-miss")?.needsRebuild).toBeFalsy();
  });
});

describe("a failed turn", () => {
  it("reports an error result on the stream instead of finishing as a normal stop", async () => {
    // Claude Code reports API failures (429 capacity, overload, prompt too long) as a
    // success-subtype result with is_error set.
    const failure = "API Error: Server is temporarily limiting requests: Rate limited";
    const p = provider();
    const turn = p.call("pi-session", [user("hi")]);

    p.answer("cc-error", successResult(failure, true));

    const reply = await turn.result();

    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toBe(failure);
  });

  it("forgets only the failing session's conversation when its query throws", async () => {
    const p = provider();
    const sibling = { sessionId: "cc-sibling", cursor: 2, cwd: "/tmp", piSessionId: "pi-sibling" };
    const first = p.call("pi-failing", [user("hi")]);

    p.answer("cc-failing", successResult("hello"));
    await first.result();
    p.bridge.mirrors.set("pi-sibling", sibling);

    const turn = p.call("pi-failing", [user("hi"), say("hello"), user("again")]);

    p.latest().fail(new Error("Claude Code process exited with code 1"));

    const reply = await turn.result();

    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toContain("exited with code 1");
    expect(p.bridge.mirrors.get("pi-failing")).toBeUndefined();
    expect(p.bridge.mirrors.get("pi-sibling")).toEqual(sibling);
  });
});

describe("a system prompt the bridge refuses", () => {
  // Fails the turn through the returned stream rather than throwing out of the provider
  // call. No query starts and no stream is left claimed.

  const turn = (p: ReturnType<typeof provider>, systemPrompt: string) =>
    p.stream(model, transcript({ systemPrompt, messages: [user("hi")], tools: [] }), {
      sessionId: "pi-session",
    });

  it("fails the turn when no capture accounts for the prompt", async () => {
    const p = provider();
    const reply = await turn(p, "a system prompt no capture boundary recorded").result();

    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toMatch(/prompt-capture: no capture/);
    expect(p.fake.queries).toHaveLength(0);
    expect(p.bridge.activeQueries.size).toBe(0);
  });

  it("fails the turn when the sendability guard refuses the capture", async () => {
    const captures = new PromptCaptures();
    const p = provider(captures);
    const prompt = `${PI_PREAMBLE}, recorded with pi's harness in its custom prompt.`;

    captures.record(prompt, { custom: prompt, contextFiles: [], skills: [] });

    const reply = await turn(p, prompt).result();

    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toMatch(/prompt-capture: refusing to send this prompt/);
    expect(p.fake.queries).toHaveLength(0);
  });
});

describe("a one-off summarizer call", () => {
  it("runs isolated from the session's conversation and prompt captures", async () => {
    // Compaction, branch and bug-report summaries use cacheRetention "none". Their prompt
    // was never captured, and they must not resume or write the live conversation.
    const p = provider();

    p.bridge.mirrors.set("pi-session", {
      sessionId: "cc-live",
      cursor: 1,
      cwd: process.cwd(),
      piSessionId: "pi-session",
    });

    const summary = p.stream(
      model,
      transcript({
        systemPrompt: "You are a summarization assistant.",
        messages: [user("Summarize the conversation.")],
      }),
      { sessionId: "pi-session", cacheRetention: "none" },
    );

    const query = p.latest();

    expect(query.params.prompt).toBe("Summarize the conversation.");
    expect(query.params.options).toMatchObject({
      persistSession: false,
      systemPrompt: "You are a summarization assistant.",
    });
    expect(query.params.options.resume).toBeUndefined();

    query.push(successResult("the summary"));
    query.end();

    expect(replyText(await summary.result())).toBe("the summary");
    expect(p.bridge.mirrors.get("pi-session")?.sessionId).toBe("cc-live");
  });
});

describe("pi's streamFn consumers", () => {
  // Anything pi hands a streamFn can route an LLM call through this provider with a
  // system prompt no capture boundary recorded. Branch summarization did exactly that
  // unnoticed: a behavioural test only probes the entry points already known, so the
  // installed source is inventoried instead.
  //
  // If this fails, a pi upgrade added or moved a streamFn consumer. Work out whether it
  // can reach a bridge model, then route it to the isolated summary path
  // (cacheRetention "none") or record here why it is harmless. A changed count inside a
  // listed file is the shape of the branch-summarization miss: read the diff.
  const piCore = fileURLToPath(
    new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core", import.meta.url),
  );

  const accounted = {
    // Hands branch summaries and /bug summaries to the two consumers below.
    "agent-session.js": 2,
    // Constructs the agent; summarizes nothing.
    "sdk.js": 2,
    // /bug summarization through completeSummarization, cacheRetention "none".
    "bug-report.js": 1,
    // Native compaction through completeSummarization, cacheRetention "none".
    "compaction/compaction.js": 13,
    // Branch summaries through completeSummarization, cacheRetention "none".
    "compaction/branch-summarization.js": 2,
  } satisfies Record<string, number>;

  it("are the ones the bridge has accounted for, in the same places", () => {
    const found: Record<string, number> = {};

    for (const file of readdirSync(piCore, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".js")) continue;

      const mentions = readFileSync(join(piCore, file), "utf8").match(/streamFn/g)?.length ?? 0;

      if (mentions > 0) found[file] = mentions;
    }

    expect(found).toEqual(accounted);
  });
});
