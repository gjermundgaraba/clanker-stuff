// The provider against scripted queries: which query each of pi's calls reaches, what it
// resumes, and what the rebuilt session holds. The sync decision itself is covered in
// sync.test.ts and the query's life in machine/conversation.test.ts.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import type {
  AssistantMessage,
  Message,
  SimpleStreamOptions,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openSession } from "cc-session-io";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { patchEnv } from "../../../../tests/helpers/env.js";
import { createTempDir } from "../../../../tests/helpers/fs.js";
import { CONTINUE_AFTER_REWRITE_PROMPT, streamClaudeCode } from "../provider.js";
import { PI_PREAMBLE } from "../prompt.js";
import { forgetSessionCwd, rememberSessionCwd } from "../session/cwd.js";
import { shared } from "../shared.js";
import { assistantMessage, init, successResult, textBlock } from "./fixtures/sdk.js";
import { fakeQueryFunction, testModel, transcript } from "./helpers.js";
import type { FakeQuery } from "./helpers.js";

const model = testModel();

const SESSION = "pi-session";

const READ = "mcp__custom-tools__read";

const readTool = { name: "read", description: "Read a file", parameters: Type.Object({}) };

let clock = 0;

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: clock++ });

const said = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: clock++,
});

const toolResult = (id: string, text: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: clock++,
});

const toolCall = (id: string) =>
  assistantMessage(`msg_${id}`, [{ type: "tool_use", id, name: READ, input: {} }]);

let configDir: string;

let cwd: string;

let restoreEnv: () => void;

beforeEach(async () => {
  configDir = await createTempDir("claude-bridge-config-");
  cwd = await createTempDir("claude-bridge-cwd-");
  restoreEnv = patchEnv({ CLAUDE_CONFIG_DIR: configDir });
  rememberSessionCwd(SESSION, cwd);
});

