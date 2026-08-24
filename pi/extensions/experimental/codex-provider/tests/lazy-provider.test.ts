import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";

import { createLazyCodexProvider } from "../lazy-provider.js";
import { createCodexModelCatalog } from "../model-catalog.js";
import type { CodexModelCatalog } from "../model-catalog.js";
import { SPIKE_MODEL } from "./fixtures.js";

type CodexProvider = Provider<"openai-codex-responses">;

const message: AssistantMessage = {
  api: "openai-codex-responses",
  content: [],
  model: SPIKE_MODEL.id,
  provider: "openai-codex",
  role: "assistant",
  stopReason: "stop",
  timestamp: 1,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
};

describe("lazy Codex provider", () => {
  it("keeps the built-in OAuth contract and catalog paths eager-only", async () => {
    const baseCatalog = createCodexModelCatalog();
    const refreshModels = vi.fn<(context: RefreshModelsContext) => Promise<void>>(
      async () => await Promise.resolve(),
    );
    const catalog: CodexModelCatalog = { ...baseCatalog, refreshModels };
    const load = vi.fn<() => Promise<CodexProvider>>();
    const provider = createLazyCodexProvider(catalog, load);
    const context: RefreshModelsContext = {
      allowNetwork: true,
      publish: vi.fn<RefreshModelsContext["publish"]>(),
      signal: new AbortController().signal,
    };

    expect(provider.getModels()).toBe(catalog.getModels());
    await provider.refreshModels?.(context);

    expect({
      auth: provider.auth,
      loadCalls: load.mock.calls.length,
      refreshCalls: refreshModels.mock.calls,
    }).toStrictEqual({
      auth: catalog.base.auth,
      loadCalls: 0,
      refreshCalls: [[context]],
    });
    expect(provider.auth.apiKey).not.toHaveProperty("login");
    expect(provider.auth.apiKey).toBe(catalog.base.auth.apiKey);
    expect(provider.auth.oauth).toBe(catalog.base.auth.oauth);
  });

  it("loads once and delegates the first stream", async () => {
    const catalog = createCodexModelCatalog();
    const stream = vi.fn<CodexProvider["stream"]>(() => {
      const events = createAssistantMessageEventStream();
      events.push({ message, reason: "stop", type: "done" });
      return events;
    });
    const loaded = { ...catalog.base, stream } satisfies CodexProvider;
    const load = vi.fn<() => Promise<CodexProvider>>(async () => loaded);
    const provider = createLazyCodexProvider(catalog, load);
    const context = { messages: [] };

    await provider.stream(SPIKE_MODEL, context).result();

    expect(load).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledWith(SPIKE_MODEL, context, undefined);
  });
});
