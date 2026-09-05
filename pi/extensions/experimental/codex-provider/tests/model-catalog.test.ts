import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createCodexModelCatalog, isSupportedCodexModelId } from "../model-catalog.js";
import { SPIKE_API_KEY } from "./fixtures.js";

type StoredModels = NonNullable<RefreshModelsContext["stored"]>;

const CAPABILITY_FIELDS = [
  "supported_in_api",
  "support_verbosity",
  "supports_parallel_tool_calls",
] as const;

const remoteModel = {
  display_name: "Boundary model",
  future_metadata: { retained: true },
  priority: 1,
  slug: "gpt-5.6-boundary",
  supported_in_api: true,
  support_verbosity: true,
  supports_parallel_tool_calls: true,
  visibility: "list",
};

// Native Astra catalog shape at Codex f1aac1e885f676a1129f2da0c46a3dba86392fc6.
// Application instructions omitted: this provider uses Pi's effective prompt.
const remoteAstra = {
  auto_compact_token_limit: null,
  comp_hash: "3000",
  context_window: 272_000,
  default_reasoning_level: "low",
  default_reasoning_summary: "none",
  default_service_tier: null,
  default_verbosity: "low",
  display_name: "GPT-6-Astra",
  experimental_supported_tools: ["send_user_message_async", "clock"],
  input_modalities: ["text", "image"],
  max_context_window: 872_000,
  minimal_client_version: "0.153.0",
  multi_agent_reasoning_effort: "xhigh",
  multi_agent_version: "v2",
  priority: 1,
  service_tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
  slug: "gpt-6-astra",
  supported_in_api: true,
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
    { effort: "high", description: "Greater reasoning depth for complex problems" },
    { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
    { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
  ],
  support_verbosity: true,
  supports_parallel_tool_calls: true,
  supports_reasoning_summary_parameter: true,
  tool_mode: "code_mode_only",
  truncation_policy: { mode: "tokens", limit: 10_000 },
  use_responses_lite: true,
  visibility: "hide",
};

const refreshContext = (
  publish: RefreshModelsContext["publish"],
  stored?: StoredModels,
): RefreshModelsContext => ({
  allowNetwork: stored === undefined,
  credential: { key: SPIKE_API_KEY, type: "api_key" },
  publish,
  signal: new AbortController().signal,
  stored,
});

const fetchStoredCatalog = async (
  models: readonly object[] = [remoteModel],
): Promise<StoredModels> => {
  let stored: StoredModels | undefined;
  const catalog = createCodexModelCatalog();
  vi.stubGlobal("fetch", async () => Response.json({ models }));
  await catalog.refreshModels(
    refreshContext(async (publication) => {
      if (publication.persist !== undefined && publication.persist !== null) {
        stored = structuredClone(publication.persist);
      }
      publication.update?.();
      return true;
    }),
  );
  if (stored === undefined) {
    throw new Error("Remote model catalog was not persisted");
  }
  return stored;
};

describe("Codex model catalog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("admits exact Astra without admitting other GPT-6 models", () => {
    expect(isSupportedCodexModelId("gpt-6-astra")).toBeTruthy();
    expect(isSupportedCodexModelId("gpt-6-astra-preview")).toBeFalsy();
    expect(isSupportedCodexModelId("gpt-6-other")).toBeFalsy();
  });

  it("seeds native Astra policy and full Pi capabilities before refresh", () => {
    const catalog = createCodexModelCatalog();
    const astra = catalog.getModels().find((model) => model.id === "gpt-6-astra");
    expect(astra).toMatchObject({
      codexOutputTokenLimit: 10_000,
      codexToolMode: "code_mode_only",
      codexVisibility: "hide",
      compat: {
        supportsAdditionalTools: true,
        supportsOpenAIGrammarTools: true,
        supportsToolSearch: true,
      },
      contextWindow: 272_000,
      cost: {
        cacheRead: 1,
        cacheWrite: 12.5,
        input: 10,
        output: 50,
        tiers: [{ inputTokensAbove: 272_000, cacheRead: 2, cacheWrite: 25, input: 20, output: 75 }],
      },
      input: ["text", "image"],
      maxTokens: 128_000,
      multiAgentVersion: "v2",
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    });
    expect(catalog.getModelMetadata("gpt-6-astra")).toMatchObject({
      comp_hash: "3000",
      default_reasoning_summary: "none",
      use_responses_lite: true,
    });
    expect(catalog.getUltraSettings(astra)).toEqual({ reasoningLevel: "xhigh" });
    expect(catalog.supportsFastMode(astra)).toBeTruthy();
    expect(
      catalog.base
        .filterModels?.(catalog.getModels(), undefined)
        .some((model) => model.id === "gpt-6-astra"),
    ).toBeFalsy();
    if (astra === undefined) throw new Error("Missing Astra fallback");
    expect(catalog.getModelWindow(astra)).toEqual({
      autoCompactTokens: 244_800,
      effectiveWindowTokens: 258_400,
    });
  });

  it("retains hidden native Astra for explicit resolution and restores its metadata from cache", async () => {
    const stored = await fetchStoredCatalog([remoteAstra]);
    const catalog = createCodexModelCatalog();
    await catalog.refreshModels(
      refreshContext(async (publication) => {
        publication.update?.();
        return true;
      }, stored),
    );
    const [astra] = catalog.getModels();
    expect(catalog.getModels()).toHaveLength(1);
    expect(astra).toMatchObject({
      id: "gpt-6-astra",
      codexToolMode: "code_mode_only",
      codexVisibility: "hide",
      multiAgentVersion: "v2",
      contextWindow: 272_000,
    });
    expect(catalog.base.filterModels?.(catalog.getModels(), undefined)).toEqual([]);
    expect(catalog.getModelMetadata("gpt-6-astra")).toMatchObject({
      comp_hash: "3000",
      use_responses_lite: true,
      visibility: "hide",
      experimental_supported_tools: ["send_user_message_async", "clock"],
    });
    expect(catalog.getUltraSettings(astra)).toEqual({ reasoningLevel: "xhigh" });
    expect(catalog.supportsFastMode(astra)).toBeTruthy();
  });

  it("lets remote Astra policy override fallback and ignores unsupported effort and tool-mode selectors", async () => {
    const stored = await fetchStoredCatalog([
      {
        ...remoteAstra,
        comp_hash: "next",
        context_window: 300_000,
        multi_agent_reasoning_effort: "future_effort",
        service_tiers: [],
        supported_reasoning_levels: [
          { effort: "high" },
          { effort: "future_effort" },
          { effort: "ultra" },
        ],
        tool_mode: "future_mode",
        use_responses_lite: false,
        visibility: "list",
      },
    ]);
    const catalog = createCodexModelCatalog();
    await catalog.refreshModels(
      refreshContext(async (publication) => {
        publication.update?.();
        return true;
      }, stored),
    );
    const [astra] = catalog.getModels();
    expect(astra).toMatchObject({
      contextWindow: 300_000,
      codexVisibility: "list",
      thinkingLevelMap: { high: "high", max: null, xhigh: null, low: null },
    });
    expect(astra?.codexToolMode).toBeUndefined();
    expect(catalog.getUltraSettings(astra)).toEqual({ reasoningLevel: "high" });
    expect(catalog.supportsFastMode(astra)).toBeFalsy();
    expect(catalog.getModelMetadata("gpt-6-astra")).toMatchObject({
      comp_hash: "next",
      use_responses_lite: false,
    });
    expect(catalog.base.filterModels?.(catalog.getModels(), undefined)).toEqual(
      catalog.getModels(),
    );
  });

  it("does not resurrect Astra or Fast capability when absent from authoritative remote metadata", async () => {
    const catalog = createCodexModelCatalog();
    const astra = catalog.getModels().find((model) => model.id === "gpt-6-astra");
    const sol = catalog.getModels().find((model) => model.id === "gpt-5.6-sol");
    const stored = await fetchStoredCatalog();
    await catalog.refreshModels(
      refreshContext(async (publication) => {
        publication.update?.();
        return true;
      }, stored),
    );
    expect(catalog.getModels().map((model) => model.id)).toEqual([remoteModel.slug]);
    expect(catalog.getModelMetadata("gpt-6-astra")).toBeUndefined();
    expect(catalog.getUltraSettings(astra)).toBeUndefined();
    expect(catalog.supportsFastMode(astra)).toBeFalsy();
    expect(catalog.supportsFastMode(sol)).toBeFalsy();
  });

  it("rejects empty remote catalogs without replacing the current catalog", async () => {
    const catalog = createCodexModelCatalog();
    const previous = catalog.getModels();
    vi.stubGlobal("fetch", async () => Response.json({ models: [] }));
    const publish = vi.fn<RefreshModelsContext["publish"]>();
    await expect(catalog.refreshModels(refreshContext(publish))).rejects.toThrow(
      "Codex model response contains no usable models",
    );
    expect(catalog.getModels()).toBe(previous);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(CAPABILITY_FIELDS)("rejects non-boolean remote %s metadata", async (field) => {
    const catalog = createCodexModelCatalog();
    vi.stubGlobal("fetch", async () =>
      Response.json({ models: [{ ...remoteModel, [field]: "false" }] }),
    );

    await expect(
      catalog.refreshModels(
        refreshContext(async (publication) => {
          publication.update?.();
          return true;
        }),
      ),
    ).rejects.toThrow("Codex model metadata capabilities are invalid");
    expect(catalog.getModels().some((model) => model.id === remoteModel.slug)).toBeFalsy();
  });

  it.each(CAPABILITY_FIELDS)("rejects non-boolean cached %s metadata", async (field) => {
    const stored = await fetchStoredCatalog();
    const models = stored.models.map((model) => {
      if (model.id !== remoteModel.slug || !("codexProviderMetadata" in model)) {
        return model;
      }
      return {
        ...model,
        codexProviderMetadata: {
          ...remoteModel,
          [field]: "false",
        },
      };
    });
    const catalog = createCodexModelCatalog();

    await catalog.refreshModels(
      refreshContext(
        async (publication) => {
          publication.update?.();
          return true;
        },
        { ...stored, models },
      ),
    );

    expect(catalog.getModels().some((model) => model.id === remoteModel.slug)).toBeFalsy();
  });
});
