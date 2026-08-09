/* oxlint-disable eslint/no-use-before-define, eslint/complexity, eslint/func-style, eslint/no-nested-ternary, eslint/no-await-in-loop, promise/avoid-new, promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Responses transport parsing, ordered retries, and socket event queues are bounded protocol state machines */

import { arch, platform, release } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

import {
  calculateCost,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  uuidv7,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Credential,
  Model,
  OpenAICodexResponsesOptions,
  Provider,
  ProviderEnv,
  ProviderHeaders,
  RefreshModelsContext,
  SimpleStreamOptions,
  StreamFunction,
  Tool,
  Usage,
} from "@earendil-works/pi-ai";

import { createGrammarToolInputProperties } from "#pi-constrained-sampling";
import { openaiCodexProvider } from "#pi-openai-codex";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "#pi-responses";
import { buildBaseOptions } from "#pi-simple-options";

import {
  canonicalJson,
  parseCompactionItem,
  sha256Canonical,
} from "./checkpoint.js";
import type { CanonicalCompactionItem } from "./checkpoint.js";
import type { CodexObservability } from "./observability.js";
import {
  estimateModelVisibleTokens,
  normalizeToolHistory,
  omitUnsupportedUserImages,
  shrinkTrailingOutputs,
} from "./replay.js";
import type { ResponsesInputItem } from "./replay.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const MODEL_CACHE_TTL_MS = 300_000;
const MODEL_CLIENT_VERSION = "0.0.0";
const REQUEST_COMPRESSION_LEVEL = 3;
const WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const WEBSOCKET_IDLE_TTL_MS = 5 * 60_000;
const WEBSOCKET_MAX_AGE_MS = 55 * 60_000;
// ponytail: offline model catalogs omit service tiers; live metadata replaces this fallback.
const FAST_MODE_FALLBACK_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);
export const ALLOWED_TOOL_CALL_PROVIDERS = new Set([
  "openai",
  "openai-codex",
  "opencode",
]);

type SupportedModel = Model<"openai-codex-responses">;
type JsonRecord = Record<string, unknown>;

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

interface RequestBody extends JsonRecord {
  client_metadata?: Record<string, string>;
  include?: string[];
  input: ResponsesInputItem[];
  instructions: string;
  model: string;
  parallel_tool_calls: boolean;
  previous_response_id?: string;
  prompt_cache_key?: string;
  reasoning?: { context?: string; effort?: string; summary?: string };
  service_tier?: OpenAICodexResponsesOptions["serviceTier"];
  store: boolean;
  stream: boolean;
  stream_options?: JsonRecord;
  text?: JsonRecord;
  tool_choice: "auto" | "none" | "required";
  tools?: JsonRecord[];
}

interface ResponseCapture {
  completed: boolean;
  outputItems: ResponsesInputItem[];
  responseId?: string;
  serviceTier?: string;
  terminal: boolean;
  usage?: Usage;
}

interface ContinuationState {
  readonly request: RequestBody;
  readonly responseId: string;
  readonly responseItems: readonly ResponsesInputItem[];
}

interface WebSocketLike {
  readonly readyState?: number;
  addEventListener: (
    type: WebSocketEventType,
    listener: WebSocketListener
  ) => void;
  close: (code?: number, reason?: string) => void;
  removeEventListener: (
    type: WebSocketEventType,
    listener: WebSocketListener
  ) => void;
  send: (data: string) => void;
}

type WebSocketEventType = "close" | "error" | "message" | "open";
type WebSocketListener = (event: unknown) => void;
type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> }
) => WebSocketLike;

interface SessionRuntime {
  activeTransport?: OpenAICodexResponsesOptions["transport"];
  continuation?: ContinuationState;
  fallbackToSse: boolean;
  socket?: {
    busy: boolean;
    createdAt: number;
    idleTimer?: ReturnType<typeof setTimeout>;
    value: WebSocketLike;
  };
  turn?: {
    id: string;
    prewarmed: boolean;
    startedAt: number;
    state?: string;
  };
  transportFallbackPending: boolean;
  window: {
    currentId: string;
    number: number;
    previousId?: string;
  };
}

interface RequestTrace {
  connectionLimitRetries: number;
  continuationMode?: "delta" | "full";
  fellBackToSse: boolean;
  missingContinuationRetries: number;
  prewarmAttempted: boolean;
  prewarmSucceeded: boolean;
  socketAgeMs?: number;
  socketReused: boolean;
  transportUsed?: "sse" | "websocket";
}

const createRequestTrace = (): RequestTrace => ({
  connectionLimitRetries: 0,
  fellBackToSse: false,
  missingContinuationRetries: 0,
  prewarmAttempted: false,
  prewarmSucceeded: false,
  socketReused: false,
});

export interface CodexCompactionRequest {
  readonly apiKey: string;
  readonly authoritativeEnvelope?: Readonly<Record<string, unknown>>;
  readonly authoritativeInput?: readonly ResponsesInputItem[];
  readonly context: Context;
  readonly codexReason?: "comp_hash_changed" | "model_downshift";
  readonly effectiveTokenLimit: number;
  readonly env?: ProviderEnv;
  readonly headers?: Readonly<ProviderHeaders>;
  readonly inputPrefix: readonly ResponsesInputItem[];
  readonly model: SupportedModel;
  readonly reason: "manual" | "overflow" | "threshold";
  readonly phase: "mid-turn" | "overflow-retry" | "pre-sampling" | "standalone";
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly thinkingLevel: SimpleStreamOptions["reasoning"];
}

export interface CodexCompactionResult {
  readonly compaction: CanonicalCompactionItem;
  readonly estimatedSourceTokens: number;
  readonly responseId: string;
  readonly usage: Usage;
}

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const modelSupportsServiceTier = (
  metadata: CodexModelMetadata,
  serviceTier: string
) =>
  (metadata.service_tiers ?? []).some(
    (tier) => isRecord(tier) && tier.id === serviceTier
  );

const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isAborted = (signal: AbortSignal | undefined) => signal?.aborted ?? false;

const cloneJson = <T>(value: T): T => structuredClone(value);

// Codex truncates by Unicode scalar value, not grapheme cluster.
// oxlint-disable-next-line typescript/no-misused-spread -- spread matches Rust char iteration
const promptCacheKey = (value: string) => [...value].slice(0, 64).join("");