afterEach(async () => {
  for (const conversation of shared().conversations.values()) conversation.stop();

  shared().conversations.clear();
  forgetSessionCwd(SESSION);
  restoreEnv();
  await rm(configDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

function bridge() {
  const fake = fakeQueryFunction();
  const deps = { runQuery: fake.run, toolGuidelines: () => new Map<string, string[]>() };

  /** One provider call, as pi makes it for this session. The messages are copies, as
   *  pi's are once it has stored them: the bridge may not rely on its own objects. */
  const call = (
    messages: Message[],
    options: SimpleStreamOptions = {},
    extra: { systemPrompt?: string; tools?: (typeof readTool)[]; model?: typeof model } = {},
  ) =>
    streamClaudeCode(
      deps,
      extra.model ?? model,
      transcript({
        messages: structuredClone(messages),
        tools: extra.tools ?? [readTool],
        ...(extra.systemPrompt === undefined ? {} : { systemPrompt: extra.systemPrompt }),
      }),
      { sessionId: SESSION, ...options },
    );

  /** The query a call started, once it has. */
  const query = (index: number): Promise<FakeQuery> =>
    vi.waitFor(() => {
      const started = fake.queries[index];

      if (started === undefined) throw new Error(`query ${index} has not started`);

      return started;
    });

  return { fake, call, query };
}

/** The first message a query reads from its stdin: its prompt. */
async function promptOf(query: FakeQuery): Promise<SDKUserMessage["message"]["content"]> {
  const { prompt } = query.params;

  if (typeof prompt === "string") throw new Error("expected a streamed prompt");

  const first = await prompt[Symbol.asyncIterator]().next();

  if (first.done === true) throw new Error("the prompt stream ended empty");

  return first.value.message.content;
}

/** Answer a query with text, and let Claude Code exit. */
function answer(query: FakeQuery, text: string, sessionId = "cc-1"): void {
  query.push(init(sessionId));
  query.push(assistantMessage(`msg_${text}`, [textBlock(text)]));
  query.push(successResult(text));
  query.end();
}

const sessionContents = (sessionId: string) =>
  openSession({ sessionId, projectPath: cwd }).messages.map((record) => record.message.content);

const sessionPath = (sessionId: string) => openSession({ sessionId, projectPath: cwd }).jsonlPath;

describe("a session's turns", () => {
  it("starts the first turn clean and resumes Claude Code's session for the next", async () => {
    const { call, query, fake } = bridge();
    const u1 = user("hi");
    const first = call([u1]);
    const q1 = await query(0);

    expect(q1.params.options.resume).toBeUndefined();
    expect(await promptOf(q1)).toEqual([{ type: "text", text: "hi" }]);

    answer(q1, "hello");

    const a1 = await first.result();
    const u2 = user("again");
    const second = call([u1, a1, u2]);
    const q2 = await query(1);

    expect(q2.params.options.resume).toBe("cc-1");
    expect(await promptOf(q2)).toEqual([{ type: "text", text: "again" }]);

    answer(q2, "hello again");

    expect((await second.result()).content).toEqual([{ type: "text", text: "hello again" }]);
    expect(fake.queries).toHaveLength(2);
  });

  // A queued follow-up arrives the moment pi has its answer, while Claude Code is still
  // writing its session file: it must resume that session, not run beside it.
  it("resumes a turn sent while the previous query is still exiting", async () => {
    const { call, query } = bridge();
    const u1 = user("hi");
    const first = call([u1]);
    const q1 = await query(0);

    q1.push(init("cc-1"));
    q1.push(successResult("hello"));

    const a1 = await first.result();

    call([u1, a1, user("follow-up")]);
    q1.end();

    expect((await query(1)).params.options.resume).toBe("cc-1");
  });

  // Claude Code repeats a turn's final text in its result, and only there when the turn
  // streamed none: the record must hold that text, not the empty turn before it.
  it("resumes after a turn whose text arrived only in the result", async () => {
    const { call, query } = bridge();
    const u1 = user("hi");
    const first = call([u1]);
    const q1 = await query(0);

    q1.push(init("cc-1"));
    q1.push(successResult("only here"));
    q1.end();

    const a1 = await first.result();

    call([u1, a1, user("again")]);

    expect((await query(1)).params.options.resume).toBe("cc-1");
  });

  it("serves each pi session its own conversation", async () => {
    const { call, query } = bridge();
    const u1 = user("hi");
    const first = call([u1]);

    answer(await query(0), "hello", "cc-parent");

    const a1 = await first.result();

    call([user("child task")], { sessionId: "pi-child" });

    expect((await query(1)).params.options.resume).toBeUndefined();

    call([u1, a1, user("again")]);

    expect((await query(2)).params.options.resume).toBe("cc-parent");
  });
});

describe("the tool loop", () => {
  it("delivers pi's tool result to the query parked on the call", async () => {
    const { call, query, fake } = bridge();
    const u1 = user("read a");
    const first = call([u1]);
    const q1 = await query(0);
    const handler = (q1.params.options.mcpServers?.["custom-tools"] ?? null) !== null;

    expect(handler).toBe(true);

    q1.push(toolCall("toolu_1"));

    const a1 = await first.result();

    expect(a1.stopReason).toBe("toolUse");

    const second = call([u1, a1, toolResult("toolu_1", "contents")]);

    q1.push(assistantMessage("msg_2", [textBlock("read it")]));
    q1.push(successResult("read it"));
    q1.end();

    expect((await second.result()).content).toEqual([{ type: "text", text: "read it" }]);
    // One query served the whole turn.
    expect(fake.queries).toHaveLength(1);
  });

  // The parked query runs the model it started with.
  it("continues a turn switched to another model in a new query", async () => {
    const { call, query, fake } = bridge();
    const u1 = user("read a");
    const first = call([u1]);
    const q1 = await query(0);

    q1.push(init("cc-1"));
    q1.push(toolCall("toolu_1"));

    const a1 = await first.result();

    call([u1, a1, toolResult("toolu_1", "contents")], {}, { model: testModel("claude-opus-5-5") });

    const q2 = await query(1);

    expect(q1.closed).toBe(true);
    expect(q2.params.options.model).toBe("claude-opus-5-5[1m]");
    expect(fake.queries).toHaveLength(2);
  });

  it("ends the turn without a query when pi reports the tool after an abort", async () => {
    const { call, query, fake } = bridge();
    const controller = new AbortController();
    const u1 = user("read a");
    const first = call([u1], { signal: controller.signal });
    const q1 = await query(0);

    q1.push(toolCall("toolu_1"));

    const a1 = await first.result();

    controller.abort();
    await vi.waitFor(() => {
      expect(q1.closed).toBe(true);
    });

    const after = await call([u1, a1, toolResult("toolu_1", "aborted")], {
      signal: controller.signal,
    }).result();

    expect(after.stopReason).toBe("stop");
    expect(fake.queries).toHaveLength(1);
  });

  // A side call (an extension's one-shot under the live session id) must not disturb the
  // query parked on pi's tool, and cannot be handed tool results later.
  it("runs a side call beside a parked query, with no tools and no session left behind", async () => {
    const { call, query } = bridge();
    const u1 = user("read a");
    const first = call([u1]);
    const q1 = await query(0);

    q1.push(toolCall("toolu_1"));

    const a1 = await first.result();
    const side = call([user("summarize this for a status line")]);
    const q2 = await query(1);

    expect(q2.params.options.mcpServers).toBeUndefined();

    answer(q2, "a status", "cc-side");
    await side.result();

    expect(q1.closed).toBe(false);

    const second = call([u1, a1, toolResult("toolu_1", "contents")]);

    q1.push(successResult("done"));
    q1.end();

    expect((await second.result()).content).toEqual([{ type: "text", text: "done" }]);
  });
});

describe("a history Claude Code does not hold", () => {
  it("rewrites the session with another provider's turns and resumes it", async () => {
    const { call, query } = bridge();
    const u1 = user("hi");
    const first = call([u1]);

    answer(await query(0), "hello");

    const a1 = await first.result();

    const faux: AssistantMessage = {
      ...a1,
      provider: "faux",
      content: [{ type: "text", text: "faux" }],
    };

    const u2 = user("now you, faux");
    const u3 = user("back to claude");

    call([u1, a1, u2, faux, u3]);

    const q2 = await query(1);
    const rebuilt = q2.params.options.resume ?? "";

    expect(rebuilt).not.toBe("cc-1");
    expect(sessionContents(rebuilt)).toEqual([
      "hi",
      [{ type: "text", text: "hello" }],
      "now you, faux",
      [{ type: "text", text: "faux" }],
    ]);
    expect(await promptOf(q2)).toEqual([{ type: "text", text: "back to claude" }]);
  });

  // Delivering the result to the parked query would answer off the context pi just
  // compacted away.
  it("discards a parked query after compaction and continues the turn in a new session", async () => {
    const { call, query } = bridge();
    const u1 = user("read a");
    const first = call([u1]);
    const q1 = await query(0);

    q1.push(init("cc-1"));
    q1.push(toolCall("toolu_1"));

    const a1 = await first.result();
    const summary = user("<summary>the user asked to read a</summary>");

    call([summary, a1, toolResult("toolu_1", "contents")]);

    const q2 = await query(1);

    expect(q1.closed).toBe(true);
    // The killed process may still write to cc-1.
    expect(q2.params.options.resume).toEqual(expect.any(String));
    expect(q2.params.options.resume).not.toBe("cc-1");
    expect(await promptOf(q2)).toEqual([{ type: "text", text: CONTINUE_AFTER_REWRITE_PROMPT }]);
  });
});

it("fails the turn without a query when the gate refuses the prompt", async () => {
  const { call, fake } = bridge();

  const reply = await call(
    [user("hi")],
    {},
    { systemPrompt: `${PI_PREAMBLE}, a harness.` },
  ).result();

  expect(reply.stopReason).toBe("error");
  expect(reply.errorMessage).toMatch(/refusing to send this prompt/u);
  expect(fake.queries).toHaveLength(0);
});

describe("a one-off request", () => {
  const SUMMARY_PROMPT = "You are a summarization assistant.";

  // pi's compaction and branch summaries: a session id pi minted for the call, and
  // cacheRetention "none".
  it("runs a summary under the caller's prompt, leaving the session's conversation alone", async () => {
    const { call, query } = bridge();

    const reply = call(
      [user("Summarize the conversation.")],
      { cacheRetention: "none" },
      { systemPrompt: SUMMARY_PROMPT, tools: [] },
    );

    const q = await query(0);

    expect(q.params.options.systemPrompt).toBe(SUMMARY_PROMPT);
    expect(q.params.options.resume).toBeUndefined();
    expect(await promptOf(q)).toEqual([{ type: "text", text: "Summarize the conversation." }]);
    expect(shared().conversations.has(SESSION)).toBe(false);

    answer(q, "the summary", "cc-summary");

    expect((await reply.result()).content).toEqual([{ type: "text", text: "the summary" }]);
  });

  // No later call could deliver a tool's result to it.
  it("carries the history it was given without tools, and leaves no session behind", async () => {
    const { call, query } = bridge();
    const reply = call([user("earlier"), said("noted"), user("now")], { cacheRetention: "none" });
    const q = await query(0);
    const written = sessionPath(q.params.options.resume ?? "");

    expect(q.params.options.mcpServers).toBeUndefined();
    expect(sessionContents(q.params.options.resume ?? "")).toEqual([
      "earlier",
      [{ type: "text", text: "noted" }],
    ]);
    expect(await promptOf(q)).toEqual([{ type: "text", text: "now" }]);

    answer(q, "done");
    await reply.result();

    await vi.waitFor(() => {
      expect(existsSync(written)).toBe(false);
    });
  });

  it("passes the caller's reasoning level to Claude Code", async () => {
    const { call, query } = bridge();

    // Fable 5.1's pi-ai thinking map names only xhigh and max.
    const fable = {
      ...testModel("claude-fable-5-1"),
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    };

    call([user("Advise.")], { cacheRetention: "none", reasoning: "max" }, { model: fable });

    expect((await query(0)).params.options.effort).toBe("max");
  });
});

it("runs Claude Code without the user's own Claude Code setup", async () => {
  const { call, query } = bridge();

  call([user("hi")]);

  expect((await query(0)).params.options).toMatchObject({
    settingSources: [],
    skills: [],
    strictMcpConfig: true,
    model: "claude-haiku-5-5[1m]",
  });
});
