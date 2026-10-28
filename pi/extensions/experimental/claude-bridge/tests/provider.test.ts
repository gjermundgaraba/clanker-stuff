import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AssistantMessage,
  Message,
  SimpleStreamOptions,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { openSession } from "cc-session-io";
import { Type } from "typebox";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { patchEnv } from "../../../../tests/helpers/env.js";
import { createTempDir } from "../../../../tests/helpers/fs.js";
import { PI_PREAMBLE } from "../prompt.js";
import { CONTINUE_PROMPT, streamClaudeCode } from "../provider.js";
import { Sessions } from "../sessions.js";
import {
  assistantMessage,
  init,
  successResult,
  textBlock,
} from "./fixtures/sdk.js";
import { fakeQueryFunction, testModel, transcript } from "./helpers.js";
import type { FakeQuery } from "./helpers.js";

const model = testModel();

const SESSION = "pi-session";

const CHILD = "pi-child";

const READ = "mcp__custom-tools__read";

const readTool = {
  name: "read",
  description: "Read a file",
  parameters: Type.Object({}),
};

let clock = 0;

const user = (text: string): UserMessage => ({
  role: "user",
  content: text,
  timestamp: (clock += 1),
});

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
  timestamp: (clock += 1),
});

const toolResult = (id: string, text: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: (clock += 1),
});

const toolCall = (id: string) =>
  assistantMessage(`msg_${id}`, [
    { type: "tool_use", id, name: READ, input: {} },
  ]);

let configDir: string;

let cwd: string;

let restoreEnv: () => void;

let sessions: Sessions | undefined;

const bridge = () => {
  const fake = fakeQueryFunction();

  sessions = new Sessions(fake.run);
  sessions.start(SESSION, cwd);

  const deps = { sessions, toolGuidelines: () => new Map<string, string[]>() };

  const call = (
    messages: Message[],
    options: SimpleStreamOptions = {},
    extra: {
      systemPrompt?: string;
      tools?: Array<typeof readTool>;
      model?: typeof model;
    } = {}
  ) =>
    streamClaudeCode(
      deps,
      extra.model ?? model,
      transcript({
        messages: structuredClone(messages),
        tools: extra.tools ?? [readTool],
        ...(extra.systemPrompt === undefined
          ? {}
          : { systemPrompt: extra.systemPrompt }),
      }),
      { sessionId: SESSION, ...options }
    );

  const query = async (index: number): Promise<FakeQuery> =>
    await vi.waitFor(() => {
      const started = fake.queries[index];

      if (started === undefined) {
        throw new Error(`query ${index} has not started`);
      }

      return started;
    });

  return { fake, call, query };
};

const promptOf = async (
  query: FakeQuery
): Promise<SDKUserMessage["message"]["content"]> => {
  const { prompt } = query.params;

  if (typeof prompt === "string") {
    throw new TypeError("expected a streamed prompt");
  }

  const first = await prompt[Symbol.asyncIterator]().next();

  if (first.done === true) {
    throw new Error("the prompt stream ended empty");
  }

  return first.value.message.content;
};

const answer = (query: FakeQuery, text: string, sessionId = "cc-1"): void => {
  query.push(init(sessionId));
  query.push(assistantMessage(`msg_${text}`, [textBlock(text)]));
  query.push(successResult(text));
  query.end();
};

const sessionContents = (sessionId: string) =>
  openSession({ sessionId, projectPath: cwd }).messages.map(
    (record) => record.message.content
  );

const sessionPath = (sessionId: string) =>
  openSession({ sessionId, projectPath: cwd }).jsonlPath;

