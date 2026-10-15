// One-off summarizer calls: an isolated Claude Code process per call, run in the owning
// session's directory, whose failures never become a summary.

import { rm } from "node:fs/promises";

import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createTempDir } from "../../../../tests/helpers/fs.js";
import { Bridge } from "../bridge.js";
import { PromptCaptures } from "../prompt/capture.js";
import { forgetSessionCwd, rememberSessionCwd, rememberSummarySession } from "../session/cwd.js";
import { isolatedSummaryStream } from "../summary.js";
import { errorResult, successResult } from "./fixtures/sdk.js";
import { fakeQueryFunction, testModel, transcript } from "./helpers.js";
import type { FakeQuery } from "./helpers.js";

const model = testModel();

const SUMMARY_PROMPT = "You are a summarization assistant.";

function summarize(options: SimpleStreamOptions = {}, prompt = "Summarize the conversation.") {
  const fake = fakeQueryFunction();
  const bridge = new Bridge(fake.run, new PromptCaptures());

  const stream = isolatedSummaryStream(
    bridge,
    model,
    transcript({
      systemPrompt: SUMMARY_PROMPT,
      messages: [{ role: "user", content: prompt, timestamp: 0 }],
    }),
    { cacheRetention: "none", ...options },
  );

  const query = (): FakeQuery => {
    const [only, ...rest] = fake.queries;

    if (only === undefined || rest.length > 0) {
      throw new Error(`expected one query, got ${fake.queries.length}`);
    }

    return only;
  };

  return { fake, stream, query };
}

describe("isolated summary query", () => {
  it("runs one session-less turn under the caller's summarization prompt", async () => {
    const { stream, query } = summarize();
    const q = query();

    expect(q.params.prompt).toBe("Summarize the conversation.");
    expect(q.params.options).toMatchObject({
      persistSession: false,
      tools: [],
      systemPrompt: SUMMARY_PROMPT,
      maxTurns: 1,
    });

    q.push(successResult("the summary"));
    q.end();

    const reply = await stream.result();

    expect(reply.stopReason).toBe("stop");
    expect(reply.content).toEqual([{ type: "text", text: "the summary" }]);
    expect(q.closed).toBe(true);
  });

  it("passes the caller's reasoning level to Claude Code", async () => {
    // Fable 5.1's pi-ai thinking map names only xhigh and max.
    const fable = {
      ...testModel("claude-fable-5-1"),
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    };

    const fake = fakeQueryFunction();

    const stream = isolatedSummaryStream(
      new Bridge(fake.run, new PromptCaptures()),
      fable,
      transcript({ messages: [{ role: "user", content: "Advise.", timestamp: 0 }] }),
      { cacheRetention: "none", reasoning: "max" },
    );

    const [q] = fake.queries;

    if (q === undefined) throw new Error("no query started");

    expect(q.params.options.effort).toBe("max");

    q.push(successResult("advice"));
    q.end();
    await stream.result();
  });

  it("leaves effort to Claude Code's default without a reasoning level", async () => {
    const { stream, query } = summarize();
    const q = query();

    expect(q.params.options).not.toHaveProperty("effort");

    q.push(successResult("the summary"));
    q.end();
    await stream.result();
  });
});

describe("isolated summary cwd", () => {
  // A host serving several sessions from one process has one process cwd; a summary
  // must load the owning session's project, not the host's.
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    dirA = await createTempDir("claude-bridge-summary-a-");
    dirB = await createTempDir("claude-bridge-summary-b-");
    rememberSessionCwd("pi-a", dirA);
    rememberSessionCwd("pi-b", dirB);
  });

  afterEach(async () => {
    forgetSessionCwd("pi-a");
    forgetSessionCwd("pi-b");
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it("runs concurrent summaries in the directory of the session whose operation started them", async () => {
    // pi forwards the operation's signal to each summary call; the before hook tied it to
    // its session.
    const signalA = new AbortController().signal;
    const signalB = new AbortController().signal;

    rememberSummarySession(signalA, "pi-a");
    rememberSummarySession(signalB, "pi-b");

    const a = summarize({ signal: signalA });
    const b = summarize({ signal: signalB });

    expect(a.query().params.options.cwd).toBe(dirA);
    expect(b.query().params.options.cwd).toBe(dirB);

    for (const { stream, query } of [a, b]) {
      query().push(successResult("summary"));
      query().end();
      await stream.result();
    }
  });

  it("falls back to the call's session id when the signal belongs to no operation", async () => {
    const { stream, query } = summarize({
      sessionId: "pi-b",
      signal: new AbortController().signal,
    });

    expect(query().params.options.cwd).toBe(dirB);

    query().push(successResult("summary"));
    query().end();
    await stream.result();
  });
});

describe("isolated summary failures", () => {
  // A failure must reach pi as a failed call: accepting it as a summary would write
  // "Prompt is too long" into the session history.

  it("fails on an error result Claude Code reports with a success subtype", async () => {
    const { stream, query } = summarize();

    query().push(successResult("Prompt is too long", true));
    query().end();

    const reply = await stream.result();

    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toBe("Prompt is too long");
  });

  it("fails with the errors of a dedicated error subtype", async () => {
    const { stream, query } = summarize();

    query().push(errorResult("error_during_execution", ["controlled summary failure"]));
    query().end();

    const reply = await stream.result();

    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toBe("controlled summary failure");
  });

  // pi's own check refuses a "length" summary before it replaces any history.
  it("reports a summary Claude Code cut off at its output cap as truncated", async () => {
    const { stream, query } = summarize();

    query().push({ ...successResult("half a summ"), stop_reason: "max_tokens" });
    query().end();

    const reply = await stream.result();

    expect(reply.stopReason).toBe("length");
  });

  it("refuses a request with history or tools instead of dropping them", async () => {
    const fake = fakeQueryFunction();
    const bridge = new Bridge(fake.run, new PromptCaptures());

    const withHistory = isolatedSummaryStream(
      bridge,
      model,
      transcript({
        messages: [
          { role: "user", content: "earlier", timestamp: 0 },
          { role: "user", content: "now", timestamp: 1 },
        ],
      }),
      { cacheRetention: "none" },
    );

    const withTools = isolatedSummaryStream(
      bridge,
      model,
      transcript({
        messages: [{ role: "user", content: "now", timestamp: 0 }],
        tools: [{ name: "read", description: "Read a file", parameters: Type.Object({}) }],
      }),
      { cacheRetention: "none" },
    );

    for (const reply of [await withHistory.result(), await withTools.result()]) {
      expect(reply.stopReason).toBe("error");
      expect(reply.errorMessage).toMatch(/single user message and no tools/);
    }

    expect(fake.queries).toHaveLength(0);
  });

  it("fails on an empty summary", async () => {
    const { stream, query } = summarize();

    query().push(successResult("  "));
    query().end();

    const reply = await stream.result();

    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toMatch(/empty text/);
  });

  it("fails without starting a query when there is no prompt to summarize", async () => {
    const { fake, stream } = summarize({}, "");
    const reply = await stream.result();

    expect(reply.stopReason).toBe("error");
    expect(fake.queries).toHaveLength(0);
  });

  it("stops the Claude Code process and reports the abort", async () => {
    const controller = new AbortController();
    const { stream, query } = summarize({ signal: controller.signal });

    controller.abort();

    const reply = await stream.result();

    expect(reply.stopReason).toBe("aborted");
    expect(query().interrupted).toBe(true);
    expect(query().closed).toBe(true);
  });
});
