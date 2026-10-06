import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { probeTier } from "../scripts/probe.js";

const model: Model<"openai-responses"> = {
  api: "openai-responses",
  provider: "openai",
  id: "fixture",
  name: "Fixture",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 4096,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
};

const setup = async (subscription = true) => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", () =>
    Promise.resolve(
      subscription
        ? {
            type: "oauth",
            access: "offline-subscription",
            refresh: "unused",
            expires: Date.now() + 3_600_000,
          }
        : { type: "api_key", key: "sk-offline" },
    ),
  );
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
  const native = runtime.getProvider("openai");

  if (native === undefined) throw new Error("Missing native OpenAI provider");

  runtime.registerNativeProvider({
    ...native,
    getModels: () => [model],
    getAllModels: () => [model],
  });
  await runtime.refresh({ allowNetwork: false });

  return { runtime, native };
};

const reply = (
  reported: string | undefined,
  terminal: "response.completed" | "response.incomplete" = "response.completed",
) =>
  new Response(
    [
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: "fixture", service_tier: "fast" },
      },
      {
        type: terminal,
        sequence_number: 1,
        response: {
          id: "fixture",
          status: terminal === "response.completed" ? "completed" : "incomplete",
          ...(reported !== undefined ? { service_tier: reported } : {}),
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "fixture-request",
        "openai-processing-ms": "123",
      },
    },
  );

describe("native Fast verification probe", () => {
  it.each([
    ["priority", "priority"],
    ["priority", "fast"],
    ["fast", "priority"],
    ["fast", "fast"],
  ] as const)(
    "confirms requested %s when the completed response reports %s",
    async (requested, reported) => {
      const { runtime } = await setup();
      let calls = 0;

      const result = await probeTier(runtime, model, requested, async (input, init) => {
        calls++;
        const request = new Request(input, init);
        expect(request.headers.has("originator")).toBe(false);
        expect(request.headers.has("x-codex-routing-hint")).toBe(false);

        const response = reply(reported);
        response.headers.set("x-private-test-header", "never-log-this-header-value");

        return response;
      });

      expect(calls).toBe(1);
      expect(result.responseHeaderNames).toContain("x-private-test-header");
      expect(JSON.stringify(result)).not.toContain("never-log-this-header-value");
      expect(result).toMatchObject({
        requested,
        wire: {
          url: "https://api.openai.com/v1/responses",
          model: "fixture",
          tier: requested,
          reasoning: "medium",
        },
        status: 200,
        requestId: "fixture-request",
        serverProcessingMs: "123",
        reported,
        completed: true,
        stopReason: "stop",
        requestSucceeded: true,
        confirmedFast: true,
      });
    },
  );

  it.each(["default", undefined])(
    "does not infer Fast from a requested tier, an early fast event or successful status: %s",
    async (reported) => {
      const { runtime } = await setup();

      const result = await probeTier(runtime, model, "priority", async () => reply(reported));

      expect(result.status).toBe(200);
      expect(result.stopReason).toBe("stop");
      expect(result.events).toStrictEqual([
        { event: "response.created", reported: "fast" },
        { event: "response.completed", reported },
      ]);
      expect(result.reported).toBe(reported);
      expect(result.requestSucceeded).toBe(true);
      expect(result.confirmedFast).toBe(false);
    },
  );

  it.each(["default", "fast"])(
    "keeps the explicit standard control separate from Fast verification: %s",
    async (reported) => {
      const { runtime } = await setup();

      const result = await probeTier(runtime, model, "default", async () => reply(reported));

      expect(result.wire?.tier).toBe("default");
      expect(result.reported).toBe(reported);
      expect(result.completed).toBe(true);
      expect(result.requestSucceeded).toBe(true);
      expect(result.confirmedFast).toBe(false);
    },
  );

  it("rejects an incomplete stream even when it reports fast", async () => {
    const { runtime } = await setup();

    const result = await probeTier(runtime, model, "fast", async () =>
      reply("fast", "response.incomplete"),
    );

    expect(result.completed).toBe(false);
    expect(result.requestSucceeded).toBe(false);
    expect(result.confirmedFast).toBe(false);
  });

  it.each([
    { model: "other", service_tier: "priority" },
    { model: "fixture", service_tier: "default" },
  ])("does not send a request changed after the probe's payload hook: %j", async (changed) => {
    const { runtime, native } = await setup();
    runtime.registerNativeProvider({
      ...native,
      getModels: () => [model],
      getAllModels: () => [model],
      streamSimple: (selected, context, options) =>
        native.streamSimple(selected, context, {
          ...options,
          onPayload: () => ({ ...changed, input: [], stream: true }),
        }),
    });
    let calls = 0;

    const result = await probeTier(runtime, model, "priority", async () => {
      calls++;

      return reply("priority");
    });

    expect(calls).toBe(0);
    expect(result.wire).toBeUndefined();
    expect(result.stopReason).toBe("error");
    expect(result.requestSucceeded).toBe(false);
    expect(result.confirmedFast).toBe(false);
  });

  it("records an HTTP failure without retries or treating it as confirmation", async () => {
    const { runtime } = await setup();
    let calls = 0;

    const result = await probeTier(runtime, model, "priority", async () => {
      calls++;

      return new Response(JSON.stringify({ error: { message: "Fixture failure" } }), {
        status: 503,
        headers: { "x-request-id": "fixture-failure" },
      });
    });

    expect(calls).toBe(1);
    expect(result.status).toBe(503);
    expect(result.requestId).toBe("fixture-failure");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Fixture failure");
    expect(result.requestSucceeded).toBe(false);
    expect(result.confirmedFast).toBe(false);
  });

  it("rejects API-key authentication before any transport call", async () => {
    const { runtime } = await setup(false);
    let calls = 0;

    await expect(
      probeTier(runtime, model, "priority", async () => {
        calls++;

        return reply("priority");
      }),
    ).rejects.toThrow("native OpenAI subscription");
    expect(calls).toBe(0);
  });
});
