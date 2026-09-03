import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import { createChildRuntime, SUBAGENT_IDENTITY_ENTRY_TYPE } from "../runtime.js";
import { TranscriptCursor } from "../transcript.js";

const CommunicationDetailsSchema = Type.Object(
  { communicationId: Type.String() },
  { additionalProperties: true },
);

const lastProviderPayloadText = (
  harness: Awaited<ReturnType<typeof createAgentSessionHarness>>,
): string =>
  JSON.stringify(harness.lastProviderPayload(Type.Object({}, { additionalProperties: true })));

const usage = (totalTokens: number) => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: totalTokens,
  output: 0,
  totalTokens,
});

const runtimeRequest = (
  harness: Awaited<ReturnType<typeof createAgentSessionHarness>>,
  identity = "/root/child",
) => ({
  bridge: () => Promise.resolve(),
  cwd: path.dirname(harness.agentDir),
  dataDir: path.join(harness.agentDir, "data", "subagents"),
  history: [],
  identity,
  model: harness.faux.getModel(),
  modelRegistry: harness.session.extensionRunner.getModelRegistry(),
  prompt: "You are a child.",
  tools: [],
  trusted: false,
});

const blockNextTranscriptVerification = () => {
  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const spy = vi
    .spyOn(TranscriptCursor.prototype, "verify")
    .mockImplementation(async function (this: TranscriptCursor, expectedId) {
      spy.mockRestore();
      started.resolve(undefined);
      await release.promise;
      return this.verify(expectedId);
    });
  return { release, spy, started };
};

