/* oxlint-disable eslint/complexity -- model catalog parsing and projection validate one bounded remote protocol payload */
import { arch, platform, release } from "node:os";

import { uuidv7 } from "@earendil-works/pi-ai";
import type {
  Api,
  ApiKeyAuth,
  Credential,
  Model,
  Provider,
  ProviderHeaders,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";

import { openaiCodexProvider } from "#pi-openai-codex";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const MODEL_CACHE_TTL_MS = 300_000;
const MODEL_CLIENT_VERSION = "0.0.0";

type JsonRecord = Record<string, unknown>;
type SupportedModel = Model<"openai-codex-responses">;
type CodexProvider = Provider<"openai-codex-responses">;

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

export interface CodexModelMetadata extends JsonRecord {
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
  readonly priority: number;
  readonly service_tiers?: readonly unknown[];
  readonly slug: string;
  readonly supported_in_api: boolean;
  readonly supported_reasoning_levels?: readonly unknown[];
  readonly support_verbosity: boolean;
  readonly supports_reasoning_summary_parameter?: boolean;
  readonly supports_parallel_tool_calls: boolean;
  readonly use_responses_lite: boolean;
  readonly visibility: string;
}

const FALLBACK_FAST_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const modelSupportsServiceTier = (
  metadata: CodexModelMetadata,
  serviceTier: string
) =>
  (metadata.service_tiers ?? []).some(
    (tier) => isRecord(tier) && tier.id === serviceTier
  );

const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const resolveCodexResponsesUrl = (baseUrl?: string): string => {
  const candidate = baseUrl?.trim();
  const normalized = (
    candidate === undefined || candidate.length === 0
      ? DEFAULT_BASE_URL
      : candidate
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
  responseUrl.pathname = responseUrl.pathname.replace(
    /\/responses$/u,
    "/models"
  );
  responseUrl.searchParams.set("client_version", MODEL_CLIENT_VERSION);
  return responseUrl.toString();
};

const extractAccountId = (token: string): string => {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8")
    );
    if (!isRecord(payload)) {
      throw new Error("invalid token payload");
    }
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string") {
      throw new Error("missing account id");
    }
    return auth.chatgpt_account_id;
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
  extra?: Readonly<ProviderHeaders>
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
    if (typeof value === "string") {
      return [value];
    }
    return isRecord(value) && typeof value.effort === "string"
      ? [value.effort]
      : [];
  });

const parseModelMetadata = (value: unknown): CodexModelMetadata => {
  if (!isRecord(value)) {
    throw new Error("Codex model metadata must be an object");
  }
  const { display_name: displayName, slug, visibility } = value;
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new Error("Codex model metadata display_name is invalid");
  }
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("Codex model metadata slug is invalid");
  }
  if (typeof visibility !== "string" || visibility.length === 0) {
    throw new Error("Codex model metadata visibility is invalid");
  }
  const {
    priority,
    supported_in_api: supportedInApi,
    support_verbosity: supportVerbosity,
    supports_parallel_tool_calls: supportsParallelToolCalls,
  } = value;
  if (
    typeof supportedInApi !== "boolean" ||
    typeof supportVerbosity !== "boolean" ||
    typeof supportsParallelToolCalls !== "boolean" ||
    typeof priority !== "number" ||
    !Number.isSafeInteger(priority)
  ) {
    throw new TypeError("Codex model metadata capabilities are invalid");
  }
  for (const key of [
    "auto_compact_token_limit",
    "context_window",
    "max_context_window",
  ] as const) {
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      !isNonnegativeInteger(value[key])
    ) {
      throw new Error(`Codex model metadata ${key} is invalid`);
    }
  }
  const autoCompactTokenLimit =
    typeof value.auto_compact_token_limit === "number"
      ? value.auto_compact_token_limit
      : undefined;
  const contextWindow =
    typeof value.context_window === "number" ? value.context_window : undefined;
  const maxContextWindow =
    typeof value.max_context_window === "number"
      ? value.max_context_window
      : undefined;
  const percent = value.effective_context_window_percent ?? 95;
  if (
    typeof percent !== "number" ||
    !Number.isSafeInteger(percent) ||
    percent <= 0 ||
    percent > 100
  ) {
    throw new Error("Codex model effective context percentage is invalid");
  }
  return {
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
    use_responses_lite: value.use_responses_lite === true,
    visibility,
  };
};

