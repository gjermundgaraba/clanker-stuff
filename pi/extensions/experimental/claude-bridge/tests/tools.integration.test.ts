// Live: pi tools served to real Claude Code, and messages arriving while one runs. Each
// test bills the user's Claude subscription; run with CLAUDE_BRIDGE_LIVE=1 (see live.ts).

import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  LIVE,
  LIVE_TIMEOUT,
  createLiveSession,
  expectAnswer,
  liveEnvironment,
  nextEvent,
  sessionMentions,
  sessionRecords,
  type DebugLog,
  type LiveSession,
} from "./live.js";

/** Blocks for a while, so a test can act while Claude Code waits on the result. */
const slowTool = defineTool({
  name: "SlowTool",
  label: "Slow tool",
  description:
    "Waits for the specified number of seconds before returning. Use this when asked to call SlowTool.",
  parameters: Type.Object({
    seconds: Type.Optional(
      Type.Number({ description: "How long to wait before returning (default 5)" }),
    ),
  }),
  async execute(_toolCallId, params, signal) {
    const ms = (params.seconds ?? 5) * 1000;

    await delay(ms, undefined, signal === undefined ? {} : { signal });

    return { content: [{ type: "text", text: `SlowTool completed after ${ms}ms` }], details: {} };
  },
});