describe("child runtime", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("materializes an identity-bound transcript before publication", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const runtime = await createChildRuntime(runtimeRequest(harness));
    try {
      expect(existsSync(runtime.sessionFile)).toBeTruthy();
      await expect(readFile(runtime.sessionFile, "utf-8")).resolves.toContain(
        `"customType":"${SUBAGENT_IDENTITY_ENTRY_TYPE}"`,
      );
      runtime.commit();
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("accepts only a persisted user turn and returns its final assistant result", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    harness.setResponses([fauxAssistantMessage("child answer")]);
    const runtime = await createChildRuntime(runtimeRequest(harness));
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "task" });
      await expect(turn.accepted).resolves.toBeUndefined();
      await expect(turn.settled).resolves.toStrictEqual({
        status: "completed",
        text: "child answer",
      });
      expect(
        SessionManager.open(
          runtime.sessionFile,
          path.dirname(runtime.sessionFile),
          path.dirname(harness.agentDir),
        )
          .getBranch()
          .some((entry) => entry.type === "message" && entry.message.role === "user"),
      ).toBeTruthy();
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("accepts a second turn after the first result is persisted", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    harness.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
    ]);
    const runtime = await createChildRuntime(runtimeRequest(harness));
    runtime.commit();
    try {
      const first = runtime.startTurn({ text: "first task" });
      await expect(first.accepted).resolves.toBeUndefined();
      await expect(first.settled).resolves.toMatchObject({
        text: "first answer",
      });

      const second = runtime.startTurn({ text: "second task" });
      await expect(second.accepted).resolves.toBeUndefined();
      await expect(second.settled).resolves.toMatchObject({
        text: "second answer",
      });
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it.each([
    ["abort", "input"],
    ["abort", "before_agent_start"],
    ["dispose", "input"],
    ["dispose", "before_agent_start"],
  ] as const)("%s cancels a turn suspended in %s preflight", async (operation, preflightEvent) => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const preflightStarted = Promise.withResolvers<undefined>();
    const releasePreflight = Promise.withResolvers<undefined>();
    const preflightFinished = Promise.withResolvers<undefined>();
    let providerStarted = false;
    harness.setResponses([
      async () => {
        providerStarted = true;
        return fauxAssistantMessage("detached answer");
      },
    ]);
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: async (pi) => {
        const suspend = async () => {
          preflightStarted.resolve(undefined);
          await releasePreflight.promise;
          preflightFinished.resolve(undefined);
        };
        if (preflightEvent === "input") {
          pi.on("input", suspend);
        } else {
          pi.on("before_agent_start", suspend);
        }
      },
      trusted: true,
    });
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await preflightStarted.promise;

      let stop: Promise<void>;
      if (operation === "abort") {
        stop = runtime.abort();
        await stop;
      } else {
        let stopped = false;
        stop = runtime.dispose().then(() => {
          stopped = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stopped).toBeFalsy();
      }
      releasePreflight.resolve(undefined);
      await preflightFinished.promise;
      await stop;

      await expect(turn.accepted).rejects.toThrow(
        operation === "abort" ? "Child turn was aborted" : "Child runtime was disposed",
      );
      await expect(turn.settled).rejects.toThrow(
        operation === "abort" ? "Child turn was aborted" : "Child runtime was disposed",
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(providerStarted).toBeFalsy();
      expect(harness.getPendingResponseCount()).toBe(1);
      expect(
        SessionManager.open(
          runtime.sessionFile,
          path.dirname(runtime.sessionFile),
          path.dirname(harness.agentDir),
        )
          .getBranch()
          .some((entry) => entry.type === "message" && entry.message.role === "user"),
      ).toBeFalsy();
    } finally {
      releasePreflight.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it.each(["input", "before_agent_start"] as const)(
    "dispose emits shutdown while fencing a turn suspended in %s",
    async (preflightEvent) => {
      const harness = await createAgentSessionHarness();
      process.env.PI_CODING_AGENT_DIR = harness.agentDir;
      const preflightStarted = Promise.withResolvers<undefined>();
      const shutdownStarted = Promise.withResolvers<undefined>();
      const cleanup = Promise.withResolvers<undefined>();
      const releasePreflight = Promise.withResolvers<undefined>();
      let preflightFinished = false;
      let shutdownCount = 0;
      const runtime = await createChildRuntime({
        ...runtimeRequest(harness),
        bridge: async (pi) => {
          const suspend = async () => {
            preflightStarted.resolve(undefined);
            await cleanup.promise;
            await releasePreflight.promise;
            preflightFinished = true;
          };
          if (preflightEvent === "input") {
            pi.on("input", suspend);
          } else {
            pi.on("before_agent_start", suspend);
          }
          pi.on("session_shutdown", () => {
            shutdownCount += 1;
            cleanup.resolve(undefined);
            shutdownStarted.resolve(undefined);
          });
        },
        trusted: true,
      });
      runtime.commit();
      let disposal: Promise<void> | undefined;
      try {
        const turn = runtime.startTurn({ text: "initial task" });
        await preflightStarted.promise;

        let disposed = false;
        disposal = runtime.dispose().then(() => {
          disposed = true;
        });
        await shutdownStarted.promise;
        let concurrentDisposed = false;
        const concurrentDisposal = runtime.dispose().then(() => {
          concurrentDisposed = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(disposed).toBeFalsy();
        expect(concurrentDisposed).toBeFalsy();
        expect(preflightFinished).toBeFalsy();

        releasePreflight.resolve(undefined);
        await Promise.all([disposal, concurrentDisposal]);
        expect(preflightFinished).toBeTruthy();
        await expect(turn.accepted).rejects.toThrow("Child runtime was disposed");
        await expect(turn.settled).rejects.toThrow("Child runtime was disposed");

        await runtime.dispose();
        expect(shutdownCount).toBe(1);
      } finally {
        cleanup.resolve(undefined);
        releasePreflight.resolve(undefined);
        await disposal;
        await runtime.dispose();
        harness.cleanup();
      }
    },
  );

  it("fences interrupted preflight before stale auto-compaction", async () => {
    const harness = await createAgentSessionHarness({
      models: [{ contextWindow: 100, id: "faux-1", maxTokens: 100 }],
    });
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    await writeFile(
      path.join(harness.agentDir, "settings.json"),
      JSON.stringify({
        compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
      }),
    );
    const inputStarted = Promise.withResolvers<undefined>();
    const releaseInput = Promise.withResolvers<undefined>();
    let compactionStarted = false;
    const model = harness.faux.getModel();
    const now = Date.now();
    const previousAssistant: AssistantMessage = {
      ...fauxAssistantMessage("previous response", {
        stopReason: "length",
        timestamp: now - 500,
      }),
      api: model.api,
      model: model.id,
      provider: model.provider,
      usage: usage(100),
    };
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("input", async () => {
          inputStarted.resolve(undefined);
          await releaseInput.promise;
        });
        pi.on("session_before_compact", async (event) => {
          compactionStarted = true;
          return {
            compaction: {
              details: {},
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              summary: "preflight compaction",
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
      },
      history: [
        {
          content: [{ text: "previous prompt", type: "text" }],
          role: "user",
          timestamp: now - 1000,
        },
        previousAssistant,
      ],
      trusted: true,
    });
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "cancelled task" });
      await inputStarted.promise;

      await runtime.abort();
      let disposed = false;
      const disposal = runtime.dispose().then(() => {
        disposed = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(disposed).toBeFalsy();

      releaseInput.resolve(undefined);
      await disposal;
      await expect(turn.accepted).rejects.toThrow("Child turn was aborted");
      await expect(turn.settled).rejects.toThrow("Child turn was aborted");

      const branch = SessionManager.open(
        runtime.sessionFile,
        path.dirname(runtime.sessionFile),
        path.dirname(harness.agentDir),
      ).getBranch();
      expect(compactionStarted).toBeFalsy();
      expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(0);
      expect(
        branch.some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            JSON.stringify(entry.message.content).includes("cancelled task"),
        ),
      ).toBeFalsy();
      expect(harness.getPendingResponseCount()).toBe(0);
    } finally {
      releaseInput.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("guards canceled preflight before compaction begins after delayed auth", async () => {
    const harness = await createAgentSessionHarness({
      models: [{ contextWindow: 100, id: "faux-1", maxTokens: 100 }],
    });
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    await writeFile(
      path.join(harness.agentDir, "settings.json"),
      JSON.stringify({
        compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
      }),
    );
    const authStarted = Promise.withResolvers<undefined>();
    const releaseAuth = Promise.withResolvers<undefined>();
    const model = harness.faux.getModel();
    const provider = harness.session.extensionRunner
      .getModelRegistry()
      .getRegisteredNativeProvider(model.provider);
    const apiKeyAuth = provider?.auth.apiKey;
    if (apiKeyAuth === undefined) {
      throw new Error("Faux API key auth is unavailable");
    }
    const resolveAuth = apiKeyAuth.resolve.bind(apiKeyAuth);
    let blockAuth = false;
    const authSpy = vi.spyOn(apiKeyAuth, "resolve").mockImplementation(async (input) => {
      if (blockAuth) {
        authStarted.resolve(undefined);
        await releaseAuth.promise;
      }
      return resolveAuth(input);
    });
    const now = Date.now();
    const previousAssistant: AssistantMessage = {
      ...fauxAssistantMessage("previous response", {
        stopReason: "length",
        timestamp: now - 500,
      }),
      api: model.api,
      model: model.id,
      provider: model.provider,
      usage: usage(100),
    };
    let projectCompactionStarted = false;
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("session_before_compact", (event) => {
          projectCompactionStarted = true;
          return {
            compaction: {
              details: {},
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              summary: "late preflight compaction",
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
      },
      history: [
        {
          content: [{ text: "previous prompt", type: "text" }],
          role: "user",
          timestamp: now - 1000,
        },
        previousAssistant,
      ],
      trusted: true,
    });
    runtime.commit();
    blockAuth = true;
    try {
      const turn = runtime.startTurn({ text: "cancelled task" });
      await authStarted.promise;

      await runtime.abort();
      releaseAuth.resolve(undefined);
      await runtime.dispose();
      await expect(turn.accepted).rejects.toThrow("Child turn was aborted");
      await expect(turn.settled).rejects.toThrow("Child turn was aborted");

      expect(projectCompactionStarted).toBeFalsy();
      const branch = SessionManager.open(
        runtime.sessionFile,
        path.dirname(runtime.sessionFile),
        path.dirname(harness.agentDir),
      ).getBranch();
      expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(0);
      expect(
        branch.some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            JSON.stringify(entry.message.content).includes("cancelled task"),
        ),
      ).toBeFalsy();
    } finally {
      authSpy.mockRestore();
      releaseAuth.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("aborts signal-aware pre-prompt auto-compaction at the stop boundary", async () => {
    const harness = await createAgentSessionHarness({
      models: [{ contextWindow: 100, id: "faux-1", maxTokens: 100 }],
    });
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    await writeFile(
      path.join(harness.agentDir, "settings.json"),
      JSON.stringify({
        compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
      }),
    );
    const compactionStarted = Promise.withResolvers<undefined>();
    const compactionAborted = Promise.withResolvers<undefined>();
    const model = harness.faux.getModel();
    const now = Date.now();
    const previousAssistant: AssistantMessage = {
      ...fauxAssistantMessage("previous response", {
        stopReason: "length",
        timestamp: now - 500,
      }),
      api: model.api,
      model: model.id,
      provider: model.provider,
      usage: usage(100),
    };
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("session_before_compact", async (event) => {
          compactionStarted.resolve(undefined);
          if (!event.signal.aborted) {
            await new Promise<void>((resolve) => {
              event.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          compactionAborted.resolve(undefined);
          return { cancel: true };
        });
      },
      history: [
        {
          content: [{ text: "previous prompt", type: "text" }],
          role: "user",
          timestamp: now - 1000,
        },
        previousAssistant,
      ],
      trusted: true,
    });
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "cancelled task" });
      await compactionStarted.promise;

      await runtime.abort();
      await compactionAborted.promise;
      await runtime.dispose();
      await expect(turn.accepted).rejects.toThrow("Child turn was aborted");
      await expect(turn.settled).rejects.toThrow("Child turn was aborted");

      const branch = SessionManager.open(
        runtime.sessionFile,
        path.dirname(runtime.sessionFile),
        path.dirname(harness.agentDir),
      ).getBranch();
      expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(0);
      expect(
        branch.some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            JSON.stringify(entry.message.content).includes("cancelled task"),
        ),
      ).toBeFalsy();
      expect(harness.getPendingResponseCount()).toBe(0);
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("cancels post-run auto-compaction after blocked auth", async () => {
    const harness = await createAgentSessionHarness({
      models: [{ contextWindow: 100, id: "faux-1", maxTokens: 100 }],
    });
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    await writeFile(
      path.join(harness.agentDir, "settings.json"),
      JSON.stringify({
        compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 10 },
      }),
    );
    const authStarted = Promise.withResolvers<undefined>();
    const releaseAuth = Promise.withResolvers<undefined>();
    const model = harness.faux.getModel();
    const provider = harness.session.extensionRunner
      .getModelRegistry()
      .getRegisteredNativeProvider(model.provider);
    const apiKeyAuth = provider?.auth.apiKey;
    if (apiKeyAuth === undefined) {
      throw new Error("Faux API key auth is unavailable");
    }
    const resolveAuth = apiKeyAuth.resolve.bind(apiKeyAuth);
    let blockAuth = false;
    const authSpy = vi.spyOn(apiKeyAuth, "resolve").mockImplementation(async (input) => {
      if (blockAuth) {
        authStarted.resolve(undefined);
        await releaseAuth.promise;
      }
      return resolveAuth(input);
    });
    harness.setResponses([
      async () => {
        blockAuth = true;
        return {
          ...fauxAssistantMessage("child answer"),
          api: model.api,
          model: model.id,
          provider: model.provider,
          usage: usage(91),
        };
      },
      fauxAssistantMessage("unexpected summary"),
    ]);
    let projectCompactionStarted = false;
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("session_before_compact", () => {
          projectCompactionStarted = true;
        });
      },
      trusted: true,
    });
    runtime.commit();
    let abort: Promise<void> | undefined;
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      await authStarted.promise;
      expect(projectCompactionStarted).toBeFalsy();

      let stopped = false;
      abort = runtime.abort().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopped).toBeTruthy();
      await abort;

      releaseAuth.resolve(undefined);
      await expect(turn.settled).resolves.toStrictEqual({
        status: "completed",
        text: "child answer",
      });

      expect(projectCompactionStarted).toBeFalsy();
      expect(
        SessionManager.open(
          runtime.sessionFile,
          path.dirname(runtime.sessionFile),
          path.dirname(harness.agentDir),
        )
          .getBranch()
          .filter((entry) => entry.type === "compaction"),
      ).toHaveLength(0);
      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(1);
      expect(harness.getPendingResponseCount()).toBe(1);
    } finally {
      authSpy.mockRestore();
      releaseAuth.resolve(undefined);
      await abort;
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("aborts before a completed overflow compaction can retry", async () => {
    const harness = await createAgentSessionHarness({
      models: [{ contextWindow: 1000, id: "faux-1", maxTokens: 100 }],
    });
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    await writeFile(
      path.join(harness.agentDir, "settings.json"),
      JSON.stringify({
        compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
      }),
    );
    const compactionStarted = Promise.withResolvers<undefined>();
    const releaseCompaction = Promise.withResolvers<undefined>();
    const model = harness.faux.getModel();
    harness.setResponses([
      {
        ...fauxAssistantMessage("partial answer", { stopReason: "length" }),
        api: model.api,
        model: model.id,
        provider: model.provider,
        usage: usage(100),
      },
      fauxAssistantMessage("unexpected retry"),
    ]);
    let willRetry = false;
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("session_before_compact", (event) => ({
          compaction: {
            details: {},
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            summary: "overflow compaction",
            tokensBefore: event.preparation.tokensBefore,
          },
        }));
        pi.on("session_compact", async (event) => {
          willRetry = event.willRetry;
          compactionStarted.resolve(undefined);
          await releaseCompaction.promise;
        });
      },
      trusted: true,
    });
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "x".repeat(5000) });
      await turn.accepted;
      await compactionStarted.promise;
      expect(willRetry).toBeTruthy();
      expect(
        SessionManager.open(
          runtime.sessionFile,
          path.dirname(runtime.sessionFile),
          path.dirname(harness.agentDir),
        )
          .getBranch()
          .filter((entry) => entry.type === "compaction"),
      ).toHaveLength(1);

      let stopped = false;
      const abort = runtime.abort().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopped).toBeTruthy();
      await abort;

      releaseCompaction.resolve(undefined);
      await expect(turn.settled).resolves.toStrictEqual({ status: "interrupted" });
      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(1);
      expect(harness.getPendingResponseCount()).toBe(1);
    } finally {
      releaseCompaction.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("does not start an overflow retry after cancellation during context conversion", async () => {
    const harness = await createAgentSessionHarness({
      models: [{ contextWindow: 1000, id: "faux-1", maxTokens: 100 }],
    });
    const streamSpy = vi.spyOn(ModelRuntime.prototype, "streamSimple");
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    await writeFile(
      path.join(harness.agentDir, "settings.json"),
      JSON.stringify({
        compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
      }),
    );
    const retryContextStarted = Promise.withResolvers<undefined>();
    const releaseRetryContext = Promise.withResolvers<undefined>();
    const model = harness.faux.getModel();
    let blockRetryContext = false;
    harness.setResponses([
      {
        ...fauxAssistantMessage("partial answer", { stopReason: "length" }),
        api: model.api,
        model: model.id,
        provider: model.provider,
        usage: usage(100),
      },
      fauxAssistantMessage("unexpected retry"),
    ]);
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("context", async (event) => {
          if (blockRetryContext) {
            retryContextStarted.resolve(undefined);
            await releaseRetryContext.promise;
          }
          return { messages: event.messages };
        });
        pi.on("session_before_compact", (event) => ({
          compaction: {
            details: {},
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            summary: "overflow compaction",
            tokensBefore: event.preparation.tokensBefore,
          },
        }));
        pi.on("session_compact", (event) => {
          expect(event.willRetry).toBeTruthy();
          blockRetryContext = true;
        });
      },
      trusted: true,
    });
    runtime.commit();
    let abort: Promise<void> | undefined;
    try {
      const turn = runtime.startTurn({ text: "x".repeat(5000) });
      await turn.accepted;
      await retryContextStarted.promise;
      expect(streamSpy).toHaveBeenCalledTimes(1);
      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(1);

      abort = runtime.abort();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      releaseRetryContext.resolve(undefined);
      await abort;

      await expect(turn.settled).resolves.toStrictEqual({ status: "interrupted" });
      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(1);
      expect(streamSpy).toHaveBeenCalledTimes(1);
      expect(harness.getPendingResponseCount()).toBe(1);
    } finally {
      streamSpy.mockRestore();
      releaseRetryContext.resolve(undefined);
      await abort;
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("defers active queue-only mail after a final answer", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const agentEnd = Promise.withResolvers<undefined>();
    const releaseAgentEnd = Promise.withResolvers<undefined>();
    harness.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("answer after steering"),
    ]);
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: async (pi) => {
        pi.on("agent_end", async () => {
          agentEnd.resolve(undefined);
          await releaseAgentEnd.promise;
        });
      },
    });
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      await agentEnd.promise;
      expect(runtime.isStreaming()).toBeTruthy();

      const delivery = runtime.sendMessage({
        content: "new steering context",
        customType: "subagent-message",
        details: { communicationId: "message-1" },
      });
      releaseAgentEnd.resolve(undefined);

      await delivery.accepted;
      await expect(turn.settled).resolves.toMatchObject({
        text: "first answer",
      });
      expect(harness.getPendingResponseCount()).toBe(1);
      const persisted = SessionManager.open(
        runtime.sessionFile,
        path.dirname(runtime.sessionFile),
        path.dirname(harness.agentDir),
      ).getBranch();
      const assistantIndex = persisted.findIndex(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      );
      const customIndex = persisted.findIndex(
        (entry) =>
          entry.type === "custom_message" &&
          Value.Check(CommunicationDetailsSchema, entry.details) &&
          entry.details.communicationId === "message-1",
      );
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(customIndex).toBeGreaterThan(assistantIndex);

      const next = runtime.startTurn({ text: "next task" });
      await next.accepted;
      await expect(next.settled).resolves.toMatchObject({
        text: "answer after steering",
      });
      expect(lastProviderPayloadText(harness)).toContain("new steering context");
    } finally {
      releaseAgentEnd.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("steers admitted mail into an existing tool continuation", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const toolStarted = Promise.withResolvers<undefined>();
    const releaseTool = Promise.withResolvers<undefined>();
    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("continue", {}, { id: "continue-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("answer with mail"),
    ]);
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: async (pi) => {
        pi.registerTool({
          description: "Continue after a barrier",
          async execute() {
            toolStarted.resolve(undefined);
            await releaseTool.promise;
            return {
              content: [{ text: "continued", type: "text" }],
              details: {},
            };
          },
          label: "Continue",
          name: "continue",
          parameters: Type.Object({}),
        });
      },
      tools: ["continue"],
    });
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      await toolStarted.promise;
      const delivery = runtime.sendMessage({
        content: "mail visible to continuation",
        customType: "subagent-message",
        details: { communicationId: "message-tool" },
      });
      releaseTool.resolve(undefined);

      await delivery.accepted;
      await expect(turn.settled).resolves.toMatchObject({
        text: "answer with mail",
      });
      expect(lastProviderPayloadText(harness)).toContain("mail visible to continuation");
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("clears queued triggering mail before aborting the active turn", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const toolStarted = Promise.withResolvers<undefined>();
    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("wait", {}, { id: "wait-active-mail" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("detached continuation"),
    ]);
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: async (pi) => {
        pi.registerTool({
          description: "Wait until aborted",
          async execute(_toolCallId, _params, signal) {
            toolStarted.resolve(undefined);
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
          name: "wait",
          parameters: Type.Object({}),
        });
      },
      tools: ["wait"],
    });
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      await toolStarted.promise;
      const delivery = runtime.sendMessage(
        {
          content: "Message Type: NEW_TASK\nPayload: detached work",
          customType: "subagent-message",
          details: { communicationId: "active-new-task" },
        },
        undefined,
        true,
      );

      await runtime.abort();

      await expect(delivery.accepted).rejects.toThrow("Child turn was aborted");
      await turn.settled;
      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(1);
      expect(harness.getPendingResponseCount()).toBe(1);
      const deliveries = SessionManager.open(
        runtime.sessionFile,
        path.dirname(runtime.sessionFile),
        path.dirname(harness.agentDir),
      )
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom_message" &&
            Value.Check(CommunicationDetailsSchema, entry.details) &&
            entry.details.communicationId === "active-new-task",
        );
      expect(deliveries).toHaveLength(0);
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it.each(["abort", "dispose"] as const)(
    "%s waits for passive mail to be durably accepted exactly once",
    async (operation) => {
      const harness = await createAgentSessionHarness();
      process.env.PI_CODING_AGENT_DIR = harness.agentDir;
      const toolStarted = Promise.withResolvers<undefined>();
      const order: string[] = [];
      harness.setResponses([
        fauxAssistantMessage(fauxToolCall("wait", {}, { id: `wait-passive-${operation}` }), {
          stopReason: "toolUse",
        }),
      ]);
      const runtime = await createChildRuntime({
        ...runtimeRequest(harness),
        bridge: async (pi) => {
          pi.registerTool({
            description: "Wait until aborted",
            async execute(_toolCallId, _params, signal) {
              toolStarted.resolve(undefined);
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
            name: "wait",
            parameters: Type.Object({}),
          });
          pi.on("session_shutdown", () => {
            order.push("shutdown");
          });
        },
        tools: ["wait"],
      });
      runtime.commit();
      try {
        const turn = runtime.startTurn({ text: "initial task" });
        await turn.accepted;
        await toolStarted.promise;
        const deliveryId = `passive-${operation}`;
        const delivery = runtime.sendMessage({
          content: `mail persisted during ${operation}`,
          customType: "subagent-message",
          details: { communicationId: deliveryId },
        });
        void delivery.accepted.then(() => {
          order.push("accepted");
        });

        if (operation === "abort") {
          await runtime.abort();
        } else {
          await runtime.dispose();
        }
        order.push("stopped");

        await expect(delivery.accepted).resolves.toBeUndefined();
        await turn.settled;
        expect(order).toStrictEqual(
          operation === "abort" ? ["accepted", "stopped"] : ["accepted", "shutdown", "stopped"],
        );
        const deliveries = SessionManager.open(
          runtime.sessionFile,
          path.dirname(runtime.sessionFile),
          path.dirname(harness.agentDir),
        )
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom_message" &&
              Value.Check(CommunicationDetailsSchema, entry.details) &&
              entry.details.communicationId === deliveryId,
          );
        expect(deliveries).toHaveLength(1);
      } finally {
        await runtime.dispose();
        harness.cleanup();
      }
    },
  );

  it("waits for agent-settled passive verification before abort returns", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const agentEnd = Promise.withResolvers<undefined>();
    const releaseAgentEnd = Promise.withResolvers<undefined>();
    const agentSettled = Promise.withResolvers<undefined>();
    const releaseAgentSettled = Promise.withResolvers<undefined>();
    harness.setResponses([fauxAssistantMessage("finished")]);
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: async (pi) => {
        pi.on("agent_end", async () => {
          agentEnd.resolve(undefined);
          await releaseAgentEnd.promise;
        });
        pi.on("agent_settled", async () => {
          agentSettled.resolve(undefined);
          await releaseAgentSettled.promise;
        });
      },
    });
    runtime.commit();
    let verification: ReturnType<typeof blockNextTranscriptVerification> | undefined;
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      await agentEnd.promise;
      const deliveryId = "passive-settlement-verification";
      const delivery = runtime.sendMessage({
        content: "mail flushed at settlement",
        customType: "subagent-message",
        details: { communicationId: deliveryId },
      });
      releaseAgentEnd.resolve(undefined);
      await agentSettled.promise;
      verification = blockNextTranscriptVerification();
      releaseAgentSettled.resolve(undefined);
      await verification.started.promise;

      let stopped = false;
      const abort = runtime.abort().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopped).toBeFalsy();

      verification.release.resolve(undefined);
      await expect(delivery.accepted).resolves.toBeUndefined();
      await abort;
      await turn.settled;
      expect(
        SessionManager.open(
          runtime.sessionFile,
          path.dirname(runtime.sessionFile),
          path.dirname(harness.agentDir),
        )
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom_message" &&
              Value.Check(CommunicationDetailsSchema, entry.details) &&
              entry.details.communicationId === deliveryId,
          ),
      ).toHaveLength(1);
    } finally {
      verification?.spy.mockRestore();
      verification?.release.resolve(undefined);
      releaseAgentEnd.resolve(undefined);
      releaseAgentSettled.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("waits for direct-appended message verification before abort returns", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const runtime = await createChildRuntime(runtimeRequest(harness));
    runtime.commit();
    const verification = blockNextTranscriptVerification();
    try {
      const deliveryId = "direct-append-verification";
      const delivery = runtime.sendMessage({
        content: "mail appended while idle",
        customType: "subagent-message",
        details: { communicationId: deliveryId },
      });
      await verification.started.promise;

      let stopped = false;
      const abort = runtime.abort().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopped).toBeFalsy();

      verification.release.resolve(undefined);
      await expect(delivery.accepted).resolves.toBeUndefined();
      await abort;
      expect(
        SessionManager.open(
          runtime.sessionFile,
          path.dirname(runtime.sessionFile),
          path.dirname(harness.agentDir),
        )
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom_message" &&
              Value.Check(CommunicationDetailsSchema, entry.details) &&
              entry.details.communicationId === deliveryId,
          ),
      ).toHaveLength(1);
    } finally {
      verification.spy.mockRestore();
      verification.release.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("waits for consumed steering verification before abort returns", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const releaseFirstResponse = Promise.withResolvers<undefined>();
    const firstTurnEnd = Promise.withResolvers<undefined>();
    const releaseFirstTurnEnd = Promise.withResolvers<undefined>();
    let heldTurnEnd = false;
    harness.setResponses([
      async () => {
        await releaseFirstResponse.promise;
        return fauxAssistantMessage("first answer");
      },
      fauxAssistantMessage("answer after steering"),
    ]);
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: async (pi) => {
        pi.on("turn_end", async () => {
          if (heldTurnEnd) {
            return;
          }
          heldTurnEnd = true;
          firstTurnEnd.resolve(undefined);
          await releaseFirstTurnEnd.promise;
        });
      },
    });
    runtime.commit();
    let verification: ReturnType<typeof blockNextTranscriptVerification> | undefined;
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      const deliveryId = "consumed-steering-verification";
      const delivery = runtime.sendMessage(
        {
          content: "steering consumed before interrupt",
          customType: "subagent-message",
          details: { communicationId: deliveryId },
        },
        undefined,
        true,
      );
      releaseFirstResponse.resolve(undefined);
      await firstTurnEnd.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      verification = blockNextTranscriptVerification();
      releaseFirstTurnEnd.resolve(undefined);
      await verification.started.promise;

      let stopped = false;
      const abort = runtime.abort().then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(stopped).toBeFalsy();

      verification.release.resolve(undefined);
      await expect(delivery.accepted).resolves.toBeUndefined();
      await abort;
      await turn.settled;
      expect(
        SessionManager.open(
          runtime.sessionFile,
          path.dirname(runtime.sessionFile),
          path.dirname(harness.agentDir),
        )
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom_message" &&
              Value.Check(CommunicationDetailsSchema, entry.details) &&
              entry.details.communicationId === deliveryId,
          ),
      ).toHaveLength(1);
    } finally {
      verification?.spy.mockRestore();
      verification?.release.resolve(undefined);
      releaseFirstResponse.resolve(undefined);
      releaseFirstTurnEnd.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("holds passive mail through a tool abort until the next explicit turn", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const toolStarted = Promise.withResolvers<undefined>();
    const agentSettled = Promise.withResolvers<undefined>();
    const releaseAgentSettled = Promise.withResolvers<undefined>();
    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("wait", {}, { id: "wait-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("next explicit answer"),
    ]);
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: async (pi) => {
        pi.on("agent_settled", async () => {
          agentSettled.resolve(undefined);
          await releaseAgentSettled.promise;
        });
        pi.registerTool({
          description: "Wait until aborted",
          async execute(_toolCallId, _params, signal) {
            toolStarted.resolve(undefined);
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
          name: "wait",
          parameters: Type.Object({}),
        });
      },
      tools: ["wait"],
    });
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      await toolStarted.promise;
      let delivered = false;
      const delivery = runtime.sendMessage({
        content: "mail held through abort",
        customType: "subagent-message",
        details: { communicationId: "message-abort" },
      });
      void delivery.accepted.then(() => {
        delivered = true;
      });

      const abort = runtime.abort();
      await agentSettled.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(delivered).toBeFalsy();
      expect(harness.getPendingResponseCount()).toBe(1);

      releaseAgentSettled.resolve(undefined);
      await abort;
      await expect(turn.settled).resolves.toMatchObject({ status: "interrupted" });
      await delivery.accepted;
      expect(harness.getPendingResponseCount()).toBe(1);
      expect(
        SessionManager.open(
          runtime.sessionFile,
          path.dirname(runtime.sessionFile),
          path.dirname(harness.agentDir),
        )
          .getBranch()
          .some(
            (entry) =>
              entry.type === "custom_message" &&
              Value.Check(CommunicationDetailsSchema, entry.details) &&
              entry.details.communicationId === "message-abort",
          ),
      ).toBeTruthy();

      const next = runtime.startTurn({ text: "next task" });
      await next.accepted;
      await expect(next.settled).resolves.toMatchObject({ text: "next explicit answer" });
      expect(lastProviderPayloadText(harness)).toContain("mail held through abort");
    } finally {
      releaseAgentSettled.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("defers passive mail until a retry has safely completed", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    await writeFile(
      path.join(harness.agentDir, "settings.json"),
      JSON.stringify({
        retry: {
          baseDelayMs: 1,
          enabled: true,
          maxRetries: 1,
          provider: { maxRetries: 0 },
        },
      }),
    );
    const errorStarted = Promise.withResolvers<undefined>();
    const releaseError = Promise.withResolvers<undefined>();
    harness.setResponses([
      async () => {
        errorStarted.resolve(undefined);
        await releaseError.promise;
        return fauxAssistantMessage("", {
          errorMessage: "server overloaded",
          stopReason: "error",
        });
      },
      fauxAssistantMessage("answer after retry"),
    ]);
    const runtime = await createChildRuntime(runtimeRequest(harness));
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      await errorStarted.promise;
      const delivery = runtime.sendMessage({
        content: "mail held across retry",
        customType: "subagent-message",
        details: { communicationId: "message-retry" },
      });
      releaseError.resolve(undefined);

      await expect(turn.settled).resolves.toMatchObject({
        text: "answer after retry",
      });
      await delivery.accepted;

      const payloads = harness.providerPayloads(
        Type.Object(
          { messages: Type.Optional(Type.Array(Type.Unknown())) },
          { additionalProperties: true },
        ),
      );
      expect(payloads).toHaveLength(2);
      expect(JSON.stringify(payloads[1]?.messages)).not.toContain("server overloaded");
      expect(JSON.stringify(payloads[1]?.messages)).not.toContain("mail held across retry");

      const persisted = SessionManager.open(
        runtime.sessionFile,
        path.dirname(runtime.sessionFile),
        path.dirname(harness.agentDir),
      ).getBranch();
      const successfulAssistantIndex = persisted.findLastIndex(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.stopReason !== "error",
      );
      const customIndex = persisted.findIndex(
        (entry) =>
          entry.type === "custom_message" &&
          Value.Check(CommunicationDetailsSchema, entry.details) &&
          entry.details.communicationId === "message-retry",
      );
      expect(successfulAssistantIndex).toBeGreaterThanOrEqual(0);
      expect(customIndex).toBeGreaterThan(successfulAssistantIndex);
    } finally {
      releaseError.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("does not steer passive mail behind existing one-at-a-time steering", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const toolStarted = Promise.withResolvers<undefined>();
    const releaseTool = Promise.withResolvers<undefined>();
    const inputSeen = Promise.withResolvers<undefined>();
    let steerExisting: (() => void) | undefined;
    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("continue", {}, { id: "continue-steer-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("answer to existing steering"),
      fauxAssistantMessage("next explicit answer"),
    ]);
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: async (pi) => {
        steerExisting = () => {
          pi.sendUserMessage("existing user steering", { deliverAs: "steer" });
        };
        pi.on("input", () => {
          inputSeen.resolve(undefined);
          return { action: "continue" };
        });
        pi.registerTool({
          description: "Continue after a barrier",
          async execute() {
            toolStarted.resolve(undefined);
            await releaseTool.promise;
            return {
              content: [{ text: "continued", type: "text" }],
              details: {},
            };
          },
          label: "Continue",
          name: "continue",
          parameters: Type.Object({}),
        });
      },
      tools: ["continue"],
    });
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      await toolStarted.promise;
      const delivery = runtime.sendMessage({
        content: "mail held behind existing steering",
        customType: "subagent-message",
        details: { communicationId: "message-existing-steer" },
      });
      steerExisting?.();
      await inputSeen.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      releaseTool.resolve(undefined);

      await expect(turn.settled).resolves.toMatchObject({
        text: "answer to existing steering",
      });
      await delivery.accepted;
      expect(harness.getPendingResponseCount()).toBe(1);
      const payloads = harness.providerPayloads(
        Type.Object(
          { messages: Type.Optional(Type.Array(Type.Unknown())) },
          { additionalProperties: true },
        ),
      );
      expect(payloads).toHaveLength(2);
      expect(JSON.stringify(payloads[1]?.messages)).toContain("existing user steering");
      expect(JSON.stringify(payloads[1]?.messages)).not.toContain(
        "mail held behind existing steering",
      );

      const next = runtime.startTurn({ text: "next task" });
      await next.accepted;
      await expect(next.settled).resolves.toMatchObject({ text: "next explicit answer" });
      expect(lastProviderPayloadText(harness)).toContain("mail held behind existing steering");
    } finally {
      releaseTool.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("does not continue after an all-terminating tool batch", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const toolStarted = Promise.withResolvers<undefined>();
    const releaseTool = Promise.withResolvers<undefined>();
    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("terminate", {}, { id: "terminate-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("next explicit turn"),
    ]);
    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: async (pi) => {
        pi.registerTool({
          description: "Terminate after a barrier",
          async execute() {
            toolStarted.resolve(undefined);
            await releaseTool.promise;
            return {
              content: [{ text: "terminated", type: "text" }],
              details: {},
              terminate: true,
            };
          },
          label: "Terminate",
          name: "terminate",
          parameters: Type.Object({}),
        });
      },
      tools: ["terminate"],
    });
    runtime.commit();
    try {
      const turn = runtime.startTurn({ text: "initial task" });
      await turn.accepted;
      await toolStarted.promise;
      const delivery = runtime.sendMessage({
        content: "mail after terminating tool",
        customType: "subagent-message",
        details: { communicationId: "message-terminal-tool" },
      });
      releaseTool.resolve(undefined);

      await delivery.accepted;
      await expect(turn.settled).resolves.toMatchObject({ status: "completed" });
      expect(harness.getPendingResponseCount()).toBe(1);

      const next = runtime.startTurn({ text: "next task" });
      await next.accepted;
      await expect(next.settled).resolves.toMatchObject({ text: "next explicit turn" });
      expect(lastProviderPayloadText(harness)).toContain("mail after terminating tool");
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("keeps triggering messages active and idle", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const firstResponse = Promise.withResolvers<null>();
    harness.setResponses([
      async () => {
        await firstResponse.promise;
        return fauxAssistantMessage("first answer");
      },
      fauxAssistantMessage("active follow-up"),
      fauxAssistantMessage("idle follow-up"),
    ]);
    const runtime = await createChildRuntime(runtimeRequest(harness));
    runtime.commit();
    try {
      const active = runtime.startTurn({ text: "initial task" });
      await active.accepted;
      const steered = runtime.sendMessage(
        {
          content: "active task",
          customType: "subagent-message",
          details: { communicationId: "active-task" },
        },
        undefined,
        true,
      );
      firstResponse.resolve(null);
      await steered.accepted;
      await expect(active.settled).resolves.toMatchObject({ text: "active follow-up" });

      const idle = runtime.sendMessage(
        {
          content: "idle task",
          customType: "subagent-message",
          details: { communicationId: "idle-task" },
        },
        undefined,
        true,
      );
      await idle.accepted;
      await expect(idle.settled).resolves.toMatchObject({ text: "idle follow-up" });
      expect(harness.getPendingResponseCount()).toBe(0);
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("rejects restoring a transcript for another child", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const runtime = await createChildRuntime(runtimeRequest(harness));
    runtime.commit();
    const { sessionFile } = runtime;
    await runtime.dispose();
    try {
      await expect(
        createChildRuntime({
          ...runtimeRequest(harness, "/root/sibling"),
          sessionFile,
        }),
      ).rejects.toThrow("belongs to a different agent");
    } finally {
      harness.cleanup();
    }
  });

  it("rejects a symlinked child-session directory", async () => {
    const harness = await createAgentSessionHarness();
    const target = await mkdtemp(path.join(os.tmpdir(), "subagents-sessions-"));
    const dataDir = path.join(harness.agentDir, "data", "subagents");
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    try {
      await mkdir(dataDir, { recursive: true });
      await symlink(target, path.join(dataDir, "sessions"));

      await expect(createChildRuntime({ ...runtimeRequest(harness), dataDir })).rejects.toThrow(
        "must be a regular directory",
      );
    } finally {
      await rm(target, { force: true, recursive: true });
      harness.cleanup();
    }
  });
});
