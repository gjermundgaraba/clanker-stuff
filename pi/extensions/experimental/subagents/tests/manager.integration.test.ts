import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createAgentSessionHarness,
  type AgentSessionHarness,
} from "../../../../tests/harness/agent-session.js";
import subagents from "../index.js";
import { createControlStore, rootBinding } from "../snapshot.js";
import { V1_NOTIFICATION_TYPE } from "../v1/controller.js";
import { SUBAGENT_MESSAGE_TYPE } from "../v2/protocol.js";

const configuredHarness = async (
  protocol: "v1" | "v2",
  extensionFactories: ExtensionFactory[] = [],
  settings?: NonNullable<Parameters<typeof createAgentSessionHarness>[0]>["settings"],
  persist = true,
): Promise<{
  cleanup: () => Promise<void>;
  harness: AgentSessionHarness;
  shutdown: () => Promise<void>;
}> => {
  const agentDir = getAgentDir();
  const configFile = path.join(agentDir, "subagents.json");
  const sessionDir = path.join(
    agentDir,
    `subagents-manager-test-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(agentDir, { recursive: true });
  await writeFile(configFile, JSON.stringify({ protocols: { "*": protocol }, version: 1 }));
  const harness = await createAgentSessionHarness({
    extensionFactories: [subagents, ...extensionFactories],
    sessionDir: persist ? sessionDir : undefined,
    settings,
  });
  let shutDown = false;
  const shutdown = async () => {
    if (shutDown) {
      return;
    }
    shutDown = true;
    await harness.session.extensionRunner.emit({
      reason: "quit",
      type: "session_shutdown",
    });
    harness.cleanup();
  };
  return {
    async cleanup() {
      await shutdown();
      await rm(configFile, { force: true });
      await rm(sessionDir, { force: true, recursive: true });
    },
    harness,
    shutdown,
  };
};

const controlStore = (harness: AgentSessionHarness) => {
  const sessionFile = harness.sessionManager.getSessionFile();
  if (sessionFile === undefined) {
    throw new Error("Expected a persisted root session");
  }
  return createControlStore(
    getExtensionStoragePaths("subagents").dataDir,
    rootBinding(harness.sessionManager.getSessionId(), sessionFile),
  );
};

const controlFile = (harness: AgentSessionHarness) => {
  const sessionFile = harness.sessionManager.getSessionFile();
  if (sessionFile === undefined) {
    throw new Error("Expected a persisted root session");
  }
  const key = createHash("sha256")
    .update(`${path.resolve(sessionFile)}\0${harness.sessionManager.getSessionId()}`)
    .digest("hex");
  return path.join(getExtensionStoragePaths("subagents").dataDir, "trees", `${key}.json`);
};

const waitForChildCompletion = async (harness: AgentSessionHarness) => {
  const store = controlStore(harness);
  await vi.waitFor(async () => {
    const snapshot = await store.load();
    const status =
      snapshot?.protocolLatch === "v2"
        ? snapshot.state.nodes.find((node) => node.path === "/root/worker")?.status
        : snapshot?.protocolLatch === "v1"
          ? snapshot.state.agents[0]?.status
          : undefined;
    expect(status).toBe("completed");
  });
};

const waitForRootAcknowledgement = async (harness: AgentSessionHarness, protocol: "v1" | "v2") => {
  const store = controlStore(harness);
  await vi.waitFor(async () => {
    const snapshot = await store.load();
    expect(snapshot?.protocolLatch).toBe(protocol);
    const pending =
      snapshot?.protocolLatch === "v2" && protocol === "v2"
        ? snapshot.state.communications.filter(({ to }) => to === "/root")
        : snapshot?.protocolLatch === "v1" && protocol === "v1"
          ? snapshot.state.notifications
          : [];
    expect(pending).toHaveLength(0);
  });
};

const rootAgentEndBarrier = () => {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let rootSessionId: string | undefined;
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      rootSessionId ??= ctx.sessionManager.getSessionId();
    });
    pi.on("agent_end", async (_event, ctx) => {
      if (ctx.sessionManager.getSessionId() === rootSessionId) {
        reached.resolve();
        await released.promise;
      }
    });
  };
  return { extension, reached: reached.promise, release: released.resolve };
};

const rootFinalBarrier = () => {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let rootSessionId: string | undefined;
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      rootSessionId ??= ctx.sessionManager.getSessionId();
    });
    pi.on("message_end", async (event, ctx) => {
      if (
        ctx.sessionManager.getSessionId() === rootSessionId &&
        event.message.role === "assistant" &&
        JSON.stringify(event.message.content).includes("root final")
      ) {
        reached.resolve();
        await released.promise;
      }
    });
  };
  return { extension, reached: reached.promise, release: released.resolve };
};

const lastProviderPayloadText = (harness: AgentSessionHarness) =>
  JSON.stringify(harness.lastProviderPayload(Type.Object({}, { additionalProperties: true })));

describe("root subagent delivery", () => {
  it("defers a V2 completion after a final answer without starting another response", async () => {
    const rootAgentEnd = rootAgentEndBarrier();
    const childRelease = Promise.withResolvers<null>();
    const { cleanup, harness } = await configuredHarness("v2", [rootAgentEnd.extension]);

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_turns: "none",
            message: "Investigate the race.",
            task_name: "worker",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage("root final"),
        fauxAssistantMessage("next explicit answer"),
      ]);

      const prompting = harness.prompt("Delegate this work.");
      await rootAgentEnd.reached;
      childRelease.resolve(null);
      await waitForChildCompletion(harness);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      rootAgentEnd.release();
      await prompting;

      expect(harness.getPendingResponseCount()).toBe(1);
      await waitForRootAcknowledgement(harness, "v2");
      const sessionFile = harness.sessionManager.getSessionFile();
      if (sessionFile === undefined) {
        throw new Error("Expected a persisted root session");
      }
      const entries = SessionManager.open(
        sessionFile,
        harness.sessionManager.getSessionDir(),
        harness.sessionManager.getCwd(),
      ).getBranch();
      const finalIndex = entries.findIndex(
        (entry) => entry.type === "message" && JSON.stringify(entry).includes("root final"),
      );
      const mailIndex = entries.findIndex(
        (entry) =>
          entry.type === "custom_message" && JSON.stringify(entry).includes("child answer"),
      );
      expect(finalIndex).toBeGreaterThanOrEqual(0);
      expect(mailIndex).toBeGreaterThan(finalIndex);

      await harness.prompt("Use the completed child result.");
      expect(lastProviderPayloadText(harness)).toContain("child answer");
    } finally {
      rootAgentEnd.release();
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("puts V2 completion mail into an already-required tool continuation", async () => {
    const childRelease = Promise.withResolvers<null>();
    const { cleanup, harness } = await configuredHarness("v2");

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_turns: "none",
            message: "Investigate the race.",
            task_name: "worker",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage(fauxToolCall("wait_agent", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("integrated"),
      ]);

      const prompting = harness.prompt("Delegate and wait.");
      await vi.waitFor(() => {
        expect(
          harness
            .eventsOfType("tool_execution_start")
            .some((event) => event.toolName === "wait_agent"),
        ).toBeTruthy();
      });
      childRelease.resolve(null);
      await prompting;

      await waitForRootAcknowledgement(harness, "v2");
      expect(lastProviderPayloadText(harness)).toContain("child answer");
      expect(harness.messages().at(-1)).toMatchObject({ role: "assistant" });
    } finally {
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("holds V2 completion mail outside a retry payload until settlement", async () => {
    const childRelease = Promise.withResolvers<null>();
    const rootErrorStarted = Promise.withResolvers<null>();
    const releaseRootError = Promise.withResolvers<null>();
    const { cleanup, harness } = await configuredHarness("v2", [], {
      retry: { baseDelayMs: 1, maxRetries: 1 },
    });

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_turns: "none",
            message: "Investigate the retry.",
            task_name: "worker",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        async () => {
          rootErrorStarted.resolve(null);
          await releaseRootError.promise;
          return fauxAssistantMessage("", {
            errorMessage: "overloaded_error",
            stopReason: "error",
          });
        },
        fauxAssistantMessage("retry recovered"),
        fauxAssistantMessage("must remain unused"),
      ]);

      const prompting = harness.prompt("Delegate through a retry.");
      await rootErrorStarted.promise;
      childRelease.resolve(null);
      await waitForChildCompletion(harness);
      releaseRootError.resolve(null);
      await prompting;

      const retryPayload = lastProviderPayloadText(harness);
      expect(retryPayload).not.toContain("child answer");
      expect(retryPayload).not.toContain("overloaded_error");
      expect(harness.getPendingResponseCount()).toBe(1);
      await waitForRootAcknowledgement(harness, "v2");
    } finally {
      releaseRootError.resolve(null);
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("does not steer V2 completion mail behind existing one-at-a-time steering", async () => {
    const childRelease = Promise.withResolvers<null>();
    const { cleanup, harness } = await configuredHarness("v2");

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_turns: "none",
            message: "Investigate the queue.",
            task_name: "worker",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage(fauxToolCall("wait_agent", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("answered existing steering"),
        fauxAssistantMessage("must remain unused"),
      ]);

      const prompting = harness.prompt("Delegate and wait.");
      await vi.waitFor(() => {
        expect(
          harness
            .eventsOfType("tool_execution_start")
            .some((event) => event.toolName === "wait_agent"),
        ).toBeTruthy();
      });
      await harness.session.steer("existing user steering");
      childRelease.resolve(null);
      await prompting;

      const payload = lastProviderPayloadText(harness);
      expect(payload).toContain("existing user steering");
      expect(payload).not.toContain("child answer");
      expect(harness.getPendingResponseCount()).toBe(1);
      await waitForRootAcknowledgement(harness, "v2");
    } finally {
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("does not continue V2 completion mail after a terminating tool", async () => {
    const childRelease = Promise.withResolvers<null>();
    const toolStarted = Promise.withResolvers<null>();
    const releaseTool = Promise.withResolvers<null>();
    const terminatingTool: ExtensionFactory = (pi) => {
      pi.registerTool({
        description: "Terminate after a barrier",
        async execute() {
          toolStarted.resolve(null);
          await releaseTool.promise;
          return {
            content: [{ text: "terminated", type: "text" }],
            details: {},
            terminate: true,
          };
        },
        label: "Terminate",
        name: "terminate_root",
        parameters: Type.Object({}),
      });
    };
    const { cleanup, harness } = await configuredHarness("v2", [terminatingTool]);

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_turns: "none",
            message: "Investigate the race.",
            task_name: "worker",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage(fauxToolCall("terminate_root", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("must remain unused"),
      ]);

      const prompting = harness.prompt("Delegate, then terminate.");
      await toolStarted.promise;
      childRelease.resolve(null);
      await waitForChildCompletion(harness);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      releaseTool.resolve(null);
      await prompting;

      expect(harness.getPendingResponseCount()).toBe(1);
      await waitForRootAcknowledgement(harness, "v2");
    } finally {
      releaseTool.resolve(null);
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("holds V2 completion mail through a root tool abort until settlement", async () => {
    const childRelease = Promise.withResolvers<void>();
    const toolStarted = Promise.withResolvers<void>();
    const rootAgentEnd = rootAgentEndBarrier();
    const abortingTool: ExtensionFactory = (pi) => {
      pi.registerTool({
        description: "Wait until aborted",
        async execute(_toolCallId, _params, signal) {
          toolStarted.resolve();
          if (signal === undefined) {
            throw new Error("Tool signal is unavailable");
          }
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            content: [{ text: "aborted", type: "text" }],
            details: {},
          };
        },
        label: "Wait",
        name: "wait_for_abort",
        parameters: Type.Object({}),
      });
    };
    const { cleanup, harness } = await configuredHarness("v2", [
      abortingTool,
      rootAgentEnd.extension,
    ]);

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_turns: "none",
            message: "Investigate the abort.",
            task_name: "worker",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer after abort");
        },
        fauxAssistantMessage(fauxToolCall("wait_for_abort", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("next explicit answer"),
      ]);

      const prompting = harness.prompt("Delegate, then wait.");
      await toolStarted.promise;
      childRelease.resolve();
      await waitForChildCompletion(harness);

      const store = controlStore(harness);
      await vi.waitFor(async () => {
        const snapshot = await store.load();
        expect(snapshot?.protocolLatch).toBe("v2");
        if (snapshot?.protocolLatch === "v2") {
          expect(snapshot.state.communications.filter(({ to }) => to === "/root")).toHaveLength(1);
        }
      });
      expect(harness.eventsOfType("agent_settled")).toHaveLength(0);

      const aborting = harness.session.abort();
      await rootAgentEnd.reached;
      expect(
        harness
          .messages()
          .some(
            (message) =>
              message.role === "custom" &&
              JSON.stringify(message).includes("child answer after abort"),
          ),
      ).toBeFalsy();
      expect(harness.eventsOfType("agent_settled")).toHaveLength(0);

      rootAgentEnd.release();
      await Promise.all([aborting, prompting]);
      expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
      expect(harness.getPendingResponseCount()).toBe(1);
      await waitForRootAcknowledgement(harness, "v2");

      await harness.prompt("Use the completed child result.");
      expect(lastProviderPayloadText(harness)).toContain("child answer after abort");
    } finally {
      rootAgentEnd.release();
      childRelease.resolve();
      await cleanup();
    }
  });

  it("preserves V1 active completion injection after a final answer", async () => {
    const childRelease = Promise.withResolvers<null>();
    const rootFinal = rootFinalBarrier();
    const { cleanup, harness } = await configuredHarness("v1", [rootFinal.extension]);

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_context: false,
            message: "Investigate the race.",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage("root final"),
        fauxAssistantMessage("integrated"),
      ]);

      const prompting = harness.prompt("Delegate this work.");
      await rootFinal.reached;
      childRelease.resolve(null);
      await waitForChildCompletion(harness);
      rootFinal.release();
      await prompting;

      expect(harness.getPendingResponseCount()).toBe(0);
      await waitForRootAcknowledgement(harness, "v1");
      expect(lastProviderPayloadText(harness)).toContain("child answer");
    } finally {
      rootFinal.release();
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("does not steer V1 completion after the active run stops accepting input", async () => {
    const rootAgentEnd = rootAgentEndBarrier();
    const childRelease = Promise.withResolvers<null>();
    const { cleanup, harness } = await configuredHarness("v1", [rootAgentEnd.extension]);

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_context: false,
            message: "Investigate the race.",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage("root final"),
        fauxAssistantMessage("must remain unused"),
      ]);

      const prompting = harness.prompt("Delegate this work.");
      await rootAgentEnd.reached;
      childRelease.resolve(null);
      await waitForChildCompletion(harness);
      rootAgentEnd.release();
      await prompting;

      expect(harness.getPendingResponseCount()).toBe(1);
      await waitForRootAcknowledgement(harness, "v1");
      expect(
        harness
          .messages()
          .filter(
            (message) =>
              message.role === "custom" && JSON.stringify(message).includes("child answer"),
          ),
      ).toHaveLength(1);
    } finally {
      rootAgentEnd.release();
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("re-appends a V1 completion cleared from the active root queue", async () => {
    const childRelease = Promise.withResolvers<null>();
    const rootFinal = rootFinalBarrier();
    const { cleanup, harness } = await configuredHarness("v1", [rootFinal.extension]);

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_context: false,
            message: "Investigate the race.",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage("root final"),
        fauxAssistantMessage("must remain unused"),
      ]);

      const prompting = harness.prompt("Delegate this work.");
      await rootFinal.reached;
      childRelease.resolve(null);
      await waitForChildCompletion(harness);
      await vi.waitFor(() => {
        expect(harness.session.agent.hasQueuedMessages()).toBe(true);
      });
      harness.session.clearQueue();
      rootFinal.release();
      await prompting;

      expect(harness.getPendingResponseCount()).toBe(1);
      await waitForRootAcknowledgement(harness, "v1");
      const sessionFile = harness.sessionManager.getSessionFile();
      if (sessionFile === undefined) {
        throw new Error("Expected a persisted root session");
      }
      const notifications = SessionManager.open(
        sessionFile,
        harness.sessionManager.getSessionDir(),
        harness.sessionManager.getCwd(),
      )
        .getBranch()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === V1_NOTIFICATION_TYPE,
        );
      expect(notifications).toHaveLength(1);
      expect(JSON.stringify(notifications[0])).toContain("child answer");
    } finally {
      rootFinal.release();
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("re-appends a cleared V1 completion in an in-memory root session", async () => {
    const childRelease = Promise.withResolvers<null>();
    const rootFinal = rootFinalBarrier();
    const { cleanup, harness } = await configuredHarness(
      "v1",
      [rootFinal.extension],
      undefined,
      false,
    );

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_context: false,
            message: "Investigate the race.",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage("root final"),
        fauxAssistantMessage("must remain unused"),
      ]);

      const prompting = harness.prompt("Delegate this work.");
      await rootFinal.reached;
      childRelease.resolve(null);
      await vi.waitFor(() => {
        expect(harness.session.agent.hasQueuedMessages()).toBe(true);
      });
      harness.session.clearQueue();
      rootFinal.release();
      await prompting;

      expect(harness.getPendingResponseCount()).toBe(1);
      expect(
        harness
          .messages()
          .filter(
            (message) =>
              message.role === "custom" && JSON.stringify(message).includes("child answer"),
          ),
      ).toHaveLength(1);
    } finally {
      rootFinal.release();
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("does not re-append a consumed V1 completion when transcript entry creation fails", async () => {
    const childRelease = Promise.withResolvers<null>();
    const rootFinal = rootFinalBarrier();
    const { cleanup, harness } = await configuredHarness("v1", [rootFinal.extension]);
    const append = harness.sessionManager.appendCustomMessageEntry.bind(harness.sessionManager);
    const appendSpy = vi
      .spyOn(harness.sessionManager, "appendCustomMessageEntry")
      .mockImplementation((customType, ...args) => {
        if (customType === V1_NOTIFICATION_TYPE) {
          throw new Error("simulated V1 entry creation failure");
        }
        return append(customType, ...args);
      });

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_context: false,
            message: "Investigate the race.",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage("root final"),
        fauxAssistantMessage("must remain unused"),
      ]);

      const prompting = harness.prompt("Delegate this work.");
      await rootFinal.reached;
      childRelease.resolve(null);
      await waitForChildCompletion(harness);
      await vi.waitFor(() => {
        expect(harness.session.agent.hasQueuedMessages()).toBe(true);
      });
      rootFinal.release();
      await prompting;

      expect(
        harness
          .messages()
          .filter(
            (message) =>
              message.role === "custom" && JSON.stringify(message).includes("child answer"),
          ),
      ).toHaveLength(1);
      expect(
        appendSpy.mock.calls.filter(([customType]) => customType === V1_NOTIFICATION_TYPE),
      ).toHaveLength(1);
      expect(
        harness.sessionManager
          .getBranch()
          .filter(
            (entry) => entry.type === "custom_message" && entry.customType === V1_NOTIFICATION_TYPE,
          ),
      ).toHaveLength(0);

      const payloadCount = harness.providerPayloads(
        Type.Object({}, { additionalProperties: true }),
      ).length;
      await harness.prompt("Do not duplicate the child result.");
      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(payloadCount);
      expect(
        appendSpy.mock.calls.filter(([customType]) => customType === V1_NOTIFICATION_TYPE),
      ).toHaveLength(1);
      const snapshot = await controlStore(harness).load();
      expect(snapshot?.protocolLatch).toBe("v1");
      expect(snapshot?.protocolLatch === "v1" ? snapshot.state.notifications : []).toHaveLength(1);
    } finally {
      rootFinal.release();
      childRelease.resolve(null);
      appendSpy.mockRestore();
      await cleanup();
    }
  });

  it("keeps a V1 completion durable while idle until the next prompt", async () => {
    const childRelease = Promise.withResolvers<null>();
    const { cleanup, harness } = await configuredHarness("v1");

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_context: false,
            message: "Investigate the race.",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage("root final"),
        fauxAssistantMessage("used child answer"),
      ]);

      await harness.prompt("Delegate this work.");
      childRelease.resolve(null);
      await waitForChildCompletion(harness);

      const snapshot = await controlStore(harness).load();
      expect(snapshot?.protocolLatch).toBe("v1");
      expect(snapshot?.protocolLatch === "v1" ? snapshot.state.notifications : []).toHaveLength(1);
      expect(
        harness
          .messages()
          .filter(
            (message) =>
              message.role === "custom" && JSON.stringify(message).includes("child answer"),
          ),
      ).toHaveLength(0);

      await harness.prompt("Use the completed child result.");
      expect(lastProviderPayloadText(harness)).toContain("child answer");
      await waitForRootAcknowledgement(harness, "v1");
    } finally {
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it.each(["handled", "failed"] as const)(
    "drains mail published during a %s preflight on the next normal input",
    async (outcome) => {
      const childRelease = Promise.withResolvers<null>();
      let activeHarness: AgentSessionHarness | undefined;
      const publishLate: ExtensionFactory = (pi) => {
        pi.on("input", async (event) => {
          if (event.text !== "Do not start this turn.") {
            return;
          }
          childRelease.resolve(null);
          await vi.waitFor(async () => {
            if (activeHarness === undefined) {
              throw new Error("Harness is unavailable");
            }
            const snapshot = await controlStore(activeHarness).load();
            expect(
              snapshot?.protocolLatch === "v2"
                ? snapshot.state.communications.filter(({ to }) => to === "/root")
                : [],
            ).toHaveLength(1);
          });
          return outcome === "handled" ? ({ action: "handled" } as const) : undefined;
        });
      };
      const { cleanup, harness } = await configuredHarness("v2", [publishLate]);
      activeHarness = harness;

      try {
        harness.setResponses([
          fauxAssistantMessage(
            fauxToolCall("spawn_agent", {
              fork_turns: "none",
              message: "Investigate the preflight.",
              task_name: "worker",
            }),
            { stopReason: "toolUse" },
          ),
          async () => {
            await childRelease.promise;
            return fauxAssistantMessage("late child answer");
          },
          fauxAssistantMessage("root final"),
          fauxAssistantMessage("used late mail"),
        ]);

        await harness.prompt("Delegate this work.");
        if (outcome === "failed") {
          const provider = harness.session.model?.provider;
          if (provider === undefined) {
            throw new Error("Expected a selected model");
          }
          await harness.session.modelRuntime.removeRuntimeApiKey(provider);
          await expect(harness.prompt("Do not start this turn.")).rejects.toThrow(
            "No API key found",
          );
          await harness.session.modelRuntime.setRuntimeApiKey(provider, "faux-key");
        } else {
          await harness.prompt("Do not start this turn.");
        }

        expect(
          harness
            .messages()
            .some(
              (message) =>
                message.role === "custom" && JSON.stringify(message).includes("late child answer"),
            ),
        ).toBe(false);

        await harness.prompt("Now use the delivered child result.");
        expect(lastProviderPayloadText(harness)).toContain("late child answer");
        await waitForRootAcknowledgement(harness, "v2");
      } finally {
        childRelease.resolve(null);
        await cleanup();
      }
    },
  );

  it("fails closed after a root append failure without duplicating the in-memory message", async () => {
    const childRelease = Promise.withResolvers<null>();
    const { cleanup, harness, shutdown } = await configuredHarness("v2");
    let resumed: AgentSessionHarness | undefined;
    const append = harness.sessionManager.appendCustomMessageEntry.bind(harness.sessionManager);
    const appendSpy = vi
      .spyOn(harness.sessionManager, "appendCustomMessageEntry")
      .mockImplementation((customType, ...args) => {
        if (customType === SUBAGENT_MESSAGE_TYPE) {
          throw new Error("simulated root append failure");
        }
        return append(customType, ...args);
      });

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_turns: "none",
            message: "Investigate the append.",
            task_name: "worker",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage("root final"),
        fauxAssistantMessage("must remain unused"),
      ]);

      await harness.prompt("Delegate this work.");
      childRelease.resolve(null);
      await waitForChildCompletion(harness);
      const payloadCount = harness.providerPayloads(
        Type.Object({}, { additionalProperties: true }),
      ).length;

      await harness.prompt("Use the completed child result.");

      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(payloadCount);
      expect(harness.getPendingResponseCount()).toBe(1);
      expect(
        appendSpy.mock.calls.filter(([customType]) => customType === SUBAGENT_MESSAGE_TYPE).length,
      ).toBe(1);
      appendSpy.mockRestore();

      await harness.prompt("Try the completed child result again.");
      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(payloadCount);
      expect(
        harness
          .messages()
          .filter(
            (message) =>
              message.role === "custom" && JSON.stringify(message).includes("child answer"),
          ),
      ).toHaveLength(1);
      const snapshot = await controlStore(harness).load();
      expect(
        snapshot?.protocolLatch === "v2"
          ? snapshot.state.communications.filter(({ to }) => to === "/root")
          : [],
      ).toHaveLength(1);

      await shutdown();
      resumed = await createAgentSessionHarness({
        continueSession: true,
        cwd: harness.sessionManager.getCwd(),
        extensionFactories: [subagents],
        sessionDir: harness.sessionManager.getSessionDir(),
      });
      resumed.setResponses([fauxAssistantMessage("recovered after restart")]);
      await resumed.prompt("Recover the completed child result.");

      expect(lastProviderPayloadText(resumed)).toContain("child answer");
      expect(
        resumed
          .messages()
          .filter(
            (message) =>
              message.role === "custom" && JSON.stringify(message).includes("child answer"),
          ),
      ).toHaveLength(1);
      await waitForRootAcknowledgement(resumed, "v2");
    } finally {
      appendSpy.mockRestore();
      if (resumed !== undefined) {
        await resumed.session.extensionRunner.emit({
          reason: "quit",
          type: "session_shutdown",
        });
        resumed.cleanup();
      }
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("does not start the next provider snapshot when root acknowledgement fails", async () => {
    const childRelease = Promise.withResolvers<null>();
    const { cleanup, harness } = await configuredHarness("v2");
    const stateFile = controlFile(harness);
    const append = harness.sessionManager.appendCustomMessageEntry.bind(harness.sessionManager);
    const appendSpy = vi
      .spyOn(harness.sessionManager, "appendCustomMessageEntry")
      .mockImplementation((customType, ...args) => {
        const entryId = append(customType, ...args);
        if (customType === SUBAGENT_MESSAGE_TYPE) {
          rmSync(stateFile, { force: true });
          mkdirSync(stateFile);
        }
        return entryId;
      });

    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("spawn_agent", {
            fork_turns: "none",
            message: "Investigate the acknowledgement.",
            task_name: "worker",
          }),
          { stopReason: "toolUse" },
        ),
        async () => {
          await childRelease.promise;
          return fauxAssistantMessage("child answer");
        },
        fauxAssistantMessage("root final"),
        fauxAssistantMessage("must remain unused"),
      ]);

      await harness.prompt("Delegate this work.");
      childRelease.resolve(null);
      await waitForChildCompletion(harness);
      const payloadCount = harness.providerPayloads(
        Type.Object({}, { additionalProperties: true }),
      ).length;

      await harness.prompt("Use the completed child result.");

      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(payloadCount);
      expect(harness.getPendingResponseCount()).toBe(1);

      await harness.prompt("Continue without collaboration.");
      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(payloadCount + 1);
      expect(lastProviderPayloadText(harness)).toContain("Continue without collaboration.");
    } finally {
      appendSpy.mockRestore();
      rmSync(stateFile, { force: true, recursive: true });
      childRelease.resolve(null);
      await cleanup();
    }
  });

  it("drains every settled V2 root completion before the next prompt snapshot", async () => {
    const childOneRelease = Promise.withResolvers<null>();
    const childTwoRelease = Promise.withResolvers<null>();
    const rootAgentEnd = rootAgentEndBarrier();
    const { cleanup, harness } = await configuredHarness("v2", [rootAgentEnd.extension]);

    try {
      harness.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("spawn_agent", {
              fork_turns: "none",
              message: "First investigation.",
              task_name: "worker_one",
            }),
            fauxToolCall("spawn_agent", {
              fork_turns: "none",
              message: "Second investigation.",
              task_name: "worker_two",
            }),
          ],
          { stopReason: "toolUse" },
        ),
        async () => {
          await childOneRelease.promise;
          return fauxAssistantMessage("first child answer");
        },
        async () => {
          await childTwoRelease.promise;
          return fauxAssistantMessage("second child answer");
        },
        fauxAssistantMessage("root final"),
        fauxAssistantMessage("used both answers"),
      ]);

      const prompting = harness.prompt("Delegate twice.");
      await rootAgentEnd.reached;
      childOneRelease.resolve(null);
      childTwoRelease.resolve(null);
      const store = controlStore(harness);
      await vi.waitFor(async () => {
        const snapshot = await store.load();
        expect(snapshot?.protocolLatch).toBe("v2");
        if (snapshot?.protocolLatch !== "v2") {
          return;
        }
        expect(
          snapshot.state.nodes.filter(
            ({ path: agentPath, status }) =>
              (agentPath === "/root/worker_one" || agentPath === "/root/worker_two") &&
              status === "completed",
          ),
        ).toHaveLength(2);
        expect(snapshot.state.communications.filter(({ to }) => to === "/root")).toHaveLength(2);
      });
      rootAgentEnd.release();
      await prompting;

      await harness.prompt("Use both completed child results.");
      const payload = lastProviderPayloadText(harness);
      expect(payload).toContain("first child answer");
      expect(payload).toContain("second child answer");
      await waitForRootAcknowledgement(harness, "v2");
    } finally {
      rootAgentEnd.release();
      childOneRelease.resolve(null);
      childTwoRelease.resolve(null);
      await cleanup();
    }
  });
});
