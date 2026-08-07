import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createFastMode } from "../fast-mode.js";

const model = (id: string): Model<Api> => ({
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  contextWindow: 1_000_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id,
  input: ["text"],
  maxTokens: 128_000,
  name: id,
  provider: "openai-codex",
  reasoning: true,
});

describe("codex fast mode", () => {
  it("transitions between disabled, enabled, and unsupported states", () => {
    const host = createExtensionHost(() => {});
    const ctx = host.createContext({ model: model("gpt-5.5") });
    const fastMode = createFastMode();

    fastMode.start(false, ctx);
    expect({
      payload: fastMode.applyToRequest({ stream: true }, ctx),
      status: host.getStatus("codex-fast"),
    }).toStrictEqual({ payload: undefined, status: undefined });

    fastMode.toggle(ctx);
    expect({
      payload: fastMode.applyToRequest({ stream: true }, ctx),
      status: host.getStatus("codex-fast"),
    }).toStrictEqual({
      payload: { service_tier: "priority", stream: true },
      status: "⚡",
    });

    fastMode.toggle(ctx);
    expect({
      payload: fastMode.applyToRequest({ stream: true }, ctx),
      status: host.getStatus("codex-fast"),
    }).toStrictEqual({ payload: undefined, status: undefined });

    fastMode.toggle(ctx);
    fastMode.refreshStatus(
      host.createContext({ model: model("gpt-5.4-mini") })
    );
    expect(host.getStatus("codex-fast")).toBeUndefined();
  });

  it("starts enabled for a supported model", () => {
    const host = createExtensionHost(() => {});
    const ctx = host.createContext({ model: model("gpt-5.4") });
    const fastMode = createFastMode();

    fastMode.start(true, ctx);
    expect(host.getStatus("codex-fast")).toBe("⚡");
    expect(fastMode.applyToRequest({}, ctx)).toStrictEqual({
      service_tier: "priority",
    });
  });
});
