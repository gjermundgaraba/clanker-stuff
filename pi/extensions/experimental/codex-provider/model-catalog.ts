import { arch, platform, release } from "node:os";

import { uuidv7 } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type {
  Api,
  ApiKeyAuth,
  Credential,
  Model,
  ModelThinkingLevel,
  OpenAICodexResponsesOptions,
  Provider,
  ProviderHeaders,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";

import { openaiCodexProvider } from "#pi-openai-codex";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const MODEL_CACHE_TTL_MS = 300_000;
const MODEL_CLIENT_VERSION = "0.0.0";
const MODEL_CACHE_VERSION = 2;
const MODEL_CACHE_VERSION_FIELD = "codexProviderCacheVersion";
const MODEL_CACHE_METADATA_FIELD = "codexProviderMetadata";
const MODEL_CACHE_ACCOUNT_FIELD = "codexProviderAccountId";
const DEFAULT_OUTPUT_TOKEN_LIMIT = 10_000;

type SupportedModel = Model<"openai-codex-responses"> & {
  readonly codexOutputTokenLimit?: number;
  readonly multiAgentVersion?: "disabled" | "v1" | "v2";
};
type CachedSupportedModel = SupportedModel & {
  readonly codexProviderAccountId: string;
  readonly codexProviderCacheVersion: 2;
  readonly codexProviderMetadata: CodexModelMetadata;
};
type CodexProvider = Provider<"openai-codex-responses">;
type CodexWireReasoningEffort = NonNullable<OpenAICodexResponsesOptions["reasoningEffort"]>;
type CatalogSnapshot =
  | { readonly kind: "fallback" }
  | {
      readonly accountId: string;
      readonly kind: "remote";
      readonly metadata: ReadonlyMap<string, CodexModelMetadata>;
      readonly models: readonly SupportedModel[];
    };

const PI_CODEX_REASONING_EFFORTS = {
  high: "high",
  low: "low",
  max: "max",
  medium: "medium",
  minimal: "minimal",
  off: "none",
  xhigh: "xhigh",
} as const satisfies Record<ModelThinkingLevel, CodexWireReasoningEffort>;
const CODEX_WIRE_REASONING_EFFORT_SET: ReadonlySet<string> = new Set(
  Object.values(PI_CODEX_REASONING_EFFORTS),
);
const ReasoningEffortInputSchema = Type.Unknown();
type ReasoningEffortInput = Static<typeof ReasoningEffortInputSchema>;
const BooleanValueSchema = Type.Boolean();
const ReasoningEffortStringSchema = Type.String();

export const isCodexWireReasoningEffort = (
  value: ReasoningEffortInput,
): value is CodexWireReasoningEffort =>
  Value.Check(ReasoningEffortStringSchema, value) && CODEX_WIRE_REASONING_EFFORT_SET.has(value);

const storedApiKeyAuth: ApiKeyAuth = {
  name: "OpenAI Codex access token",
  resolve: async ({ credential, signal }) => {
    signal.throwIfAborted();
    return credential?.key !== undefined && credential.key.length > 0
      ? {
          auth: { apiKey: credential.key },
          env: credential.env,
          source: "stored credential",
        }
      : undefined;
  },
};

export interface CodexModelServiceTier {
  readonly id?: string;
}

export interface CodexModelReasoningLevel {
  readonly effort?: string;
}

export interface CodexModelMetadataWire {
  readonly auto_compact_token_limit?: number | null;
  readonly base_instructions?: string;
  readonly comp_hash?: string;
  readonly context_window?: number | null;
  readonly default_reasoning_level?: string;
  readonly default_reasoning_summary?: "auto" | "concise" | "detailed" | "none";
  readonly default_service_tier?: string;
  readonly default_verbosity?: "high" | "low" | "medium";
  readonly display_name?: string;
  readonly effective_context_window_percent?: number | null;
  readonly input_modalities?: readonly string[];
  readonly max_context_window?: number | null;
  readonly multi_agent_version?: string | null;
  readonly priority?: number;
  readonly service_tiers?: readonly (CodexModelServiceTier | null)[];
  readonly slug?: string;
  readonly supported_in_api?: boolean;
  readonly supported_reasoning_levels?: readonly (string | CodexModelReasoningLevel | null)[];
  readonly support_verbosity?: boolean;
  readonly supports_reasoning_summary_parameter?: boolean;
  readonly supports_parallel_tool_calls?: boolean;
  readonly truncation_policy?: {
    readonly limit: number;
    readonly mode: "bytes" | "tokens";
  };
  readonly use_responses_lite?: boolean | null;
  readonly visibility?: string;
}

export interface CodexModelMetadata {
  readonly auto_compact_token_limit?: number;
  readonly base_instructions?: string;
  readonly comp_hash?: string;
  readonly context_window?: number;
  readonly default_reasoning_level?: string;
  readonly default_reasoning_summary?: "auto" | "concise" | "detailed" | "none";
  readonly default_service_tier?: string;
  readonly default_verbosity?: "high" | "low" | "medium";
  readonly display_name: string;
  readonly effective_context_window_percent: number;
  readonly input_modalities?: readonly string[];
  readonly max_context_window?: number;
  readonly multi_agent_version?: string | null;
  readonly priority: number;
  readonly service_tiers?: readonly (CodexModelServiceTier | null)[];
  readonly slug: string;
  readonly supported_in_api: boolean;
  readonly supported_reasoning_levels?: readonly (string | CodexModelReasoningLevel | null)[];
  readonly support_verbosity: boolean;
  readonly supports_reasoning_summary_parameter?: boolean;
  readonly supports_parallel_tool_calls: boolean;
  readonly truncation_policy?: {
    readonly limit: number;
    readonly mode: "bytes" | "tokens";
  };
  readonly use_responses_lite: boolean;
  readonly visibility: string;
}

const FALLBACK_FAST_MODELS = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
const FALLBACK_MODEL_PRIORITY = new Map([
  ["gpt-5.6-sol", 1],
  ["gpt-5.6-terra", 2],
  ["gpt-5.6-luna", 3],
]);
const FALLBACK_MULTI_AGENT_VERSION = new Map<
  string,
  NonNullable<SupportedModel["multiAgentVersion"]>
>([
  ["gpt-5.6-sol", "v2"],
  ["gpt-5.6-terra", "v2"],
  ["gpt-5.6-luna", "v1"],
]);

const TokenPayloadSchema = Type.Object({
  "https://api.openai.com/auth": Type.Object({ chatgpt_account_id: Type.String() }),
});

export const isSupportedCodexModelId = (modelId: string): boolean => modelId.startsWith("gpt-5.6-");

export const modelSupportsServiceTier = (metadata: CodexModelMetadata, serviceTier: string) =>
  (metadata.service_tiers ?? []).some((tier) => tier?.id === serviceTier);

const isNonnegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const isTruncationPolicy = (
  value: NonNullable<CodexModelMetadataWire["truncation_policy"]>,
): boolean =>
  (value.mode === "bytes" || value.mode === "tokens") && isNonnegativeInteger(value.limit);

const isMultiAgentVersion = (
  value: string | null | undefined,
): value is NonNullable<SupportedModel["multiAgentVersion"]> =>
  value === "disabled" || value === "v1" || value === "v2";

const seedFallbackModel = (model: SupportedModel): SupportedModel => {
  const version = FALLBACK_MULTI_AGENT_VERSION.get(model.id);
  const seeded: SupportedModel = {
    ...model,
    codexOutputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
  };
  return version === undefined ? seeded : { ...seeded, multiAgentVersion: version };
};

const restoreCachedModel = (model: CachedSupportedModel): SupportedModel => {
  const {
    codexProviderAccountId: _accountId,
    codexProviderCacheVersion: _cacheVersion,
    codexProviderMetadata: _metadata,
    ...restored
  } = model;
  return restored;
};

export const resolveCodexResponsesUrl = (baseUrl?: string): string => {
  const candidate = baseUrl?.trim();
  const normalized = (
    candidate === undefined || candidate.length === 0 ? DEFAULT_BASE_URL : candidate
  ).replace(/\/+$/u, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
};

const resolveModelsUrl = (baseUrl?: string): string => {
  const responseUrl = new URL(resolveCodexResponsesUrl(baseUrl));
  responseUrl.pathname = responseUrl.pathname.replace(/\/responses$/u, "/models");
  responseUrl.searchParams.set("client_version", MODEL_CLIENT_VERSION);
  return responseUrl.toString();
};

const extractAccountId = (token: string): string => {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8"),
    );
    if (!Value.Check(TokenPayloadSchema, payload)) {
      throw new Error("invalid token payload");
    }
    return Value.Parse(TokenPayloadSchema, payload)["https://api.openai.com/auth"]
      .chatgpt_account_id;
  } catch {
    throw new Error("Failed to extract accountId from OpenAI credential");
  }
};