const normalizeTimeout = (
  value: number | undefined,
  name: string
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative finite number`);
  }
  return Math.floor(value);
};

const resolveResponsesUrl = (baseUrl?: string) => {
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

const resolveModelsUrl = (baseUrl?: string) => {
  const responseUrl = new URL(resolveResponsesUrl(baseUrl));
  responseUrl.pathname = responseUrl.pathname.replace(
    /\/responses$/u,
    "/models"
  );
  responseUrl.searchParams.set("client_version", MODEL_CLIENT_VERSION);
  return responseUrl.toString();
};

const resolveWebSocketUrl = (baseUrl?: string) => {
  const url = new URL(resolveResponsesUrl(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

const extractAccountId = (token: string) => {
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
) => {
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

const headersRecord = (headers: Headers) =>
  Object.fromEntries(headers.entries());

const buildBaseHeaders = (
  model: SupportedModel,
  options: OpenAICodexResponsesOptions | undefined,
  requestId: string
) => {
  const apiKey = options?.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("OpenAI Codex authentication is unavailable");
  }
  const headers = new Headers();
  applyHeaders(headers, model.headers, options?.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("chatgpt-account-id", extractAccountId(apiKey));
  headers.set("originator", "pi");
  headers.set("user-agent", `pi (${platform()} ${release()}; ${arch()})`);
  headers.set("session-id", requestId);
  headers.set("x-client-request-id", requestId);
  return headers;
};

const splitDeferredTools = (context: Context, enabled: boolean) => {
  const unique = new Map(
    (context.tools ?? []).map((tool) => [tool.name, tool])
  );
  if (!enabled) {
    return {
      deferred: new Map<string, Tool>(),
      immediate: [...unique.values()],
    };
  }
  const deferredNames = new Set<string>();
  const usedNames = new Set<string>();
  for (const message of context.messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          usedNames.add(block.name);
        }
      }
    } else if (message.role === "toolResult") {
      for (const name of message.addedToolNames ?? []) {
        if (!usedNames.has(name)) {
          deferredNames.add(name);
        }
      }
    }
  }
  const deferred = new Map<string, Tool>();
  const immediate: Tool[] = [];
  for (const [name, tool] of unique) {
    if (deferredNames.has(name)) {
      deferred.set(name, tool);
    } else {
      immediate.push(tool);
    }
  }
  return { deferred, immediate };
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
  base: Provider<"openai-codex-responses">
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

const initialUsage = (): Usage => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
});

const requestMetadata = (
  sessionId: string,
  session: SessionRuntime,
  kind: "compaction" | "prewarm" | "turn",
  compaction?: Readonly<Record<string, string>>
) => {
  const turn = (session.turn ??= {
    id: uuidv7(),
    prewarmed: false,
    startedAt: Date.now(),
  });
  const canonical = JSON.stringify({
    request_kind: kind,
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: turn.id,
    turn_started_at_unix_ms: turn.startedAt,
    window_id: session.window.currentId,
    ...(compaction ? { compaction } : {}),
  });
  return {
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: turn.id,
    "x-codex-turn-metadata": canonical,
    "x-codex-window-id": session.window.currentId,
  };
};

const compactionMetadata = (request: CodexCompactionRequest) => ({
  implementation: "responses_compaction_v2",
  phase:
    request.phase === "standalone"
      ? "standalone_turn"
      : request.phase === "pre-sampling"
        ? "pre_turn"
        : "mid_turn",
  reason:
    request.codexReason ??
    (request.reason === "manual" ? "user_requested" : "context_limit"),
  strategy: "memento",
  trigger: request.reason === "manual" ? "manual" : "auto",
});

const buildRequestBody = (
  model: SupportedModel,
  context: Context,
  options: OpenAICodexResponsesOptions | undefined,
  metadata: CodexModelMetadata | undefined,
  sessionId: string,
  session: SessionRuntime,
  kind: "prewarm" | "turn" = "turn"
) => {
  const grammarToolInputProperties = createGrammarToolInputProperties(
    context.tools,
    model.compat?.supportsOpenAIGrammarTools ?? false
  );
  const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
  const supportsOpenAIGrammarTools =
    model.compat?.supportsOpenAIGrammarTools ?? false;
  const placement = splitDeferredTools(
    context,
    model.compat?.supportsToolSearch ?? false
  );
  const toolOptions = {
    strict: null,
    supportsOpenAIGrammarTools,
    supportsStrictMode,
  } as const;
  let input: ResponsesInputItem[] = convertResponsesMessages(
    model,
    context,
    ALLOWED_TOOL_CALL_PROVIDERS,
    {
      deferredTools: placement.deferred,
      grammarToolInputProperties,
      includeSystemPrompt: false,
      toolOptions,
    }
  ).map((item) => ({ ...item }));
  const tools =
    placement.immediate.length > 0
      ? convertResponsesTools(placement.immediate, toolOptions).map((tool) => ({
          ...tool,
        }))
      : undefined;
  const lite = metadata?.use_responses_lite === true;
  if (lite) {
    const prefix: ResponsesInputItem[] = [];
    if ((tools?.length ?? 0) > 0) {
      prefix.push({ role: "developer", tools, type: "additional_tools" });
    }
    if (context.systemPrompt !== undefined && context.systemPrompt.length > 0) {
      prefix.push({
        content: [{ text: context.systemPrompt, type: "input_text" }],
        role: "developer",
        type: "message",
      });
    }
    input = [...prefix, ...input];
  }
  const body: RequestBody = {
    client_metadata: requestMetadata(sessionId, session, kind),
    include: ["reasoning.encrypted_content"],
    input,
    instructions: lite
      ? ""
      : context.systemPrompt !== undefined && context.systemPrompt.length > 0
        ? context.systemPrompt
        : "You are a helpful assistant.",
    model: model.id,
    parallel_tool_calls:
      !lite && metadata?.supports_parallel_tool_calls !== false,
    prompt_cache_key:
      options?.cacheRetention === "none"
        ? undefined
        : promptCacheKey(sessionId),
    store: false,
    stream: true,
    text:
      metadata?.support_verbosity === false
        ? undefined
        : {
            verbosity:
              options?.textVerbosity ?? metadata?.default_verbosity ?? "low",
          },
    tool_choice: options?.toolChoice ?? "auto",
  };
  if (!lite && tools !== undefined) {
    body.tools = tools;
  }
  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  const serviceTier = options?.serviceTier;
  if (
    serviceTier !== null &&
    serviceTier !== undefined &&
    serviceTier.length > 0 &&
    serviceTier !== "default" &&
    (metadata === undefined || modelSupportsServiceTier(metadata, serviceTier))
  ) {
    body.service_tier = serviceTier;
  }
  const reasoningEffort =
    options?.reasoningEffort ?? metadata?.default_reasoning_level;
  if (reasoningEffort !== undefined && reasoningEffort.length > 0) {
    const thinkingLevelMap: Readonly<
      Record<string, string | null | undefined>
    > = model.thinkingLevelMap ?? {};
    const effort =
      reasoningEffort === "none"
        ? (model.thinkingLevelMap?.off ?? "none")
        : (thinkingLevelMap[reasoningEffort] ?? reasoningEffort);
    if (effort !== null) {
      const configuredSummary =
        options?.reasoningSummary ?? metadata?.default_reasoning_summary;
      const summary =
        metadata?.supports_reasoning_summary_parameter === false ||
        configuredSummary === "none" ||
        configuredSummary === "off" ||
        configuredSummary === null
          ? undefined
          : (configuredSummary ?? "auto");
      body.reasoning = {
        ...(lite ? { context: "all_turns" } : {}),
        effort,
        ...(summary === undefined ? {} : { summary }),
      };
    }
  }
  return { body, grammarToolInputProperties, responsesLite: lite };
};

const equalContinuationValue = (value: unknown) => {
  const serialized = JSON.stringify(
    value,
    (key: string, nested: unknown): unknown =>
      key === "internal_chat_message_metadata_passthrough" ? undefined : nested
  );
  return serialized === undefined
    ? undefined
    : canonicalJson(JSON.parse(serialized));
};

const stableRequestValue = (value: RequestBody) => {
  const ignored = new Set([
    "client_metadata",
    "input",
    "previous_response_id",
    "stream_options",
  ]);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !ignored.has(key))
  );
};

const continuationDelta = (
  body: RequestBody,
  continuation: ContinuationState
): ResponsesInputItem[] | undefined => {
  if (
    equalContinuationValue(stableRequestValue(body)) !==
    equalContinuationValue(stableRequestValue(continuation.request))
  ) {
    return undefined;
  }
  const baseline = [
    ...continuation.request.input,
    ...continuation.responseItems,
  ];
  if (body.input.length < baseline.length) {
    return undefined;
  }
  const prefix = body.input.slice(0, baseline.length);
  return equalContinuationValue(prefix) === equalContinuationValue(baseline)
    ? body.input.slice(baseline.length)
    : undefined;
};

const jsonWireValue = (value: unknown): unknown => {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : JSON.parse(serialized);
};

const requestShapeObservation = (body: RequestBody) => {
  const cacheEnabled =
    typeof body.prompt_cache_key === "string" &&
    body.prompt_cache_key.length > 0;
  try {
    return {
      cacheEnabled,
      cacheKeyHash:
        typeof body.prompt_cache_key === "string"
          ? sha256Canonical(body.prompt_cache_key)
          : undefined,
      inputItemHashes: body.input.map((item) =>
        sha256Canonical(jsonWireValue(item)).slice(0, 16)
      ),
      instructionsHash: sha256Canonical(body.instructions),
      stableRequestHash: sha256Canonical(
        jsonWireValue(stableRequestValue(body))
      ),
      toolsHash: sha256Canonical(jsonWireValue(body.tools ?? [])),
    };
  } catch {
    return { cacheEnabled, hashingFailed: true };
  }
};

class CodexProviderError extends Error {
  readonly body?: string;
  readonly code?: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly useCurrentModelFallback: boolean;

  constructor(
    message: string,
    code?: string,
    retryable = false,
    status?: number,
    body?: string,
    useCurrentModelFallback = false
  ) {
    super(message);
    this.name = "CodexProviderError";
    this.body = body;
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.useCurrentModelFallback = useCurrentModelFallback;
  }
}

// oxlint-disable-next-line eslint/max-classes-per-file -- private transport control signal
class WebSocketUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSocketUnavailableError";
  }
}

const RETRYABLE_WEBSOCKET_ERROR_CODES = new Set([
  "previous_response_not_found",
  "websocket_connection_limit_reached",
]);

const requestErrorObservation = (error: unknown) => ({
  code: error instanceof CodexProviderError ? error.code : undefined,
  name: error instanceof Error ? error.name : "ThrownValue",
  retryable: error instanceof CodexProviderError ? error.retryable : undefined,
  status: error instanceof CodexProviderError ? error.status : undefined,
});

export const isCodexCompactionCurrentModelFallbackError = (error: unknown) =>
  error instanceof CodexProviderError && error.useCurrentModelFallback;

const responseFailureClassification = (code: string | undefined) => {
  if (code === "context_length_exceeded") {
    return { retryable: false, useCurrentModelFallback: true };
  }
  if (
    code === "insufficient_quota" ||
    code === "usage_not_included" ||
    code === "cyber_policy"
  ) {
    return { retryable: false, useCurrentModelFallback: false };
  }
  if (code === "invalid_prompt" || code === "bio_policy") {
    return { retryable: false, useCurrentModelFallback: true };
  }
  if (code === "server_is_overloaded" || code === "slow_down") {
    return { retryable: false, useCurrentModelFallback: true };
  }
  return { retryable: true, useCurrentModelFallback: false };
};

const mapCodexEvent = (event: JsonRecord) => {
  if (event.type === "error") {
    const nested = isRecord(event.error) ? event.error : undefined;
    const status =
      typeof event.status === "number"
        ? event.status
        : typeof nested?.status === "number"
          ? nested.status
          : undefined;
    if (status !== undefined) {
      throw responseError(status, JSON.stringify({ error: nested ?? event }));
    }
    const code = [event.code, nested?.code, nested?.type].find(
      (value): value is string => typeof value === "string"
    );
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof nested?.message === "string"
          ? nested.message
          : code;
    const resolvedMessage = message ?? "Codex request failed";
    throw new CodexProviderError(
      resolvedMessage,
      code,
      RETRYABLE_WEBSOCKET_ERROR_CODES.has(code ?? "")
    );
  }
  if (event.type === "response.failed") {
    const response = isRecord(event.response) ? event.response : undefined;
    const error = isRecord(response?.error) ? response.error : undefined;
    const message =
      typeof error?.message === "string"
        ? error.message
        : "Codex response failed";
    const code = typeof error?.code === "string" ? error.code : undefined;
    const classification = responseFailureClassification(code);
    throw new CodexProviderError(
      message,
      code,
      classification.retryable,
      undefined,
      undefined,
      classification.useCurrentModelFallback
    );
  }
  if (event.type === "response.done" || event.type === "response.incomplete") {
    const response = isRecord(event.response)
      ? { ...event.response, status: event.response.status ?? "completed" }
      : event.response;
    return { ...event, response, type: "response.completed" };
  }
  return event;
};

const captureEvent = (capture: ResponseCapture, event: JsonRecord) => {
  if (event.type === "response.output_item.done" && isRecord(event.item)) {
    capture.outputItems.push(cloneJson(event.item));
  }
  if (
    event.type === "response.completed" ||
    event.type === "response.done" ||
    event.type === "response.incomplete"
  ) {
    capture.terminal = true;
    const response = isRecord(event.response) ? event.response : undefined;
    if (typeof response?.id === "string") {
      capture.responseId = response.id;
    }
    if (typeof response?.service_tier === "string") {
      capture.serviceTier = response.service_tier;
    }
    capture.completed =
      event.type !== "response.incomplete" && response?.status !== "incomplete";
    const rawUsage = isRecord(response?.usage) ? response.usage : undefined;
    if (rawUsage) {
      const details = isRecord(rawUsage.input_tokens_details)
        ? rawUsage.input_tokens_details
        : undefined;
      const cached =
        typeof details?.cached_tokens === "number" ? details.cached_tokens : 0;
      const cacheWrite =
        typeof details?.cache_write_tokens === "number"
          ? details.cache_write_tokens
          : 0;
      const input =
        typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : 0;
      capture.usage = {
        ...initialUsage(),
        cacheRead: cached,
        cacheWrite,
        input: Math.max(0, input - cached - cacheWrite),
        output:
          typeof rawUsage.output_tokens === "number"
            ? rawUsage.output_tokens
            : 0,
        totalTokens:
          typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : 0,
      };
    }
  }
};

const terminalTurnState = (event: JsonRecord): string | undefined => {
  if (event.type !== "response.metadata" || !isRecord(event.headers)) {
    return undefined;
  }
  for (const [name, value] of Object.entries(event.headers)) {
    if (
      name.toLowerCase() === "x-codex-turn-state" &&
      typeof value === "string" &&
      value.length > 0
    ) {
      return value;
    }
  }
  return undefined;
};

async function* parseSse(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<JsonRecord> {
  if (!response.body) {
    throw new Error("Codex response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => void reader.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (isAborted(signal)) {
        throw new Error("Request was aborted");
      }
      const result: unknown = await reader.read();
      if (
        !isRecord(result) ||
        typeof result.done !== "boolean" ||
        (result.value !== undefined && !(result.value instanceof Uint8Array))
      ) {
        throw new Error("Codex stream returned an invalid byte chunk");
      }
      const { done, value } = result;
      buffer += decoder.decode(value, { stream: !done });
      const normalized = buffer.replaceAll("\r\n", "\n");
      const chunks = normalized.split("\n\n");
      buffer = done ? "" : (chunks.pop() ?? "");
      for (const chunk of chunks) {
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim();
        if (data.length > 0 && data !== "[DONE]") {
          const parsed: unknown = JSON.parse(data);
          if (!isRecord(parsed)) {
            throw new Error("Codex stream event must be an object");
          }
          yield parsed;
        }
      }
      if (done) {
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {
      // Reader cancellation is best effort during cleanup.
    });
    reader.releaseLock();
  }
}

const retryDelay = (response: Response, attempt: number) => {
  const milliseconds = response.headers.get("retry-after-ms");
  if (milliseconds !== null && Number.isFinite(Number(milliseconds))) {
    return Math.max(0, Number(milliseconds));
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }
  return 1000 * 2 ** attempt;
};

const responseErrorClassification = (
  status: number,
  code: string | undefined,
  body: string
) => {
  if (status === 400) {
    const excludedFromModelFallback =
      code === "cyber_policy" ||
      body.includes(
        "The image data you provided does not represent a valid image"
      );
    return {
      retryable: false,
      useCurrentModelFallback: !excludedFromModelFallback,
    };
  }
  if (status === 429) {
    return {
      retryable:
        code !== "usage_limit_reached" && code !== "usage_not_included",
      useCurrentModelFallback: code !== "usage_not_included",
    };
  }
  if (
    status === 503 &&
    (code === "server_is_overloaded" || code === "slow_down")
  ) {
    return { retryable: false, useCurrentModelFallback: true };
  }
  return { retryable: true, useCurrentModelFallback: true };
};

const responseError = (status: number, text: string) => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const code =
        typeof parsed.error.code === "string"
          ? parsed.error.code
          : typeof parsed.error.type === "string"
            ? parsed.error.type
            : undefined;
      const classification = responseErrorClassification(status, code, text);
      return new CodexProviderError(
        typeof parsed.error.message === "string"
          ? parsed.error.message
          : `Codex request failed (${status})`,
        code,
        classification.retryable,
        status,
        text,
        classification.useCurrentModelFallback
      );
    }
  } catch {
    // Plain-text error bodies are valid.
  }
  const classification = responseErrorClassification(status, undefined, text);
  return new CodexProviderError(
    text.length > 0 ? text : `Codex request failed (${status})`,
    undefined,
    classification.retryable,
    status,
    text,
    classification.useCurrentModelFallback
  );
};

const compressBody = (body: string): Uint8Array | undefined => {
  try {
    const compressed = zstdCompressSync(body, {
      params: {
        [zlibConstants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_LEVEL,
      },
    });
    return new Uint8Array(
      compressed.buffer,
      compressed.byteOffset,
      compressed.byteLength
    );
  } catch {
    // Compression is optional.
  }
  return undefined;
};

const isWebSocketConstructor = (
  value: unknown
): value is WebSocketConstructor => typeof value === "function";

const closeSocket = (
  session: SessionRuntime,
  expected = session.socket?.value
) => {
  const cached = session.socket;
  if (!cached || cached.value !== expected) {
    return;
  }
  session.socket = undefined;
  session.continuation = undefined;
  clearTimeout(cached.idleTimer);
  try {
    cached.value.close(1000, "session reset");
  } catch {
    // Closing an already-closed socket is harmless.
  }
};

const connectSocket = async (
  url: string,
  headers: Headers,
  session: SessionRuntime,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
) => {
  const now = Date.now();
  const cached = session.socket;
  if (cached?.busy === true) {
    throw new WebSocketUnavailableError("WebSocket session is busy");
  }
  if (
    cached &&
    !cached.busy &&
    cached.value.readyState === 1 &&
    now - cached.createdAt < WEBSOCKET_MAX_AGE_MS
  ) {
    clearTimeout(cached.idleTimer);
    cached.busy = true;
    return cached.value;
  }
  if (cached) {
    closeSocket(session, cached.value);
  }
  const Constructor: unknown = globalThis.WebSocket;
  if (!isWebSocketConstructor(Constructor)) {
    throw new WebSocketUnavailableError("WebSocket transport is unavailable");
  }
  signal?.throwIfAborted();
  const socket = new Constructor(url, { headers: headersRecord(headers) });
  session.socket = { busy: true, createdAt: now, value: socket };
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("open", onOpen);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onAbort = () => {
      finish(new Error("Request was aborted"));
    };
    const onClose = () => {
      finish(new Error("WebSocket closed during connect"));
    };
    const onError = () => {
      finish(new Error("WebSocket connection failed"));
    };
    const onOpen = () => {
      finish();
    };
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    socket.addEventListener("open", onOpen);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    if (timeout > 0) {
      timer = setTimeout(() => {
        finish(new Error(`WebSocket connect timed out after ${timeout}ms`));
      }, timeout);
    }
    if (signal?.aborted === true) {
      onAbort();
    }
  }).catch((error: unknown) => {
    closeSocket(session, socket);
    throw error;
  });
  return socket;
};

const releaseSocket = (
  session: SessionRuntime,
  socket: WebSocketLike,
  keep: boolean
) => {
  const cached = session.socket;
  if (cached?.value !== socket) {
    return;
  }
  if (!keep) {
    closeSocket(session, socket);
    return;
  }
  cached.busy = false;
  cached.idleTimer = setTimeout(() => {
    closeSocket(session, socket);
  }, WEBSOCKET_IDLE_TTL_MS);
  cached.idleTimer.unref?.();
};

const messageData = async (event: unknown) => {
  const data = isRecord(event) ? event.data : undefined;
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
  }
  if (data instanceof Blob) {
    return await data.text();
  }
  throw new Error("Unsupported WebSocket message payload");
};

async function* parseWebSocket(
  socket: WebSocketLike,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number | undefined
): AsyncGenerator<JsonRecord> {
  const queue: (Error | JsonRecord)[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const enqueue = (value: Error | JsonRecord) => {
    queue.push(value);
    wake?.();
    wake = undefined;
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        enqueue(
          new Error(`WebSocket stream timed out after ${idleTimeoutMs}ms`)
        );
      }, idleTimeoutMs);
    }
  };
  const onAbort = () => {
    enqueue(new Error("Request was aborted"));
  };
  const onClose = () => {
    enqueue(new Error("WebSocket closed before completion"));
  };
  const onError = () => {
    enqueue(new Error("WebSocket error: stream failed"));
  };
  const onMessage = (event: unknown) => {
    void messageData(event)
      .then((data) => {
        const value: unknown = JSON.parse(data);
        if (!isRecord(value)) {
          throw new Error("Codex WebSocket event must be an object");
        }
        armIdle();
        enqueue(value);
      })
      .catch((error: unknown) => {
        enqueue(error instanceof Error ? error : new Error(String(error)));
      });
  };
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);
  socket.addEventListener("message", onMessage);
  signal?.addEventListener("abort", onAbort, { once: true });
  armIdle();
  try {
    while (!finished) {
      if (queue.length === 0) {
        const waiting = Promise.withResolvers<null>();
        wake = () => {
          waiting.resolve(null);
        };
        await waiting.promise;
      }
      const value = queue.shift();
      if (!value) {
        continue;
      }
      if (value instanceof Error) {
        throw value;
      }
      yield value;
      finished =
        value.type === "response.done" ||
        value.type === "response.completed" ||
        value.type === "response.incomplete";
    }
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onAbort);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("message", onMessage);
  }
}

const applyTurnHeaders = (
  headers: Headers,
  body: RequestBody,
  session: SessionRuntime
) => {
  const metadata = body.client_metadata?.["x-codex-turn-metadata"];
  if (typeof metadata === "string") {
    headers.set("x-codex-turn-metadata", metadata);
  }
  headers.set("x-codex-window-id", session.window.currentId);
  if (session.turn?.state !== undefined && session.turn.state.length > 0) {
    headers.set("x-codex-turn-state", session.turn.state);
  }
};

const sseEvents = async function* sseEvents(
  model: SupportedModel,
  body: RequestBody,
  options: OpenAICodexResponsesOptions | undefined,
  session: SessionRuntime,
  requestId: string,
  responsesLite = false,
  maxRetries = options?.maxRetries ?? 0,
  redirect: "error" | "follow" | "manual" = "follow"
) {
  const headers = buildBaseHeaders(model, options, requestId);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("openai-beta", "responses=experimental");
  if (responsesLite) {
    headers.set("x-openai-internal-codex-responses-lite", "true");
  }
  applyTurnHeaders(headers, body, session);
  const bodyJson = JSON.stringify(body);
  const compressed = compressBody(bodyJson);
  if (compressed !== undefined) {
    headers.set("content-encoding", "zstd");
  }
  const fetch = options?.fetch ?? globalThis.fetch;
  const timeoutMs = normalizeTimeout(options?.timeoutMs, "timeoutMs");
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let emitted = false;
    if (isAborted(options?.signal)) {
      throw new Error("Request was aborted");
    }
    try {
      const signals: AbortSignal[] = [];
      if (options?.signal !== undefined) {
        signals.push(options.signal);
      }
      const timeoutController = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        signals.push(timeoutController.signal);
        timeout = setTimeout(() => {
          timeoutController.abort();
        }, timeoutMs);
      }
      let response: Response;
      try {
        response = await fetch(resolveResponsesUrl(model.baseUrl), {
          body: compressed ?? bodyJson,
          headers,
          method: "POST",
          redirect,
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        if (timeoutController.signal.aborted && !isAborted(options?.signal)) {
          throw new Error(
            `Codex SSE response headers timed out after ${timeoutMs}ms`,
            { cause: error }
          );
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      await options?.onResponse?.(
        { headers: headersRecord(response.headers), status: response.status },
        model
      );
      const turnState = response.headers.get("x-codex-turn-state");
      if (
        turnState !== null &&
        turnState.length > 0 &&
        session.turn !== undefined &&
        session.turn.state === undefined
      ) {
        session.turn.state = turnState;
      }
      if (response.ok) {
        for await (const event of parseSse(response, options?.signal)) {
          emitted = true;
          yield event;
        }
        return;
      }
      const text = await response.text();
      const error = responseError(response.status, text);
      if (attempt === maxRetries || !error.retryable) {
        throw error;
      }
      const wait = retryDelay(response, attempt);
      const cap = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
      if (cap > 0 && wait > cap) {
        throw new Error(
          `Server requested ${Math.ceil(wait / 1000)}s retry delay (max: ${Math.ceil(cap / 1000)}s)`
        );
      }
      await delay(wait, undefined, { signal: options?.signal });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (
        attempt === maxRetries ||
        emitted ||
        isAborted(options?.signal) ||
        lastError instanceof CodexProviderError
      ) {
        throw lastError ?? new Error("Codex request failed");
      }
      await delay(1000 * 2 ** attempt, undefined, {
        signal: options?.signal,
      });
    }
  }
  throw lastError ?? new Error("Codex request failed");
};

const websocketEvents = async function* websocketEvents(
  model: SupportedModel,
  fullBody: RequestBody,
  options: OpenAICodexResponsesOptions | undefined,
  session: SessionRuntime,
  requestId: string,
  capture: ResponseCapture,
  trace: RequestTrace,
  responsesLite = false,
  generate = true
) {
  let retriedConnectionLimit = false;
  let retriedMissingContinuation = false;
  while (true) {
    const headers = buildBaseHeaders(model, options, requestId);
    headers.set("openai-beta", WEBSOCKET_BETA);
    if (responsesLite) {
      headers.set("x-openai-internal-codex-responses-lite", "true");
    }
    applyTurnHeaders(headers, fullBody, session);
    const previousSocket = session.socket;
    trace.transportUsed = "websocket";
    const socket = await connectSocket(
      resolveWebSocketUrl(model.baseUrl),
      headers,
      session,
      options?.signal,
      normalizeTimeout(
        options?.websocketConnectTimeoutMs,
        "websocketConnectTimeoutMs"
      )
    );
    if (session.socket) {
      trace.socketReused ||= previousSocket?.value === socket;
      trace.socketAgeMs = Date.now() - session.socket.createdAt;
    }
    const delta = session.continuation
      ? continuationDelta(fullBody, session.continuation)
      : undefined;
    trace.continuationMode = delta === undefined ? "full" : "delta";
    const requestBody =
      delta !== undefined && session.continuation !== undefined
        ? {
            ...fullBody,
            input: delta,
            previous_response_id: session.continuation.responseId,
          }
        : fullBody;
    if (delta === undefined) {
      session.continuation = undefined;
    }
    let emitted = false;
    try {
      socket.send(
        JSON.stringify({
          ...requestBody,
          client_metadata: {
            ...requestBody.client_metadata,
            ...(session.turn?.state !== undefined &&
            session.turn.state.length > 0
              ? { "x-codex-turn-state": session.turn.state }
              : {}),
            ...(responsesLite
              ? {
                  ws_request_header_x_openai_internal_codex_responses_lite:
                    "true",
                }
              : {}),
            "x-codex-ws-stream-request-start-ms": Date.now().toString(),
          },
          generate: generate ? undefined : false,
          type: "response.create",
        })
      );
      for await (const event of parseWebSocket(
        socket,
        options?.signal,
        normalizeTimeout(options?.timeoutMs, "timeoutMs")
      )) {
        mapCodexEvent(event);
        const turnState = terminalTurnState(event);
        if (
          turnState !== undefined &&
          session.turn !== undefined &&
          session.turn.state === undefined
        ) {
          session.turn.state = turnState;
        }
        emitted = true;
        captureEvent(capture, event);
        yield event;
      }
      session.continuation =
        capture.completed && capture.responseId !== undefined
          ? {
              request: cloneJson(fullBody),
              responseId: capture.responseId,
              responseItems: cloneJson(capture.outputItems),
            }
          : undefined;
      releaseSocket(session, socket, capture.completed);
      return;
    } catch (error) {
      const code = error instanceof CodexProviderError ? error.code : undefined;
      closeSocket(session, socket);
      if (
        !emitted &&
        code === "previous_response_not_found" &&
        !retriedMissingContinuation
      ) {
        retriedMissingContinuation = true;
        trace.missingContinuationRetries += 1;
        continue;
      }
      if (
        !emitted &&
        code === "websocket_connection_limit_reached" &&
        !retriedConnectionLimit
      ) {
        retriedConnectionLimit = true;
        trace.connectionLimitRetries += 1;
        continue;
      }
      throw error;
    }
  }
};

const createSession = (): SessionRuntime => ({
  fallbackToSse: false,
  transportFallbackPending: false,
  window: { currentId: uuidv7(), number: 0 },
});

const activateSseFallback = (session: SessionRuntime) => {
  session.transportFallbackPending = true;
  session.fallbackToSse = true;
};

function successfulOutput(
  output: AssistantMessage
): asserts output is AssistantMessage & {
  stopReason: "length" | "stop" | "toolUse";
} {
  if (
    output.stopReason === "pending" ||
    output.stopReason === "error" ||
    output.stopReason === "aborted"
  ) {
    throw new Error(
      output.errorMessage ?? "Codex stream ended without a successful response"
    );
  }
}

const serviceTierMultiplier = (
  modelId: string,
  tier: string | null | undefined
) => {
  if (tier === "flex") {
    return 0.5;
  }
  if (tier === "priority") {
    return modelId === "gpt-5.5" ? 2.5 : 2;
  }
  return 1;
};

const applyServiceTier = (
  usage: Usage,
  tier: string | null | undefined,
  model: SupportedModel
) => {
  const multiplier = serviceTierMultiplier(model.id, tier);
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input +
    usage.cost.output +
    usage.cost.cacheRead +
    usage.cost.cacheWrite;
};

export const createCodexProviderRuntime = (
  observability: CodexObservability,
  isFastModeEnabled: () => boolean = () => false
) => {
  const base = openaiCodexProvider();
  const fallback = [...base.getModels()];
  let models = fallback;
  let metadataByModel = new Map<string, CodexModelMetadata>();
  const sessions = new Map<string, SessionRuntime>();

  const supportsFastMode = (model: SupportedModel) => {
    const metadata = metadataByModel.get(model.id);
    return metadata === undefined
      ? FAST_MODE_FALLBACK_MODELS.has(model.id)
      : modelSupportsServiceTier(metadata, "priority");
  };

  const getSession = (sessionId: string) => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = createSession();
      sessions.set(sessionId, session);
    }
    return session;
  };

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
    const headers = buildBaseHeaders(authModel, { apiKey }, uuidv7());
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

  const normalEvents = async function* normalEvents(
    model: SupportedModel,
    body: RequestBody,
    options: OpenAICodexResponsesOptions | undefined,
    session: SessionRuntime,
    requestId: string,
    capture: ResponseCapture,
    trace: RequestTrace,
    responsesLite = false,
    redirect: "follow" | "manual" = "follow",
    fallbackAfterWebSocketFailure = true
  ) {
    const transport = options?.transport ?? "auto";
    if (transport !== "sse" && !session.fallbackToSse) {
      let emitted = false;
      try {
        for await (const event of websocketEvents(
          model,
          body,
          options,
          session,
          requestId,
          capture,
          trace,
          responsesLite
        )) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        if (
          !fallbackAfterWebSocketFailure ||
          emitted ||
          isAborted(options?.signal) ||
          error instanceof CodexProviderError
        ) {
          throw error;
        }
        activateSseFallback(session);
        trace.fellBackToSse = true;
      }
    }
    session.continuation = undefined;
    trace.transportUsed = "sse";
    trace.continuationMode = "full";
    for await (const event of sseEvents(
      model,
      body,
      options,
      session,
      requestId,
      responsesLite,
      options?.maxRetries ?? 0,
      redirect
    )) {
      captureEvent(capture, event);
      yield event;
    }
  };

  const compact = async (
    request: CodexCompactionRequest
  ): Promise<CodexCompactionResult> => {
    const standalone = request.phase === "standalone";
    const runtimeSessionId = standalone
      ? `${request.sessionId}:compaction:${uuidv7()}`
      : request.sessionId;
    const session = standalone ? createSession() : getSession(runtimeSessionId);
    session.turn ??= {
      id: uuidv7(),
      prewarmed: true,
      startedAt: Date.now(),
    };
    const options: OpenAICodexResponsesOptions = {
      apiKey: request.apiKey,
      env: request.env,
      headers: request.headers,
      maxRetries: 0,
      reasoningEffort: request.thinkingLevel,
      serviceTier:
        isFastModeEnabled() && supportsFastMode(request.model)
          ? "priority"
          : undefined,
      sessionId: runtimeSessionId,
      signal: request.signal,
      transport: session.activeTransport ?? "auto",
    };
    const startedAt = Date.now();
    const trace = createRequestTrace();
    let attempts = 0;
    let compactionError: unknown;
    let compactionResult: CodexCompactionResult | undefined;
    let observedBody: RequestBody | undefined;
    try {
      const built = buildRequestBody(
        request.model,
        request.context,
        options,
        metadataByModel.get(request.model.id),
        runtimeSessionId,
        session
      );
      const envelope = request.authoritativeEnvelope
        ? cloneJson(request.authoritativeEnvelope)
        : built.body;
      let envelopeInput = built.body.input;
      if (envelope.input !== undefined) {
        if (!Array.isArray(envelope.input) || !envelope.input.every(isRecord)) {
          throw new Error("Authoritative Codex input is malformed");
        }
        envelopeInput = envelope.input;
      }
      const source = [
        ...request.inputPrefix,
        ...(request.authoritativeInput ?? envelopeInput),
      ];
      if (source.some((item) => item.type === "compaction_trigger")) {
        throw new Error("Compaction source already contains a trigger");
      }
      const instructions =
        typeof envelope.instructions === "string"
          ? envelope.instructions
          : (request.context.systemPrompt ?? "");
      const normalized = normalizeToolHistory(
        omitUnsupportedUserImages(source, request.model.input.includes("image"))
      );
      const effectiveInput = shrinkTrailingOutputs(
        normalized,
        instructions,
        request.effectiveTokenLimit
      );
      const estimatedSourceTokens = estimateModelVisibleTokens(
        instructions,
        effectiveInput
      );
      const body: RequestBody = {
        ...built.body,
        ...envelope,
        client_metadata: {
          ...(isRecord(envelope.client_metadata)
            ? envelope.client_metadata
            : {}),
          ...requestMetadata(
            runtimeSessionId,
            session,
            "compaction",
            compactionMetadata(request)
          ),
        },
        input: [...effectiveInput, { type: "compaction_trigger" }],
        model: request.model.id,
        previous_response_id: undefined,
        store: false,
        stream: true,
      };
      if (
        request.codexReason !== undefined &&
        body.service_tier === "priority" &&
        !supportsFastMode(request.model)
      ) {
        delete body.service_tier;
      }
      observedBody = body;
      const configuredWebsocketTransport =
        options.transport === "sse" ? undefined : (options.transport ?? "auto");
      const websocketAttempts =
        configuredWebsocketTransport === undefined || session.fallbackToSse
          ? 0
          : 3;
      const maxAttempts = websocketAttempts + 3;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        attempts += 1;
        const capture: ResponseCapture = {
          completed: false,
          outputItems: [],
          terminal: false,
        };
        const compactions: CanonicalCompactionItem[] = [];
        try {
          for await (const event of normalEvents(
            request.model,
            body,
            options,
            session,
            uuidv7(),
            capture,
            trace,
            built.responsesLite,
            "manual",
            false
          )) {
            mapCodexEvent(event);
            if (
              event.type === "response.output_item.done" &&
              isRecord(event.item) &&
              (event.item.type === "compaction" ||
                event.item.type === "compaction_summary")
            ) {
              compactions.push(
                parseCompactionItem(event.item, {
                  allowAlias: true,
                  allowResponseMetadata: true,
                })
              );
            }
          }
          if (!capture.completed) {
            throw new CodexProviderError(
              "Codex compaction stream ended before completion",
              "response_stream_failed",
              true
            );
          }
          if (
            capture.responseId === undefined ||
            capture.usage === undefined ||
            compactions.length !== 1
          ) {
            throw new CodexProviderError(
              "Codex compaction returned an invalid response"
            );
          }
          calculateCost(request.model, capture.usage);
          applyServiceTier(
            capture.usage,
            capture.serviceTier === "default"
              ? body.service_tier
              : (capture.serviceTier ?? body.service_tier),
            request.model
          );
          compactionResult = {
            compaction: compactions[0],
            estimatedSourceTokens,
            responseId: capture.responseId,
            usage: capture.usage,
          };
          return compactionResult;
        } catch (error) {
          if (
            request.signal.aborted ||
            (error instanceof CodexProviderError && !error.retryable)
          ) {
            throw error;
          }
          if (
            configuredWebsocketTransport !== undefined &&
            attempt < websocketAttempts &&
            error instanceof WebSocketUnavailableError
          ) {
            activateSseFallback(session);
            trace.fellBackToSse = true;
            attempt = websocketAttempts - 1;
            continue;
          }
          if (
            configuredWebsocketTransport !== undefined &&
            attempt + 1 === websocketAttempts
          ) {
            activateSseFallback(session);
            trace.fellBackToSse = true;
            continue;
          }
          if (attempt === maxAttempts - 1) {
            throw error;
          }
          const transportAttempt =
            attempt < websocketAttempts ? attempt : attempt - websocketAttempts;
          await delay(transportAttempt === 0 ? 500 : 1000, undefined, {
            signal: request.signal,
          });
        }
      }
      throw new Error("Compaction retry loop ended unexpectedly");
    } catch (error) {
      compactionError = error;
      throw error;
    } finally {
      observability.record(request.sessionId, "compaction", {
        attempts,
        durationMs: Date.now() - startedAt,
        error:
          compactionError === undefined
            ? undefined
            : requestErrorObservation(compactionError),
        model: request.model.id,
        outcome:
          compactionResult === undefined
            ? request.signal.aborted
              ? "aborted"
              : "error"
            : "success",
        phase: request.phase,
        reason: request.reason,
        request:
          observedBody === undefined
            ? undefined
            : requestShapeObservation(observedBody),
        response:
          compactionResult === undefined
            ? undefined
            : {
                cacheReadTokens: compactionResult.usage.cacheRead,
                cacheWriteTokens: compactionResult.usage.cacheWrite,
                id: compactionResult.responseId,
                inputTokens: compactionResult.usage.input,
                outputTokens: compactionResult.usage.output,
                totalTokens: compactionResult.usage.totalTokens,
              },
        transport: {
          configured: options.transport ?? "auto",
          ...trace,
        },
      });
      if (standalone) {
        closeSocket(session);
      }
    }
  };

  const prewarm = async (
    model: SupportedModel,
    body: RequestBody,
    options: OpenAICodexResponsesOptions | undefined,
    session: SessionRuntime,
    requestId: string,
    sessionId: string,
    responsesLite: boolean,
    prewarmInput: readonly ResponsesInputItem[] | undefined,
    trace: RequestTrace
  ) => {
    if (
      options?.transport === "sse" ||
      session.fallbackToSse ||
      session.socket ||
      session.turn?.prewarmed === true ||
      prewarmInput === undefined
    ) {
      return;
    }
    trace.prewarmAttempted = true;
    if (session.turn) {
      session.turn.prewarmed = true;
    }
    const capture: ResponseCapture = {
      completed: false,
      outputItems: [],
      terminal: false,
    };
    try {
      for await (const _event of websocketEvents(
        model,
        {
          ...body,
          client_metadata: {
            ...body.client_metadata,
            ...requestMetadata(sessionId, session, "prewarm"),
          },
          input: [...prewarmInput],
        },
        options,
        session,
        requestId,
        capture,
        createRequestTrace(),
        responsesLite,
        false
      )) {
        // Prewarm output is intentionally discarded.
      }
      trace.prewarmSucceeded = capture.completed;
      session.continuation = undefined;
    } catch {
      // websocketEvents owns cleanup for the socket it acquired.
    }
  };

  const stream: StreamFunction<
    "openai-codex-responses",
    OpenAICodexResponsesOptions
  > = (model, context, options) => {
    const events = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      api: "openai-codex-responses",
      content: [],
      model: model.id,
      provider: model.provider,
      role: "assistant",
      stopReason: "pending",
      timestamp: Date.now(),
      usage: initialUsage(),
    };
    const sessionId =
      options?.sessionId !== undefined && options.sessionId.length > 0
        ? options.sessionId
        : uuidv7();
    const startedAt = Date.now();
    const trace = createRequestTrace();
    let observedBody: RequestBody | undefined;
    let observedError: unknown;
    void (async () => {
      try {
        if (options?.apiKey === undefined || options.apiKey.length === 0) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const session = getSession(sessionId);
        const built = buildRequestBody(
          model,
          context,
          options,
          metadataByModel.get(model.id),
          sessionId,
          session
        );
        let litePrefixLength = 0;
        if (built.responsesLite) {
          if (built.body.input[0]?.type === "additional_tools") {
            litePrefixLength += 1;
          }
          if (
            context.systemPrompt !== undefined &&
            context.systemPrompt.length > 0 &&
            built.body.input[litePrefixLength]?.type === "message" &&
            built.body.input[litePrefixLength]?.role === "developer"
          ) {
            litePrefixLength += 1;
          }
        }
        const prewarmInput = built.responsesLite
          ? built.body.input.slice(0, litePrefixLength)
          : [];
        let { body } = built;
        if (isFastModeEnabled() && supportsFastMode(model)) {
          body.service_tier = "priority";
        }
        const originalBodyJson = JSON.stringify(body);
        const previousTransport = session.activeTransport;
        session.activeTransport = session.fallbackToSse
          ? "sse"
          : (options.transport ?? "auto");
        let transformed: unknown;
        try {
          transformed = await options.onPayload?.(body, model);
        } finally {
          session.activeTransport = previousTransport;
        }
        if (transformed !== undefined) {
          if (
            !isRecord(transformed) ||
            !Array.isArray(transformed.input) ||
            !transformed.input.every(isRecord)
          ) {
            throw new Error(
              "Codex payload transform returned an invalid request"
            );
          }
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated Responses replacement payload boundary
          body = transformed as RequestBody;
        }
        observedBody = body;
        const requestId = promptCacheKey(sessionId);
        const prewarmCompatible =
          transformed === undefined ||
          JSON.stringify(body) === originalBodyJson;
        await prewarm(
          model,
          body,
          options,
          session,
          requestId,
          sessionId,
          built.responsesLite,
          prewarmCompatible ? prewarmInput : undefined,
          trace
        );
        const capture: ResponseCapture = {
          completed: false,
          outputItems: [],
          terminal: false,
        };
        let started = false;
        const source = async function* source() {
          for await (const event of normalEvents(
            model,
            body,
            options,
            session,
            requestId,
            capture,
            trace,
            built.responsesLite
          )) {
            if (!started) {
              started = true;
              events.push({ partial: output, type: "start" });
            }
            // Pi's public processor does not export its event union.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated Responses wire event boundary
            yield mapCodexEvent(event) as never;
          }
        };
        await processResponsesStream(source(), output, events, model, {
          applyServiceTierPricing: (usage, tier) => {
            applyServiceTier(usage, tier, model);
          },
          grammarToolInputProperties: built.grammarToolInputProperties,
          resolveServiceTier: (responseTier, requestTier) =>
            responseTier === "default"
              ? requestTier
              : (responseTier ?? requestTier),
          serviceTier: body.service_tier,
        });
        if (!capture.terminal) {
          throw new Error("Codex stream ended before completion");
        }
        successfulOutput(output);
        events.push({
          message: output,
          reason: output.stopReason,
          type: "done",
        });
        events.end();
      } catch (error) {
        observedError = error;
        for (const block of output.content) {
          if (isRecord(block)) {
            delete block.customInput;
            delete block.partialJson;
          }
        }
        output.stopReason = isAborted(options?.signal) ? "aborted" : "error";
        output.errorMessage =
          error instanceof Error ? error.message : String(error);
        events.push({
          error: output,
          reason: output.stopReason,
          type: "error",
        });
        events.end();
      } finally {
        observability.record(sessionId, "request", {
          durationMs: Date.now() - startedAt,
          error:
            observedError === undefined
              ? undefined
              : requestErrorObservation(observedError),
          model: model.id,
          outcome: output.stopReason,
          reasoning: options?.reasoningEffort,
          request:
            observedBody === undefined
              ? undefined
              : requestShapeObservation(observedBody),
          response: {
            cacheReadTokens: output.usage.cacheRead,
            cacheWriteTokens: output.usage.cacheWrite,
            id: output.responseId,
            inputTokens: output.usage.input,
            outputTokens: output.usage.output,
            reasoningTokens: output.usage.reasoning,
            totalTokens: output.usage.totalTokens,
          },
          serviceTier: observedBody?.service_tier,
          transport: {
            configured: options?.transport ?? "auto",
            ...trace,
          },
          turnId: observedBody?.client_metadata?.turn_id,
          windowId: observedBody?.client_metadata?.["x-codex-window-id"],
        });
      }
    })();
    return events;
  };

  const streamSimple: Provider<"openai-codex-responses">["streamSimple"] = (
    model,
    context,
    options
  ) => {
    const baseOptions = buildBaseOptions(
      model,
      context,
      options,
      options?.apiKey
    );
    const level =
      options?.reasoning !== undefined && options.reasoning.length > 0
        ? clampThinkingLevel(model, options.reasoning)
        : undefined;
    return stream(model, context, {
      ...baseOptions,
      reasoningEffort: level === "off" ? undefined : level,
    });
  };

  const closeSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      closeSocket(session);
      sessions.delete(sessionId);
    }
  };

  const streamPortableSummary: typeof streamSimple = (
    model,
    context,
    options
  ) => {
    const sessionId = `portable-summary:${uuidv7()}`;
    const events = streamSimple(model, context, { ...options, sessionId });
    void events.result().then(
      () => {
        closeSession(sessionId);
      },
      () => {
        closeSession(sessionId);
      }
    );
    return events;
  };

  const filterModels = base.filterModels?.bind(base);
  const provider: Provider<"openai-codex-responses"> = {
    ...base,
    auth: {
      ...base.auth,
      apiKey: {
        name: "OpenAI Codex access token",
        resolve: async ({ credential }) =>
          credential === undefined
            ? undefined
            : {
                auth: { apiKey: credential.key },
                env: credential.env,
                source: "stored credential",
              },
      },
    },
    ...(filterModels === undefined
      ? {}
      : {
          filterModels: (values, credential) =>
            filterModels(values, credential),
        }),
    getModels: () => models,
    refreshModels,
    stream,
    streamSimple,
  };

  return {
    beginTurn(sessionId: string) {
      const session = getSession(sessionId);
      session.turn = { id: uuidv7(), prewarmed: false, startedAt: Date.now() };
    },
    closeSession,
    compact,
    consumeTransportFallback(sessionId: string) {
      const session = sessions.get(sessionId);
      const pending = session?.transportFallbackPending ?? false;
      if (session) {
        session.transportFallbackPending = false;
      }
      return pending;
    },
    endTurn(sessionId: string) {
      const session = sessions.get(sessionId);
      if (session) {
        session.turn = undefined;
      }
    },
    getModelMetadata(modelId: string) {
      return metadataByModel.get(modelId);
    },
    getModelWindow(model: SupportedModel) {
      return modelWindow(model, metadataByModel.get(model.id));
    },
    getWindow(sessionId: string) {
      return { ...getSession(sessionId).window };
    },
    installWindow(
      sessionId: string,
      window: {
        readonly currentWindowId: string;
        readonly previousWindowId: string | null;
        readonly windowNumber: number;
      }
    ) {
      const session = getSession(sessionId);
      if (
        session.window.currentId === window.currentWindowId &&
        session.window.number === window.windowNumber &&
        (session.window.previousId ?? null) === window.previousWindowId
      ) {
        return { ...session.window };
      }
      session.window = {
        currentId: window.currentWindowId,
        number: window.windowNumber,
        ...(window.previousWindowId !== null &&
        window.previousWindowId.length > 0
          ? { previousId: window.previousWindowId }
          : {}),
      };
      session.continuation = undefined;
      return { ...session.window };
    },
    provider,
    streamPortableSummary,
    supportsFastMode,
  };
};

export type CodexProviderRuntime = ReturnType<
  typeof createCodexProviderRuntime
>;