/** The `claude` processes under `pid`, at any depth, matched on the executable. */
function claudeDescendants(pid: number): { pid: number; command: string }[] {
  let children: number[];

  try {
    children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(Number);
  } catch {
    // pgrep exits 1 when there are none.
    return [];
  }

  return children.flatMap((child) => {
    let command = "";

    try {
      command = execFileSync("ps", ["-o", "command=", "-p", String(child)], {
        encoding: "utf8",
      }).trim();
    } catch {
      // Exited between pgrep and ps.
    }

    const own =
      path.basename(command.split(" ")[0] ?? "") === "claude" ? [{ pid: child, command }] : [];

    return [...own, ...claudeDescendants(child)];
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!LIVE)("claude-bridge live tool calls", () => {
  let env: ReturnType<typeof liveEnvironment>;
  let log: DebugLog;
  const sessions: LiveSession[] = [];

  const open = async () => {
    const session = await createLiveSession({ tools: [slowTool] });

    sessions.push(session);

    return session;
  };

  const toolStarted = (live: LiveSession) =>
    nextEvent(live.h, (event) => event.type === "tool_execution_start");

  beforeAll(() => {
    env = liveEnvironment();
    ({ log } = env);
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.close();
  });

  afterAll(() => {
    env.restore();
  });

  it(
    "drains a steer at the tool boundary, before Claude Code's next model call",
    async () => {
      const live = await open();
      const mark = log.mark();

      const run = live.h.prompt(
        "Call SlowTool with seconds=1 exactly 12 times, strictly one at a time: wait for each result before starting the next. Do not call it twice in the same message.",
      );

      await toolStarted(live);
      await live.h.session.steer(
        "STOP. Do not call SlowTool again. Reply with only the word BANANA.",
      );
      await run;
      expectAnswer(live.h);

      // Only mid-turn steering produces a `queued_command` attachment between the tool
      // result and the next assistant message. A steer that lost the stdin race lands
      // after that message, and one replayed as a follow-up has no attachment at all.
      // Model output cannot tell these apart: Claude obeys a late steer too.
      const written = log.since(mark);
      const records = sessionRecords(written, live.projectDir);

      const steerAt = records.findIndex(
        (r) =>
          r.attachment?.type === "queued_command" &&
          JSON.stringify(r.attachment.prompt ?? "").includes("Do not call SlowTool again"),
      );

      expect(steerAt, "the steer never reached Claude Code as a queued command").not.toBe(-1);

      const toolResultAt = records.findLastIndex(
        (r, index) =>
          index < steerAt && JSON.stringify(r.message?.content ?? "").includes('"tool_result"'),
      );

      expect(toolResultAt, "no tool result before the steer").not.toBe(-1);
      expect(
        records.slice(toolResultAt + 1, steerAt).filter((r) => r.type === "assistant"),
        "the turn continued before the steer was drained",
      ).toEqual([]);
      expect(records.slice(steerAt).some((r) => r.type === "assistant")).toBe(true);
      expect(written).toContain("steer written to Claude Code's stdin before the tool results");
    },
    LIVE_TIMEOUT,
  );

  it(
    "delivers every parallel tool result and a steer that arrives among them",
    async () => {
      const live = await open();
      const mark = log.mark();

      const run = live.h.prompt(
        "Call SlowTool three times in parallel: seconds=3, seconds=4, seconds=5. Then list all three results.",
      );

      await toolStarted(live);
      await live.h.session.steer(
        "This is a steer during parallel tool execution. IMPORTANT: also say the exact word 'PAPAYA' on its own line in your response.",
      );
      await run;
      expectAnswer(live.h);

      const records = sessionRecords(log.since(mark), live.projectDir);

      // Parallel results usually share one user record, so count the results themselves.
      const delivered = records
        .filter((r) => r.type === "user")
        .flatMap((r) => [
          ...JSON.stringify(r.message?.content ?? "").matchAll(/SlowTool completed after (\d+)ms/g),
        ])
        .map((match) => Number(match[1]))
        .toSorted((a, b) => a - b);

      expect(delivered, "a parallel tool result never reached Claude Code").toEqual([
        3000, 4000, 5000,
      ]);
      // pi drains steers between tool results too. Assert the transport fact, not an echo:
      // Claude Code delivers a drained steer as a system reminder inside the tool result,
      // which its own prompt-injection guidance tells the model to distrust.
      expect(sessionMentions(records, "PAPAYA"), "the steer was dropped between results").toBe(
        true,
      );
    },
    LIVE_TIMEOUT,
  );

  it(
    "never pushes a steer that arrives during a text-only reply into the running query",
    async () => {
      const live = await open();
      const mark = log.mark();

      const run = live.h.prompt(
        "Write exactly 12 short numbered sentences about the history of computing. Do NOT call any tools.",
      );

      await nextEvent(
        live.h,
        (event) =>
          event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
      );
      await live.h.session.steer(
        "After you finish, also say the exact word 'KIWI' on its own line.",
      );
      await run;

      expect(expectAnswer(live.h).toLowerCase()).toContain("kiwi");

      // No tool boundary to steer at, and the query's input has already ended.
      const written = log.since(mark);

      expect(written).not.toContain("steer written to CC stdin");
      expect(written).not.toContain("steer push rejected");
    },
    LIVE_TIMEOUT,
  );

  it(
    "kills Claude Code when pi aborts with a tool call in flight, then answers again",
    async () => {
      const live = await open();
      let cc: { pid: number; command: string }[] = [];

      try {
        const run = live.h.prompt("Call SlowTool with seconds=60.");

        await toolStarted(live);
        cc = claudeDescendants(process.pid);

        expect(
          cc.length,
          "no Claude Code subprocess while a tool call is in flight",
        ).toBeGreaterThan(0);

        // Claude Code survives stdin EOF while a tool call is parked: it reads the lost
        // MCP transport as a tool error and keeps calling the API. Nothing throws when
        // this regresses, so the assertion is on the process table.
        await live.h.session.abort();
        await run;

        const deadline = Date.now() + 5000;

        while (Date.now() < deadline && cc.some((p) => alive(p.pid))) await delay(200);

        expect(cc.filter((p) => alive(p.pid)).map((p) => `${p.pid} ${p.command}`)).toEqual([]);
      } finally {
        // A survivor bills API requests until something stops it.
        for (const p of cc) {
          try {
            process.kill(p.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }

      expect((await live.ask("Reply with just the word 'recovered'.")).toLowerCase()).toContain(
        "recovered",
      );
    },
    LIVE_TIMEOUT,
  );
});
