import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { SubagentsConfig } from "../config.js";
import { SubagentManager } from "../manager.js";
import {
  createControlStore,
  freshSnapshot,
  rootBinding,
  serializeSnapshot,
} from "../snapshot.js";
import { V1Controller } from "../v1/controller.js";
import { V2Controller } from "../v2/controller.js";

const V1 = [
  "close_agent",
  "resume_agent",
  "send_input",
  "spawn_agent",
  "wait_agent",
];
const V2 = [
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "send_message",
  "spawn_agent",
  "wait_agent",
];
const model = (version?: "disabled" | "v1" | "v2") =>
  ({
    id: version ?? "undeclared",
    ...(version === undefined ? {} : { multiAgentVersion: version }),
    provider: "test",
  }) as unknown as Model<Api>;

const extension =
  (config: SubagentsConfig, dataDir = "/tmp/subagents-index-test") =>
  (pi: ExtensionAPI): void => {
    const manager = new SubagentManager(pi, {
      config,
      dataDir,
    });
    pi.on("session_start", manager.start.bind(manager));
    pi.on("before_agent_start", manager.beforeAgentStart.bind(manager));
    pi.on("model_select", manager.modelSelect.bind(manager));
    pi.on("tool_call", manager.toolCall.bind(manager));
    pi.registerCommand("agents", {
      description: "Show the durable subagent tree",
      handler: (_args, ctx) => {
        ctx.ui.notify(manager.describe(), "info");
        return Promise.resolve();
      },
    });
  };

describe("subagents extension selection", () => {
  it("defaults undeclared models to V1", async () => {
    const host = createExtensionHost(
      extension(structuredClone(DEFAULT_CONFIG)),
      {
        model: model(),
      }
    );
    await host.ready;
    await host.emitSessionStart();
    expect(
      host
        .getActiveTools()
        .filter((name) => V1.includes(name))
        .toSorted()
    ).toStrictEqual(V1);
  });

  it("projects V2 from provider model metadata", async () => {
    const host = createExtensionHost(
      extension(structuredClone(DEFAULT_CONFIG)),
      {
        model: model("v2"),
      }
    );
    await host.ready;
    await host.emitSessionStart();
    expect(
      host
        .getActiveTools()
        .filter((name) => V2.includes(name))
        .toSorted()
    ).toStrictEqual(V2);
  });

  it("locks disabled during first-turn setup", async () => {
    const host = createExtensionHost(
      extension(structuredClone(DEFAULT_CONFIG)),
      {
        model: model("disabled"),
      }
    );
    await host.ready;
    const ctx = host.createContext();
    await host.emitSessionStart(ctx);
    await host.emit(
      "before_agent_start",
      {
        systemPrompt: "system",
        systemPromptOptions: {},
        type: "before_agent_start",
      },
      ctx
    );
    expect(
      host
        .getActiveTools()
        .filter((name) => V1.includes(name) || V2.includes(name))
    ).toStrictEqual([]);
  });

  it("updates the unlocked tree before the first turn when the protocol changes", async () => {
    const v1 = model("v1");
    const v2 = model("v2");
    const host = createExtensionHost(
      extension(structuredClone(DEFAULT_CONFIG)),
      {
        model: v1,
      }
    );
    await host.ready;
    const v1Context = host.createContext({ model: v1 });
    await host.emitSessionStart(v1Context);

    const v2Context = host.createContext({ model: v2 });
    await host.emit(
      "model_select",
      {
        model: v2,
        previousModel: v1,
        source: "set",
        type: "model_select",
      },
      v2Context
    );
    await host.runCommand("agents", "", v2Context);

    expect(host.getNotifications()).toContainEqual({
      message: expect.stringMatching(/^unlocked V2\n\/root {2}completed/u),
      type: "info",
    });
    expect(
      host
        .getActiveTools()
        .filter((name) => V2.includes(name))
        .toSorted()
    ).toStrictEqual(V2);

    await host.emit(
      "before_agent_start",
      {
        systemPrompt: "system",
        systemPromptOptions: {},
        type: "before_agent_start",
      },
      v2Context
    );
    await host.runCommand("agents", "", v2Context);

    expect(host.getNotifications()).toContainEqual({
      message: expect.stringMatching(/^locked V2\n\/root {2}completed/u),
      type: "info",
    });
  });

  it("consumes a pending restore before invoking its controller", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "subagents-manager-"));
    const sessionFile = path.join(dataDir, "session.jsonl");
    const sessionId = "restore-once";
    const binding = rootBinding(sessionId, sessionFile);
    const store = createControlStore(dataDir, binding);
    await store.write(serializeSnapshot(freshSnapshot("v2", binding)), () => {
      // The fixture only needs the committed control file.
    });
    const restore = vi
      .spyOn(V2Controller.prototype, "restore")
      .mockResolvedValue();

    try {
      const selectedModel = model("v2");
      const host = createExtensionHost(
        extension(structuredClone(DEFAULT_CONFIG), dataDir),
        {
          model: selectedModel,
          sessionId,
        }
      );
      await host.ready;
      const base = host.createContext({ model: selectedModel });
      const ctx = host.createContext({
        model: selectedModel,
        sessionManager: {
          ...base.sessionManager,
          getSessionFile: () => sessionFile,
        },
      });
      await host.emitSessionStart(ctx);
      const event = {
        systemPrompt: "system",
        systemPromptOptions: {},
        type: "before_agent_start" as const,
      };

      await host.emit("before_agent_start", event, ctx);
      await host.emit("before_agent_start", event, ctx);

      expect(restore).toHaveBeenCalledOnce();
    } finally {
      restore.mockRestore();
      await rm(dataDir, { force: true, recursive: true });
    }
  });

  it("waits for an in-flight root acknowledgement during shutdown", async () => {
    const acknowledgement = Promise.withResolvers<null>();
    let deliveryAvailable = true;
    const rootDeliveries = vi
      .spyOn(V1Controller.prototype, "rootDeliveries")
      .mockImplementation(() =>
        deliveryAvailable
          ? [{ agentId: "agent-1", content: "done", id: "notification-1" }]
          : []
      );
    const acknowledgeRoot = vi
      .spyOn(V1Controller.prototype, "acknowledgeRoot")
      .mockImplementation(async () => {
        deliveryAvailable = false;
        await acknowledgement.promise;
      });

    try {
      const host = createExtensionHost((pi) => {
        const manager = new SubagentManager(pi, {
          config: structuredClone(DEFAULT_CONFIG),
          dataDir: "/tmp/subagents-shutdown-test",
        });
        pi.on("session_start", manager.start.bind(manager));
        pi.on("session_shutdown", manager.shutdown.bind(manager));
      });
      await host.ready;
      await host.emitSessionStart();
      await vi.waitFor(() => expect(acknowledgeRoot).toHaveBeenCalledOnce());

      let stopped = false;
      const shutdown = host.emitSessionShutdown().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBeFalsy();

      acknowledgement.resolve(null);
      await shutdown;
      expect(stopped).toBeTruthy();
    } finally {
      rootDeliveries.mockRestore();
      acknowledgeRoot.mockRestore();
    }
  });
});