const applyHeaders = (
  target: Headers,
  ...sources: readonly (Readonly<ProviderHeaders> | undefined)[]
): void => {
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value === null) {
        target.delete(name);
      } else {
        target.set(name, value);
      }
    }
  }
};

export const createCodexHeaders = (
  model: SupportedModel,
  apiKey: string,
  requestId: string,
  extra?: Readonly<ProviderHeaders>,
): Headers => {
  const headers = new Headers();
  applyHeaders(headers, model.headers, extra);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("chatgpt-account-id", extractAccountId(apiKey));
  headers.set("originator", "pi");
  headers.set("user-agent", `pi (${platform()} ${release()}; ${arch()})`);
  headers.set("session-id", requestId);
  headers.set("x-client-request-id", requestId);
  return headers;
};

const reasoningLevels = (metadata: CodexModelMetadata) =>
  (metadata.supported_reasoning_levels ?? []).flatMap((value) => {
    if (Value.Check(ReasoningEffortStringSchema, value)) {
      return [value];
    }
    return value?.effort === undefined ? [] : [value.effort];
  });

const parseModelMetadata = (value: CodexModelMetadataWire): CodexModelMetadata => {
  if (!(value instanceof Object) || Array.isArray(value)) {
    throw new Error("Codex model metadata must be an object");
  }
  const { display_name: displayName, slug, visibility } = value;
  if (displayName === undefined || displayName.length === 0) {
    throw new Error("Codex model metadata display_name is invalid");
  }
  if (slug === undefined || slug.length === 0) {
    throw new Error("Codex model metadata slug is invalid");
  }
  if (visibility === undefined || visibility.length === 0) {
    throw new Error("Codex model metadata visibility is invalid");
  }
  const {
    priority,
    supported_in_api: supportedInApi,
    support_verbosity: supportVerbosity,
    supports_parallel_tool_calls: supportsParallelToolCalls,
  } = value;
  if (
    !Value.Check(BooleanValueSchema, supportedInApi) ||
    !Value.Check(BooleanValueSchema, supportVerbosity) ||
    !Value.Check(BooleanValueSchema, supportsParallelToolCalls) ||
    priority === undefined ||
    !Number.isSafeInteger(priority)
  ) {
    throw new TypeError("Codex model metadata capabilities are invalid");
  }
  for (const key of ["auto_compact_token_limit", "context_window", "max_context_window"] as const) {
    const windowValue = value[key];
    if (
      windowValue !== undefined &&
      windowValue !== null &&
      (!Number.isSafeInteger(windowValue) || windowValue < 0)
    ) {
      throw new Error(`Codex model metadata ${key} is invalid`);
    }
  }
  const autoCompactTokenLimit = value.auto_compact_token_limit ?? undefined;
  const contextWindow = value.context_window ?? undefined;
  const maxContextWindow = value.max_context_window ?? undefined;
  const percent = value.effective_context_window_percent ?? 95;
  if (!Number.isSafeInteger(percent) || percent <= 0 || percent > 100) {
    throw new Error("Codex model effective context percentage is invalid");
  }
  const truncationPolicy = value.truncation_policy;
  if (truncationPolicy !== undefined && !isTruncationPolicy(truncationPolicy)) {
    throw new Error("Codex model truncation policy is invalid");
  }
  const parsed: CodexModelMetadata = {
    ...value,
    auto_compact_token_limit: autoCompactTokenLimit,
    context_window: contextWindow,
    display_name: displayName,
    effective_context_window_percent: percent,
    max_context_window: maxContextWindow,
    priority,
    slug,
    support_verbosity: supportVerbosity,
    supported_in_api: supportedInApi,
    supports_parallel_tool_calls: supportsParallelToolCalls,
    truncation_policy:
      truncationPolicy === undefined
        ? undefined
        : {
            limit: truncationPolicy.limit,
            mode: truncationPolicy.mode,
          },
    use_responses_lite: value.use_responses_lite === true,
    visibility,
  };
  return parsed;
};

