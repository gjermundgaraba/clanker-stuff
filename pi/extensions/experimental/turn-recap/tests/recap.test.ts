import { getEventListeners } from "node:events";

import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { generateRecap, RECAP_REQUEST_TIMEOUT_MS } from "../recap.js";
import { queuedStream, sampleUsage, unresponsiveStream } from "./fixtures.js";
import type { ResponseStep } from "./fixtures.js";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";

const setupStream = <Stream extends ReturnType<typeof queuedStream>>(stream: Stream) => {
  const model = fauxProvider({
    models: [{ id: "small", reasoning: true }],
    provider: "cheap",
  }).getModel();

  const ctx = createExtensionHost(() => {}).createContext({
    modelRegistry: {
      find: () => model,
      streamSimple: stream,
    },
  });

  return { model, stream, ctx, signal: new AbortController().signal };
};

const setup = (...responses: ResponseStep[]) => setupStream(queuedStream(...responses));

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
      expect(request?.[2]).toMatchObject({ cacheRetention: "none" });
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

  it("reports the provider's error and keeps its reported usage", async () => {
    const response = fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Your input exceeds the context window of this model",
    });

    response.usage = { ...response.usage, input: 1001 };
    const env = setup(() => response);
    expect(
      await generateRecap(
        env.ctx,
        { model: { provider: "cheap", id: "small" }, thinking: "off" },
        "Prompt",
        env.signal,
      ),
    ).toMatchObject({
      status: "failed",
      error: "Your input exceeds the context window of this model",
      usage: { input: 1001 },
    });
  });

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

  it.each([
    ["cancel", "Stopped"],
    ["timeout", "Recap request timed out"],
  ])("aborts the request on %s and names the cause", async (action, error) => {
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

    if (action === "cancel") controller.abort(new Error("Stopped"));
    else await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS);
    expect(await request).toMatchObject({ status: "failed", error });
    expect(env.stream.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["cancel", "Stopped"],
    ["timeout", "Recap request timed out"],
  ])("stops waiting on %s when the provider ignores cancellation", async (action, error) => {
    vi.useFakeTimers();
    const env = setupStream(unresponsiveStream());
    const controller = new AbortController();

    const request = generateRecap(
      env.ctx,
      { model: { provider: "cheap", id: "small" }, thinking: "off" },
      "Prompt",
      controller.signal,
    );

    if (action === "cancel") controller.abort(new Error("Stopped"));
    else await vi.advanceTimersByTimeAsync(RECAP_REQUEST_TIMEOUT_MS);
    expect(await request).toStrictEqual({ status: "failed", error });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends at once when the recap was already aborted", async () => {
    const env = setupStream(unresponsiveStream());
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));

    expect(
      await generateRecap(
        env.ctx,
        { model: { provider: "cheap", id: "small" }, thinking: "off" },
        "Prompt",
        controller.signal,
      ),
    ).toStrictEqual({ status: "failed", error: "Stopped" });
  });
});
