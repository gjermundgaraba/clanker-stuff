import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { describe, expect, it } from "vite-plus/test";

import {
  isSupportedProvider,
  resolveQuotaProvider,
  SUPPORTED_PROVIDERS,
  usageResult,
} from "../providers.js";

describe("providers", () => {
  it("classifies supported providers at the fetch boundary", () => {
    expect(SUPPORTED_PROVIDERS.every(isSupportedProvider)).toBe(true);

    for (const provider of ["unknown", "openai", "openai-codex", undefined])
      expect(isSupportedProvider(provider)).toBe(false);
  });

  it("preserves raw identity and targets physical selections immediately", () => {
    const session = SessionManager.inMemory();
    session.appendMessage({ ...fauxAssistantMessage("done"), provider: "anthropic" });

    const ctx = createExtensionHost(() => {}).createContext({
      sessionManager: session,
      model: {
        api: "test",
        provider: "openai",
        id: "physical",
        name: "Physical",
        baseUrl: "",
        contextWindow: 0,
        maxTokens: 0,
        input: ["text"],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });

    expect(resolveQuotaProvider(ctx)).toBe("openai");
    expect(resolveQuotaProvider({ ...ctx, model: undefined })).toBeUndefined();
  });

  it("uses physical attempts for virtual selections without guessing an unrouted provider", () => {
    const session = SessionManager.inMemory();
    const original = session.appendMessage({ role: "user", content: "start", timestamp: 0 });

    const ctx = createExtensionHost(() => {}).createContext({
      sessionManager: session,
      model: {
        api: "pi-virtual",
        provider: "anthropic",
        id: "auto",
        name: "Auto",
        baseUrl: "",
        contextWindow: 0,
        maxTokens: 0,
        input: ["text"],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });

    expect(resolveQuotaProvider(ctx)).toBeUndefined();
    session.appendMessage({ ...fauxAssistantMessage("done"), provider: "anthropic" });
    session.appendMessage({
      ...fauxAssistantMessage("", { stopReason: "error" }),
      provider: "openai",
    });
    expect(resolveQuotaProvider(ctx)).toBe("openai");
    session.appendMessage({
      ...fauxAssistantMessage("", { stopReason: "error" }),
      api: "pi-virtual",
      provider: "router",
    });
    expect(resolveQuotaProvider(ctx)).toBe("openai");
    session.branch(original);
    expect(resolveQuotaProvider(ctx)).toBeUndefined();
  });

  it("requires quota or accounting", () => {
    expect(usageResult({ fetchedAt: 1, provider: "radius", quotaWindows: [] })).toMatchObject({
      ok: false,
    });
    expect(
      usageResult({
        accounting: { available: 0, kind: "credit-balance" },
        fetchedAt: 1,
        provider: "openrouter",
        quotaWindows: [],
      }),
    ).toMatchObject({ ok: true });
  });
});