describe("streamClaudeCode", () => {
  beforeEach(async () => {
    configDir = await createTempDir("claude-bridge-config-");
    cwd = await createTempDir("claude-bridge-cwd-");
    restoreEnv = patchEnv({ CLAUDE_CONFIG_DIR: configDir });
  });

  afterEach(async () => {
    for (const id of [SESSION, CHILD]) {
      sessions?.end(id);
    }

    restoreEnv();
    await rm(configDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  describe("a session's turns", () => {
    it("starts the first turn clean and resumes Claude Code's session for the next", async () => {
      const { call, query, fake } = bridge();
      const u1 = user("hi");
      const first = call([u1]);
      const q1 = await query(0);

      expect(q1.params.options.resume).toBeUndefined();
      await expect(promptOf(q1)).resolves.toStrictEqual([
        { type: "text", text: "hi" },
      ]);

      answer(q1, "hello");

      const a1 = await first.result();
      const u2 = user("again");
      const second = call([u1, a1, u2]);
      const q2 = await query(1);

      expect(q2.params.options.resume).toBe("cc-1");
      await expect(promptOf(q2)).resolves.toStrictEqual([
        { type: "text", text: "again" },
      ]);

      answer(q2, "hello again");

      const a2 = await second.result();

      expect(a2.content).toStrictEqual([{ type: "text", text: "hello again" }]);
      expect(fake.queries).toHaveLength(2);
    });

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

      const q2 = await query(1);

      expect(q2.params.options.resume).toBe("cc-1");
    });

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

      const q2 = await query(1);

      expect(q2.params.options.resume).toBe("cc-1");
    });

    it("serves each pi session its own conversation", async () => {
      const { call, query } = bridge();
      const u1 = user("hi");
      const first = call([u1]);

      answer(await query(0), "hello", "cc-parent");

      const a1 = await first.result();

      call([user("child task")], { sessionId: CHILD });

      const child = await query(1);

      expect(child.params.options.resume).toBeUndefined();

      call([u1, a1, user("again")]);

      const q3 = await query(2);

      expect(q3.params.options.resume).toBe("cc-parent");
    });
  });

  describe("the tool loop", () => {
    it("delivers pi's tool result to the query parked on the call", async () => {
      const { call, query, fake } = bridge();
      const u1 = user("read a");
      const first = call([u1]);
      const q1 = await query(0);

      const handler =
        (q1.params.options.mcpServers?.["custom-tools"] ?? null) !== null;

      expect(handler).toBe(true);

      q1.push(toolCall("toolu_1"));

      const a1 = await first.result();

      expect(a1.stopReason).toBe("toolUse");

      const second = call([u1, a1, toolResult("toolu_1", "contents")]);

      q1.push(assistantMessage("msg_2", [textBlock("read it")]));
      q1.push(successResult("read it"));
      q1.end();

      const a2 = await second.result();

      expect(a2.content).toStrictEqual([{ type: "text", text: "read it" }]);
      expect(fake.queries).toHaveLength(1);
    });

    it("continues a turn switched to another model in a new query", async () => {
      const { call, query, fake } = bridge();
      const u1 = user("read a");
      const first = call([u1]);
      const q1 = await query(0);

      q1.push(init("cc-1"));
      q1.push(toolCall("toolu_1"));

      const a1 = await first.result();

      call(
        [u1, a1, toolResult("toolu_1", "contents")],
        {},
        { model: testModel("claude-opus-5-5") }
      );

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

      const a2 = await second.result();

      expect(a2.content).toStrictEqual([{ type: "text", text: "done" }]);
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
      expect(sessionContents(rebuilt)).toStrictEqual([
        "hi",
        [{ type: "text", text: "hello" }],
        "now you, faux",
        [{ type: "text", text: "faux" }],
      ]);
      await expect(promptOf(q2)).resolves.toStrictEqual([
        { type: "text", text: "back to claude" },
      ]);
    });

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
      expect(q2.params.options.resume).toStrictEqual(expect.any(String));
      expect(q2.params.options.resume).not.toBe("cc-1");
      await expect(promptOf(q2)).resolves.toStrictEqual([
        { type: "text", text: CONTINUE_PROMPT },
      ]);
    });
  });

  it("fails the turn without a query when the gate refuses the prompt", async () => {
    const { call, fake } = bridge();

    const reply = await call(
      [user("hi")],
      {},
      { systemPrompt: `${PI_PREAMBLE}, a harness.` }
    ).result();

    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toMatch(/refusing to send this prompt/u);
    expect(fake.queries).toHaveLength(0);
  });

  it("continues a compacted turn with its steer, its tools and no parked query", async () => {
    const { call, query } = bridge();
    const u1 = user("read a");
    const first = call([u1]);
    const q1 = await query(0);

    q1.push(init("cc-1"));
    q1.push(toolCall("toolu_1"));

    const a1 = await first.result();
    const summary = user("<summary>the user asked to read a</summary>");

    call([
      summary,
      a1,
      toolResult("toolu_1", "contents"),
      user("use b instead"),
    ]);

    const q2 = await query(1);

    expect(q1.closed).toBe(true);
    expect(q2.params.options.mcpServers).toBeDefined();
    await expect(promptOf(q2)).resolves.toStrictEqual([
      { type: "text", text: "use b instead" },
    ]);
  });

  describe("a one-off request", () => {
    const SUMMARY_PROMPT = "You are a summarization assistant.";

    it("runs a summary under the caller's prompt, leaving the session's conversation alone", async () => {
      const { call, query } = bridge();

      const reply = call(
        [user("Summarize the conversation.")],
        { cacheRetention: "none" },
        { systemPrompt: SUMMARY_PROMPT, tools: [] }
      );

      const q = await query(0);

      expect(q.params.options.systemPrompt).toBe(SUMMARY_PROMPT);
      expect(q.params.options.resume).toBeUndefined();
      await expect(promptOf(q)).resolves.toStrictEqual([
        { type: "text", text: "Summarize the conversation." },
      ]);

      answer(q, "the summary", "cc-summary");

      const summary = await reply.result();

      expect(summary.content).toStrictEqual([
        { type: "text", text: "the summary" },
      ]);
    });

    it("carries the history it was given without tools, and leaves no session behind", async () => {
      const { call, query } = bridge();

      const reply = call([user("earlier"), said("noted"), user("now")], {
        cacheRetention: "none",
      });

      const q = await query(0);
      const written = sessionPath(q.params.options.resume ?? "");

      expect(q.params.options.mcpServers).toBeUndefined();
      expect(sessionContents(q.params.options.resume ?? "")).toStrictEqual([
        "earlier",
        [{ type: "text", text: "noted" }],
      ]);
      await expect(promptOf(q)).resolves.toStrictEqual([
        { type: "text", text: "now" },
      ]);

      answer(q, "done");
      await reply.result();

      await vi.waitFor(() => {
        expect(existsSync(written)).toBe(false);
      });
    });

    it("hands pi no call for a tool it listed but the one-off does not serve", async () => {
      const { call, query } = bridge();
      const reply = call([user("Summarize.")], { cacheRetention: "none" });
      const q = await query(0);

      q.push(toolCall("toolu_1"));
      answer(q, "the summary");

      const result = await reply.result();

      expect(result.stopReason).toBe("stop");
      expect(result.content).toStrictEqual([
        { type: "text", text: "the summary" },
      ]);
    });

    it("fails a one-off that returns no text", async () => {
      const { call, query } = bridge();
      const reply = call([user("Summarize.")], { cacheRetention: "none" });

      answer(await query(0), "");

      const failed = await reply.result();

      expect(failed.stopReason).toBe("error");
    });

    it("passes the caller's reasoning level to Claude Code", async () => {
      const { call, query } = bridge();

      const fable = {
        ...testModel("claude-fable-5-1"),
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      };

      call(
        [user("Advise.")],
        { cacheRetention: "none", reasoning: "max" },
        { model: fable }
      );

      const q = await query(0);

      expect(q.params.options.effort).toBe("max");
    });
  });

  it("runs Claude Code without the user's own Claude Code setup", async () => {
    const { call, query } = bridge();

    call([user("hi")]);

    const q = await query(0);

    expect(q.params.options).toMatchObject({
      settingSources: [],
      skills: [],
      strictMcpConfig: true,
      verbatimPrompts: true,
      model: "claude-haiku-5-5[1m]",
    });
  });
});