const projectModel = (
  metadata: CodexModelMetadata,
  fallback: readonly SupportedModel[],
  baseUrl: string
): SupportedModel => {
  const existing = fallback.find((model) => model.id === metadata.slug);
  const levels = reasoningLevels(metadata);
  const hasRemoteReasoningLevels =
    metadata.supported_reasoning_levels !== undefined;
  const thinkingLevelMap: Record<string, string | null> = Object.fromEntries(
    levels.flatMap((level) => {
      const piLevel = level === "ultra" ? "max" : level;
      return ["minimal", "low", "medium", "high", "xhigh", "max"].includes(
        piLevel
      )
        ? [[piLevel, level]]
        : [];
    })
  );
  if (hasRemoteReasoningLevels) {
    for (const level of ["off", "minimal", "low", "medium", "high"] as const) {
      thinkingLevelMap[level] ??= null;
    }
  }
  const contextWindow =
    metadata.context_window ??
    metadata.max_context_window ??
    existing?.contextWindow ??
    128_000;
  const modalities = metadata.input_modalities?.filter(
    (input): input is "image" | "text" => input === "text" || input === "image"
  );
  return {
    api: "openai-codex-responses",
    baseUrl: existing?.baseUrl ?? baseUrl,
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
      ? levels.length > 0
      : existing?.reasoning === true,
    ...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
  };
};

const modelWindow = (
  model: SupportedModel,
  metadata: CodexModelMetadata | undefined
):
  | {
      readonly autoCompactTokens: number;
      readonly effectiveWindowTokens: number;
    }
  | undefined => {
  const contextWindow =
    metadata?.context_window ??
    metadata?.max_context_window ??
    model.contextWindow;
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
      (contextWindow * (metadata?.effective_context_window_percent ?? 95)) / 100
    ),
  };
};

const credentialApiKey = async (
  credential: Credential | undefined,
  base: CodexProvider
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

export const createCodexModelCatalog = () => {
  const builtin = openaiCodexProvider();
  const base: CodexProvider = {
    ...builtin,
    auth: { ...builtin.auth, apiKey: storedApiKeyAuth },
  };
  const fallback = [...base.getModels()];
  let models = fallback;
  let metadataByModel = new Map<string, CodexModelMetadata>();

  const refreshModels = async (context: RefreshModelsContext) => {
    const { stored } = context;
    // Stored projections omit private request metadata; skip offline restore.
    if (!context.allowNetwork || context.signal.aborted) {
      return;
    }
    const now = Date.now();
    if (
      context.force !== true &&
      metadataByModel.size > 0 &&
      stored?.checkedAt !== undefined &&
      now - stored.checkedAt < MODEL_CACHE_TTL_MS
    ) {
      return;
    }
    const apiKey = await credentialApiKey(context.credential, base);
    if (apiKey === undefined || apiKey.length === 0) {
      return;
    }
    const [authModel] = fallback;
    if (authModel === undefined) {
      throw new Error("Pi's static Codex model catalog is empty");
    }
    const headers = createCodexHeaders(authModel, apiKey, uuidv7());
    if (
      metadataByModel.size > 0 &&
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
    if (response.status === 304 && metadataByModel.size > 0) {
      await context.publish({
        persist: { ...stored, checkedAt: now, models },
      });
      return;
    }
    if (!response.ok) {
      throw new Error(`Codex model refresh failed (${response.status})`);
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.models)) {
      throw new Error("Codex model response is malformed");
    }
    const nextMetadata = new Map<string, CodexModelMetadata>();
    for (const value of payload.models) {
      const metadata = parseModelMetadata(value);
      if (metadata.visibility === "list" && !nextMetadata.has(metadata.slug)) {
        nextMetadata.set(metadata.slug, metadata);
      }
    }
    if (nextMetadata.size === 0) {
      throw new Error("Codex model response contains no usable models");
    }
    const nextModels = [...nextMetadata.values()]
      .toSorted((left, right) => left.priority - right.priority)
      .map((metadata) =>
        projectModel(metadata, fallback, base.baseUrl ?? DEFAULT_BASE_URL)
      );
    if (context.signal.aborted) {
      return;
    }
    await context.publish({
      persist: {
        checkedAt: now,
        etag: response.headers.get("etag") ?? undefined,
        models: nextModels,
      },
      update: () => {
        metadataByModel = nextMetadata;
        models = nextModels;
      },
    });
  };

  return {
    base,
    getModelMetadata: (modelId: string) => metadataByModel.get(modelId),
    getModelWindow: (model: SupportedModel) =>
      modelWindow(model, metadataByModel.get(model.id)),
    getModels: () => models,
    refreshModels,
    supportsFastMode: (model: Model<Api> | undefined): boolean => {
      if (
        model?.provider !== "openai-codex" ||
        model.api !== "openai-codex-responses"
      ) {
        return false;
      }
      const metadata = metadataByModel.get(model.id);
      return metadata === undefined
        ? FALLBACK_FAST_MODELS.has(model.id)
        : modelSupportsServiceTier(metadata, "priority");
    },
  };
};

export type CodexModelCatalog = ReturnType<typeof createCodexModelCatalog>;
