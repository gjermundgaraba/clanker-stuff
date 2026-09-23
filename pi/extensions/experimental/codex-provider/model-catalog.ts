import { fetchCodexHttp } from "@clanker-stuff/codex-http";
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

// Catalog compatibility target, not the Pi application version. Older queries hide GPT-6 Sol/Luna.
const MODEL_CLIENT_VERSION = "0.156.1";

const MODEL_CACHE_METADATA_FIELD = "codexProviderMetadata";

const MODEL_CACHE_ACCOUNT_FIELD = "codexProviderAccountId";

const DEFAULT_OUTPUT_TOKEN_LIMIT = 10_000;

type SupportedModel = Model<"openai-codex-responses"> & {
  readonly codexOutputTokenLimit?: number;
  readonly codexToolMode?: CodexToolMode;
  readonly codexSupportedTools?: readonly string[];
  readonly codexVisibility?: string;
  // Structural protocol consumed by subagents, carried with the effective model.
  readonly spawnAgentMetadata?: {
    readonly description?: string;
    readonly defaultReasoningEffort?: ModelThinkingLevel;
    readonly serviceTiers: readonly string[];
    readonly showInPicker: boolean;
  };
  readonly multiAgentVersion?: "disabled" | "v1" | "v2";
};

type CachedSupportedModel = SupportedModel & {
  readonly codexProviderAccountId: string;
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
      readonly rejections: readonly string[];
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

const CODEX_PI_REASONING_LEVELS: ReadonlyMap<string, ModelThinkingLevel> = new Map(
  Object.values(PI_CODEX_REASONING_EFFORTS).map((effort) => [
    effort,
    effort === "none" ? "off" : effort,
  ]),
);

const ModelsPayloadSchema = Type.Object({ models: Type.Array(Type.Unknown()) });

const ModelIdentitySchema = Type.Object({ slug: Type.String({ minLength: 1 }) });

// Keep the entry boundary permissive for native fields not interpreted by this provider.
const ModelEntrySchema = Type.Object({
  description: Type.Optional(Type.String()),
  display_name: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String()),
  visibility: Type.Optional(Type.String()),
});

const ModelMessagesSchema = Type.Union([
  Type.Object({
    multi_agent: Type.Optional(
      Type.Union([
        Type.Object({
          mode: Type.Optional(
            Type.Union([
              Type.Object({
                hint_text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                proactive: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              }),
              Type.Null(),
            ]),
          ),
        }),
        Type.Null(),
      ]),
    ),
  }),
  Type.Null(),
]);

export const isCodexWireReasoningEffort = (value: unknown): value is CodexWireReasoningEffort =>
  typeof value === "string" && CODEX_PI_REASONING_LEVELS.has(value);