const cacheModel = (
  model: SupportedModel,
  metadata: CodexModelMetadata,
  accountId: string,
): CachedSupportedModel => ({
  ...model,
  [MODEL_CACHE_ACCOUNT_FIELD]: accountId,
  [MODEL_CACHE_VERSION_FIELD]: MODEL_CACHE_VERSION,
  [MODEL_CACHE_METADATA_FIELD]: metadata,
});

const cacheCatalog = (
  models: readonly SupportedModel[],
  metadataByModel: ReadonlyMap<string, CodexModelMetadata>,
  accountId: string,
): CachedSupportedModel[] =>
  models.map((model) => {
    const metadata = metadataByModel.get(model.id);
    if (metadata === undefined) {
      throw new Error(`Codex model metadata is missing for ${model.id}`);
    }
    return cacheModel(model, metadata, accountId);
  });

const isCurrentCachedModel = (model: Model<Api>): model is CachedSupportedModel =>
  model.api === "openai-codex-responses" &&
  model.provider === "openai-codex" &&
  MODEL_CACHE_ACCOUNT_FIELD in model &&
  Value.Check(ReasoningEffortStringSchema, model[MODEL_CACHE_ACCOUNT_FIELD]) &&
  model[MODEL_CACHE_ACCOUNT_FIELD].length > 0 &&
  MODEL_CACHE_VERSION_FIELD in model &&
  model[MODEL_CACHE_VERSION_FIELD] === MODEL_CACHE_VERSION &&
  MODEL_CACHE_METADATA_FIELD in model &&
  (!("multiAgentVersion" in model) ||
    model.multiAgentVersion === undefined ||
    (Value.Check(ReasoningEffortStringSchema, model.multiAgentVersion) &&
      isMultiAgentVersion(model.multiAgentVersion)));

