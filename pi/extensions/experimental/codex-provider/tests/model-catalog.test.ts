import { openaiCodexProvider } from "#pi-openai-codex";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createCodexModelCatalog as createCatalog } from "../model-catalog.js";
import { SPIKE_API_KEY, SPIKE_MODEL, builtinWithModels, makeCodexApiKey } from "./fixtures.js";

type StoredModels = NonNullable<RefreshModelsContext["stored"]>;

const CAPABILITY_FIELDS = [
  "supported_in_api",
  "support_verbosity",
  "supports_parallel_tool_calls",
] as const;

const WINDOW_FIELDS = ["auto_compact_token_limit", "context_window", "max_context_window"] as const;

const remoteModel = {
  display_name: "Boundary model",
  future_metadata: { retained: true },
  priority: 1,
  slug: "gpt-6-future",
  supported_in_api: true,
  support_verbosity: true,
  supports_parallel_tool_calls: true,
  visibility: "list",
};

const futureModel = {
  ...SPIKE_MODEL,
  id: remoteModel.slug,
  cost: { input: 3, output: 7, cacheRead: 1, cacheWrite: 3 },
};

const createCodexModelCatalog = () => createCatalog(undefined, builtinWithModels(futureModel));

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
  ...(stored !== undefined ? { stored } : {}),
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

  it("carries spawn guidance through refresh and account-cache restoration", async () => {
    const stored = await fetchStoredCatalog([
      {
        ...remoteModel,
        description: "Fast and affordable synthetic worker.",
        default_reasoning_level: "medium",
        supported_reasoning_levels: ["low", "medium", "ultra"],
        service_tiers: [{ id: "priority" }, { id: "unsupported" }],
        multi_agent_version: "v1",
        visibility: "hide",
      },
    ]);

    const expected = {
      spawnAgentMetadata: {
        description: "Fast and affordable synthetic worker.",
        defaultReasoningEffort: "medium",
        serviceTiers: ["priority"],
        showInPicker: false,
      },
      multiAgentVersion: "v1",
      thinkingLevelMap: { low: "low", medium: "medium", high: null, max: null },
    };

    expect(stored.models[0]).toMatchObject(expected);
    const catalog = createCodexModelCatalog();
    await catalog.refreshModels(
      refreshContext(async (publication) => {
        publication.update?.();

        return true;
      }, stored),
    );
    expect(catalog.getModels()[0]).toMatchObject(expected);
    const fallback = createCodexModelCatalog();

    for (const model of fallback.getModels()) {
      expect(fallback.supportsFastMode(model)).toBe(
        model.spawnAgentMetadata?.serviceTiers.includes("priority") ?? false,
      );
    }
  });

  it("admits a newly bundled Pi model only after refresh, preserving its prices and capabilities", async () => {
    const catalog = createCodexModelCatalog();
    expect(catalog.supportsModel(futureModel)).toBe(false);
    const stored = await fetchStoredCatalog();
    await catalog.refreshModels(
      refreshContext(
        async (publication) => {
          publication.update?.();

          return true;
        },
        {
          ...stored,
          models: stored.models.map((model) => ({
            ...model,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {},
          })),
        },
      ),
    );
    expect(catalog.getModels()).toHaveLength(1);
    expect(catalog.getModels()[0]).toMatchObject({
      id: futureModel.id,
      cost: futureModel.cost,
      compat: futureModel.compat,
    });
    expect(catalog.supportsModel(futureModel)).toBe(true);
    expect(
      catalog.supportsModel({ ...futureModel, compat: { supportsAdditionalTools: true } }),
    ).toBe(false);
    expect(catalog.supportsModel({ ...futureModel, provider: "unrelated" })).toBe(false);
    expect(catalog.base.filterModels?.(catalog.getModels(), undefined)).toEqual(
      catalog.getModels(),
    );
  });

  it("does not admit unknown names, unsupported Pi capabilities, or unknown tool modes", async () => {
    const stored = await fetchStoredCatalog([
      remoteModel,
      { ...remoteModel, slug: "gpt-5.6-unknown" },
      { ...remoteModel, slug: "gpt-6-unknown" },
      { ...remoteModel, slug: "gpt-5.2" },
      { ...remoteAstra, tool_mode: "future_mode" },
    ]);

    expect(stored.models.map((model) => model.id)).toEqual([futureModel.id]);
    const noFutureDefinition = createCatalog();
    await noFutureDefinition.refreshModels(
      refreshContext(async (publication) => {
        publication.update?.();

        return true;
      }, stored),
    );
    expect(noFutureDefinition.getModels()).toEqual([]);
    expect(noFutureDefinition.getRejections()).toStrictEqual([
      `${futureModel.id}: No Pi-bundled definition with required grammar-tool support`,
    ]);
    expect(noFutureDefinition.supportsModel(futureModel)).toBe(false);
  });

  it.each(["gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])(
    "preserves Pi capabilities and image limits for %s through refresh and cache restoration",
    async (id) => {
      const fallback = createCodexModelCatalog()
        .getModels()
        .find((model) => model.id === id);

      const builtin = openaiCodexProvider()
        .getModels()
        .find((model) => model.id === id);

      expect(builtin).toBeDefined();
      expect(fallback?.cost).toEqual(builtin?.cost);
      expect(fallback?.compat).toEqual(builtin?.compat);
      expect(fallback?.inputLimits).toEqual(builtin?.inputLimits);

      expect(fallback?.inputLimits?.images?.resize).toBeDefined();

      const stored = await fetchStoredCatalog([{ ...remoteModel, slug: id }]);
      expect(stored.models[0]?.inputLimits).toEqual(fallback?.inputLimits);

      const restored = createCodexModelCatalog();
      await restored.refreshModels(
        refreshContext(async (publication) => {
          publication.update?.();

          return true;
        }, stored),
      );
      expect(restored.getModels()[0]?.inputLimits).toEqual(fallback?.inputLimits);
    },
  );

  it("seeds native Astra policy and full Pi capabilities before refresh", () => {
    const catalog = createCodexModelCatalog();
    const astra = catalog.getModels().find((model) => model.id === "gpt-6-astra");
    expect(astra).toMatchObject({
      codexOutputTokenLimit: 10_000,
      codexToolMode: "code_mode_only",
      codexVisibility: "list",
      codexSupportedTools: ["send_user_message_async", "clock"],
      compat: {
        supportsAdditionalTools: true,
        supportsMidConvoSystemMessages: true,
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
    ).toBeTruthy();

    if (astra === undefined) throw new Error("Missing Astra fallback");
    expect(catalog.getModelWindow(astra)).toEqual({
      autoCompactTokens: 244_800,
      effectiveWindowTokens: 258_400,
    });
  });

  it.each([
    { id: "gpt-6-sol", ultra: true },
    { id: "gpt-6-luna", ultra: false },
  ])("projects $id native policy through fallback, refresh and cache", async ({ id, ultra }) => {
    const fallback = createCodexModelCatalog();

    const expected = {
      id,
      codexToolMode: "code_mode_only",
      codexSupportedTools: ["send_user_message_async", "clock"],
      multiAgentVersion: "v2",
      contextWindow: 272_000,
      maxTokens: 128_000,
      spawnAgentMetadata: {
        defaultReasoningEffort: "medium",
        serviceTiers: ["priority"],
        showInPicker: true,
      },
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    };

    const fallbackModel = fallback.getModels().find((model) => model.id === id);
    expect(fallbackModel).toMatchObject(expected);
    expect(fallback.getUltraSettings(fallbackModel)).toEqual(
      ultra ? { reasoningLevel: "max" } : undefined,
    );
    expect(fallback.getModelMetadata(id)).toMatchObject({
      comp_hash: "3000",
      default_reasoning_summary: "none",
      use_responses_lite: true,
      default_service_tier: "priority",
    });
    expect(
      fallback.base
        .filterModels?.(fallback.getModels(), undefined)
        .some((model) => model.id === id),
    ).toBe(true);

    const stored = await fetchStoredCatalog([
      {
        ...remoteAstra,
        slug: id,
        default_reasoning_level: "medium",
        default_service_tier: "priority",
        minimal_client_version: "0.155.0",
        multi_agent_reasoning_effort: null,
        supported_reasoning_levels: [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          ...(ultra ? ["ultra"] : []),
        ],
        visibility: "list",
      },
    ]);

    expect(stored.models[0]).toMatchObject(expected);
    const restored = createCodexModelCatalog();
    await restored.refreshModels(
      refreshContext(async (publication) => {
        publication.update?.();

        return true;
      }, stored),
    );
    const [model] = restored.getModels();
    expect(model).toMatchObject(expected);
    expect(restored.getUltraSettings(model)).toEqual(ultra ? { reasoningLevel: "max" } : undefined);
    expect(restored.supportsFastMode(model)).toBe(true);
    expect(restored.getModelMetadata(id)?.use_responses_lite).toBe(true);
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

  it("lets remote Astra policy override fallback and ignores unsupported optional reasoning efforts", async () => {
    const stored = await fetchStoredCatalog([
      {
        ...remoteAstra,
        comp_hash: "next",
        tool_mode: null,
        context_window: 300_000,
        multi_agent_reasoning_effort: "future_effort",
        service_tiers: [],
        supported_reasoning_levels: [
          { effort: "high" },
          { effort: "future_effort" },
          { effort: "ultra" },
        ],
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

  it.each([{ models: [] }, { models: [{ ...remoteAstra, tool_mode: "future_mode" }] }])(
    "keeps live authoritative absence without resurrecting offline profiles (%j)",
    async ({ models }) => {
      const catalog = createCodexModelCatalog();
      const astra = catalog.getModels().find((model) => model.id === remoteAstra.slug);
      vi.stubGlobal("fetch", async () =>
        Response.json({ models }, { headers: { etag: '"empty-catalog"' } }),
      );
      let stored: StoredModels | undefined;

      const publish: RefreshModelsContext["publish"] = async (publication) => {
        if (publication.persist != null) stored = publication.persist;
        publication.update?.();

        return true;
      };

      await catalog.refreshModels(refreshContext(publish));
      expect(stored?.models).toStrictEqual([]);
      expect(catalog.getModels()).toStrictEqual([]);
      expect(catalog.supportsModel(astra)).toBe(false);
      expect(catalog.supportsFastMode(astra)).toBe(false);

      // Repeated offline refresh must not overwrite an already account-bound live result.
      await catalog.refreshModels({ ...refreshContext(publish, stored), allowNetwork: false });
      expect(catalog.getModels()).toStrictEqual([]);

      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).has("if-none-match")).toBe(false);

        return Response.json({ models: [remoteModel] });
      });

      vi.stubGlobal("fetch", fetch);
      await catalog.refreshModels({
        ...refreshContext(publish, stored),
        allowNetwork: true,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(catalog.getModels().map((model) => model.id)).toStrictEqual([futureModel.id]);
    },
  );

  it.each([
    { account: "same", key: SPIKE_API_KEY },
    { account: "different", key: makeCodexApiKey("different-account") },
  ])("ignores an empty persisted cache under the $account account", async ({ key }) => {
    const stored = { ...(await fetchStoredCatalog([])), etag: '"old-account"' };
    const catalog = createCodexModelCatalog();
    const fallbackIds = catalog.getModels().map((model) => model.id);
    expect(fallbackIds.length).toBeGreaterThan(0);

    const context = {
      ...refreshContext(async (publication) => {
        publication.update?.();

        return true;
      }, stored),
      credential: { type: "api_key", key } as const,
    };

    await catalog.refreshModels(context);
    expect(catalog.getModels().map((model) => model.id)).toStrictEqual(fallbackIds);

    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("if-none-match")).toBe(false);

      return new Response(null, { status: 503 });
    });

    vi.stubGlobal("fetch", fetch);
    await expect(catalog.refreshModels({ ...context, allowNetwork: true })).rejects.toThrow(
      "Codex model refresh failed (503)",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(catalog.getModels().map((model) => model.id)).toStrictEqual(fallbackIds);
  });

  it.each([undefined, null, false, true, "true", 1])(
    "preserves native metadata and normalizes null defaults with use_responses_lite=%s",
    async (useResponsesLite) => {
      const nativeMetadata = {
        ...remoteModel,
        auto_compact_token_limit: null,
        context_window: null,
        default_reasoning_summary: "future_summary",
        default_service_tier: null,
        default_verbosity: "future_verbosity",
        effective_context_window_percent: null,
        max_context_window: null,
        multi_agent_reasoning_effort: "future_effort",
        multi_agent_version: "future_version",
        service_tiers: [null, { id: "future_tier", future_field: true }],
        supported_reasoning_levels: [null, "future_effort", { effort: "future_effort", rank: 1 }],
        use_responses_lite: useResponsesLite,
      };

      const stored = await fetchStoredCatalog([nativeMetadata]);

      const {
        auto_compact_token_limit: _auto,
        context_window: _context,
        max_context_window: _max,
        ...preservedMetadata
      } = nativeMetadata;

      const expectedMetadata = {
        ...preservedMetadata,
        effective_context_window_percent: 95,
        use_responses_lite: useResponsesLite === true,
      };

      expect(stored.models[0]).toMatchObject({ codexProviderMetadata: expectedMetadata });

      const catalog = createCodexModelCatalog();
      await catalog.refreshModels(
        refreshContext(async (publication) => {
          publication.update?.();

          return true;
        }, stored),
      );
      expect(catalog.getModelMetadata(remoteModel.slug)).toMatchObject(expectedMetadata);
    },
  );

  it("projects refreshed experimental tool capabilities and restores them from the account cache", async () => {
    const stored = await fetchStoredCatalog([
      {
        ...remoteModel,
        experimental_supported_tools: ["request_user_input_async", "send_message_to_user_async"],
      },
    ]);

    expect(stored.models[0]).toMatchObject({
      codexSupportedTools: ["request_user_input_async", "send_message_to_user_async"],
    });
    const catalog = createCodexModelCatalog();
    await catalog.refreshModels(
      refreshContext(async (publication) => {
        publication.update?.();

        return true;
      }, stored),
    );
    expect(catalog.getModels()[0]).toMatchObject({
      codexSupportedTools: ["request_user_input_async", "send_message_to_user_async"],
    });
  });

  it.each([null, { models: {} }])(
    "rejects malformed envelopes without publication: %j",
    async (payload) => {
      const catalog = createCodexModelCatalog();
      vi.stubGlobal("fetch", async () => Response.json(payload));
      const publish = vi.fn<RefreshModelsContext["publish"]>();
      await expect(catalog.refreshModels(refreshContext(publish))).rejects.toThrow(
        "Codex model response is malformed",
      );
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it.each([
    ...[null, "request_user_input_async", [42]].map((value) => ({
      entry: { ...remoteModel, experimental_supported_tools: value },
      message: "Codex model experimental tools are invalid",
    })),
    ...[null, [], ...[1, undefined, ""].map((slug) => ({ ...remoteModel, slug }))].map((entry) => ({
      entry,
      message: "invalid or missing model slug",
    })),
    ...["display_name", "visibility"].flatMap((field) => [
      { entry: { ...remoteModel, [field]: 1 }, message: "Codex model metadata fields are invalid" },
      ...[undefined, ""].map((value) => ({
        entry: { ...remoteModel, [field]: value },
        message: `Codex model metadata ${field} is invalid`,
      })),
    ]),
  ])("rejects only invalid entries: $message ($entry)", async ({ entry, message }) => {
    const catalog = createCodexModelCatalog();
    vi.stubGlobal("fetch", async () => Response.json({ models: [entry, remoteAstra] }));
    await catalog.refreshModels(
      refreshContext(async (publication) => {
        publication.update?.();

        return true;
      }),
    );
    expect(catalog.getModels().map((model) => model.id)).toStrictEqual([remoteAstra.slug]);
    expect(catalog.getRejections()).toHaveLength(1);
    expect(catalog.getRejections()[0]).toContain(message);
  });

  it("diagnoses unbundled IDs before parsing metadata and atomically publishes the valid subset", async () => {
    const catalog = createCodexModelCatalog();
    vi.stubGlobal("fetch", async () =>
      Response.json({
        models: [
          { slug: "unknown-model", visibility: 42, experimental_supported_tools: false },
          { ...remoteAstra, tool_mode: "future-required-mode" },
          remoteModel,
        ],
      }),
    );

    const publish = vi.fn<RefreshModelsContext["publish"]>(async (publication) => {
      expect(catalog.getModels().some((model) => model.id === remoteModel.slug)).toBe(false);
      expect(publication.persist?.models.map((model) => model.id)).toStrictEqual([
        remoteModel.slug,
      ]);
      publication.update?.();

      return true;
    });

    await catalog.refreshModels(refreshContext(publish));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(catalog.getModels().map((model) => model.id)).toStrictEqual([remoteModel.slug]);
    expect(catalog.getRejections()).toStrictEqual([
      "unknown-model: No Pi-bundled definition with required grammar-tool support",
      `${remoteAstra.slug}: Unsupported visibility or required tool mode`,
    ]);
  });

  it.each([
    ...WINDOW_FIELDS.flatMap((field) =>
      [-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((value) => ({
        field,
        value,
        message: `Codex model metadata ${field} is invalid`,
      })),
    ),
    ...[0, 101, 1.5].map((value) => ({
      field: "effective_context_window_percent",
      value,
      message: "Codex model effective context percentage is invalid",
    })),
    ...[1.5, Number.MAX_SAFE_INTEGER + 1].map((value) => ({
      field: "priority",
      value,
      message: "Codex model metadata capabilities are invalid",
    })),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((limit) => ({
      field: "truncation_policy",
      value: { mode: "tokens", limit },
      message: "Codex model truncation policy is invalid",
    })),
    {
      field: "truncation_policy",
      value: { mode: "future_mode", limit: 0 },
      message: "Codex model truncation policy is invalid",
    },
  ])("preserves numeric validation for $field=$value", async ({ field, value, message }) => {
    const catalog = createCodexModelCatalog();
    vi.stubGlobal("fetch", async () =>
      Response.json({ models: [{ ...remoteModel, [field]: value }] }),
    );
    await catalog.refreshModels(
      refreshContext(async (publication) => {
        publication.update?.();

        return true;
      }),
    );
    expect(catalog.getModels()).toStrictEqual([]);
    expect(catalog.getRejections()).toStrictEqual([`${remoteModel.slug}: ${message}`]);
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("accepts safe integer limits of %s", async (limit) => {
    const metadata = {
      ...remoteModel,
      auto_compact_token_limit: limit,
      context_window: limit,
      effective_context_window_percent: limit === 0 ? 1 : 100,
      max_context_window: limit,
      priority: limit === 0 ? Number.MIN_SAFE_INTEGER : limit,
      truncation_policy: { mode: "tokens", limit },
    };

    const stored = await fetchStoredCatalog([metadata]);
    expect(stored.models[0]).toMatchObject({ codexProviderMetadata: metadata });
  });

  it.each(CAPABILITY_FIELDS)("rejects non-boolean remote %s metadata", async (field) => {
    const catalog = createCodexModelCatalog();
    vi.stubGlobal("fetch", async () =>
      Response.json({ models: [{ ...remoteModel, [field]: "false" }] }),
    );

    await catalog.refreshModels(
      refreshContext(async (publication) => {
        publication.update?.();

        return true;
      }),
    );
    expect(catalog.getModels()).toStrictEqual([]);
    expect(catalog.getRejections()).toStrictEqual([
      `${remoteModel.slug}: Codex model metadata capabilities are invalid`,
    ]);
  });

  it.each(["metadata identity", "duplicate identity", "mixed accounts"])(
    "discards the whole cache on broken %s",
    async (corruption) => {
      const stored = await fetchStoredCatalog([remoteModel, remoteAstra]);

      const models =
        corruption === "duplicate identity"
          ? [...stored.models, ...stored.models]
          : stored.models.map((model) =>
              model.id !== remoteAstra.slug
                ? model
                : {
                    ...model,
                    ...(corruption === "mixed accounts"
                      ? { codexProviderAccountId: "another-account" }
                      : { codexProviderMetadata: { ...remoteAstra, slug: remoteModel.slug } }),
                  },
            );

      const catalog = createCodexModelCatalog();
      const offlineIds = catalog.getModels().map((model) => model.id);
      await catalog.refreshModels(
        refreshContext(
          async (publication) => {
            publication.update?.();

            return true;
          },
          { ...stored, models },
        ),
      );
      expect(catalog.getModels().map((model) => model.id)).toStrictEqual(offlineIds);
      expect(catalog.supportsModel(futureModel)).toBe(false);
    },
  );

  it.each(CAPABILITY_FIELDS)("rejects non-boolean cached %s metadata", async (field) => {
    const stored = await fetchStoredCatalog([remoteModel, remoteAstra]);

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

    expect(catalog.getModels().map((model) => model.id)).toStrictEqual([remoteAstra.slug]);
    expect(catalog.getRejections()).toStrictEqual([
      `${remoteModel.slug}: Codex model metadata capabilities are invalid`,
    ]);
  });
});