const storedApiKeyAuth: ApiKeyAuth = {
  name: "OpenAI Codex access token",
  resolve: async ({ credential, signal }) => {
    signal.throwIfAborted();

    return credential?.key !== undefined && credential.key.length > 0
      ? {
          auth: { apiKey: credential.key },
          ...(credential.env !== undefined ? { env: credential.env } : {}),
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

export type CodexModelMessages = Static<typeof ModelMessagesSchema>;

export type CodexToolMode = "direct" | "code_mode" | "code_mode_only";

export interface CodexModelMetadataWire extends Readonly<Static<typeof ModelEntrySchema>> {
  readonly auto_compact_token_limit?: number | null;
  readonly base_instructions?: string;
  readonly comp_hash?: string;
  readonly context_window?: number | null;
  readonly default_reasoning_level?: string;
  readonly default_reasoning_summary?: "auto" | "concise" | "detailed" | "none";
  readonly default_service_tier?: string;
  readonly default_verbosity?: "high" | "low" | "medium";
  readonly effective_context_window_percent?: number | null;
  readonly input_modalities?: readonly string[];
  readonly experimental_supported_tools?: readonly string[];
  readonly max_context_window?: number | null;
  readonly model_messages?: CodexModelMessages;
  readonly multi_agent_reasoning_effort?: string | null;
  readonly multi_agent_version?: string | null;
  readonly priority?: number;
  readonly service_tiers?: readonly (CodexModelServiceTier | null)[];
  readonly supported_in_api?: boolean;
  readonly supported_reasoning_levels?: readonly (string | CodexModelReasoningLevel | null)[];
  readonly support_verbosity?: boolean;
  readonly supports_reasoning_summary_parameter?: boolean;
  readonly supports_parallel_tool_calls?: boolean;
  readonly truncation_policy?: {
    readonly limit: number;
    readonly mode: "bytes" | "tokens";
  };
  readonly tool_mode?: string | null;
  readonly use_responses_lite?: boolean | null;
}

export interface CodexModelMetadata extends CodexModelMetadataWire {
  readonly auto_compact_token_limit?: number;
  readonly context_window?: number;
  readonly display_name: string;
  readonly effective_context_window_percent: number;
  readonly max_context_window?: number;
  readonly priority: number;
  readonly slug: string;
  readonly supported_in_api: boolean;
  readonly support_verbosity: boolean;
  readonly supports_parallel_tool_calls: boolean;
  readonly use_responses_lite: boolean;
  readonly visibility: string;
}

export interface CodexUltraSettings {
  readonly proactivePolicy?: string;
  readonly reasoningLevel: ModelThinkingLevel;
}

// Codex rust-v0.156.1 (b412ff32c417f855c2b2d1581b77058eed87c84b), models-manager/models.json.
// Native policy only: Pi owns prices, capabilities, image limits and application state.
const GPT6_COMMON_METADATA = {
  comp_hash: "3000",
  context_window: 272_000,
  default_reasoning_summary: "none",
  default_verbosity: "low",
  effective_context_window_percent: 95,
  input_modalities: ["text", "image"],
  max_context_window: 872_000,
  multi_agent_version: "v2",
  service_tiers: [{ id: "priority" }],
  experimental_supported_tools: ["send_user_message_async", "clock"],
  supported_in_api: true,
  support_verbosity: true,
  supports_parallel_tool_calls: true,
  supports_reasoning_summary_parameter: true,
  tool_mode: "code_mode_only",
  truncation_policy: { limit: 10_000, mode: "tokens" },
  use_responses_lite: true,
  visibility: "list",
} satisfies Partial<CodexModelMetadata>;

interface OfflineProfile {
  readonly id: string;
  readonly metadata?: Omit<CodexModelMetadata, "slug" | "priority">;
  readonly spawnAgentMetadata?: SupportedModel["spawnAgentMetadata"];
  readonly multiAgentVersion?: SupportedModel["multiAgentVersion"];
}

// Ordered cold-start seeds, not an online allowlist. Older profiles retain only
// the native fields audited at Codex af1fc2dbff; GPT-6 policy is pinned above.
const OFFLINE_PROFILES: readonly OfflineProfile[] = [
  {
    id: "gpt-6-astra",
    metadata: {
      ...GPT6_COMMON_METADATA,
      display_name: "GPT-6-Astra",
      description: "Frontier intelligence for the most demanding work.",
      default_reasoning_level: "low",
      multi_agent_reasoning_effort: "xhigh",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
  },
  {
    id: "gpt-6-sol",
    metadata: {
      ...GPT6_COMMON_METADATA,
      display_name: "GPT-6-Sol",
      description: "Workhorse model for coding and everyday work.",
      default_reasoning_level: "medium",
      default_service_tier: "priority",
      multi_agent_reasoning_effort: null,
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
  },
  {
    id: "gpt-6-luna",
    metadata: {
      ...GPT6_COMMON_METADATA,
      display_name: "GPT-6-Luna",
      description: "Fast and affordable model for easier tasks.",
      default_reasoning_level: "medium",
      default_service_tier: "priority",
      multi_agent_reasoning_effort: null,
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
    },
  },
  {
    id: "gpt-5.6-sol",
    multiAgentVersion: "v2",
    spawnAgentMetadata: {
      description: "Latest frontier agentic coding model.",
      defaultReasoningEffort: "low",
      serviceTiers: ["priority"],
      showInPicker: true,
    },
  },
  {
    id: "gpt-5.6-terra",
    multiAgentVersion: "v2",
    spawnAgentMetadata: {
      description: "Balanced agentic coding model for everyday work.",
      defaultReasoningEffort: "medium",
      serviceTiers: ["priority"],
      showInPicker: true,
    },
  },
  {
    id: "gpt-5.6-luna",
    multiAgentVersion: "v1",
    spawnAgentMetadata: {
      description: "Fast and affordable agentic coding model.",
      defaultReasoningEffort: "medium",
      serviceTiers: ["priority"],
      showInPicker: true,
    },
  },
];

const TokenPayloadSchema = Type.Object({
  "https://api.openai.com/auth": Type.Object({ chatgpt_account_id: Type.String() }),
});

// Grammar tools are required by the Codex tool set; other wire features are negotiated.
// Pi owns these declarations; model-name prefixes are not evidence of support.
const hasRequiredCapabilities = (model: Model<Api> | undefined): boolean =>
  model?.provider === "openai-codex" &&
  model.api === "openai-codex-responses" &&
  model.compat !== undefined &&
  "supportsOpenAIGrammarTools" in model.compat &&
  model.compat.supportsOpenAIGrammarTools === true;

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

const isToolMode = (value: string | null | undefined): value is CodexToolMode =>
  value === "direct" || value === "code_mode" || value === "code_mode_only";

const hasSupportedPolicy = (metadata: CodexModelMetadata): boolean =>
  (metadata.visibility === "list" || metadata.visibility === "hide") &&
  (metadata.tool_mode === undefined ||
    metadata.tool_mode === null ||
    isToolMode(metadata.tool_mode));

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

export const extractAccountId = (token: string): string => {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8"),
    );

    if (!Value.Check(TokenPayloadSchema, payload)) {
      throw new Error("invalid token payload");
    }

    return payload["https://api.openai.com/auth"].chatgpt_account_id;
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
  model: Pick<SupportedModel, "headers">,
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
    if (typeof value === "string") {
      return [value];
    }

    return value?.effort === undefined ? [] : [value.effort];
  });

export const piReasoningLevel = (effort: string): ModelThinkingLevel | undefined =>
  CODEX_PI_REASONING_LEVELS.get(effort);

const ultraSettings = (
  metadata: CodexModelMetadata | undefined,
): CodexUltraSettings | undefined => {
  if (metadata?.multi_agent_version !== "v2") {
    return undefined;
  }

  const levels = reasoningLevels(metadata);

  if (!levels.includes("ultra")) {
    return undefined;
  }

  const configured = metadata.multi_agent_reasoning_effort;

  const configuredLevel =
    configured !== undefined && configured !== null && levels.includes(configured)
      ? piReasoningLevel(configured)
      : undefined;

  const representable = levels.flatMap((effort) => piReasoningLevel(effort) ?? []);

  const fallback =
    configuredLevel ?? (representable.includes("max") ? "max" : (representable.at(-1) ?? "medium"));

  const mode = metadata.model_messages?.multi_agent?.mode;
  const policy = mode?.hint_text ?? mode?.proactive;

  return policy !== undefined && policy !== null
    ? { proactivePolicy: policy, reasoningLevel: fallback }
    : { reasoningLevel: fallback };
};

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
    typeof supportedInApi !== "boolean" ||
    typeof supportVerbosity !== "boolean" ||
    typeof supportsParallelToolCalls !== "boolean" ||
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

  if (
    value.multi_agent_reasoning_effort !== undefined &&
    value.multi_agent_reasoning_effort !== null &&
    typeof value.multi_agent_reasoning_effort !== "string"
  ) {
    throw new Error("Codex model multi-agent reasoning effort is invalid");
  }

  if (
    value.model_messages !== undefined &&
    !Value.Check(ModelMessagesSchema, value.model_messages)
  ) {
    throw new Error("Codex model messages are invalid");
  }

  if (
    value.experimental_supported_tools !== undefined &&
    (!Array.isArray(value.experimental_supported_tools) ||
      value.experimental_supported_tools.some((tool) => typeof tool !== "string"))
  ) {
    throw new Error("Codex model experimental tools are invalid");
  }

  const {
    truncation_policy: _truncation,
    auto_compact_token_limit: _autoCompact,
    context_window: _context,
    max_context_window: _maxContext,
    ...validated
  } = value;

  const parsed: CodexModelMetadata = {
    ...validated,
    ...(autoCompactTokenLimit !== undefined
      ? { auto_compact_token_limit: autoCompactTokenLimit }
      : {}),
    ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
    display_name: displayName,
    effective_context_window_percent: percent,
    ...(maxContextWindow !== undefined ? { max_context_window: maxContextWindow } : {}),
    priority,
    slug,
    support_verbosity: supportVerbosity,
    supported_in_api: supportedInApi,
    supports_parallel_tool_calls: supportsParallelToolCalls,
    ...(truncationPolicy !== undefined
      ? { truncation_policy: { limit: truncationPolicy.limit, mode: truncationPolicy.mode } }
      : {}),
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

const isCachedModel = (
  model: Model<Api>,
): model is Model<Api> & {
  readonly codexProviderAccountId: string;
  readonly codexProviderMetadata: unknown;
} =>
  model.api === "openai-codex-responses" &&
  model.provider === "openai-codex" &&
  MODEL_CACHE_ACCOUNT_FIELD in model &&
  typeof model[MODEL_CACHE_ACCOUNT_FIELD] === "string" &&
  model[MODEL_CACHE_ACCOUNT_FIELD].length > 0 &&
  MODEL_CACHE_METADATA_FIELD in model;

const restoreCache = (
  stored: RefreshModelsContext["stored"],
  accountId: string,
  builtinModels: ReadonlyMap<string, SupportedModel>,
) => {
  // Ownership exists only on model entries; an empty persisted list has no account identity.
  if (stored === undefined || stored.models.length === 0) return undefined;

  const metadata = new Map<string, CodexModelMetadata>();
  const models: SupportedModel[] = [];
  const rejections: string[] = [];
  const seen = new Set<string>();

  for (const model of stored.models) {
    // Account and identity corruption invalidate the snapshot, not just an entry.
    if (!isCachedModel(model) || model[MODEL_CACHE_ACCOUNT_FIELD] !== accountId) return undefined;

    const value = model[MODEL_CACHE_METADATA_FIELD];

    if (!Value.Check(ModelIdentitySchema, value) || value.slug !== model.id || seen.has(model.id)) {
      return undefined;
    }

    seen.add(model.id);
    const entry = projectCatalogEntry(value, builtinModels, rejections);

    if (entry === undefined) continue;

    metadata.set(model.id, entry.metadata);
    models.push(entry.model);
  }

  return { accountId, metadata, models, rejections };
};

const projectModel = (metadata: CodexModelMetadata, baseModel: SupportedModel): SupportedModel => {
  const supportedReasoningEfforts = reasoningLevels(metadata).filter(isCodexWireReasoningEffort);
  const ultraReasoning = ultraSettings(metadata);

  const projectedReasoningEfforts =
    ultraReasoning === undefined
      ? supportedReasoningEfforts
      : [...supportedReasoningEfforts, PI_CODEX_REASONING_EFFORTS[ultraReasoning.reasoningLevel]];

  const hasRemoteReasoningLevels = metadata.supported_reasoning_levels !== undefined;

  const thinkingLevelMap = hasRemoteReasoningLevels
    ? Object.fromEntries(
        Object.entries(PI_CODEX_REASONING_EFFORTS).map(([piLevel, wireEffort]) => [
          piLevel,
          projectedReasoningEfforts.includes(wireEffort) ? wireEffort : null,
        ]),
      )
    : baseModel.thinkingLevelMap;

  const contextWindow =
    metadata.context_window ?? metadata.max_context_window ?? baseModel.contextWindow;

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

  const defaultReasoningEffort =
    metadata.default_reasoning_level !== undefined
      ? piReasoningLevel(metadata.default_reasoning_level)
      : undefined;

  const model: SupportedModel = {
    ...baseModel,
    codexOutputTokenLimit: outputTokenLimit,
    ...(isToolMode(metadata.tool_mode) ? { codexToolMode: metadata.tool_mode } : {}),
    ...(metadata.experimental_supported_tools !== undefined
      ? { codexSupportedTools: metadata.experimental_supported_tools }
      : {}),
    codexVisibility: metadata.visibility,
    spawnAgentMetadata: {
      ...(metadata.description !== undefined ? { description: metadata.description } : {}),
      ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
      serviceTiers: (metadata.service_tiers ?? []).flatMap((tier) =>
        // Pi currently implements only the priority service tier.
        tier?.id === "priority" ? [tier.id] : [],
      ),
      showInPicker: metadata.visibility === "list",
    },
    contextWindow,
    id: metadata.slug,
    input: modalities !== undefined && modalities.length > 0 ? modalities : baseModel.input,
    name: metadata.display_name,
    provider: "openai-codex",
    reasoning: hasRemoteReasoningLevels
      ? projectedReasoningEfforts.some((level) => level !== "none")
      : baseModel.reasoning,
  };

  if (thinkingLevelMap !== undefined) {
    model.thinkingLevelMap = thinkingLevelMap;
  }

  return multiAgentVersion === undefined ? model : { ...model, multiAgentVersion };
};

const projectCatalogEntry = (
  value: Static<typeof ModelIdentitySchema>,
  builtinModels: ReadonlyMap<string, SupportedModel>,
  rejections: string[],
): { metadata: CodexModelMetadata; model: SupportedModel } | undefined => {
  const baseModel = builtinModels.get(value.slug);

  if (baseModel === undefined) {
    rejections.push(`${value.slug}: No Pi-bundled definition with required grammar-tool support`);

    return undefined;
  }

  try {
    if (!Value.Check(ModelEntrySchema, value)) {
      throw new Error("Codex model metadata fields are invalid");
    }

    const metadata = parseModelMetadata(value);

    if (!hasSupportedPolicy(metadata)) {
      throw new Error("Unsupported visibility or required tool mode");
    }

    return { metadata, model: projectModel(metadata, baseModel) };
  } catch (cause) {
    rejections.push(`${value.slug}: ${cause instanceof Error ? cause.message : String(cause)}`);

    return undefined;
  }
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

export const createCodexModelCatalog = (
  onAccountChanged?: () => void,
  builtin: CodexProvider = openaiCodexProvider(),
) => {
  const builtinModels = new Map(
    builtin
      .getModels()
      .filter(hasRequiredCapabilities)
      .map((model) => [model.id, model]),
  );

  const fallbackMetadata = new Map<string, CodexModelMetadata>();

  const fallback = OFFLINE_PROFILES.flatMap((profile, index): SupportedModel[] => {
    const baseModel = builtinModels.get(profile.id);

    if (baseModel === undefined) return [];

    const metadata =
      profile.metadata === undefined
        ? undefined
        : { ...profile.metadata, slug: profile.id, priority: index + 1 };

    if (metadata !== undefined) fallbackMetadata.set(profile.id, metadata);

    return [
      {
        ...(metadata === undefined ? baseModel : projectModel(metadata, baseModel)),
        codexOutputTokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
        ...(profile.spawnAgentMetadata !== undefined
          ? { spawnAgentMetadata: profile.spawnAgentMetadata }
          : {}),
        ...(profile.multiAgentVersion !== undefined
          ? { multiAgentVersion: profile.multiAgentVersion }
          : {}),
      },
    ];
  });

  const base: CodexProvider = {
    ...builtin,
    auth: { ...builtin.auth, apiKey: storedApiKeyAuth },
    // Pi resolves explicit IDs through getModels; filterModels supplies the picker list.
    filterModels: (models) =>
      models.filter(
        (model) => supportsModel(model) && modelMetadata(model.id)?.visibility !== "hide",
      ),
    getModels: () => fallback,
  };

  let catalog: CatalogSnapshot = { kind: "fallback" };
  let accountObserved = false;
  let observedAccountId: string | undefined;

  const catalogModels = (): readonly SupportedModel[] =>
    catalog.kind === "remote" ? catalog.models : fallback;

  const modelMetadata = (modelId: string): CodexModelMetadata | undefined =>
    catalog.kind === "remote" ? catalog.metadata.get(modelId) : fallbackMetadata.get(modelId);

  const supportsModel = (model: Model<Api> | undefined): boolean =>
    hasRequiredCapabilities(model) &&
    model !== undefined &&
    builtinModels.has(model.id) &&
    catalogModels().some((candidate) => candidate.id === model.id);

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
      const current =
        accountId === undefined ? undefined : restoreCache(stored, accountId, builtinModels);

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
                    rejections: current.rejections,
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

    // Empty snapshots are rechecked unconditionally. Persisted empty lists cannot
    // establish ownership of a freshness timestamp or another account's validator.
    if (
      context.force !== true &&
      catalog.kind === "remote" &&
      catalog.accountId === accountId &&
      catalog.models.length > 0 &&
      stored?.checkedAt !== undefined &&
      now - stored.checkedAt < MODEL_CACHE_TTL_MS
    ) {
      return;
    }

    const headers = createCodexHeaders({}, apiKey, uuidv7());

    if (
      catalog.kind === "remote" &&
      catalog.accountId === accountId &&
      catalog.models.length > 0 &&
      stored?.etag !== undefined &&
      stored.etag.length > 0
    ) {
      headers.set("if-none-match", stored.etag);
    }

    const response = await fetchCodexHttp(resolveModelsUrl(base.baseUrl), {
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

    if (!Value.Check(ModelsPayloadSchema, payload)) {
      throw new Error("Codex model response is malformed");
    }

    const nextMetadata = new Map<string, CodexModelMetadata>();
    const admitted: { metadata: CodexModelMetadata; model: SupportedModel }[] = [];
    const rejections: string[] = [];

    for (const [index, value] of payload.models.entries()) {
      if (!Value.Check(ModelIdentitySchema, value)) {
        rejections.push(`Entry ${index + 1}: invalid or missing model slug`);
        continue;
      }

      if (nextMetadata.has(value.slug)) continue;
      const entry = projectCatalogEntry(value, builtinModels, rejections);

      if (entry === undefined) continue;

      nextMetadata.set(value.slug, entry.metadata);
      admitted.push(entry);
    }

    const nextModels = admitted
      .toSorted((left, right) => left.metadata.priority - right.metadata.priority)
      .map(({ model }) => model);

    if (context.signal.aborted) {
      return;
    }

    const etag = response.headers.get("etag");
    await context.publish({
      persist: {
        checkedAt: now,
        ...(etag !== null ? { etag } : {}),
        models: cacheCatalog(nextModels, nextMetadata, accountId),
      },
      update: () => {
        catalog = {
          accountId,
          kind: "remote",
          metadata: nextMetadata,
          models: nextModels,
          rejections,
        };
      },
    });
  };

  return {
    base,
    getModelMetadata: modelMetadata,
    getRejections: (): readonly string[] => (catalog.kind === "remote" ? catalog.rejections : []),
    getModelWindow: (model: SupportedModel) => modelWindow(model, modelMetadata(model.id)),
    getModels: catalogModels,
    getUltraSettings: (model: Model<Api> | undefined): CodexUltraSettings | undefined => {
      if (model === undefined || !supportsModel(model)) {
        return undefined;
      }

      return ultraSettings(modelMetadata(model.id));
    },
    refreshModels,
    supportsModel,
    supportsFastMode: (model: Model<Api> | undefined): boolean => {
      if (model === undefined || !supportsModel(model)) {
        return false;
      }

      const metadata = modelMetadata(model.id);

      return metadata === undefined
        ? catalog.kind === "fallback" &&
            (fallback
              .find((candidate) => candidate.id === model.id)
              ?.spawnAgentMetadata?.serviceTiers.includes("priority") ??
              false)
        : modelSupportsServiceTier(metadata, "priority");
    },
  };
};

export type CodexModelCatalog = ReturnType<typeof createCodexModelCatalog>;