const restoreCurrentCache = (
  stored: RefreshModelsContext["stored"],
  accountId: string,
):
  | {
      readonly accountId: string;
      readonly metadata: Map<string, CodexModelMetadata>;
      readonly models: SupportedModel[];
    }
  | undefined => {
  if (stored === undefined || stored.models.length === 0) {
    return undefined;
  }
  const cachedModels: CachedSupportedModel[] = [];
  const metadata = new Map<string, CodexModelMetadata>();
  try {
    for (const model of stored.models) {
      if (!isCurrentCachedModel(model)) {
        return undefined;
      }
      if (model[MODEL_CACHE_ACCOUNT_FIELD] !== accountId) {
        return undefined;
      }
      const parsed = parseModelMetadata(model[MODEL_CACHE_METADATA_FIELD]);
      if (parsed.slug !== model.id || metadata.has(model.id)) {
        return undefined;
      }
      cachedModels.push(model);
      metadata.set(model.id, parsed);
    }
  } catch {
    return undefined;
  }
  return {
    accountId,
    metadata,
    models: cachedModels.map(restoreCachedModel),
  };
};

const projectModel = (
  metadata: CodexModelMetadata,
  fallback: readonly SupportedModel[],
  baseUrl: string,
): SupportedModel => {
  const existing = fallback.find((model) => model.id === metadata.slug);
  const supportedReasoningEfforts = reasoningLevels(metadata).filter(isCodexWireReasoningEffort);
  const hasRemoteReasoningLevels = metadata.supported_reasoning_levels !== undefined;
  const thinkingLevelMap = hasRemoteReasoningLevels
    ? Object.fromEntries(
        Object.entries(PI_CODEX_REASONING_EFFORTS).map(([piLevel, wireEffort]) => [
          piLevel,
          supportedReasoningEfforts.includes(wireEffort) ? wireEffort : null,
        ]),
      )
    : existing?.thinkingLevelMap;
  const contextWindow =
    metadata.context_window ?? metadata.max_context_window ?? existing?.contextWindow ?? 128_000;
  const multiAgentVersion = isMultiAgentVersion(metadata.multi_agent_version)
    ? metadata.multi_agent_version
    : undefined;
  let outputTokenLimit = DEFAULT_OUTPUT_TOKEN_LIMIT;
  if (metadata.truncation_policy?.mode === "tokens") {
    outputTokenLimit = metadata.truncation_policy.limit;
  } else if (metadata.truncation_policy?.mode === "bytes") {
    outputTokenLimit = Math.ceil(metadata.truncation_policy.limit / 4);
  }
  const modalities = metadata.input_modalities?.filter(
    (input): input is "image" | "text" => input === "text" || input === "image",
  );
  const model: SupportedModel = {
    api: "openai-codex-responses",
    baseUrl: existing?.baseUrl ?? baseUrl,
    codexOutputTokenLimit: outputTokenLimit,
    compat: existing?.compat,
    contextWindow,
    cost: existing?.cost ?? {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
    },
    id: metadata.slug,
    input:
      modalities !== undefined && modalities.length > 0
        ? modalities
        : (existing?.input ?? ["text", "image"]),
    maxTokens: existing?.maxTokens ?? Math.min(contextWindow, 128_000),
    name: metadata.display_name,
    provider: "openai-codex",
    reasoning: hasRemoteReasoningLevels
      ? supportedReasoningEfforts.some((level) => level !== "none")
      : existing?.reasoning === true,
  };
  if (thinkingLevelMap !== undefined) {
    model.thinkingLevelMap = thinkingLevelMap;
  }
  return multiAgentVersion === undefined ? model : { ...model, multiAgentVersion };
};

