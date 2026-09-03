import { rm } from "node:fs/promises";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { parseRecapEntry, RECAP_ENTRY_TYPE } from "../entry.js";
import { createRecapRuntime, RECAP_REQUEST_TIMEOUT_MS, RECAP_RETRY_DELAY_MS } from "../runtime.js";
import {
  completionMock,
  createRecapConfigFile,
  flushPromises,
  sessionWithTurns,
} from "./fixtures.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";

type CompleteModel = ExtensionContext["modelRegistry"]["complete"];
type FindModel = ExtensionContext["modelRegistry"]["find"];

const setup = async (complete: CompleteModel, find?: FindModel, configuredModelId = "small") => {
  const { configPath } = await createRecapConfigFile(configuredModelId);
  const session = sessionWithTurns(3);
  const branch = session.getBranch();
  const model = fauxProvider({
    models: [{ id: "small" }],
    provider: "cheap",
  }).getModel();
  const activeModel = fauxProvider({
    models: [{ id: "expensive" }],
    provider: "active",
  }).getModel();
  let runtime: ReturnType<typeof createRecapRuntime> | undefined;
  const host = createExtensionHost(
    (pi) => {
      runtime = createRecapRuntime(pi, configPath);
    },
    {
      entries: branch,
      leafId: branch.at(-1)?.id,
      model: activeModel,
    },
  );
  await host.ready;
  if (runtime === undefined) {
    throw new Error("Recap runtime was not created");
  }
  const ctx = host.createContext({
    modelRegistry: {
      complete,
      find: find ?? (() => model),
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
  });
  await runtime.start(ctx);
  return { configPath, ctx, host, model, runtime };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("recap runtime", () => {
  it("uses the configured model and appends a display-only recap", async () => {
    const completion = completionMock(async () =>
      fauxAssistantMessage(
        "  \u001B[31mFinished the parser.\u001B[0m\u0007 Next: test it.\u202E  ",
      ),
    );
    const { ctx, host, model, runtime } = await setup(completion);

    runtime.settled(ctx);

    await vi.waitFor(() => {
      expect(host.getAppendedEntries()).toHaveLength(1);
    });
    expect(completion.mock.calls).toHaveLength(1);
    expect(completion.mock.calls[0]?.[0]).toBe(model);
    expect(completion.mock.calls[0]?.[1]).not.toHaveProperty("systemPrompt");
    expect(completion.mock.calls[0]?.[1]).not.toHaveProperty("tools");
    expect(completion.mock.calls[0]?.[1].messages[0]?.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("Write a brief catch-up"),
        type: "text",
      }),
    ]);
    expect(completion.mock.calls[0]?.[2]).toMatchObject({
      cacheRetention: "none",
      maxTokens: 4096,
      timeoutMs: 30_000,
    });
    expect(completion.mock.calls[0]?.[2]?.sessionId).toEqual(expect.any(String));
    expect(completion.mock.calls[0]?.[2]?.sessionId).not.toBe("");
    expect(completion.mock.calls[0]?.[2]?.sessionId).not.toBe(ctx.sessionManager.getSessionId());

    const [entry] = host.getAppendedEntries();
    expect(entry?.type).toBe("custom");
    if (entry?.type !== "custom") {
      throw new Error("Expected a custom recap entry");
    }
    expect(entry.customType).toBe(RECAP_ENTRY_TYPE);
    expect(parseRecapEntry(entry.data)).toStrictEqual({
      completedTurns: 3,
      recap: "Finished the parser. Next: test it.",
    });
  });

  it("caps output at the configured model limit", async () => {
    const completion = completionMock(async () => fauxAssistantMessage("Done"));
    const { ctx, host, model, runtime } = await setup(completion);
    model.maxTokens = 1024;

    runtime.settled(ctx);

    await vi.waitFor(() => {
      expect(host.getAppendedEntries()).toHaveLength(1);
    });
    expect(completion.mock.calls[0]?.[2]?.maxTokens).toBe(1024);
  });

  it("disables itself instead of falling back to the active model", async () => {
    const completion = completionMock(async () => fauxAssistantMessage("unused"));
    const { configPath, ctx, host, runtime } = await setup(
      completion,
      () => undefined,
      "small\u001B[31m\u0007\u202E",
    );

    runtime.settled(ctx);

    expect(host.getNotifications()).toEqual([
      {
        message: `Recap disabled (${configPath}): Model cheap/small was not found by Pi`,
        type: "error",
      },
    ]);
    expect(completion.mock.calls).toHaveLength(0);
    expect(host.getAppendedEntries()).toHaveLength(0);
  });

  it("ignores initialization failure after disposal", async () => {
    const completion = completionMock(async () => fauxAssistantMessage("unused"));
    const { configPath, ctx, host, runtime } = await setup(completion);
    await rm(configPath);

    const starting = runtime.start(ctx);
    runtime.dispose();
    await starting;

    expect(host.getNotifications()).toHaveLength(0);
  });

  it("disables itself after one delayed retry fails", async () => {
    vi.useFakeTimers();
    const completion = completionMock(async () => {
      await Promise.resolve();
      throw new Error("\u001B[31mprovider\u001B[0m\u0007 unavailable\u202E");
    });
    const { configPath, ctx, host, runtime } = await setup(completion);

    runtime.settled(ctx);
    await flushPromises();
    expect(completion.mock.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECAP_RETRY_DELAY_MS);
    expect(completion.mock.calls).toHaveLength(2);
    expect(completion.mock.calls.map(([, , options]) => options?.sessionId)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(
      completion.mock.calls.every(([, , options]) => (options?.sessionId?.length ?? 0) > 0),
    ).toBe(true);
    expect(completion.mock.calls[0]?.[2]?.sessionId).not.toBe(
      completion.mock.calls[1]?.[2]?.sessionId,
    );
    expect(
      completion.mock.calls.every(
        ([, , options]) => options?.sessionId !== ctx.sessionManager.getSessionId(),
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(RECAP_RETRY_DELAY_MS * 2);
    expect(completion.mock.calls).toHaveLength(2);
    expect(host.getAppendedEntries()).toHaveLength(0);
    expect(host.getNotifications()).toEqual([
      {
        message: `Recap disabled (${configPath}) after repeated generation failures: provider unavailable`,
        type: "warning",
      },
    ]);

    runtime.settled(ctx);
    expect(completion.mock.calls).toHaveLength(2);
    expect(host.getNotifications()).toHaveLength(1);
  });

  it("discards a stale retry failure without disabling the current conversation", async () => {
    vi.useFakeTimers();
    const retry = Promise.withResolvers<AssistantMessage>();
    let call = 0;
    const completion = completionMock(async () => {
      call += 1;
      if (call === 1) {
        throw new Error("first failure");
      }
      if (call === 2) {
        return await retry.promise;
      }
      return fauxAssistantMessage("Fresh recap");
    });
    const { ctx, host, runtime } = await setup(completion);
    const fullContext = ctx.sessionManager.buildContextEntries();
    let contextEntries = fullContext;
    Object.assign(ctx.sessionManager, {
      buildContextEntries: () => contextEntries,
    });

    runtime.settled(ctx);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(RECAP_RETRY_DELAY_MS);
    expect(completion.mock.calls).toHaveLength(2);

    contextEntries = fullContext.slice(-2);
    retry.reject(new Error("stale retry failure"));
    await flushPromises();
    expect(host.getNotifications()).toHaveLength(0);

    runtime.settled(ctx);
    await vi.waitFor(() => {
      expect(host.getAppendedEntries()).toHaveLength(1);
    });
    expect(completion.mock.calls).toHaveLength(3);
  });

  it("enforces the deadline when completion ignores cancellation", async () => {
    vi.useFakeTimers();
    const completion = completionMock(async () => await new Promise<AssistantMessage>(() => {}));
    const { ctx, host, runtime } = await setup(completion);

    runtime.settled(ctx);
    expect(completion.mock.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS);
    expect(completion.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(RECAP_RETRY_DELAY_MS);
    expect(completion.mock.calls).toHaveLength(2);
    expect(completion.mock.calls[0]?.[2]?.sessionId).not.toBe(
      completion.mock.calls[1]?.[2]?.sessionId,
    );

    await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS);
    expect(completion.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
    expect(completion.mock.calls).toHaveLength(2);
    expect(host.getAppendedEntries()).toHaveLength(0);
  });

  it("preserves a replacement when the prior completion settles during cancellation", async () => {
    const requests: PromiseWithResolvers<AssistantMessage>[] = [];
    const completion = completionMock(() => {
      const request = Promise.withResolvers<AssistantMessage>();
      requests.push(request);
      return request.promise;
    });
    const { ctx, host, runtime } = await setup(completion);

    runtime.settled(ctx);
    expect(requests).toHaveLength(1);
    requests[0]?.resolve(fauxAssistantMessage("Stale recap"));
    runtime.cancel();
    runtime.settled(ctx);
    await flushPromises();

    expect(requests).toHaveLength(2);
    requests[1]?.resolve(fauxAssistantMessage("Current recap"));
    await vi.waitFor(() => {
      expect(host.getAppendedEntries()).toHaveLength(1);
    });

    expect(host.getAppendedEntries()[0]).toMatchObject({
      data: { recap: "Current recap" },
    });
  });

  it.each(["length", "toolUse", "deferred"] as const)(
    "rejects a textual %s response",
    async (stopReason) => {
      vi.useFakeTimers();
      const completion = completionMock(async () =>
        fauxAssistantMessage("Not a final recap", { stopReason }),
      );
      const { ctx, host, runtime } = await setup(completion);

      runtime.settled(ctx);
      await flushPromises();

      expect(completion.mock.calls).toHaveLength(1);
      expect(host.getAppendedEntries()).toHaveLength(0);
      runtime.cancel();
    },
  );

  it("uses compaction-aware history without resetting lifetime cadence", async () => {
    const completion = completionMock(async () => fauxAssistantMessage("Current context recap"));
    const { ctx, host, runtime } = await setup(completion);
    const fullBranch = ctx.sessionManager.getBranch();
    const compactedContext = fullBranch.slice(-2);
    Object.assign(ctx.sessionManager, {
      buildContextEntries: () => compactedContext,
    });

    runtime.settled(ctx);

    await vi.waitFor(() => {
      expect(host.getAppendedEntries()).toHaveLength(1);
    });
    const prompt = completion.mock.calls[0]?.[1].messages[0]?.content;
    expect(prompt).toEqual([
      expect.objectContaining({
        text: expect.not.stringContaining("request 1"),
      }),
    ]);
    expect(prompt).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("request 3"),
      }),
    ]);
    expect(host.getAppendedEntries()[0]).toMatchObject({
      data: { completedTurns: 3 },
    });
  });

  it("discards a recap when compaction changes its prompt before completion", async () => {
    const request = Promise.withResolvers<AssistantMessage>();
    const completion = completionMock(() => request.promise);
    const { ctx, host, runtime } = await setup(completion);
    const fullContext = ctx.sessionManager.buildContextEntries();
    let contextEntries = fullContext;
    Object.assign(ctx.sessionManager, {
      buildContextEntries: () => contextEntries,
    });

    runtime.settled(ctx);
    contextEntries = fullContext.slice(-2);
    request.resolve(fauxAssistantMessage("This result is stale"));
    await flushPromises();

    expect(completion.mock.calls).toHaveLength(1);
    expect(host.getAppendedEntries()).toHaveLength(0);
  });

  it("discards a recap when the active conversation changes before completion", async () => {
    let finish: ((message: AssistantMessage) => void) | undefined;
    const completion = completionMock(
      async () =>
        await new Promise<AssistantMessage>((resolve) => {
          finish = resolve;
        }),
    );
    const { ctx, host, runtime } = await setup(completion);

    runtime.settled(ctx);
    await flushPromises();
    const changedBranch = sessionWithTurns(4).getBranch();
    Object.assign(ctx.sessionManager, {
      getBranch: () => changedBranch,
    });
    if (finish === undefined) {
      throw new Error("Recap completion did not start");
    }
    finish(fauxAssistantMessage("This result is stale"));
    await flushPromises();

    expect(completion.mock.calls).toHaveLength(1);
    expect(host.getAppendedEntries()).toHaveLength(0);
  });
});
