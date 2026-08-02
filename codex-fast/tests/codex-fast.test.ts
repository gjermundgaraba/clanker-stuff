import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

const model = (id: string, provider = "openai-codex"): Model<Api> => ({
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  contextWindow: 1_000_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id,
  input: ["text"],
  maxTokens: 128_000,
  name: id,
  provider,
  reasoning: true,
});

describe("codex fast mode", () => {
  it("starts disabled", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext({ model: model("gpt-5.5") });

    await host.emitSessionStart(ctx);
    const [payload] = await host.emit(
      "before_provider_request",
      {
        payload: { model: "gpt-5.5", stream: true },
        type: "before_provider_request",
      },
      ctx
    );

    expect(host.getStatus("codex-fast")).toBeUndefined();
    expect(payload).toBeUndefined();
  });

  it("starts enabled with --fast", async () => {
    const host = createExtensionHost(extension, { flags: { fast: true } });
    const ctx = host.createContext({ model: model("gpt-5.5") });

    await host.emitSessionStart(ctx);
    const [payload] = await host.emit(
      "before_provider_request",
      {
        payload: { model: "gpt-5.5", stream: true },
        type: "before_provider_request",
      },
      ctx
    );

    expect(host.getStatus("codex-fast")).toBe("⚡");
    expect(payload).toStrictEqual({
      model: "gpt-5.5",
      service_tier: "priority",
      stream: true,
    });
  });

  it("toggles priority requests and the lightning status", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext({ model: model("gpt-5.5") });

    await host.emitSessionStart(ctx);
    await host.runCommand("fast", "", ctx);
    const [enabledPayload] = await host.emit(
      "before_provider_request",
      {
        payload: { model: "gpt-5.5", stream: true },
        type: "before_provider_request",
      },
      ctx
    );

    expect(host.getStatus("codex-fast")).toBe("⚡");
    expect(enabledPayload).toStrictEqual({
      model: "gpt-5.5",
      service_tier: "priority",
      stream: true,
    });

    await host.runCommand("fast", "", ctx);
    const [disabledPayload] = await host.emit(
      "before_provider_request",
      {
        payload: { model: "gpt-5.5" },
        type: "before_provider_request",
      },
      ctx
    );
    expect(host.getStatus("codex-fast")).toBeUndefined();
    expect(disabledPayload).toBeUndefined();
  });

  it("only shows active status on models that support fast mode", async () => {
    const host = createExtensionHost(extension);
    const fastModel = model("gpt-5.4");
    const otherModel = model("gpt-5.4-mini");
    const fastCtx = host.createContext({ model: fastModel });

    await host.emitSessionStart(fastCtx);
    await host.runCommand("fast", "", fastCtx);
    expect(host.getStatus("codex-fast")).toBe("⚡");

    await host.emit(
      "model_select",
      {
        model: otherModel,
        previousModel: fastModel,
        source: "set",
        type: "model_select",
      },
      host.createContext({ model: otherModel })
    );
    expect(host.getStatus("codex-fast")).toBeUndefined();
  });
});
