import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { DEFAULT_CONFIG } from "../config.js";
import { Controller } from "../controller.js";
import { createChildRuntime } from "../runtime.js";
import type { ChildRuntime, ChildRuntimeRequest } from "../runtime.js";
import { openTree } from "../store.js";

describe("retired child selections", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  it.each(["completion", "interruption", "shutdown"])(
    "cold reuse keeps one-time native model/thinking changes made during %s retirement",
    async (ending) => {
      let rootCtx: ExtensionContext | undefined;

      const harness = await createAgentSessionHarness({
        models: [
          { id: "initial", reasoning: true },
          { id: "final", reasoning: true },
        ],
        extensionFactories: [
          (pi) => {
            pi.on("session_start", (_event, ctx) => {
              rootCtx = ctx;
            });
          },
        ],
      });

      process.env.PI_CODING_AGENT_DIR = harness.agentDir;
      const finalModel = harness.faux.getModel("final");

      if (rootCtx === undefined || finalModel === undefined) throw new Error("Missing fixture");
      const ctx = rootCtx;
      harness.session.setThinkingLevel("low");
      const started = Promise.withResolvers<undefined>();
      harness.setResponses([
        async (_context, options) => {
          started.resolve(undefined);

          if (ending !== "completion") {
            const signal = options?.signal;

            if (signal === undefined) throw new Error("Missing native abort signal");

            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }

          return fauxAssistantMessage("first outcome");
        },
        fauxAssistantMessage("reused outcome"),
      ]);

      const dataDir = path.join(harness.agentDir, "subagents");
      const requests: ChildRuntimeRequest[] = [];
      const runtimes: ChildRuntime[] = [];
      const errors: unknown[] = [];
      let mutations = 0;

      const controller = new Controller({
        config: DEFAULT_CONFIG,
        dataDir,
        deliverRoot: () => {},
        rootRunning: () => false,
        onBackgroundError: (cause) => errors.push(cause),
        createRuntime: async (request) => {
          requests.push(request);

          const runtime = await createChildRuntime({
            ...request,
            bridge: async (pi) => {
              await request.bridge(pi);
              pi.on("session_shutdown", async (_event, childCtx) => {
                if (
                  childCtx.sessionManager
                    .getBranch()
                    .some(
                      (entry) => entry.type === "custom" && entry.customType === "selection-once",
                    )
                )
                  return;

                if (!(await pi.setModel(finalModel))) throw new Error("Native selection failed");
                pi.setThinkingLevel("high");
                pi.appendEntry("selection-once", true);
                mutations += 1;
              });
            },
          });

          runtimes.push(runtime);

          return runtime;
        },
      });

      try {
        const sessionId = ctx.sessionManager.getSessionId();
        const opened = await openTree(dataDir, sessionId, true);
        await controller.open(opened.store, opened.tree);
        await controller.spawn(
          "/root",
          {
            agentType: undefined,
            forkTurns: "none",
            message: "First work",
            model: undefined,
            taskName: "worker",
            thinking: undefined,
            tools: [],
          },
          ctx,
        );
        await started.promise;

        if (ending === "interruption") await controller.interrupt("/root", "worker");

        if (ending === "shutdown") await controller.shutdown();
        else await vi.waitFor(() => expect(mutations).toBe(1));

        await controller.shutdown();
        const saved = await openTree(dataDir, sessionId, true);
        expect(saved.tree.nodes[0]).toMatchObject({
          model: `${finalModel.provider}/final`,
          thinking: "high",
        });
        await controller.open(saved.store, saved.tree);
        await controller.followUp("/root", "worker", "Cold reuse", ctx);

        // The explicit cold-start arguments are the critical contract: native saved entries
        // cannot repair stale overrides, and the mutation is never reapplied at startup.
        expect(requests[1]?.model.id).toBe("final");
        expect(requests[1]?.thinkingLevel).toBe("high");
        expect(runtimes[1]?.model).toBe(`${finalModel.provider}/final`);
        expect(runtimes[1]?.thinkingLevel).toBe("high");
        await vi.waitFor(() =>
          expect(controller.list("/root", "worker")).toMatchObject([
            { agent_status: { completed: "reused outcome" } },
          ]),
        );
        await controller.shutdown();
        expect(mutations).toBe(1);
        expect(errors).toStrictEqual([]);
        expect(harness.session.model?.id).toBe("initial");
        expect(harness.session.thinkingLevel).toBe("low");
      } finally {
        await controller.shutdown();
        harness.cleanup();
      }
    },
  );
});
