import { getEventListeners } from "node:events";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { generateRecap, RECAP_REQUEST_TIMEOUT_MS } from "../recap.js";
import { queuedStream, sampleUsage } from "./fixtures.js";
import type { ResponseStep } from "./fixtures.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";

const setup = (...responses: ResponseStep[]) => {
  const model = fauxProvider({
    models: [{ id: "small", reasoning: true }],
    provider: "cheap",
  }).getModel();

  const stream = queuedStream(...responses);

  const ctx = createExtensionHost(() => {}).createContext({
    modelRegistry: {
      find: () => model,
      streamSimple: stream,
    },
  });

  return { model, stream, ctx, signal: new AbortController().signal };
};

afterEach(() => vi.useRealTimers());

describe("isolated recap requests", () => {
  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "maps %s thinking without inheriting the active model",
    async (thinking) => {
      const env = setup(() => ({
        ...fauxAssistantMessage("\u001B[31mReady\u001B[0m\u0007\u202E"),
        usage: sampleUsage(),
      }));

      env.model.thinkingLevelMap = { xhigh: "xhigh", max: "max" };

      const result = await generateRecap(
        env.ctx,
        { model: { provider: "cheap", id: "small" }, thinking },
        "Prompt",
        env.signal,
      );

      expect(result).toMatchObject({
        status: "ready",
        text: "Ready",
        usage: { input: 100, output: 50 },
      });
      const request = env.stream.mock.calls[0];
      expect(request?.[0]).toBe(env.model);
      expect(request?.[1]).not.toHaveProperty("tools");
      expect(request?.[1]).not.toHaveProperty("systemPrompt");
      expect(request?.[2]).toMatchObject({
        cacheRetention: "none",
        timeoutMs: RECAP_REQUEST_TIMEOUT_MS,
      });
      expect(request?.[2]?.sessionId).not.toBe(env.ctx.sessionManager.getSessionId());
      expect(request?.[2]?.reasoning).toBe(thinking === "off" ? undefined : thinking);
      expect(getEventListeners(env.signal, "abort")).toHaveLength(0);
    },
  );

  it("clamps unsupported thinking", async () => {
    const env = setup(() => fauxAssistantMessage("Ready"));
    env.model.reasoning = false;
    await generateRecap(
      env.ctx,
      { model: { provider: "cheap", id: "small" }, thinking: "high" },
      "Prompt",
      env.signal,
    );
    expect(env.stream.mock.calls[0]?.[2]).not.toHaveProperty("reasoning");
  });

  it("reports an unavailable model as a request failure without falling back", async () => {
    const ctx = createExtensionHost(() => {}).createContext({
      modelRegistry: { find: () => undefined },
    });

    const result = await generateRecap(
      ctx,
      { model: { provider: "cheap", id: "small" }, thinking: "off" },
      "Prompt",
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      status: "failed",
      error: "Model cheap/small was not found by Pi",
    });
  });

  it.each(["error", "silent", "length"] as const)(
    "recognizes %s overflow and retains reported usage",
    async (kind) => {
      const response = fauxAssistantMessage("Overflow", {
        stopReason: kind === "silent" ? "stop" : kind,
        ...(kind === "error"
          ? { errorMessage: "Your input exceeds the context window of this model" }
          : {}),
      });

      response.usage = { ...response.usage, input: 1001, output: 0, cacheRead: 0 };
      const env = setup(() => response);
      env.model.contextWindow = 1000;
      expect(
        await generateRecap(
          env.ctx,
          { model: { provider: "cheap", id: "small" }, thinking: "off" },
          "Prompt",
          env.signal,
        ),
      ).toMatchObject({
        status: "failed",
        error: "Recap input exceeds the model's context window",
        usage: { input: 1001 },
      });
    },
  );

  it.each(["length", "toolUse", "deferred", "error", "aborted"] as const)(
    "rejects textual %s responses",
    async (stopReason) => {
      const env = setup(() => fauxAssistantMessage("Not final", { stopReason }));
      expect(
        await generateRecap(
          env.ctx,
          { model: { provider: "cheap", id: "small" }, thinking: "off" },
          "Prompt",
          env.signal,
        ),
      ).toMatchObject({ status: "failed" });
    },
  );

  it("rejects empty text", async () => {
    const env = setup(() => fauxAssistantMessage("   "));
    expect(
      await generateRecap(
        env.ctx,
        { model: { provider: "cheap", id: "small" }, thinking: "off" },
        "Prompt",
        env.signal,
      ),
    ).toMatchObject({ status: "failed", error: "Recap model returned no text" });
  });

  it.each(["cancel", "timeout"])("releases an uncooperative provider after %s", async (action) => {
    vi.useFakeTimers();
    const response = Promise.withResolvers<AssistantMessage>();
    const env = setup(() => response.promise);
    const controller = new AbortController();

    const request = generateRecap(
      env.ctx,
      { model: { provider: "cheap", id: "small" }, thinking: "off" },
      "Prompt",
      controller.signal,
    );

    if (action === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS);
    expect(await request).toMatchObject({ status: "failed" });
    expect(env.stream.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    response.reject(new Error("Late rejection"));
    await Promise.resolve();
  });
});
