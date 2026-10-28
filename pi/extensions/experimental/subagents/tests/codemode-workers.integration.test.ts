import path from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { DEFAULT_CONFIG } from "../config.js";
import { Controller } from "../controller.js";
import { createChildRuntime } from "../runtime.js";
import { openTree } from "../store.js";

const WORKERS = "PI_CODEMODE_MAX_WORKERS";

const respond: FauxResponseStep = (context) =>
  context.messages.at(-1)?.role === "toolResult"
    ? fauxAssistantMessage("done")
    : fauxAssistantMessage(
        fauxToolCall("codemode", { code: "text(await tools.hold({}));" }),
        {
          stopReason: "toolUse",
        }
      );

describe("codemode workers", () => {
  const previous = {
    agentDir: process.env["PI_CODING_AGENT_DIR"],
    workers: process.env[WORKERS],
  };

  beforeEach(() => {
    Reflect.deleteProperty(process.env, WORKERS);
  });

  afterEach(() => {
    for (const [name, value] of [
      ["PI_CODING_AGENT_DIR", previous.agentDir],
      [WORKERS, previous.workers],
    ] as const) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  });

  it("runs a codemode script in every concurrent child at once", async () => {
    let rootCtx: ExtensionContext | undefined;

    const harness = await createAgentSessionHarness({
      extensionFactories: [
        (pi) => {
          pi.on("session_start", (_event, ctx) => {
            rootCtx = ctx;
          });
        },
      ],
    });

    process.env["PI_CODING_AGENT_DIR"] = harness.agentDir;

    if (rootCtx === undefined) {
      throw new Error("Missing fixture");
    }

    const ctx = rootCtx;
    const children = DEFAULT_CONFIG.maxConcurrent;

    harness.setResponses(Array.from({ length: children * 2 }, () => respond));

    const released = Promise.withResolvers<undefined>();
    let holding = 0;
    const errors: unknown[] = [];

    const controller = new Controller({
      config: DEFAULT_CONFIG,
      dataDir: path.join(harness.agentDir, "subagents"),
      deliverRoot: () => {},
      rootRunning: () => false,
      onBackgroundError: (cause) => {
        errors.push(cause);
      },
      createRuntime: async (request) =>
        await createChildRuntime({
          ...request,
          bridge: async (pi) => {
            await request.bridge(pi);
            pi.registerTool({
              name: "hold",
              label: "hold",
              description: "Holds until every child's script runs.",
              exposure: "codemode",
              parameters: Type.Object({}),
              execute: async () => {
                holding += 1;
                await released.promise;

                return {
                  content: [{ type: "text", text: "held" }],
                  details: undefined,
                };
              },
            });
          },
        }),
    });

    try {
      const opened = await openTree(
        path.join(harness.agentDir, "subagents"),
        ctx.sessionManager.getSessionId(),
        true
      );

      await controller.open(opened.store, opened.tree);

      for (let index = 0; index < children; index += 1) {
        await controller.spawn(
          "/root",
          {
            agentType: undefined,
            forkTurns: "none",
            message: "Run the script",
            model: undefined,
            taskName: `worker_${index}`,
            thinking: undefined,
            tools: ["codemode"],
          },
          ctx
        );
      }

      await vi.waitFor(
        () => {
          expect(holding).toBe(children);
        },
        {
          timeout: 5000,
        }
      );
      released.resolve(undefined);
      await vi.waitFor(
        () => {
          expect(
            controller
              .list("/root", undefined)
              .filter(({ agent_name }) => agent_name !== "/root")
          ).toMatchObject(
            Array.from({ length: children }, () => ({
              agent_status: { completed: "done" },
            }))
          );
        },
        { timeout: 3000 }
      );
      expect(errors).toStrictEqual([]);
    } finally {
      released.resolve(undefined);
      await controller.shutdown();
      harness.cleanup();
    }
  });
});
