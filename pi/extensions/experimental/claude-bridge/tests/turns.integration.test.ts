// Live: conversations through real Claude Code. Each test bills the user's Claude
// subscription; run with CLAUDE_BRIDGE_LIVE=1 (see live.ts).

import { readFileSync } from "node:fs";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  LIVE,
  LIVE_TIMEOUT,
  createLiveSession,
  liveEnvironment,
  syncResults,
  type DebugLog,
  type LiveSession,
} from "./live.js";

// 32x32 solid crimson PNG: a colour the model can name unambiguously.
const CRIMSON_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4I2JDU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULADahsD1ndvqVAAAAAElFTkSuQmCC";

describe.skipIf(!LIVE)("claude-bridge live conversations", () => {
  let env: ReturnType<typeof liveEnvironment>;
  let log: DebugLog;
  const sessions: LiveSession[] = [];

  const open = async (options?: Parameters<typeof createLiveSession>[0]) => {
    const session = await createLiveSession(options);

    sessions.push(session);

    return session;
  };

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
    "answers through Claude Code with pi's custom system prompt applied",
    async () => {
      const live = await open({
        systemPrompt: "End every reply with the word BANANA on its own line.",
      });

      const text = await live.ask("What is 2 + 2? Reply with just the number.");

      expect(text).toMatch(/4/);
      // Claude Code replaces pi's prompt with its own; only the custom part is appended.
      expect(text.trim()).toMatch(/BANANA\W*$/);
    },
    LIVE_TIMEOUT,
  );

  it(
    "resumes one Claude Code session across turns, keeping the prompt cache warm",
    async () => {
      const live = await open();
      const scratch = path.join(live.h.tempDir, "secret.txt");
      const mark = log.mark();

      await live.ask("The secret number is 42. Acknowledge briefly.");
      await live.ask(`Write the secret number to ${scratch}. Just the number, nothing else.`);
      await live.ask("What is 42 * 2? Just the number.");
      await live.ask(`Read ${scratch} and tell me what's in it.`);

      const text = await live.ask(
        "What was the secret number, what did you write, what did you read, and what was 42*2? One per line.",
      );

      expect(readFileSync(scratch, "utf8").trim()).toBe("42");
      expect(text).toMatch(/42/);
      expect(text).toMatch(/84/);

      const toolNames = live.h
        .messages()
        .flatMap((m) => (m.role === "toolResult" ? [m.toolName] : []));

      expect(toolNames).toEqual(expect.arrayContaining(["write", "read"]));

      // Consecutive same-provider turns resume the session (Case 3). A rebuild would
      // reset prompt caching: the off-by-one cursor bug made every follow-up rebuild.
      const syncs = syncResults(log.since(mark));

      expect(syncs.filter((s) => s.path === "clean-start")).toHaveLength(1);
      expect(syncs.filter((s) => s.path === "rebuild")).toEqual([]);

      const reuses = syncs.filter((s) => s.path === "reuse");

      expect(reuses.length).toBeGreaterThanOrEqual(2);
      expect(new Set(reuses.map((s) => s.sessionId)).size).toBe(1);

      // From the third model call on, the system prompt and history are cache hits:
      // cacheRead never drops, and it is at least 90% of the input.
      const usages = live.h.messages().flatMap((m) => (m.role === "assistant" ? [m.usage] : []));

      for (const [index, usage] of usages.entries()) {
        if (index < 2) continue;

        const total = usage.input + usage.cacheRead + usage.cacheWrite;
        const label = `model call ${index + 1}: ${JSON.stringify(usage)}`;

        expect(usage.cacheRead, label).toBeGreaterThanOrEqual(usages[index - 1]?.cacheRead ?? 0);
        expect(usage.cacheRead / total, label).toBeGreaterThanOrEqual(0.9);
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    "rebuilds the same Claude Code session in place after pi compacts",
    async () => {
      // Three one-word exchanges fit in any realistic budget, leaving nothing to compact.
      const live = await open({ settings: { compaction: { keepRecentTokens: 1 } } });
      const mark = log.mark();

      await live.ask(
        "Pick a number between 1 and 100 and remember it. Reply with just the number.",
      );
      await live.ask("Now pick a colour. Reply with just the colour.");
      await live.ask("Now pick a fruit. Reply with just the fruit.");
      await live.h.session.compact();

      expect(await live.ask("Are you still there? Reply with just 'yes'.")).toMatch(/yes/i);

      // Split at the rewrite marker: the summary call before it legitimately used the
      // pre-compact session; the next prompt after it must not.
      const written = log.since(mark);
      const marker = written.indexOf("session_compact:");

      expect(marker, "no session_compact marker: the handler is not subscribed").not.toBe(-1);

      const before = syncResults(written.slice(0, marker)).filter((s) => s.path !== "clean-start");
      const [first] = syncResults(written.slice(marker));

      expect(before.at(-1)?.sessionId).toBeDefined();
      // REUSE would resume the pre-compact transcript (and thrash Claude Code's own
      // autocompact); a rotated id would orphan the old file under ~/.claude/projects.
      expect(first).toEqual({
        path: "rebuild",
        sessionId: before.at(-1)?.sessionId,
        flavor: "preserved",
      });
    },
    LIVE_TIMEOUT,
  );

  it(
    "carries turns another provider answered into Claude Code's session",
    async () => {
      const live = await open();

      await live.useFaux();
      live.h.setResponses([fauxAssistantMessage("Noted.")]);
      await live.ask("The first word is 'quokka'. The second word comes later.");

      await live.useBridge();

      let mark = log.mark();

      const second = await live.ask(
        "The second word is 'tamarind'. What are the first and second words? Reply with just the two words.",
      );

      expect(second.toLowerCase()).toContain("quokka");
      expect(second.toLowerCase()).toContain("tamarind");

      // The first bridge turn imports the faux turn as history (Case 2).
      const [imported] = syncResults(log.since(mark));

      expect(imported).toMatchObject({ path: "rebuild", flavor: "first" });

      await live.useFaux();
      live.h.setResponses([fauxAssistantMessage("Noted.")]);
      await live.ask("The third word is 'zeppelin'.");

      await live.useBridge();
      mark = log.mark();

      const third = await live.ask(
        "List the first, second, and third words. Reply with just the three words.",
      );

      expect(third.toLowerCase()).toContain("quokka");
      expect(third.toLowerCase()).toContain("tamarind");
      expect(third.toLowerCase()).toContain("zeppelin");

      // Returning after missed turns rewrites the session under the same id (Case 4).
      const [resumed] = syncResults(log.since(mark));

      expect(resumed).toEqual({
        path: "rebuild",
        sessionId: imported?.sessionId,
        flavor: "preserved",
      });
    },
    LIVE_TIMEOUT,
  );

  it(
    "imports an image another provider received",
    async () => {
      const live = await open();

      await live.useFaux();
      live.h.setResponses([fauxAssistantMessage("Got it.")]);
      await live.h.prompt("Here is an image. Just acknowledge it.", {
        images: [{ type: "image", data: CRIMSON_PNG, mimeType: "image/png" }],
      });

      await live.useBridge();

      const answer = await live.ask(
        "What colour is the image I sent earlier? Answer with a single lowercase colour word.",
      );

      // Only the first word counts: "I can't see an image, it was an error" contains "red".
      expect(["red", "crimson"]).toContain(answer.toLowerCase().match(/[a-z]+/)?.[0]);
    },
    LIVE_TIMEOUT,
  );
});
