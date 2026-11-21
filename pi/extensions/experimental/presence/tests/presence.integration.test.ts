import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { PARKED_CHANNEL } from "@clanker-stuff/presence-protocol";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import extension from "../index.js";
import { presenceDir, recordFile, recordSchema } from "../record.js";
import { verdictOf } from "../verdict.js";

const current = async () =>
  Value.Parse(
    recordSchema,
    JSON.parse(await readFile(recordFile(presenceDir(), process.pid), "utf8"))
  );

const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean) => {
  const deadline = Date.now() + 5000;

  for (;;) {
    const value = await read().catch(() => undefined);

    if (value !== undefined && ok(value)) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the presence record");
    }

    await delay(20);
  }
};

const wordNow = async () => verdictOf(await current(), true, Date.now()).word;

describe("a session's presence", () => {
  it("is working mid-tool, waiting once idle, working while parked, and stopped after quit", async () => {
    const { promise: held, resolve: release } =
      Promise.withResolvers<undefined>();

    const probe = (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "slow",
        label: "Slow",
        description: "Takes until released.",
        parameters: Type.Object({}),
        execute: async () => {
          await held;

          return { content: [{ type: "text", text: "done" }], details: {} };
        },
      });
      pi.registerTool({
        name: "park",
        label: "Park",
        description: "Parks work elsewhere.",
        parameters: Type.Object({}),
        execute: async () => {
          pi.events.emit(PARKED_CHANNEL, {
            source: "test",
            items: [{ id: "p1", about: "the nightly build" }],
          });

          return { content: [{ type: "text", text: "parked" }], details: {} };
        },
      });
    };

    const h = await createAgentSessionHarness({
      extensionFactories: [extension, probe],
      mode: "rpc",
    });

    try {
      h.session.setSessionName("kiwi");
      h.setResponses([
        fauxAssistantMessage(fauxToolCall("slow", {}), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Finished."),
      ]);

      const running = h.prompt("Run the slow thing");
      const busy = await until(current, (r) => r.tool === "slow");

      expect(busy.name).toBe("kiwi");
      expect(verdictOf(busy, true, Date.now()).word).toBe("working");

      release(undefined);
      await running;
      await until(wordNow, (word) => word === "waiting");

      h.setResponses([
        fauxAssistantMessage(fauxToolCall("park", {}), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Parked it."),
      ]);
      await h.prompt("Park the build");

      const parked = await until(
        current,
        (r) => r.activity === "idle" && r.parked.length > 0
      );

      expect(verdictOf(parked, true, Date.now())).toStrictEqual({
        word: "working",
        detail: "parked on the nightly build",
      });
    } finally {
      await h.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      h.cleanup();
    }

    await expect(wordNow()).resolves.toBe("stopped");
  });
});
