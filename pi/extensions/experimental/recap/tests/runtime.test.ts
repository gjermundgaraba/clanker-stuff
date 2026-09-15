import { Value } from "typebox/value";
import { getEventListeners } from "node:events";
import { rm, writeFile } from "node:fs/promises";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { RecapConfig } from "../config.js";
import { buildRecapPrompt } from "../conversation.js";
import { RecapEntrySchema, RECAP_ENTRY_TYPE } from "../entry.js";
import { createRecapRuntime, RECAP_REQUEST_TIMEOUT_MS } from "../runtime.js";
import {
  completionMock,
  createRecapConfigFile,
  flushPromises,
  sessionWithTurns,
  userMessage,
} from "./fixtures.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";

type CompleteModel = ExtensionContext["modelRegistry"]["complete"];
interface SetupOptions {
  config?: RecapConfig;
  model?: Partial<Model<Api>>;
  registry?: Partial<ExtensionContext["modelRegistry"]>;
}

const setup = async (complete: CompleteModel, options: SetupOptions = {}) => {
  const { configPath } = await createRecapConfigFile(options.config);
  const session = sessionWithTurns(3);
  const branch = session.getBranch();
  const model = fauxProvider({
    models: [{ id: "small" }],
    provider: "cheap",
  }).getModel();
  Object.assign(model, options.model);
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
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true }),
      ...options.registry,
    },
  });
  await runtime.start(ctx);
  return { configPath, ctx, host, model, runtime };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("recap runtime", () => {
  it("does not duplicate a recap on repeated settled events or reload", async () => {
    const completion = completionMock(async () => fauxAssistantMessage("Recap"));
    const { ctx, host, runtime } = await setup(completion);

    runtime.settled(ctx);
    await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));
    runtime.settled(ctx);
    await runtime.start(ctx);
    runtime.settled(ctx);
    await flushPromises();

    expect(completion).toHaveBeenCalledTimes(1);
    expect(host.getAppendedEntries()).toHaveLength(1);
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "sends configured %s thinking through the registered provider with fresh auth",
    async (thinking) => {
      const completion = completionMock(async () => fauxAssistantMessage("unused"));
      const { provider, setResponses } = fauxProvider({ provider: "cheap" });
      setResponses([fauxAssistantMessage("Recap")]);
      const stream = vi.spyOn(provider, "streamSimple");
      const getAuth = vi
        .fn<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>()
        .mockResolvedValueOnce({ ok: true, apiKey: "startup-key" })
        .mockResolvedValue({
          ok: true,
          apiKey: "fresh-key",
          baseUrl: "https://recap.example.test",
          env: { RECAP_AUTH: "ambient" },
          headers: { "x-recap": "test" },
        });
      const { ctx, host, model, runtime } = await setup(completion, {
        config: { model: { id: "small", provider: "cheap" }, thinking },
        model: { reasoning: true, thinkingLevelMap: { max: "max", xhigh: "xhigh" } },
        registry: { getApiKeyAndHeaders: getAuth, getProvider: () => provider },
      });

      runtime.settled(ctx);
      await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));

      expect(completion).not.toHaveBeenCalled();
      expect(getAuth).toHaveBeenCalledTimes(2);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(stream.mock.calls[0]?.[0]).toEqual({
        ...model,
        baseUrl: "https://recap.example.test",
      });
      expect(stream.mock.calls[0]?.[1]).not.toHaveProperty("tools");
      expect(stream.mock.calls[0]?.[1]).not.toHaveProperty("systemPrompt");
      expect(stream.mock.calls[0]?.[2]).not.toHaveProperty("maxTokens");
      expect(stream.mock.calls[0]?.[2]).toMatchObject({
        apiKey: "fresh-key",
        cacheRetention: "none",
        env: { RECAP_AUTH: "ambient" },
        headers: { "x-recap": "test" },
        reasoning: thinking === "off" ? undefined : thinking,
        sessionId: expect.any(String),
        signal: expect.any(AbortSignal),
        timeoutMs: RECAP_REQUEST_TIMEOUT_MS,
      });
    },
  );

  it.each([
    { reasoning: false, thinking: "high", expected: undefined },
    { reasoning: true, thinking: "max", expected: "high" },
  ] as const)(
    "clamps thinking to model capabilities: %j",
    async ({ reasoning, thinking, expected }) => {
      const completion = completionMock(async () => fauxAssistantMessage("unused"));
      const { provider, setResponses } = fauxProvider({ provider: "cheap" });
      setResponses([fauxAssistantMessage("Recap")]);
      const stream = vi.spyOn(provider, "streamSimple");
      const { ctx, host, runtime } = await setup(completion, {
        config: { model: { id: "small", provider: "cheap" }, thinking },
        model: { reasoning },
        registry: { getProvider: () => provider },
      });
      runtime.settled(ctx);
      await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));
      expect(stream.mock.calls[0]?.[2]?.reasoning).toBe(expected);
    },
  );

  it("restores native defaults when thinking is removed on reload", async () => {
    const completion = completionMock(async () => fauxAssistantMessage("Recap"));
    const model = { id: "small", provider: "cheap" };
    const { configPath, ctx, host, runtime } = await setup(completion, {
      config: { model, thinking: "high" },
    });
    await writeFile(configPath, JSON.stringify({ model }));
    await runtime.start(ctx);
    runtime.settled(ctx);
    await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0]?.[2]).not.toHaveProperty("reasoning");
  });

  it.each(["cancel", "timeout"])(
    "does not dispatch after %s while resolving thinking-request auth",
    async (action) => {
      vi.useFakeTimers();
      const completion = completionMock(async () => fauxAssistantMessage("unused"));
      const { provider } = fauxProvider({ provider: "cheap" });
      const stream = vi.spyOn(provider, "streamSimple");
      const auth =
        Promise.withResolvers<
          Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>
        >();
      const getAuth = vi
        .fn<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>()
        .mockResolvedValueOnce({ ok: true })
        .mockImplementation(() => auth.promise);
      const { ctx, host, runtime } = await setup(completion, {
        config: { model: { id: "small", provider: "cheap" }, thinking: "low" },
        registry: { getApiKeyAndHeaders: getAuth, getProvider: () => provider },
      });

      runtime.settled(ctx);
      expect(getAuth).toHaveBeenCalledTimes(2);
      if (action === "cancel") {
        runtime.cancel();
      } else {
        await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS);
      }
      auth.resolve({ ok: true });
      await flushPromises();

      expect(stream).not.toHaveBeenCalled();
      expect(completion).not.toHaveBeenCalled();
      expect(host.getAppendedEntries()).toHaveLength(0);
      expect(host.getNotifications()).toHaveLength(action === "timeout" ? 1 : 0);
      runtime.dispose();
    },
  );

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
      timeoutMs: 30_000,
    });
    expect(completion.mock.calls[0]?.[2]?.sessionId).toEqual(expect.any(String));
    expect(completion.mock.calls[0]?.[2]?.sessionId).not.toBe("");
    expect(completion.mock.calls[0]?.[2]?.sessionId).not.toBe(ctx.sessionManager.getSessionId());
    const signal = completion.mock.calls[0]?.[2]?.signal;
    if (signal === undefined) throw new Error("Missing recap abort signal");
    expect(getEventListeners(signal, "abort")).toHaveLength(0);

    const [entry] = host.getAppendedEntries();
    expect(entry?.type).toBe("custom");
    if (entry?.type !== "custom") {
      throw new Error("Expected a custom recap entry");
    }
    expect(entry.customType).toBe(RECAP_ENTRY_TYPE);
    expect(Value.Check(RecapEntrySchema, entry.data)).toBe(true);
    expect(entry.data).toStrictEqual({
      completedTurns: 3,
      recap: "Finished the parser. Next: test it.",
    });
  });

  it("leaves the output token limit to the model provider", async () => {
    const completion = completionMock(async () => fauxAssistantMessage("Done"));
    const { ctx, host, runtime } = await setup(completion, { model: { maxTokens: 1024 } });

    runtime.settled(ctx);

    await vi.waitFor(() => {
      expect(host.getAppendedEntries()).toHaveLength(1);
    });
    expect(completion.mock.calls[0]?.[2]).not.toHaveProperty("maxTokens");
  });

  it("disables itself instead of falling back to the active model", async () => {
    const completion = completionMock(async () => fauxAssistantMessage("unused"));
    const { configPath, ctx, host, runtime } = await setup(completion, {
      config: { model: { id: "small\u001B[31m\u0007\u202E", provider: "cheap" } },
      registry: { find: () => undefined },
    });

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

  it.each(["context", "revision", "reload"] as const)(
    "suppresses an unsuccessful snapshot without retrying and recovers after %s changes",
    async (recovery) => {
      vi.useFakeTimers();
      let calls = 0;
      const completion = completionMock(async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("\u001B[31mprovider\u001B[0m\u0007 unavailable\u202E");
        }
        return fauxAssistantMessage("Fresh recap");
      });
      const { ctx, host, runtime } = await setup(completion);

      runtime.settled(ctx);
      await flushPromises();
      expect(host.getNotifications()).toEqual([
        { message: "Recap skipped: provider unavailable", type: "warning" },
      ]);
      runtime.cancel();
      runtime.settled(ctx);
      await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS * 10);
      expect(completion).toHaveBeenCalledTimes(1);
      expect(host.getNotifications()).toHaveLength(1);
      expect(host.getAppendedEntries()).toHaveLength(0);

      if (recovery === "context") {
        const shorterContext = ctx.sessionManager.buildContextEntries().slice(-2);
        Object.assign(ctx.sessionManager, { buildContextEntries: () => shorterContext });
      } else if (recovery === "revision") {
        const changedBranch = sessionWithTurns(4).getBranch();
        // Leave the prompt unchanged to prove that revision alone unlocks generation.
        Object.assign(ctx.sessionManager, { getBranch: () => changedBranch });
      } else {
        await runtime.start(ctx);
      }
      runtime.settled(ctx);
      await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));
      expect(completion).toHaveBeenCalledTimes(2);
      expect(host.getNotifications()).toHaveLength(1);
      expect(completion.mock.calls[0]?.[2]?.sessionId).not.toBe(
        completion.mock.calls[1]?.[2]?.sessionId,
      );
    },
  );

  it.each([0, -1])(
    "skips estimated input at or above the model window (offset %i)",
    async (offset) => {
      const prompt = buildRecapPrompt(sessionWithTurns(3).getBranch());
      if (prompt === undefined) throw new Error("Expected recap prompt");
      const estimated = estimateTokens(userMessage(prompt));
      const completion = completionMock(async () => fauxAssistantMessage("Fits now"));
      const { ctx, host, runtime } = await setup(completion, {
        model: { contextWindow: estimated + offset },
      });

      runtime.settled(ctx);
      runtime.settled(ctx);
      expect(completion).not.toHaveBeenCalled();
      expect(host.getAppendedEntries()).toHaveLength(0);
      expect(host.getNotifications()).toEqual([
        {
          message: `Recap skipped: Estimated input (${estimated} tokens) reaches or exceeds cheap/small's context window (${estimated + offset} tokens)`,
          type: "warning",
        },
      ]);

      const shorterContext = ctx.sessionManager.buildContextEntries().slice(-2);
      Object.assign(ctx.sessionManager, { buildContextEntries: () => shorterContext });
      runtime.settled(ctx);
      await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));
      expect(completion).toHaveBeenCalledTimes(1);
      expect(host.getNotifications()).toHaveLength(1);
    },
  );

  it("sends the full prompt below the window without reserving the model's maximum output", async () => {
    const prompt = buildRecapPrompt(sessionWithTurns(3).getBranch());
    if (prompt === undefined) throw new Error("Expected recap prompt");
    const completion = completionMock(async () => fauxAssistantMessage("Recap"));
    const { ctx, host, runtime } = await setup(completion, {
      model: { contextWindow: estimateTokens(userMessage(prompt)) + 1, maxTokens: 4096 },
    });

    runtime.settled(ctx);
    await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));
    expect(completion.mock.calls[0]?.[1].messages[0]?.content).toEqual([
      { type: "text", text: prompt },
    ]);
    expect(completion.mock.calls[0]?.[2]).not.toHaveProperty("maxTokens");
  });

  it("leaves an unknown context window to the provider", async () => {
    const completion = completionMock(async () => fauxAssistantMessage("Recap"));
    const { ctx, host, runtime } = await setup(completion, { model: { contextWindow: 0 } });
    runtime.settled(ctx);
    await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));
    expect(completion).toHaveBeenCalledTimes(1);
    expect(host.getNotifications()).toHaveLength(0);
  });

  it.each(["error", "silent", "length"] as const)(
    "recognizes %s provider overflow and allows the next turn",
    async (kind) => {
      const response = fauxAssistantMessage("Overflow", {
        stopReason: kind === "silent" ? "stop" : kind,
        errorMessage:
          kind === "error" ? "Your input exceeds the context window of this model" : undefined,
      });
      response.usage = { ...response.usage, input: 1001, output: 0, cacheRead: 0 };
      let calls = 0;
      const completion = completionMock(async () => {
        calls += 1;
        return calls === 1 ? response : fauxAssistantMessage("Fresh recap");
      });
      const { ctx, host, runtime } = await setup(completion, { model: { contextWindow: 1000 } });

      runtime.settled(ctx);
      await flushPromises();
      runtime.settled(ctx);
      expect(completion).toHaveBeenCalledTimes(1);
      expect(host.getAppendedEntries()).toHaveLength(0);
      expect(host.getNotifications()).toEqual([
        {
          message: "Recap skipped: Recap input exceeds the model's context window",
          type: "warning",
        },
      ]);

      const changedBranch = sessionWithTurns(4).getBranch();
      Object.assign(ctx.sessionManager, {
        getBranch: () => changedBranch,
        buildContextEntries: () => changedBranch,
      });
      runtime.settled(ctx);
      await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));
      expect(completion).toHaveBeenCalledTimes(2);
    },
  );

  it("discards stale failures without warning or suppressing the changed context", async () => {
    const request = Promise.withResolvers<AssistantMessage>();
    let calls = 0;
    const completion = completionMock(() => {
      calls += 1;
      return calls === 1 ? request.promise : Promise.resolve(fauxAssistantMessage("Fresh recap"));
    });
    const { ctx, host, runtime } = await setup(completion);
    const fullContext = ctx.sessionManager.buildContextEntries();
    let contextEntries = fullContext;
    Object.assign(ctx.sessionManager, { buildContextEntries: () => contextEntries });

    runtime.settled(ctx);
    contextEntries = fullContext.slice(-2);
    request.reject(new Error("stale failure"));
    await flushPromises();
    expect(host.getNotifications()).toHaveLength(0);

    runtime.settled(ctx);
    await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));
    expect(completion).toHaveBeenCalledTimes(2);
  });

  it("times out an uncooperative provider without retrying or disabling later turns", async () => {
    vi.useFakeTimers();
    const request = Promise.withResolvers<AssistantMessage>();
    let calls = 0;
    const completion = completionMock(() => {
      calls += 1;
      return calls === 1 ? request.promise : Promise.resolve(fauxAssistantMessage("Fresh recap"));
    });
    const { ctx, host, runtime } = await setup(completion);

    runtime.settled(ctx);
    await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS);
    expect(completion.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(completion.mock.calls[0]?.[2]?.signal?.reason).toEqual(
      new Error("Recap request timed out"),
    );
    expect(host.getNotifications()).toEqual([
      { message: "Recap skipped: Recap request timed out", type: "warning" },
    ]);
    runtime.settled(ctx);
    await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS * 10);
    expect(completion).toHaveBeenCalledTimes(1);
    expect(host.getAppendedEntries()).toHaveLength(0);

    const changedBranch = sessionWithTurns(4).getBranch();
    Object.assign(ctx.sessionManager, {
      getBranch: () => changedBranch,
      buildContextEntries: () => changedBranch,
    });
    runtime.settled(ctx);
    await vi.waitFor(() => expect(host.getAppendedEntries()).toHaveLength(1));
    request.resolve(fauxAssistantMessage("Late recap"));
    await flushPromises();
    expect(host.getAppendedEntries()).toHaveLength(1);
    expect(host.getAppendedEntries()[0]).toMatchObject({ data: { recap: "Fresh recap" } });
    expect(host.getNotifications()).toHaveLength(1);
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

  it("ignores a late provider rejection after cancellation", async () => {
    const request = Promise.withResolvers<AssistantMessage>();
    const completion = completionMock(() => request.promise);
    const { ctx, host, runtime } = await setup(completion);

    runtime.settled(ctx);
    runtime.cancel();
    await flushPromises();
    request.reject(new Error("Abandoned provider failed"));
    await flushPromises();

    expect(host.getAppendedEntries()).toHaveLength(0);
    expect(host.getNotifications()).toHaveLength(0);
    expect(completion.mock.calls).toHaveLength(1);
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
      runtime.settled(ctx);
      await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS * 10);

      expect(completion.mock.calls).toHaveLength(1);
      expect(host.getAppendedEntries()).toHaveLength(0);
      expect(host.getNotifications()).toHaveLength(1);
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
