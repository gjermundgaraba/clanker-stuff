import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import type { AgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import subagents from "../index.js";
import { SUBAGENT_WAKE_TYPE } from "../manager.js";
import { SUBAGENT_MESSAGE_TYPE, TreeSchema } from "../protocol.js";
import type { Tree } from "../protocol.js";

const treeFile = (sessionId: string) =>
  path.join(
    getExtensionStoragePaths("subagents").dataDir,
    "trees-v4",
    `${createHash("sha256").update(sessionId).digest("hex")}.json`,
  );

const readTree = async (harness: AgentSessionHarness): Promise<Tree> => {
  const parsed: unknown = JSON.parse(
    await readFile(treeFile(harness.sessionManager.getSessionId()), "utf-8"),
  );

  return Value.Parse(TreeSchema, parsed);
};

/** Routes each provider request to the root or child script, since both share one faux provider. */
const script = (
  harness: AgentSessionHarness,
  root: FauxResponseStep[],
  child: FauxResponseStep[] = [],
) => {
  const requests = { child: 0, root: 0 };
  const total = root.length + child.length;

  harness.setResponses(
    Array.from(
      { length: total },
      (): FauxResponseStep => async (context, options, state, model) => {
        const isChild = getCurrentSystemPrompt(context.messages).includes("You are subagent");
        const queue = isChild ? child : root;
        requests[isChild ? "child" : "root"] += 1;
        const step = queue.shift();

        if (step === undefined) {
          throw new Error(`Unexpected ${isChild ? "child" : "root"} provider request`);
        }

        return typeof step === "function" ? await step(context, options, state, model) : step;
      },
    ),
  );

  return requests;
};

const spawnWorker = fauxAssistantMessage(
  fauxToolCall("spawn_agent", { fork_turns: "none", message: "Investigate.", task_name: "worker" }),
  { stopReason: "toolUse" },
);

const mailEntries = (harness: AgentSessionHarness) =>
  harness.sessionManager
    .getEntries()
    .filter(
      (entry) => entry.type === "custom_message" && entry.customType === SUBAGENT_MESSAGE_TYPE,
    );

const harnessWith = async (
  options: Parameters<typeof createAgentSessionHarness>[0] = {},
  wakeOnFinalAnswer = true,
  rootMailDelivered?: () => void,
) =>
  await createAgentSessionHarness({
    ...options,
    extensionFactories: [
      async (pi) => {
        const configFile = getExtensionStoragePaths("subagents").configFile;

        if (wakeOnFinalAnswer) {
          await rm(configFile, { force: true });
        } else {
          await mkdir(path.dirname(configFile), { recursive: true });
          await writeFile(configFile, JSON.stringify({ version: 2, wake_on_final_answer: false }));
        }

        await subagents({
          ...pi,
          sendMessage(message, options) {
            pi.sendMessage(message, options);

            if (message.customType === SUBAGENT_MESSAGE_TYPE) rootMailDelivered?.();
          },
        });
      },
      ...(options.extensionFactories ?? []),
    ],
  });

const shutdown = async (harness: AgentSessionHarness) => {
  await harness.session.extensionRunner.emit({ reason: "quit", type: "session_shutdown" });
  harness.cleanup();
};

const wakeEntries = (harness: AgentSessionHarness) =>
  harness.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom_message" && entry.customType === SUBAGENT_WAKE_TYPE);

describe("root delivery", () => {
  it.each([false, true])(
    "wakes an idle root by default and keeps hook sections after a tool (child failed: %s)",
    async (failed) => {
      const starts: { messageType: string; idle: boolean }[] = [];

      const harness = await harnessWith({
        extensionFactories: [
          (pi) => {
            pi.on("before_agent_start", (event, ctx) => {
              starts.push({ messageType: event.messageType, idle: ctx.isIdle() });
              event.systemPromptOptions.sections["wake_test"] = `wake-${event.messageType}`;
            });
          },
        ],
      });

      const release = Promise.withResolvers<undefined>();

      try {
        const requests = script(
          harness,
          [
            spawnWorker,
            fauxAssistantMessage("root final"),
            (context) => {
              const prompt = getCurrentSystemPrompt(context.messages);
              expect(prompt).toContain("wake-custom");
              expect(prompt).toContain("You are /root");
              expect(JSON.stringify(context.messages)).toContain(
                failed ? "child failed" : "child answer",
              );

              return fauxAssistantMessage(fauxToolCall("list_agents", {}), {
                stopReason: "toolUse",
              });
            },
            (context) => {
              expect(getCurrentSystemPrompt(context.messages)).toContain("wake-custom");

              return fauxAssistantMessage("root continued");
            },
          ],
          [
            async () => {
              await release.promise;

              return failed
                ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "child failed" })
                : fauxAssistantMessage("child answer");
            },
          ],
        );

        await harness.prompt("Delegate.");
        expect(starts).toStrictEqual([{ messageType: "user", idle: false }]);
        release.resolve(undefined);
        await vi.waitFor(() => {
          expect(harness.session.getLastAssistantText()).toBe("root continued");
          expect(harness.session.isIdle).toBe(true);
        });
        expect(starts).toStrictEqual([
          { messageType: "user", idle: false },
          { messageType: "custom", idle: false },
        ]);
        expect(requests).toStrictEqual({ child: 1, root: 4 });
        expect(wakeEntries(harness)).toHaveLength(1);
        expect(mailEntries(harness)).toHaveLength(1);
      } finally {
        release.resolve(undefined);
        await shutdown(harness);
      }
    },
  );

  it.each([false, true])(
    "handles a final answer arriving during the last root request (enabled: %s)",
    async (enabled) => {
      const delivered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<undefined>();
      const harness = await harnessWith({}, enabled, () => delivered.resolve());

      try {
        const requests = script(
          harness,
          [
            spawnWorker,
            async (context) => {
              expect(JSON.stringify(context.messages)).not.toContain("late child answer");
              release.resolve(undefined);
              await delivered.promise;

              return fauxAssistantMessage("root final before mail");
            },
            (context) => {
              expect(JSON.stringify(context.messages)).toContain("late child answer");

              return fauxAssistantMessage("root reviewed late mail");
            },
          ],
          [
            async () => {
              await release.promise;

              return fauxAssistantMessage("late child answer");
            },
          ],
        );

        await harness.prompt("Delegate.");

        expect(requests).toStrictEqual({ child: 1, root: enabled ? 3 : 2 });
        expect(harness.session.getLastAssistantText()).toBe(
          enabled ? "root reviewed late mail" : "root final before mail",
        );
        await delay(200);
        expect(requests.root).toBe(enabled ? 3 : 2);
        expect(wakeEntries(harness)).toHaveLength(0);
        expect(mailEntries(harness)).toHaveLength(1);
        expect(harness.session.isIdle).toBe(true);
      } finally {
        release.resolve(undefined);
        await shutdown(harness);
      }
    },
  );

  it("does not continue again when a later root request already included the answer", async () => {
    const delivered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<undefined>();
    const harness = await harnessWith({}, true, () => delivered.resolve());

    try {
      const requests = script(
        harness,
        [
          spawnWorker,
          async () => {
            release.resolve(undefined);
            await delivered.promise;

            return fauxAssistantMessage(fauxToolCall("list_agents", {}), { stopReason: "toolUse" });
          },
          (context) => {
            expect(JSON.stringify(context.messages)).toContain("already offered answer");

            return fauxAssistantMessage("root naturally reviewed mail");
          },
        ],
        [
          async () => {
            await release.promise;

            return fauxAssistantMessage("already offered answer");
          },
        ],
      );

      await harness.prompt("Delegate.");
      await delay(200);
      expect(harness.session.getLastAssistantText()).toBe("root naturally reviewed mail");
      expect(requests).toStrictEqual({ child: 1, root: 3 });
      expect(wakeEntries(harness)).toHaveLength(0);
      expect(mailEntries(harness)).toHaveLength(1);
    } finally {
      release.resolve(undefined);
      await shutdown(harness);
    }
  });

  it("respects a context transform that deliberately omits the mail without repeating requests", async () => {
    const delivered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<undefined>();

    const harness = await harnessWith(
      {
        extensionFactories: [
          (pi) => {
            pi.on("context", (event) => ({
              messages: event.messages.filter(
                (message) =>
                  message.role !== "custom" || message.customType !== SUBAGENT_MESSAGE_TYPE,
              ),
            }));
          },
        ],
      },
      true,
      () => delivered.resolve(),
    );

    try {
      const requests = script(
        harness,
        [
          spawnWorker,
          async () => {
            release.resolve(undefined);
            await delivered.promise;

            return fauxAssistantMessage("root final before mail");
          },
          (context) => {
            expect(JSON.stringify(context.messages)).not.toContain("filtered child answer");

            return fauxAssistantMessage("root followed its context policy");
          },
        ],
        [
          async () => {
            await release.promise;

            return fauxAssistantMessage("filtered child answer");
          },
        ],
      );

      await harness.prompt("Delegate.");
      await delay(200);
      expect(harness.session.getLastAssistantText()).toBe("root followed its context policy");
      expect(requests).toStrictEqual({ child: 1, root: 3 });
      expect(wakeEntries(harness)).toHaveLength(0);
      expect(mailEntries(harness)).toHaveLength(1);
    } finally {
      release.resolve(undefined);
      await shutdown(harness);
    }
  });

  it("batches close completions into one wake", async () => {
    const harness = await harnessWith();
    const release = Promise.withResolvers<undefined>();

    const childAnswer = async () => {
      await release.promise;

      return fauxAssistantMessage("child answer");
    };

    try {
      const requests = script(
        harness,
        [
          fauxAssistantMessage(
            ["a", "b"].map((task_name) =>
              fauxToolCall("spawn_agent", {
                fork_turns: "none",
                message: "Investigate.",
                task_name,
              }),
            ),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("root final"),
          fauxAssistantMessage("both answers received"),
        ],
        [childAnswer, childAnswer],
      );

      await harness.prompt("Delegate two tasks.");
      await vi.waitFor(() => expect(requests.child).toBe(2));
      release.resolve(undefined);
      await vi.waitFor(() => {
        expect(harness.session.getLastAssistantText()).toBe("both answers received");
        expect(harness.session.isIdle).toBe(true);
      });
      expect(wakeEntries(harness)).toHaveLength(1);
      expect(wakeEntries(harness)[0]).toHaveProperty(
        "content",
        expect.stringContaining("2 child final answers"),
      );
      expect(mailEntries(harness)).toHaveLength(2);
      expect(requests.root).toBe(3);
    } finally {
      release.resolve(undefined);
      await shutdown(harness);
    }
  });

  it("keeps ordinary child messages passive, then wakes for the final answer", async () => {
    const harness = await harnessWith();
    const releaseMessage = Promise.withResolvers<undefined>();
    const releaseFinal = Promise.withResolvers<undefined>();

    try {
      const requests = script(
        harness,
        [spawnWorker, fauxAssistantMessage("root final"), fauxAssistantMessage("root continued")],
        [
          async () => {
            await releaseMessage.promise;

            return fauxAssistantMessage(
              fauxToolCall("send_message", {
                target: "/root",
                message: "child progress",
              }),
              { stopReason: "toolUse" },
            );
          },
          async () => {
            await releaseFinal.promise;

            return fauxAssistantMessage("child answer");
          },
        ],
      );

      await harness.prompt("Delegate.");
      releaseMessage.resolve(undefined);
      await vi.waitFor(() => expect(mailEntries(harness)).toHaveLength(1));
      await delay(150); // Cross the wake batching window, with the child still running.
      expect(wakeEntries(harness)).toHaveLength(0);
      expect(requests.root).toBe(2);
      releaseFinal.resolve(undefined);
      await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("root continued"));
      expect(wakeEntries(harness)).toHaveLength(1);
      expect(mailEntries(harness)).toHaveLength(2);
    } finally {
      releaseMessage.resolve(undefined);
      releaseFinal.resolve(undefined);
      await shutdown(harness);
    }
  });

  it("holds an idle wake while an extension dialog is open", async () => {
    const harness = await harnessWith();
    const release = Promise.withResolvers<undefined>();
    const answer = Promise.withResolvers<string | undefined>();
    let asking: Promise<string | undefined> | undefined;

    try {
      await harness.session.bindExtensions({
        mode: "tui",
        uiContext: {
          ...harness.session.extensionRunner.createToolContext("test", undefined).ui,
          select: () => answer.promise,
        },
      });

      const requests = script(
        harness,
        [spawnWorker, fauxAssistantMessage("root final"), fauxAssistantMessage("root continued")],
        [
          async () => {
            await release.promise;

            return fauxAssistantMessage("child answer");
          },
        ],
      );

      await harness.prompt("Delegate.");
      asking = harness.session.extensionRunner.getUIContext().select("Question", ["a"]);
      release.resolve(undefined);
      await vi.waitFor(() => expect(mailEntries(harness)).toHaveLength(1));
      await delay(150);
      expect(wakeEntries(harness)).toHaveLength(0);
      expect(requests.root).toBe(2);
      answer.resolve("a");
      await asking;
      await vi.waitFor(
        () => expect(harness.session.getLastAssistantText()).toBe("root continued"),
        { timeout: 2500 },
      );
      expect(wakeEntries(harness)).toHaveLength(1);
    } finally {
      release.resolve(undefined);
      answer.resolve(undefined);
      await asking;
      await shutdown(harness);
    }
  });

  it.each(["success", "failure", "abort"] as const)(
    "defers waking through manual compaction (%s)",
    async (outcome) => {
      const blocked = Promise.withResolvers<void>();
      const releaseCompact = Promise.withResolvers<void>();
      const releaseChild = Promise.withResolvers<undefined>();

      const harness = await harnessWith({
        settings: {
          compaction: { enabled: false, keepRecentTokens: 1 },
          retry: { enabled: false },
        },
        extensionFactories: [
          (pi) => {
            pi.on("session_before_compact", async ({ preparation }) => {
              blocked.resolve();
              await releaseCompact.promise;

              if (outcome === "failure") return;

              return {
                compaction: {
                  summary: "compacted",
                  firstKeptEntryId: preparation.firstKeptEntryId,
                  tokensBefore: preparation.tokensBefore,
                },
              };
            });
          },
        ],
      });

      let compacting: Promise<unknown> | undefined;

      try {
        script(
          harness,
          [
            spawnWorker,
            fauxAssistantMessage("root final"),
            ...(outcome === "failure"
              ? [
                  fauxAssistantMessage("", {
                    stopReason: "error",
                    errorMessage: "compaction failed",
                  }),
                ]
              : []),
            fauxAssistantMessage("root continued"),
          ],
          [
            async () => {
              await releaseChild.promise;

              return fauxAssistantMessage("child answer");
            },
          ],
        );
        await harness.prompt("Delegate.");
        compacting = harness.session.compact().then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        await blocked.promise;
        releaseChild.resolve(undefined);
        await vi.waitFor(() => expect(mailEntries(harness)).toHaveLength(1));
        await delay(150);
        expect(harness.session.isIdle).toBe(false);
        expect(wakeEntries(harness)).toHaveLength(0);

        if (outcome === "abort") harness.session.abortCompaction();
        releaseCompact.resolve();
        await compacting;
        expect(await compacting).toHaveProperty(outcome === "success" ? "result" : "error");
        await vi.waitFor(
          () => expect(harness.session.getLastAssistantText()).toBe("root continued"),
          { timeout: 2500 },
        );
        expect(wakeEntries(harness)).toHaveLength(1);
      } finally {
        releaseCompact.resolve();
        releaseChild.resolve(undefined);
        await compacting;
        await shutdown(harness);
      }
    },
  );

  it("pauses on root abort until a user-started run, not an unrelated custom run", async () => {
    const harness = await harnessWith();
    const rootStarted = Promise.withResolvers<void>();
    const firstChild = Promise.withResolvers<undefined>();
    const nextChild = Promise.withResolvers<undefined>();

    try {
      const requests = script(
        harness,
        [
          spawnWorker,
          async (_context, options) => {
            const signal = options?.signal;
            assert.ok(signal);
            rootStarted.resolve();
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });

            return fauxAssistantMessage("must not appear");
          },
          fauxAssistantMessage("manual custom run"),
          fauxAssistantMessage(
            fauxToolCall("followup_task", {
              target: "worker",
              message: "Continue.",
            }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("resumed root"),
          fauxAssistantMessage("root continued"),
        ],
        [
          async () => {
            await firstChild.promise;

            return fauxAssistantMessage("first answer");
          },
          async () => {
            await nextChild.promise;

            return fauxAssistantMessage("next answer");
          },
        ],
      );

      const running = harness.prompt("Delegate.");
      await rootStarted.promise;
      await harness.session.abort();
      await running;
      await harness.session.sendCustomMessage(
        {
          customType: "test.custom",
          content: "Explicit custom run",
          display: false,
        },
        { triggerTurn: true },
      );
      firstChild.resolve(undefined);
      await vi.waitFor(() => expect(mailEntries(harness)).toHaveLength(1));
      await delay(150);
      expect(wakeEntries(harness)).toHaveLength(0);
      expect(requests.root).toBe(3);
      await harness.prompt("Resume and give the worker another task.");
      expect(harness.session.getLastAssistantText()).toBe("resumed root");
      nextChild.resolve(undefined);
      await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("root continued"));
      expect(requests.root).toBe(6);
      expect(wakeEntries(harness)).toHaveLength(1);
    } finally {
      firstChild.resolve(undefined);
      nextChild.resolve(undefined);
      await harness.session.abort();
      await shutdown(harness);
    }
  });

  it("appends child mail to an idle root without starting a turn when waking is disabled", async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "subagents-root-"));
    const harness = await harnessWith({ sessionDir }, false);
    const release = Promise.withResolvers<undefined>();

    try {
      const requests = script(
        harness,
        // The last root step is consumed only if delivery wrongly starts a turn.
        [spawnWorker, fauxAssistantMessage("root final"), fauxAssistantMessage("unexpected turn")],
        [
          async () => {
            await release.promise;

            return fauxAssistantMessage("child answer");
          },
        ],
      );

      await harness.prompt("Delegate this work.");
      release.resolve(undefined);

      await vi.waitFor(async () => {
        expect(await readTree(harness)).toMatchObject({
          nodes: [{ path: "/root/worker", status: "completed" }],
          outbox: [],
        });
      });

      await harness.session.waitForIdle();
      await delay(150);
      expect(wakeEntries(harness)).toHaveLength(0);
      expect(requests).toStrictEqual({ child: 1, root: 2 });
      expect(mailEntries(harness).map((entry) => JSON.stringify(entry))).toStrictEqual([
        expect.stringContaining("child answer"),
      ]);

      script(harness, [
        (context) => {
          expect(JSON.stringify(context.messages)).toContain("Message Type: FINAL_ANSWER");

          return fauxAssistantMessage("used");
        },
      ]);
      await harness.prompt("Use the result.");
    } finally {
      release.resolve(undefined);
      await shutdown(harness);
      await rm(sessionDir, { force: true, recursive: true });
    }
  });

  it("puts mail that arrives during wait_agent into the next request", async () => {
    const harness = await harnessWith();
    let finalRequest = "";

    try {
      script(
        harness,
        [
          spawnWorker,
          fauxAssistantMessage(fauxToolCall("wait_agent", { timeout_ms: 30_000 }), {
            stopReason: "toolUse",
          }),
          (context) => {
            finalRequest = JSON.stringify(context.messages);

            return fauxAssistantMessage("root final");
          },
        ],
        [fauxAssistantMessage("child answer")],
      );

      await harness.prompt("Delegate and wait.");

      expect(finalRequest).toContain("Sender: /root/worker\\nPayload:\\nchild answer");
      expect(mailEntries(harness)).toHaveLength(1);
      await delay(150);
      expect(wakeEntries(harness)).toHaveLength(0);
    } finally {
      await shutdown(harness);
    }
  });

  it("re-sends unacknowledged mail on resume without duplicating transcribed mail", async () => {
    const shared = await mkdtemp(path.join(os.tmpdir(), "subagents-resume-"));
    const sessionDir = path.join(shared, "sessions");
    const cwd = path.join(shared, "project");
    await mkdir(cwd);
    const first = await harnessWith({ cwd, sessionDir });
    const sessionId = first.sessionManager.getSessionId();

    const mail = (id: string, content: string) => ({
      content,
      from: "/root/worker",
      id,
      kind: "FINAL_ANSWER" as const,
      to: "/root",
    });

    try {
      first.setResponses([fauxAssistantMessage("hello")]);
      await first.prompt("Start a persisted session.");
      // Simulates a crash after Pi transcribed this mail but before the outbox was acknowledged.
      await first.session.sendCustomMessage(
        {
          content: "already transcribed",
          customType: SUBAGENT_MESSAGE_TYPE,
          details: mail("transcribed", "already transcribed"),
          display: false,
        },
        { triggerTurn: false },
      );
      await shutdown(first);

      await mkdir(path.dirname(treeFile(sessionId)), { recursive: true });

      const tree: Tree = {
        nodes: [],
        outbox: [mail("transcribed", "already transcribed"), mail("pending", "pending answer")],
        version: 4,
      };

      await writeFile(treeFile(sessionId), JSON.stringify(tree));

      const resumed = await harnessWith({ continueSession: true, cwd, sessionDir });

      try {
        expect(resumed.sessionManager.getSessionId()).toBe(sessionId);
        await vi.waitFor(async () => {
          expect((await readTree(resumed)).outbox).toStrictEqual([]);
        });

        const delivered = mailEntries(resumed).map((entry) => JSON.stringify(entry));
        expect(delivered.filter((entry) => entry.includes("already transcribed"))).toHaveLength(1);
        expect(delivered.filter((entry) => entry.includes("pending answer"))).toHaveLength(1);
        await delay(150);
        expect(wakeEntries(resumed)).toHaveLength(0);
      } finally {
        await shutdown(resumed);
      }
    } finally {
      await rm(shared, { force: true, recursive: true });
    }
  });

  it("replaces an unreadable tree with a fresh one", async () => {
    const shared = await mkdtemp(path.join(os.tmpdir(), "subagents-invalid-"));
    const sessionDir = path.join(shared, "sessions");
    const cwd = path.join(shared, "project");
    await mkdir(cwd);
    const first = await harnessWith({ cwd, sessionDir });
    const sessionId = first.sessionManager.getSessionId();

    try {
      first.setResponses([fauxAssistantMessage("hello")]);
      await first.prompt("Start a persisted session.");
      await shutdown(first);
      await mkdir(path.dirname(treeFile(sessionId)), { recursive: true });
      await writeFile(treeFile(sessionId), JSON.stringify({ nodes: "corrupt", version: 2 }));

      const resumed = await harnessWith({ continueSession: true, cwd, sessionDir });

      try {
        script(
          resumed,
          [spawnWorker, fauxAssistantMessage("root final")],
          [fauxAssistantMessage("done")],
        );
        await resumed.prompt("Delegate.");
        await vi.waitFor(async () => {
          expect(await readTree(resumed)).toMatchObject({
            nodes: [{ path: "/root/worker", status: "completed" }],
            version: 4,
          });
        });
      } finally {
        await shutdown(resumed);
      }
    } finally {
      await rm(shared, { force: true, recursive: true });
    }
  });
});
