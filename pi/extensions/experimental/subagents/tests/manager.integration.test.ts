import { createHash } from "node:crypto";
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
import { SUBAGENT_MESSAGE_TYPE, TreeSchema } from "../protocol.js";
import type { Tree } from "../protocol.js";

const treeFile = (sessionId: string) =>
  path.join(
    getExtensionStoragePaths("subagents").dataDir,
    "trees-v3",
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

const harnessWith = async (options: Parameters<typeof createAgentSessionHarness>[0] = {}) =>
  await createAgentSessionHarness({ ...options, extensionFactories: [subagents] });

const shutdown = async (harness: AgentSessionHarness) => {
  await harness.session.extensionRunner.emit({ reason: "quit", type: "session_shutdown" });
  harness.cleanup();
};

describe("root delivery", () => {
  it("appends child mail to an idle root without starting a turn", async () => {
    const sessionDir = await mkdtemp(path.join(os.tmpdir(), "subagents-root-"));
    const harness = await harnessWith({ sessionDir });
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
        version: 3,
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
            version: 3,
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