const modelWindow = (
  model: SupportedModel,
  metadata: CodexModelMetadata | undefined,
):
  | {
      readonly autoCompactTokens: number;
      readonly effectiveWindowTokens: number;
    }
  | undefined => {
  const contextWindow =
    metadata?.context_window ?? metadata?.max_context_window ?? model.contextWindow;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  const contextLimit = Math.floor(contextWindow * 0.9);
  return {
    autoCompactTokens:
      metadata?.auto_compact_token_limit === undefined
        ? contextLimit
        : Math.min(metadata.auto_compact_token_limit, contextLimit),
    effectiveWindowTokens: Math.floor(
      (contextWindow * (metadata?.effective_context_window_percent ?? 95)) / 100,
    ),
  };
};

const credentialApiKey = async (
  credential: Credential | undefined,
  base: CodexProvider,
): Promise<string | undefined> => {
  if (credential === undefined) {
    return undefined;
  }
  if (credential.type === "api_key") {
    return credential.key;
  }
  const auth = await base.auth.oauth?.toAuth(credential);
  return auth?.apiKey ?? undefined;
};

export const createCodexModelCatalog = (onAccountChanged?: () => void) => {
  const builtin = openaiCodexProvider();
  const fallback = builtin
    .getModels()
    .filter((model) => isSupportedCodexModelId(model.id))
    .toSorted(
      (left, right) =>
        (FALLBACK_MODEL_PRIORITY.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (FALLBACK_MODEL_PRIORITY.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(seedFallbackModel);
  const base: CodexProvider = {
    ...builtin,
    auth: { ...builtin.auth, apiKey: storedApiKeyAuth },
    filterModels: (models) => models.filter((model) => isSupportedCodexModelId(model.id)),
    getModels: () => fallback,
  };
  let catalog: CatalogSnapshot = { kind: "fallback" };
  let accountObserved = false;
  let observedAccountId: string | undefined;
  const catalogModels = (): readonly SupportedModel[] =>
    catalog.kind === "remote" ? catalog.models : fallback;
  const modelMetadata = (modelId: string): CodexModelMetadata | undefined =>
    catalog.kind === "remote" ? catalog.metadata.get(modelId) : undefined;

  const refreshModels = async (context: RefreshModelsContext) => {
    const { stored } = context;
    if (context.signal.aborted) {
      return;
    }
    const apiKey = await credentialApiKey(context.credential, base);
    if (context.signal.aborted) {
      return;
    }
    const accountId =
      apiKey === undefined || apiKey.length === 0 ? undefined : extractAccountId(apiKey);
    if (!accountObserved) {
      accountObserved = true;
      observedAccountId = accountId;
    } else if (accountId !== observedAccountId) {
      observedAccountId = accountId;
      onAccountChanged?.();
    }
    if (stored !== undefined && catalog.kind === "fallback") {
      const current = accountId === undefined ? undefined : restoreCurrentCache(stored, accountId);
      if (
        !(await context.publish({
          update: () => {
            catalog =
              current === undefined
                ? { kind: "fallback" }
                : {
                    accountId: current.accountId,
                    kind: "remote",
                    metadata: current.metadata,
                    models: current.models,
                  };
          },
        }))
      ) {
        return;
      }
    }
    if (
      catalog.kind === "remote" &&
      catalog.accountId !== accountId &&
      !(await context.publish({
        persist: { checkedAt: 0, models: fallback },
        update: () => {
          catalog = { kind: "fallback" };
        },
      }))
    ) {
      return;
    }
    if (
      !context.allowNetwork ||
      context.signal.aborted ||
      apiKey === undefined ||
      apiKey.length === 0
    ) {
      return;
    }
    if (accountId === undefined) {
      throw new Error("Codex account identity is unavailable");
    }
    const now = Date.now();
    if (
      context.force !== true &&
      catalog.kind === "remote" &&
      catalog.accountId === accountId &&
      stored?.checkedAt !== undefined &&
      now - stored.checkedAt < MODEL_CACHE_TTL_MS
    ) {
      return;
    }
    const [authModel] = fallback;
    if (authModel === undefined) {
      throw new Error("Pi's static Codex model catalog has no GPT-5.6 models");
    }
    const headers = createCodexHeaders(authModel, apiKey, uuidv7());
    if (
      catalog.kind === "remote" &&
      catalog.accountId === accountId &&
      stored?.etag !== undefined &&
      stored.etag.length > 0
    ) {
      headers.set("if-none-match", stored.etag);
    }
    const response = await fetch(resolveModelsUrl(base.baseUrl), {
      headers,
      signal: context.signal,
    });
    if (context.signal.aborted) {
      return;
    }
    if (response.status === 304 && catalog.kind === "remote") {
      await context.publish({
        persist: {
          ...stored,
          checkedAt: now,
          models: cacheCatalog(catalog.models, catalog.metadata, catalog.accountId),
        },
      });
      return;
    }
    if (!response.ok) {
      throw new Error(`Codex model refresh failed (${response.status})`);
    }
    const payload: unknown = await response.json();
    const ModelsPayloadSchema = Type.Object({ models: Type.Array(Type.Unknown()) });
    if (!Value.Check(ModelsPayloadSchema, payload)) {
      throw new Error("Codex model response is malformed");
    }
    const metadataValues = Value.Parse(ModelsPayloadSchema, payload).models;
    const nextMetadata = new Map<string, CodexModelMetadata>();
    for (const value of metadataValues) {
      const ModelEntrySchema = Type.Object({
        display_name: Type.Optional(Type.String()),
        slug: Type.Optional(Type.String()),
        visibility: Type.Optional(Type.String()),
      });
      if (!Value.Check(ModelEntrySchema, value)) {
        throw new Error("Codex model metadata must be an object");
      }
      const metadata = parseModelMetadata(Value.Parse(ModelEntrySchema, value));
      if (
        metadata.visibility === "list" &&
        isSupportedCodexModelId(metadata.slug) &&
        !nextMetadata.has(metadata.slug)
      ) {
        nextMetadata.set(metadata.slug, metadata);
      }
    }
    if (nextMetadata.size === 0) {
      throw new Error("Codex model response contains no usable GPT-5.6 models");
    }
    const nextModels = [...nextMetadata.values()]
      .toSorted((left, right) => left.priority - right.priority)
      .map((metadata) => projectModel(metadata, fallback, base.baseUrl ?? DEFAULT_BASE_URL));
    if (context.signal.aborted) {
      return;
    }
    await context.publish({
      persist: {
        checkedAt: now,
        etag: response.headers.get("etag") ?? undefined,
        models: cacheCatalog(nextModels, nextMetadata, accountId),
      },
      update: () => {
        catalog = {
          accountId,
          kind: "remote",
          metadata: nextMetadata,
          models: nextModels,
        };
      },
    });
  };

  return {
    base,
    getModelMetadata: modelMetadata,
    getModelWindow: (model: SupportedModel) => modelWindow(model, modelMetadata(model.id)),
    getModels: catalogModels,
    refreshModels,
    supportsFastMode: (model: Model<Api> | undefined): boolean => {
      if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
        return false;
      }
      const metadata = modelMetadata(model.id);
      return metadata === undefined
        ? FALLBACK_FAST_MODELS.has(model.id)
        : modelSupportsServiceTier(metadata, "priority");
    },
    supportsUltra: (model: Model<Api> | undefined): boolean => {
      if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
        return false;
      }
      const metadata = modelMetadata(model.id);
      return (
        metadata?.multi_agent_version === "v2" &&
        reasoningLevels(metadata).includes("ultra") &&
        reasoningLevels(metadata).includes("max")
      );
    },
  };
};

export type CodexModelCatalog = ReturnType<typeof createCodexModelCatalog>;
