import { AsyncLocalStorage } from "node:async_hooks";
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
  Model,
  OpenAICodexResponsesOptions,
  Provider,
  ProviderEnv,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamFunction,
  Tool,
  Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { createGrammarToolInputProperties } from "#pi-constrained-sampling";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "#pi-responses";
import { buildBaseOptions } from "#pi-simple-options";

import {
  canonicalJson,
  parseCompactionItem,
  REMOTE_USER_IMAGE_PLACEHOLDER,
  sha256Canonical,
} from "./checkpoint.js";
import type { CanonicalCompactionItem } from "./checkpoint.js";
import {
  createCodexHeaders,
  createCodexModelCatalog,
  isCodexWireReasoningEffort,
  isSupportedCodexModelId,
  modelSupportsServiceTier,
  resolveCodexResponsesUrl,
} from "./model-catalog.js";
import type { CodexModelCatalog, CodexModelMetadata } from "./model-catalog.js";
import type { CodexObservability } from "./observability.js";
import {
  estimateModelVisibleTokens,
  normalizeToolHistory,
  omitUnsupportedUserImages,
  ResponsesInputItemSchema,
  shrinkTrailingOutputs,
} from "./replay.js";
import type { ResponsesInputItem } from "./replay.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const PREMATURE_RESPONSE_STREAM_ERROR =
  "OpenAI Responses stream ended before a terminal response event";
const REQUEST_COMPRESSION_LEVEL = 3;
const WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const WEBSOCKET_IDLE_TTL_MS = 5 * 60_000;
const WEBSOCKET_MAX_AGE_MS = 55 * 60_000;
export const ALLOWED_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

type SupportedModel = Model<"openai-codex-responses">;
const WireValueSchema = Type.Unknown();
type WireValue = Static<typeof WireValueSchema>;
const JsonRecordSchema = Type.Record(Type.String(), Type.Unknown());
type JsonRecord = Static<typeof JsonRecordSchema>;
const isTerminalResponseEvent = (event: JsonRecord) =>
  event.type === "response.done" ||
  event.type === "response.completed" ||
  event.type === "response.incomplete";
const TransformedRequestBodySchema = Type.Intersect([
  JsonRecordSchema,
  Type.Object({ input: Type.Array(JsonRecordSchema) }),
]);
type TransformedRequestBody = Static<typeof TransformedRequestBodySchema>;
const StringValueSchema = Type.String();
const NumberValueSchema = Type.Number();
const ResponseStreamEventEnvelopeSchema = Type.Intersect([
  JsonRecordSchema,
  Type.Object({ type: StringValueSchema }),
]);
type PiResponseStreamEvent =
  Parameters<typeof processResponsesStream>[0] extends AsyncIterable<infer Event> ? Event : never;
const ServiceTierSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("default"),
  Type.Literal("flex"),
  Type.Literal("scale"),
  Type.Literal("priority"),
  Type.Null(),
]);
const LiteImageSchema = Type.Object({ type: Type.Literal("input_image") });
const RemoteLiteImageSchema = Type.Object({
  image_url: Type.String({ pattern: /^https?:\/\//iu }),
  type: Type.Literal("input_image"),
});
const EndTurnResponseSchema = Type.Object({ end_turn: Type.Boolean() });
const WebSocketMessageSchema = Type.Object({ data: Type.Unknown() });
const ReasoningTextSchema = Type.Object({
  text: Type.String(),
  type: Type.Literal("reasoning_text"),
});
const SummaryTextSchema = Type.Object({
  text: Type.String(),
  type: Type.Literal("summary_text"),
});
const OutputTextSchema = Type.Object({
  text: Type.String(),
  type: Type.Literal("output_text"),
});
const ContinuationOutputItemSchema = Type.Union([
  Type.Object({
    content: Type.Optional(Type.Array(ReasoningTextSchema)),
    id: Type.String(),
    status: Type.Optional(Type.Literal("completed")),
    summary: Type.Array(SummaryTextSchema),
    type: Type.Literal("reasoning"),
  }),
  Type.Object({
    content: Type.Array(OutputTextSchema, { maxItems: 1, minItems: 1 }),
    id: Type.String(),
    phase: Type.Optional(
      Type.Union([Type.Literal("commentary"), Type.Literal("final_answer"), Type.Null()]),
    ),
    role: Type.Literal("assistant"),
    status: Type.Optional(Type.Literal("completed")),
    type: Type.Literal("message"),
  }),
  Type.Object({
    arguments: Type.String(),
    call_id: Type.String(),
    id: Type.String(),
    name: Type.String(),
    namespace: Type.Optional(Type.String()),
    status: Type.Optional(Type.Literal("completed")),
    type: Type.Literal("function_call"),
  }),
  Type.Object({
    call_id: Type.String(),
    id: Type.String(),
    input: Type.String(),
    name: Type.String(),
    namespace: Type.Optional(Type.String()),
    status: Type.Optional(Type.Literal("completed")),
    type: Type.Literal("custom_tool_call"),
  }),
]);

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
  temperature?: number;
  text?: JsonRecord;
  tool_choice: "auto" | "none" | "required";
  tools?: JsonRecord[];
}

type OutboundRequestBody = RequestBody | TransformedRequestBody;

interface ResponseCapture {
  completed: boolean;
  continuationBlocked?: boolean;
  outputItems: ResponsesInputItem[];
  responseId?: string;
  serviceTier?: string;
  socket?: WebSocketLike;
  terminalOutput?: WireValue[];
  usage?: Usage;
}

interface ContinuationState {
  readonly request: OutboundRequestBody;
  readonly responseId: string;
  readonly responseItems: readonly ResponsesInputItem[];
}

const WebSocketEventTypeSchema = Type.Union([
  Type.Literal("close"),
  Type.Literal("error"),
  Type.Literal("message"),
  Type.Literal("open"),
]);
const WebSocketListenerSchema = Type.Function([Type.Unknown()], Type.Void());
const WebSocketLikeSchema = Type.Object({
  addEventListener: Type.Function([WebSocketEventTypeSchema, WebSocketListenerSchema], Type.Void()),
  close: Type.Function([Type.Optional(Type.Number()), Type.Optional(Type.String())], Type.Void()),
  readyState: Type.Optional(Type.Number()),
  removeEventListener: Type.Function(
    [WebSocketEventTypeSchema, WebSocketListenerSchema],
    Type.Void(),
  ),
  send: Type.Function([Type.String()], Type.Void()),
});
type WebSocketLike = Static<typeof WebSocketLikeSchema>;
const WebSocketConstructorSchema = Type.Function([Type.String(), Type.Unknown()], Type.Unknown());

interface SessionRuntime {
  continuation?: ContinuationState;
  fallbackToSse: boolean;
  socket?: {
    busy: boolean;
    createdAt: number;
    identity: string;
    idleTimer?: ReturnType<typeof setTimeout>;
    value: WebSocketLike;
  };
  turn?: {
    fastModeEnabled: boolean;
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

type InferenceAttemptFailureClass =
  | "abort"
  | "authentication"
  | "http_retryable"
  | "http_terminal"
  | "none"
  | "protocol_connection_limit"
  | "protocol_missing_continuation"
  | "protocol_terminal"
  | "transport_dispatch"
  | "transport_stream";

type InferenceAttemptDecision =
  | "aborted"
  | "completed"
  | "fail_closed"
  | "fallback_to_sse"
  | "pending"
  | "replay_budget_exhausted"
  | "retry_sse"
  | "retry_websocket"
  | "surfaced";

interface InferenceAttemptObservation {
  readonly continuationMode: "delta" | "full";
  failureClass: InferenceAttemptFailureClass;
  finalDecision: InferenceAttemptDecision;
  readonly ordinal: number;
  responseCreated: "absent" | "committed" | "discarded";
  readonly transport: "sse" | "websocket";
}

interface RequestTrace {
  connectionLimitRetries: number;
  continuationMode?: "delta" | "full";
  missingContinuationRetries: number;
  prewarmAttempts: number;
  prewarmDispatches: number;
  prewarmSucceeded: boolean;
  sseFallbackActivated: boolean;
  socketAgeMs?: number;
  socketReused: boolean;
  transportUsed?: "sse" | "websocket";
  websocketHandshakeAttempts: number;
  websocketHandshakeFailures: number;
}

interface InferenceRecovery {
  readonly attempts: InferenceAttemptObservation[];
  readonly budget: 0 | 1;
  dispatches: number;
}

const createRequestTrace = (): RequestTrace => ({
  connectionLimitRetries: 0,
  missingContinuationRetries: 0,
  prewarmAttempts: 0,
  prewarmDispatches: 0,
  prewarmSucceeded: false,
  sseFallbackActivated: false,
  socketReused: false,
  websocketHandshakeAttempts: 0,
  websocketHandshakeFailures: 0,
});

const createInferenceRecovery = (
  options: OpenAICodexResponsesOptions | undefined,
): InferenceRecovery => ({
  attempts: [],
  budget: (options?.maxRetries ?? 0) > 0 ? 1 : 0,
  dispatches: 0,
});

const hasInferenceDispatchCapacity = (recovery: InferenceRecovery | undefined) =>
  recovery === undefined || recovery.dispatches <= recovery.budget;

const dispatchInference = <T>(recovery: InferenceRecovery | undefined, dispatch: () => T): T => {
  if (!hasInferenceDispatchCapacity(recovery)) {
    throw new Error("Codex inference replay budget exhausted");
  }
  const result = dispatch();
  if (recovery !== undefined) {
    recovery.dispatches += 1;
  }
  return result;
};

const beginInferenceAttempt = (
  recovery: InferenceRecovery | undefined,
  transport: "sse" | "websocket",
  continuationMode: "delta" | "full",
): InferenceAttemptObservation | undefined => {
  if (recovery === undefined) {
    return undefined;
  }
  const attempt: InferenceAttemptObservation = {
    continuationMode,
    failureClass: "none",
    finalDecision: "pending",
    ordinal: recovery.attempts.length + 1,
    responseCreated: "absent",
    transport,
  };
  recovery.attempts.push(attempt);
  return attempt;
};

const classifyInferenceAttemptFailure = (
  error: Error,
  signal: AbortSignal | undefined,
  dispatchFailed = false,
): InferenceAttemptFailureClass => {
  if (isAborted(signal)) {
    return "abort";
  }
  if (dispatchFailed) {
    return "transport_dispatch";
  }
  if (error instanceof CodexProviderError) {
    if (error.status === 401) {
      return "authentication";
    }
    if (error.code === "previous_response_not_found") {
      return "protocol_missing_continuation";
    }
    if (error.code === "websocket_connection_limit_reached") {
      return "protocol_connection_limit";
    }
    if (error.status !== undefined) {
      return error.retryable ? "http_retryable" : "http_terminal";
    }
    return "protocol_terminal";
  }
  return "transport_stream";
};

const finishInferenceAttempt = (
  attempt: InferenceAttemptObservation | undefined,
  failureClass: InferenceAttemptFailureClass,
  finalDecision: InferenceAttemptDecision,
) => {
  if (attempt !== undefined) {
    attempt.failureClass = failureClass;
    attempt.finalDecision = finalDecision;
  }
};

export interface CodexCompactionRequest {
  readonly apiKey: string;
  readonly authoritativeEnvelope?: Readonly<JsonRecord>;
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

const isRecord = (value: WireValue): value is JsonRecord => Value.Check(JsonRecordSchema, value);

const validateRequestReasoningEffort = (body: JsonRecord): void => {
  const { reasoning } = body;
  if (reasoning === undefined) {
    return;
  }
  if (!isRecord(reasoning)) {
    throw new TypeError("Codex payload reasoning must be an object");
  }
  const { effort } = reasoning;
  if (effort !== undefined && !isCodexWireReasoningEffort(effort)) {
    throw new Error(`Unsupported Codex Responses reasoning effort: ${JSON.stringify(effort)}`);
  }
};

const isAborted = (signal: AbortSignal | undefined) => signal?.aborted ?? false;

const cloneJson = <T>(value: T): T => structuredClone(value);

const prepareLiteContent = (content: WireValue): WireValue => {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((item: WireValue) => {
    if (!Value.Check(LiteImageSchema, item)) {
      return item;
    }
    if (Value.Check(RemoteLiteImageSchema, item)) {
      return {
        text: REMOTE_USER_IMAGE_PLACEHOLDER,
        type: "input_text",
      };
    }
    const { detail: _detail, ...image } = Value.Parse(JsonRecordSchema, item);
    return image;
  });
};

const prepareLiteRequest = (body: RequestBody): RequestBody => ({
  ...body,
  input: body.input.map((item) => {
    if (
      "content" in item &&
      (item.type === "message" ||
        item.role === "user" ||
        item.role === "developer" ||
        item.role === "system")
    ) {
      return { ...item, content: prepareLiteContent(item.content) };
    }
    if (
      (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
      Array.isArray(item.output)
    ) {
      return { ...item, output: prepareLiteContent(item.output) };
    }
    return item;
  }),
});

const prepareLiteTransformedRequest = (body: TransformedRequestBody): TransformedRequestBody => ({
  ...body,
  input: body.input.map((item) => {
    if (
      "content" in item &&
      (item.type === "message" ||
        item.role === "user" ||
        item.role === "developer" ||
        item.role === "system")
    ) {
      return { ...item, content: prepareLiteContent(item.content) };
    }
    if (
      (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
      Array.isArray(item.output)
    ) {
      return { ...item, output: prepareLiteContent(item.output) };
    }
    return item;
  }),
});

// Codex truncates by Unicode scalar value, not grapheme cluster.
const promptCacheKey = (value: string) => Array.from(value).slice(0, 64).join("");

const normalizeTimeout = (value: number | undefined, name: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative finite number`);
  }
  return Math.floor(value);
};

const resolveWebSocketUrl = (baseUrl?: string) => {
  const url = new URL(resolveCodexResponsesUrl(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

const headersRecord = (headers: Headers) => Object.fromEntries(headers.entries());

const webSocketIdentity = (url: string, headers: Headers) => {
  const stableHeaders = new Headers(headers);
  for (const name of [
    "session-id",
    "x-client-request-id",
    "x-codex-turn-metadata",
    "x-codex-turn-state",
    "x-codex-window-id",
  ]) {
    stableHeaders.delete(name);
  }
  return sha256Canonical([url, ...stableHeaders.entries()]);
};

const buildBaseHeaders = (
  model: SupportedModel,
  options: OpenAICodexResponsesOptions | undefined,
  requestId: string,
) => {
  const apiKey = options?.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("OpenAI Codex authentication is unavailable");
  }
  return createCodexHeaders(model, apiKey, requestId, options?.headers);
};

const splitDeferredTools = (context: Context, enabled: boolean) => {
  const unique = new Map((context.tools ?? []).map((tool) => [tool.name, tool]));
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
  compaction?: Readonly<Record<string, string>>,
) => {
  const { turn } = session;
  if (!turn) {
    throw new Error("Codex turn is not initialized");
  }
  const canonical = JSON.stringify({
    compaction: compaction ? compaction : undefined,
    request_kind: kind,
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: turn.id,
    turn_started_at_unix_ms: turn.startedAt,
    window_id: session.window.currentId,
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
  reason: request.codexReason ?? (request.reason === "manual" ? "user_requested" : "context_limit"),
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
  kind: "prewarm" | "turn" = "turn",
) => {
  if (!isSupportedCodexModelId(model.id)) {
    throw new Error(`Codex provider supports only GPT-5.6 models: ${model.id}`);
  }
  const grammarToolInputProperties = createGrammarToolInputProperties(
    context.tools,
    model.compat?.supportsOpenAIGrammarTools ?? false,
  );
  const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
  const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
  const deferredToolsMode =
    model.compat?.supportsAdditionalTools === true
      ? "additional-tools"
      : model.compat?.supportsToolSearch === true
        ? "tool-search"
        : undefined;
  const placement = splitDeferredTools(context, deferredToolsMode !== undefined);
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
      deferredToolsMode,
      grammarToolInputProperties,
      includeSystemPrompt: false,
      toolOptions,
    },
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
    parallel_tool_calls: !lite && metadata?.supports_parallel_tool_calls !== false,
    prompt_cache_key: options?.cacheRetention === "none" ? undefined : promptCacheKey(sessionId),
    store: false,
    stream: true,
    text:
      metadata?.support_verbosity === false
        ? undefined
        : {
            verbosity: options?.textVerbosity ?? metadata?.default_verbosity ?? "low",
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
  const remoteDefaultReasoningEffort = metadata?.default_reasoning_level;
  const reasoningEffort =
    options?.reasoningEffort ??
    (isCodexWireReasoningEffort(remoteDefaultReasoningEffort)
      ? remoteDefaultReasoningEffort
      : undefined);
  if (reasoningEffort !== undefined && reasoningEffort.length > 0) {
    const thinkingLevelMap: Readonly<Record<string, string | null | undefined>> =
      model.thinkingLevelMap ?? {};
    const mappedEffort =
      reasoningEffort === "none"
        ? (model.thinkingLevelMap?.off ?? "none")
        : (thinkingLevelMap[reasoningEffort] ?? reasoningEffort);
    if (mappedEffort !== null) {
      const configuredSummary = options?.reasoningSummary ?? metadata?.default_reasoning_summary;
      const summary =
        metadata?.supports_reasoning_summary_parameter === false ||
        configuredSummary === "none" ||
        configuredSummary === "off" ||
        configuredSummary === null
          ? undefined
          : (configuredSummary ?? "auto");
      const reasoning: NonNullable<RequestBody["reasoning"]> = { effort: mappedEffort };
      if (lite) {
        reasoning.context = "all_turns";
      }
      if (summary !== undefined) {
        reasoning.summary = summary;
      }
      body.reasoning = reasoning;
    }
  }
  return { body, grammarToolInputProperties, responsesLite: lite };
};

const equalContinuationValue = (value: WireValue) => {
  const serialized = JSON.stringify(value, (key: string, nested: WireValue): WireValue =>
    key === "internal_chat_message_metadata_passthrough" ? undefined : nested,
  );
  return serialized === undefined ? undefined : canonicalJson(JSON.parse(serialized));
};

const parseLosslessJsonRecord = (value: string): JsonRecord | undefined => {
  let lossyNumber = false;
  let parsed: WireValue;
  try {
    parsed = JSON.parse(
      value,
      (_key: string, nested: WireValue, context?: { source?: string }): WireValue => {
        const number = Number(context?.source);
        if (
          Object.is(nested, number) &&
          (!Number.isFinite(number) ||
            (Number.isInteger(number) && !Number.isSafeInteger(number)) ||
            context?.source !== JSON.stringify(number))
        ) {
          lossyNumber = true;
        }
        return nested;
      },
    );
  } catch {
    return undefined;
  }
  return !lossyNumber && isRecord(parsed) ? parsed : undefined;
};

const normalizedContinuationOutputItem = (value: WireValue): ResponsesInputItem | undefined => {
  if (!Value.Check(ContinuationOutputItemSchema, value)) {
    return undefined;
  }
  if (value.type === "reasoning") {
    return cloneJson(Value.Parse(JsonRecordSchema, value));
  }
  if (value.type === "message") {
    const [content] = value.content;
    if (content === undefined) {
      return undefined;
    }
    return {
      content: [{ annotations: [], text: content.text, type: "output_text" }],
      id: value.id,
      phase: value.phase ?? undefined,
      role: "assistant",
      status: "completed",
      type: "message",
    };
  }
  if (value.type === "function_call") {
    const argumentsValue = parseLosslessJsonRecord(value.arguments);
    if (argumentsValue === undefined) {
      return undefined;
    }
    return {
      arguments: JSON.stringify(argumentsValue),
      call_id: value.call_id,
      id: value.id,
      name: value.name,
      namespace: value.namespace,
      type: "function_call",
    };
  }
  return {
    call_id: value.call_id,
    id: value.id,
    input: value.input,
    name: value.name,
    namespace: value.namespace,
    type: "custom_tool_call",
  };
};

const continuationOutputMatches = (
  outputItems: readonly WireValue[],
  responseItems: readonly ResponsesInputItem[],
  terminalOutput?: readonly WireValue[],
) => {
  const matchesProjection = (items: readonly WireValue[]) => {
    const normalized: ResponsesInputItem[] = [];
    for (const item of items) {
      const projected = normalizedContinuationOutputItem(item);
      if (projected === undefined) {
        return false;
      }
      normalized.push(projected);
    }
    return equalContinuationValue(normalized) === equalContinuationValue(responseItems);
  };
  if (terminalOutput === undefined) {
    return matchesProjection(outputItems);
  }
  const enrichedOutputItems = outputItems.map((item, index) => {
    const terminalItem = terminalOutput[index];
    if (
      isRecord(item) &&
      item.type === "reasoning" &&
      isRecord(terminalItem) &&
      terminalItem.type === "reasoning" &&
      item.id === terminalItem.id &&
      (!Value.Check(StringValueSchema, item.encrypted_content) ||
        item.encrypted_content.length === 0) &&
      Value.Check(StringValueSchema, terminalItem.encrypted_content) &&
      terminalItem.encrypted_content.length > 0
    ) {
      return { ...item, encrypted_content: terminalItem.encrypted_content };
    }
    return item;
  });
  return matchesProjection(enrichedOutputItems) && matchesProjection(terminalOutput);
};

const stableRequestValue = (value: JsonRecord) => {
  const ignored = new Set(["client_metadata", "input", "previous_response_id", "stream_options"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !ignored.has(key)));
};

const continuationDelta = (
  body: OutboundRequestBody,
  continuation: ContinuationState,
): WireValue[] | undefined => {
  if (
    equalContinuationValue(stableRequestValue(body)) !==
    equalContinuationValue(stableRequestValue(continuation.request))
  ) {
    return undefined;
  }
  const baseline = [...continuation.request.input, ...continuation.responseItems];
  if (body.input.length < baseline.length) {
    return undefined;
  }
  const prefix = body.input.slice(0, baseline.length);
  return equalContinuationValue(prefix) === equalContinuationValue(baseline)
    ? body.input.slice(baseline.length)
    : undefined;
};

const jsonWireValue = (value: WireValue): WireValue => {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : JSON.parse(serialized);
};

const requestObservation = (body: JsonRecord) => {
  const cacheKey = Value.Check(StringValueSchema, body.prompt_cache_key)
    ? body.prompt_cache_key
    : undefined;
  const cacheEnabled = cacheKey !== undefined && cacheKey.length > 0;
  try {
    if (!Array.isArray(body.input)) {
      throw new Error("Codex request input is not an array");
    }
    return {
      cacheEnabled,
      cacheKeyHash: cacheKey !== undefined ? sha256Canonical(cacheKey) : undefined,
      inputItemHashes: body.input.map((item) => sha256Canonical(jsonWireValue(item)).slice(0, 16)),
      instructionsHash: sha256Canonical(body.instructions),
      stableRequestHash: sha256Canonical(jsonWireValue(stableRequestValue(body))),
      toolsHash: sha256Canonical(jsonWireValue(body.tools ?? [])),
    };
  } catch {
    return { cacheEnabled, hashingFailed: true };
  }
};

const requestServiceTier = (body: JsonRecord) =>
  Value.Check(ServiceTierSchema, body.service_tier) ? body.service_tier : undefined;

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
    useCurrentModelFallback = false,
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
const TERMINAL_QUOTA_ERROR_CODES = new Set([
  "credit_balance_exhausted",
  "insufficient_quota",
  "organization_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "project_spend_limit_exceeded",
  "usage_not_included",
]);

const requestErrorObservation = (cause: unknown) => ({
  code: cause instanceof CodexProviderError ? cause.code : undefined,
  name: cause instanceof Error ? cause.name : "ThrownValue",
  retryable: cause instanceof CodexProviderError ? cause.retryable : undefined,
  status: cause instanceof CodexProviderError ? cause.status : undefined,
});

export const isCodexCompactionCurrentModelFallbackError = (cause: unknown) =>
  cause instanceof CodexProviderError && cause.useCurrentModelFallback;

const responseFailureClassification = (code: string | undefined) => {
  if (code === "context_length_exceeded") {
    return { retryable: false, useCurrentModelFallback: true };
  }
  if (TERMINAL_QUOTA_ERROR_CODES.has(code ?? "") || code === "cyber_policy") {
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

const mapCodexEvent = (event: JsonRecord, output?: AssistantMessage) => {
  if (
    output !== undefined &&
    isTerminalResponseEvent(event) &&
    Value.Check(EndTurnResponseSchema, event.response)
  ) {
    output.endTurn = Value.Parse(EndTurnResponseSchema, event.response).end_turn;
  }
  if (event.type === "error") {
    const nested = isRecord(event.error) ? event.error : undefined;
    const status = Value.Check(NumberValueSchema, event.status)
      ? event.status
      : Value.Check(NumberValueSchema, nested?.status)
        ? nested.status
        : undefined;
    if (status !== undefined) {
      throw responseError(status, JSON.stringify({ error: nested ?? event }));
    }
    const code = [event.code, nested?.code, nested?.type].find((value) =>
      Value.Check(StringValueSchema, value),
    );
    const message = Value.Check(StringValueSchema, event.message)
      ? event.message
      : Value.Check(StringValueSchema, nested?.message)
        ? nested.message
        : code;
    const resolvedMessage = message ?? "Codex request failed";
    throw new CodexProviderError(
      resolvedMessage,
      code,
      RETRYABLE_WEBSOCKET_ERROR_CODES.has(code ?? ""),
    );
  }
  if (event.type === "response.failed") {
    const response = isRecord(event.response) ? event.response : undefined;
    const error = isRecord(response?.error) ? response.error : undefined;
    const message = Value.Check(StringValueSchema, error?.message)
      ? error.message
      : "Codex response failed";
    const code = Value.Check(StringValueSchema, error?.code) ? error.code : undefined;
    const classification = responseFailureClassification(code);
    throw new CodexProviderError(
      message,
      code,
      classification.retryable,
      undefined,
      undefined,
      classification.useCurrentModelFallback,
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

const toPiResponseStreamEvent = (
  event: JsonRecord,
  output: AssistantMessage,
): PiResponseStreamEvent => {
  const mapped = mapCodexEvent(event, output);
  if (!Value.Check(ResponseStreamEventEnvelopeSchema, mapped)) {
    throw new Error("Codex stream event must have a string type");
  }
  // SAFETY: The transport validated a JSON record and discriminator; pinned pi-ai owns the remaining Responses protocol shape, and processor failures are contained by this stream.
  return Object.assign({} as PiResponseStreamEvent, mapped);
};

const captureEvent = (capture: ResponseCapture, event: JsonRecord) => {
  if (event.type === "response.output_item.done") {
    if (!Value.Check(ResponsesInputItemSchema, event.item)) {
      capture.continuationBlocked = true;
    } else {
      capture.outputItems.push(cloneJson(Value.Parse(ResponsesInputItemSchema, event.item)));
      if (!Value.Check(ContinuationOutputItemSchema, event.item)) {
        capture.continuationBlocked = true;
      }
    }
  }
  if (isTerminalResponseEvent(event)) {
    const response = isRecord(event.response) ? event.response : undefined;
    if (Value.Check(StringValueSchema, response?.id)) {
      capture.responseId = response.id;
    }
    if (Value.Check(StringValueSchema, response?.service_tier)) {
      capture.serviceTier = response.service_tier;
    }
    capture.completed = event.type !== "response.incomplete" && response?.status !== "incomplete";
    if (response?.output !== undefined) {
      if (
        !Array.isArray(response.output) ||
        response.output.length !== capture.outputItems.length ||
        response.output.some((item) => !Value.Check(ContinuationOutputItemSchema, item))
      ) {
        capture.continuationBlocked = true;
      } else {
        capture.terminalOutput = cloneJson(response.output);
      }
    }
    const rawUsage = isRecord(response?.usage) ? response.usage : undefined;
    if (rawUsage) {
      const details = isRecord(rawUsage.input_tokens_details)
        ? rawUsage.input_tokens_details
        : undefined;
      const cached = Value.Check(NumberValueSchema, details?.cached_tokens)
        ? details.cached_tokens
        : 0;
      const cacheWrite = Value.Check(NumberValueSchema, details?.cache_write_tokens)
        ? details.cache_write_tokens
        : 0;
      const input = Value.Check(NumberValueSchema, rawUsage.input_tokens)
        ? rawUsage.input_tokens
        : 0;
      capture.usage = {
        ...initialUsage(),
        cacheRead: cached,
        cacheWrite,
        input: Math.max(0, input - cached - cacheWrite),
        output: Value.Check(NumberValueSchema, rawUsage.output_tokens) ? rawUsage.output_tokens : 0,
        totalTokens: Value.Check(NumberValueSchema, rawUsage.total_tokens)
          ? rawUsage.total_tokens
          : 0,
      };
    }
  }
};

const terminalTurnState = (event: JsonRecord): string | undefined => {
  if (event.type !== "response.metadata" || !Value.Check(JsonRecordSchema, event.headers)) {
    return undefined;
  }
  for (const [name, value] of Object.entries(event.headers)) {
    if (
      name.toLowerCase() === "x-codex-turn-state" &&
      Value.Check(StringValueSchema, value) &&
      value.length > 0
    ) {
      return value;
    }
  }
  return undefined;
};

async function* parseSse(response: Response, signal?: AbortSignal): AsyncGenerator<JsonRecord> {
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
      const result = await reader.read();
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

const responseErrorClassification = (status: number, code: string | undefined, body: string) => {
  if (status === 400) {
    const excludedFromModelFallback =
      code === "cyber_policy" ||
      body.includes("The image data you provided does not represent a valid image");
    return {
      retryable: false,
      useCurrentModelFallback: !excludedFromModelFallback,
    };
  }
  if (status === 429) {
    if (TERMINAL_QUOTA_ERROR_CODES.has(code ?? "")) {
      return { retryable: false, useCurrentModelFallback: false };
    }
    return {
      retryable: code !== "usage_limit_reached",
      useCurrentModelFallback: true,
    };
  }
  if (status === 503 && (code === "server_is_overloaded" || code === "slow_down")) {
    return { retryable: false, useCurrentModelFallback: true };
  }
  if (status >= 400 && status < 500) {
    return {
      retryable: status === 408 || status === 409 || status === 425,
      useCurrentModelFallback: false,
    };
  }
  return {
    retryable: status >= 500,
    useCurrentModelFallback: status >= 500,
  };
};

const responseError = (status: number, text: string) => {
  try {
    const parsed: unknown = JSON.parse(text);
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
    if (error !== undefined) {
      const code = Value.Check(StringValueSchema, error.code)
        ? error.code
        : Value.Check(StringValueSchema, error.type)
          ? error.type
          : undefined;
      const classification = responseErrorClassification(status, code, text);
      return new CodexProviderError(
        Value.Check(StringValueSchema, error.message)
          ? error.message
          : `Codex request failed (${status})`,
        code,
        classification.retryable,
        status,
        text,
        classification.useCurrentModelFallback,
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
    classification.useCurrentModelFallback,
  );
};

const compressBody = (body: string): Uint8Array | undefined => {
  try {
    const compressed = zstdCompressSync(body, {
      params: {
        [zlibConstants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_LEVEL,
      },
    });
    return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  } catch {
    // Compression is optional.
  }
  return undefined;
};

const closeSocket = (session: SessionRuntime, expected = session.socket?.value) => {
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
  timeoutMs: number | undefined,
  trace: RequestTrace,
) => {
  const now = Date.now();
  const identity = webSocketIdentity(url, headers);
  const cached = session.socket;
  if (cached?.busy === true) {
    throw new WebSocketUnavailableError("WebSocket session is busy");
  }
  if (
    cached &&
    !cached.busy &&
    cached.value.readyState === 1 &&
    cached.identity === identity &&
    now - cached.createdAt < WEBSOCKET_MAX_AGE_MS
  ) {
    clearTimeout(cached.idleTimer);
    cached.busy = true;
    return cached.value;
  }
  if (cached) {
    closeSocket(session, cached.value);
  }
  const constructorValue = globalThis.WebSocket;
  if (!Value.Check(WebSocketConstructorSchema, constructorValue)) {
    throw new WebSocketUnavailableError("WebSocket transport is unavailable");
  }
  const Constructor = Value.Parse(WebSocketConstructorSchema, constructorValue);
  signal?.throwIfAborted();
  trace.websocketHandshakeAttempts += 1;
  let socket: WebSocketLike;
  try {
    const socketValue = Reflect.construct(Constructor, [url, { headers: headersRecord(headers) }]);
    if (!Value.Check(WebSocketLikeSchema, socketValue)) {
      throw new WebSocketUnavailableError("WebSocket transport returned an invalid socket");
    }
    socket = Value.Parse(WebSocketLikeSchema, socketValue);
  } catch (error) {
    trace.websocketHandshakeFailures += 1;
    throw error;
  }
  session.socket = { busy: true, createdAt: now, identity, value: socket };
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
  }).catch((cause: WireValue) => {
    if (!isAborted(signal)) {
      trace.websocketHandshakeFailures += 1;
    }
    closeSocket(session, socket);
    throw cause;
  });
  return socket;
};

const releaseSocket = (session: SessionRuntime, socket: WebSocketLike, keep: boolean) => {
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

const messageData = async (event: WireValue) => {
  if (!Value.Check(WebSocketMessageSchema, event)) {
    throw new Error("Unsupported WebSocket message payload");
  }
  const data = Value.Parse(WebSocketMessageSchema, event).data;
  if (Value.Check(StringValueSchema, data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (data instanceof Blob) {
    return await data.text();
  }
  throw new Error("Unsupported WebSocket message payload");
};

async function* parseWebSocket(
  socket: WebSocketLike,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number | undefined,
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
        enqueue(new Error(`WebSocket stream timed out after ${idleTimeoutMs}ms`));
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
  const onMessage = (event: WireValue) => {
    void messageData(event)
      .then((data) => {
        const value: unknown = JSON.parse(data);
        if (!isRecord(value)) {
          throw new Error("Codex WebSocket event must be an object");
        }
        armIdle();
        enqueue(value);
      })
      .catch((cause: WireValue) => {
        enqueue(cause instanceof Error ? cause : new Error(String(cause)));
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
      finished = isTerminalResponseEvent(value);
    }
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onAbort);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("message", onMessage);
  }
}

async function* bufferInitialResponseCreated(
  events: AsyncIterable<JsonRecord>,
  attempt: InferenceAttemptObservation | undefined,
): AsyncGenerator<JsonRecord> {
  if (attempt === undefined) {
    yield* events;
    return;
  }
  let first = true;
  let pending: JsonRecord | undefined;
  try {
    for await (const event of events) {
      if (first && event.type === "response.created") {
        first = false;
        pending = event;
        continue;
      }
      first = false;
      if (pending !== undefined) {
        attempt.responseCreated = "committed";
        const created = pending;
        pending = undefined;
        yield created;
      }
      yield event;
    }
    if (pending !== undefined) {
      throw new Error(PREMATURE_RESPONSE_STREAM_ERROR);
    }
  } finally {
    if (pending !== undefined) {
      attempt.responseCreated = "discarded";
    }
  }
}

const applyTurnHeaders = (headers: Headers, body: JsonRecord, session: SessionRuntime) => {
  const clientMetadata = isRecord(body.client_metadata) ? body.client_metadata : undefined;
  const metadata = clientMetadata?.["x-codex-turn-metadata"];
  if (Value.Check(StringValueSchema, metadata)) {
    headers.set("x-codex-turn-metadata", metadata);
  }
  headers.set("x-codex-window-id", session.window.currentId);
  if (session.turn?.state !== undefined && session.turn.state.length > 0) {
    headers.set("x-codex-turn-state", session.turn.state);
  }
};

const applyRoutingHint = (headers: Headers, body: JsonRecord) => {
  headers.set("originator", body.service_tier === "priority" ? "codex_cli_rs" : "pi");
  const model = Value.Check(StringValueSchema, body.model) ? body.model : "";
  const tier = Value.Check(StringValueSchema, body.service_tier)
    ? `;tier=${body.service_tier}`
    : "";
  const hint = `model=${model}${tier}`;
  headers.set("x-codex-routing-hint", hint);
};

const sseEvents = async function* sseEvents(
  model: SupportedModel,
  body: JsonRecord,
  options: OpenAICodexResponsesOptions | undefined,
  session: SessionRuntime,
  requestId: string,
  trace: RequestTrace,
  responsesLite = false,
  maxRetries = options?.maxRetries ?? 0,
  redirect: "error" | "follow" | "manual" = "follow",
  recovery?: InferenceRecovery,
) {
  const headers = buildBaseHeaders(model, options, requestId);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("openai-beta", "responses=experimental");
  if (responsesLite) {
    headers.set("x-openai-internal-codex-responses-lite", "true");
  }
  applyTurnHeaders(headers, body, session);
  applyRoutingHint(headers, body);
  const bodyJson = JSON.stringify(body);
  const compressed = compressBody(bodyJson);
  if (compressed !== undefined) {
    headers.set("content-encoding", "zstd");
  }
  const fetch = options?.fetch ?? globalThis.fetch;
  const timeoutMs = normalizeTimeout(options?.timeoutMs, "timeoutMs");
  let attemptIndex = 0;
  while (true) {
    let dispatchFailed = false;
    let replayUnsafe = false;
    let retryResponse: Response | undefined;
    if (isAborted(options?.signal)) {
      throw new Error("Request was aborted");
    }
    const attempt = beginInferenceAttempt(recovery, "sse", "full");
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
        const requestInit: RequestInit = {
          body: compressed ?? bodyJson,
          headers,
          method: "POST",
          redirect,
          signal: AbortSignal.any(signals),
        };
        dispatchFailed = true;
        const responsePromise = dispatchInference(recovery, () =>
          fetch(resolveCodexResponsesUrl(model.baseUrl), requestInit),
        );
        trace.transportUsed = "sse";
        dispatchFailed = false;
        response = await responsePromise;
      } catch (error) {
        if (timeoutController.signal.aborted && !isAborted(options?.signal)) {
          throw new Error(`Codex SSE response headers timed out after ${timeoutMs}ms`, {
            cause: error,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      await options?.onResponse?.(
        { headers: headersRecord(response.headers), status: response.status },
        model,
      );
      const turnState = response.headers.get("x-codex-turn-state");
      if (
        turnState !== null &&
        turnState.length > 0 &&
        session.turn !== undefined &&
        session.turn.state === undefined
      ) {
        session.turn.state = turnState;
        replayUnsafe = true;
      }
      if (response.ok) {
        let terminal = false;
        for await (const event of bufferInitialResponseCreated(
          parseSse(response, options?.signal),
          attempt,
        )) {
          terminal ||= isTerminalResponseEvent(event);
          replayUnsafe = true;
          yield event;
        }
        if (recovery !== undefined && !terminal) {
          throw new Error(PREMATURE_RESPONSE_STREAM_ERROR);
        }
        finishInferenceAttempt(attempt, "none", "completed");
        return;
      }
      const text = await response.text();
      retryResponse = response;
      throw responseError(response.status, text);
    } catch (error) {
      const resolvedError = error instanceof Error ? error : new Error(String(error));
      const failureClass = classifyInferenceAttemptFailure(
        resolvedError,
        options?.signal,
        dispatchFailed,
      );
      if (isAborted(options?.signal)) {
        finishInferenceAttempt(attempt, failureClass, "aborted");
        throw resolvedError;
      }
      if (replayUnsafe) {
        finishInferenceAttempt(attempt, failureClass, "fail_closed");
        throw resolvedError;
      }
      const retryable =
        resolvedError instanceof CodexProviderError
          ? resolvedError.status !== undefined && resolvedError.retryable
          : true;
      if (!retryable) {
        finishInferenceAttempt(attempt, failureClass, "surfaced");
        throw resolvedError;
      }
      const hasCapacity = hasInferenceDispatchCapacity(recovery);
      if (attemptIndex === maxRetries || !hasCapacity) {
        finishInferenceAttempt(
          attempt,
          failureClass,
          recovery !== undefined && !hasCapacity ? "replay_budget_exhausted" : "surfaced",
        );
        throw resolvedError;
      }
      const retryWait =
        retryResponse === undefined
          ? 1000 * 2 ** attemptIndex
          : retryDelay(retryResponse, attemptIndex);
      const cap = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
      if (
        !Number.isSafeInteger(retryWait) ||
        retryWait > 2_147_483_647 ||
        (cap > 0 && retryWait > cap)
      ) {
        const retryDelayError = new CodexProviderError(
          `Server requested ${Math.ceil(retryWait / 1000)}s retry delay (max: ${Math.ceil(cap / 1000)}s)`,
        );
        finishInferenceAttempt(
          attempt,
          classifyInferenceAttemptFailure(retryDelayError, options?.signal),
          "surfaced",
        );
        throw retryDelayError;
      }
      try {
        await delay(retryWait, undefined, {
          signal: options?.signal,
        });
      } catch (delayError) {
        finishInferenceAttempt(attempt, "abort", "aborted");
        throw delayError;
      }
      finishInferenceAttempt(attempt, failureClass, "retry_sse");
      attemptIndex += 1;
    }
  }
};

const websocketEvents = async function* websocketEvents(
  model: SupportedModel,
  fullBody: OutboundRequestBody,
  options: OpenAICodexResponsesOptions | undefined,
  session: SessionRuntime,
  requestId: string,
  capture: ResponseCapture,
  trace: RequestTrace,
  responsesLite = false,
  generate = true,
  recovery?: InferenceRecovery,
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
    applyRoutingHint(headers, fullBody);
    const previousSocket = session.socket;
    const socket = await connectSocket(
      resolveWebSocketUrl(model.baseUrl),
      headers,
      session,
      options?.signal,
      normalizeTimeout(options?.websocketConnectTimeoutMs, "websocketConnectTimeoutMs"),
      trace,
    );
    let keepSocket = false;
    try {
      if (generate) {
        if (session.socket) {
          trace.socketReused ||= previousSocket?.value === socket;
          trace.socketAgeMs = Date.now() - session.socket.createdAt;
        }
      }
      const delta = session.continuation
        ? continuationDelta(fullBody, session.continuation)
        : undefined;
      if (generate) {
        trace.continuationMode = delta === undefined ? "full" : "delta";
      }
      const requestBody =
        delta !== undefined && session.continuation !== undefined
          ? {
              ...fullBody,
              input: delta,
              previous_response_id: session.continuation.responseId,
            }
          : fullBody;
      session.continuation = undefined;
      let emitted = false;
      let dispatchFailed = false;
      const attempt = generate
        ? beginInferenceAttempt(recovery, "websocket", delta === undefined ? "full" : "delta")
        : undefined;
      try {
        const requestRecord = Value.Parse(JsonRecordSchema, requestBody);
        const clientMetadata = isRecord(requestRecord.client_metadata)
          ? requestRecord.client_metadata
          : {};
        const frame = JSON.stringify({
          ...requestBody,
          client_metadata: {
            ...clientMetadata,
            "x-codex-turn-state":
              session.turn?.state !== undefined && session.turn.state.length > 0
                ? session.turn.state
                : undefined,
            "x-codex-ws-stream-request-start-ms": Date.now().toString(),
            ws_request_header_x_openai_internal_codex_responses_lite: responsesLite
              ? "true"
              : undefined,
          },
          generate: generate ? undefined : false,
          type: "response.create",
        });
        if (generate) {
          dispatchFailed = true;
          dispatchInference(recovery, () => {
            socket.send(frame);
          });
          trace.transportUsed = "websocket";
          dispatchFailed = false;
        } else {
          socket.send(frame);
          trace.prewarmDispatches += 1;
        }
        for await (const event of bufferInitialResponseCreated(
          parseWebSocket(
            socket,
            options?.signal,
            normalizeTimeout(options?.timeoutMs, "timeoutMs"),
          ),
          attempt,
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
        capture.socket = capture.completed ? socket : undefined;
        keepSocket = capture.completed;
        finishInferenceAttempt(attempt, "none", "completed");
        return;
      } catch (error) {
        const resolvedError = error instanceof Error ? error : new Error(String(error));
        const code = resolvedError instanceof CodexProviderError ? resolvedError.code : undefined;
        const failureClass = classifyInferenceAttemptFailure(
          resolvedError,
          options?.signal,
          dispatchFailed,
        );
        if (emitted) {
          finishInferenceAttempt(attempt, failureClass, "fail_closed");
          throw error;
        }
        if (code === "previous_response_not_found" && !retriedMissingContinuation) {
          if (!hasInferenceDispatchCapacity(recovery)) {
            finishInferenceAttempt(attempt, failureClass, "replay_budget_exhausted");
            throw error;
          }
          retriedMissingContinuation = true;
          trace.missingContinuationRetries += 1;
          finishInferenceAttempt(attempt, failureClass, "retry_websocket");
          continue;
        }
        if (code === "websocket_connection_limit_reached" && !retriedConnectionLimit) {
          if (!hasInferenceDispatchCapacity(recovery)) {
            finishInferenceAttempt(attempt, failureClass, "replay_budget_exhausted");
            throw error;
          }
          retriedConnectionLimit = true;
          trace.connectionLimitRetries += 1;
          finishInferenceAttempt(attempt, failureClass, "retry_websocket");
          continue;
        }
        finishInferenceAttempt(
          attempt,
          failureClass,
          isAborted(options?.signal) ? "aborted" : "surfaced",
        );
        throw error;
      }
    } finally {
      releaseSocket(session, socket, keepSocket);
    }
  }
};

const createSession = (): SessionRuntime => ({
  fallbackToSse: false,
  transportFallbackPending: false,
  window: { currentId: uuidv7(), number: 0 },
});

const activateSseFallback = (session: SessionRuntime, trace: RequestTrace) => {
  session.transportFallbackPending = true;
  session.fallbackToSse = true;
  trace.sseFallbackActivated = true;
};

function successfulOutput(output: AssistantMessage): asserts output is AssistantMessage & {
  stopReason: "length" | "stop" | "toolUse";
} {
  if (
    output.stopReason === "pending" ||
    output.stopReason === "error" ||
    output.stopReason === "aborted"
  ) {
    throw new Error(output.errorMessage ?? "Codex stream ended without a successful response");
  }
}

const applyServiceTier = (usage: Usage, tier: string | null | undefined) => {
  const multiplier = tier === "flex" ? 0.5 : tier === "priority" ? 2 : 1;
  if (multiplier === 1) {
    return;
  }
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
};

export const createCodexProviderRuntime = (
  observability: CodexObservability,
  isFastModeEnabled: () => boolean = () => false,
  catalog: CodexModelCatalog = createCodexModelCatalog(),
) => {
  const { base } = catalog;
  const sessions = new Map<string, SessionRuntime>();
  const requestTransport = new AsyncLocalStorage<
    NonNullable<OpenAICodexResponsesOptions["transport"]>
  >();

  const getSession = (sessionId: string) => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = createSession();
      sessions.set(sessionId, session);
    }
    return session;
  };

  const normalEvents = async function* normalEvents(
    model: SupportedModel,
    body: OutboundRequestBody,
    options: OpenAICodexResponsesOptions | undefined,
    session: SessionRuntime,
    requestId: string,
    capture: ResponseCapture,
    trace: RequestTrace,
    responsesLite = false,
    redirect: "follow" | "manual" = "follow",
    fallbackAfterWebSocketFailure = true,
    recovery?: InferenceRecovery,
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
          responsesLite,
          true,
          recovery,
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
        activateSseFallback(session, trace);
        const websocketAttempt = recovery?.attempts.at(-1);
        if (!hasInferenceDispatchCapacity(recovery)) {
          if (websocketAttempt?.finalDecision === "surfaced") {
            websocketAttempt.finalDecision = "replay_budget_exhausted";
          }
          throw error;
        }
        if (websocketAttempt?.finalDecision === "surfaced") {
          websocketAttempt.finalDecision = "fallback_to_sse";
        }
      }
    }
    session.continuation = undefined;
    trace.continuationMode = "full";
    for await (const event of sseEvents(
      model,
      body,
      options,
      session,
      requestId,
      trace,
      responsesLite,
      recovery === undefined ? (options?.maxRetries ?? 0) : recovery.budget,
      redirect,
      recovery,
    )) {
      captureEvent(capture, event);
      yield event;
    }
  };

  const compact = async (request: CodexCompactionRequest): Promise<CodexCompactionResult> => {
    const standalone = request.phase === "standalone";
    const runtimeSessionId = standalone
      ? `${request.sessionId}:compaction:${uuidv7()}`
      : request.sessionId;
    const session = standalone ? createSession() : getSession(runtimeSessionId);
    session.turn ??= {
      fastModeEnabled: isFastModeEnabled(),
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
        session.turn.fastModeEnabled && catalog.supportsFastMode(request.model)
          ? "priority"
          : undefined,
      sessionId: runtimeSessionId,
      signal: request.signal,
      transport: requestTransport.getStore() ?? "auto",
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
        catalog.getModelMetadata(request.model.id),
        request.sessionId,
        session,
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
      const source = [...request.inputPrefix, ...(request.authoritativeInput ?? envelopeInput)];
      if (source.some((item) => item.type === "compaction_trigger")) {
        throw new Error("Compaction source already contains a trigger");
      }
      const instructions = Value.Check(StringValueSchema, envelope.instructions)
        ? envelope.instructions
        : (request.context.systemPrompt ?? "");
      const normalized = normalizeToolHistory(
        omitUnsupportedUserImages(source, request.model.input.includes("image")),
      );
      const effectiveInput = shrinkTrailingOutputs(
        normalized,
        instructions,
        request.effectiveTokenLimit,
      );
      const estimatedSourceTokens = estimateModelVisibleTokens(instructions, effectiveInput);
      const envelopeMetadata = isRecord(envelope.client_metadata) ? envelope.client_metadata : {};
      let body: RequestBody = {
        ...built.body,
        ...envelope,
        client_metadata: {
          ...envelopeMetadata,
          ...requestMetadata(request.sessionId, session, "compaction", compactionMetadata(request)),
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
        !catalog.supportsFastMode(request.model)
      ) {
        delete body.service_tier;
      }
      if (built.responsesLite) {
        body = prepareLiteRequest(body);
      }
      validateRequestReasoningEffort(body);
      observedBody = body;
      const requestId = promptCacheKey(request.sessionId);
      const configuredWebsocketTransport =
        options.transport === "sse" ? undefined : (options.transport ?? "auto");
      const websocketAttempts =
        configuredWebsocketTransport === undefined || session.fallbackToSse ? 0 : 3;
      const maxAttempts = websocketAttempts + 3;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        attempts += 1;
        const capture: ResponseCapture = {
          completed: false,
          outputItems: [],
        };
        const compactions: CanonicalCompactionItem[] = [];
        try {
          for await (const event of normalEvents(
            request.model,
            body,
            options,
            session,
            requestId,
            capture,
            trace,
            built.responsesLite,
            "manual",
            false,
          )) {
            mapCodexEvent(event);
            if (
              event.type === "response.output_item.done" &&
              isRecord(event.item) &&
              (event.item.type === "compaction" || event.item.type === "compaction_summary")
            ) {
              compactions.push(
                parseCompactionItem(event.item, {
                  allowAlias: true,
                  allowResponseMetadata: true,
                }),
              );
            }
          }
          if (!capture.completed) {
            throw new CodexProviderError(
              "Codex compaction stream ended before completion",
              "response_stream_failed",
              true,
            );
          }
          if (
            capture.responseId === undefined ||
            capture.usage === undefined ||
            compactions.length !== 1
          ) {
            throw new CodexProviderError("Codex compaction returned an invalid response");
          }
          calculateCost(request.model, capture.usage);
          applyServiceTier(
            capture.usage,
            capture.serviceTier === "default"
              ? body.service_tier
              : (capture.serviceTier ?? body.service_tier),
          );
          compactionResult = {
            compaction: compactions[0],
            estimatedSourceTokens,
            responseId: capture.responseId,
            usage: capture.usage,
          };
          return compactionResult;
        } catch (error) {
          if (request.signal.aborted || (error instanceof CodexProviderError && !error.retryable)) {
            throw error;
          }
          if (
            configuredWebsocketTransport !== undefined &&
            attempt < websocketAttempts &&
            error instanceof WebSocketUnavailableError
          ) {
            activateSseFallback(session, trace);
            attempt = websocketAttempts - 1;
            continue;
          }
          if (configuredWebsocketTransport !== undefined && attempt + 1 === websocketAttempts) {
            activateSseFallback(session, trace);
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
        error: compactionError === undefined ? undefined : requestErrorObservation(compactionError),
        model: request.model.id,
        outcome:
          compactionResult === undefined
            ? request.signal.aborted
              ? "aborted"
              : "error"
            : "success",
        phase: request.phase,
        reason: request.reason,
        request: observedBody === undefined ? undefined : requestObservation(observedBody),
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
    trace: RequestTrace,
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
    trace.prewarmAttempts += 1;
    if (session.turn) {
      session.turn.prewarmed = true;
    }
    const capture: ResponseCapture = {
      completed: false,
      outputItems: [],
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
        trace,
        responsesLite,
        false,
        undefined,
      )) {
        // Prewarm output is intentionally discarded.
      }
      trace.prewarmSucceeded = capture.completed;
      session.continuation = undefined;
    } catch {
      // websocketEvents owns cleanup for the socket it acquired.
    }
  };

  const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
    model,
    context,
    options,
  ) => {
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
    const recovery = createInferenceRecovery(options);
    let observedBody: JsonRecord | undefined;
    let observedError: unknown;
    void (async () => {
      try {
        if (options?.apiKey === undefined || options.apiKey.length === 0) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const session = getSession(sessionId);
        session.turn ??= {
          fastModeEnabled: isFastModeEnabled(),
          id: uuidv7(),
          prewarmed: false,
          startedAt: Date.now(),
        };
        const built = buildRequestBody(
          model,
          context,
          options,
          catalog.getModelMetadata(model.id),
          sessionId,
          session,
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
        const prewarmInput = built.responsesLite ? built.body.input.slice(0, litePrefixLength) : [];
        let requestBody = built.body;
        if (session.turn?.fastModeEnabled === true && catalog.supportsFastMode(model)) {
          requestBody.service_tier = "priority";
        }
        if (built.responsesLite) {
          requestBody = prepareLiteRequest(requestBody);
        }
        const originalBodyJson = JSON.stringify(requestBody);
        let body: OutboundRequestBody = requestBody;
        const transport = session.fallbackToSse ? "sse" : (options.transport ?? "auto");
        const transformed = await requestTransport.run(transport, () =>
          options.onPayload?.(body, model),
        );
        if (transformed !== undefined) {
          if (!Value.Check(TransformedRequestBodySchema, transformed)) {
            throw new Error("Codex payload transform returned an invalid request");
          }
          body = Value.Parse(TransformedRequestBodySchema, transformed);
          if (built.responsesLite) {
            body = prepareLiteTransformedRequest(body);
          }
        }
        validateRequestReasoningEffort(body);
        observedBody = body;
        const requestId = promptCacheKey(sessionId);
        const prewarmCompatible =
          transformed === undefined || JSON.stringify(body) === originalBodyJson;
        await prewarm(
          model,
          requestBody,
          options,
          session,
          requestId,
          sessionId,
          built.responsesLite,
          prewarmCompatible ? prewarmInput : undefined,
          trace,
        );
        const capture: ResponseCapture = {
          completed: false,
          outputItems: [],
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
            built.responsesLite,
            "follow",
            true,
            recovery,
          )) {
            if (!started) {
              started = true;
              events.push({ partial: output, type: "start" });
            }
            yield toPiResponseStreamEvent(event, output);
          }
        };
        await processResponsesStream(source(), output, events, model, {
          applyServiceTierPricing: applyServiceTier,
          grammarToolInputProperties: built.grammarToolInputProperties,
          resolveServiceTier: (responseTier, requestTier) =>
            responseTier === "default" ? requestTier : (responseTier ?? requestTier),
          serviceTier: requestServiceTier(body),
        });
        successfulOutput(output);
        const cachedSocket = session.socket;
        if (
          capture.completed &&
          capture.continuationBlocked !== true &&
          capture.responseId !== undefined &&
          capture.socket !== undefined &&
          cachedSocket?.value === capture.socket &&
          cachedSocket.busy === false &&
          cachedSocket.value.readyState === 1
        ) {
          const responseItems = convertResponsesMessages(
            model,
            { messages: [output] },
            ALLOWED_TOOL_CALL_PROVIDERS,
            {
              grammarToolInputProperties: built.grammarToolInputProperties,
              includeSystemPrompt: false,
            },
          )
            .filter(
              (item) =>
                item.type !== "function_call_output" && item.type !== "custom_tool_call_output",
            )
            .map((item) => ({ ...item }));
          if (
            continuationOutputMatches(capture.outputItems, responseItems, capture.terminalOutput)
          ) {
            session.continuation = {
              request: cloneJson(body),
              responseId: capture.responseId,
              responseItems: cloneJson(responseItems),
            };
          }
        }
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
        output.errorMessage = error instanceof Error ? error.message : String(error);
        events.push({
          error: output,
          reason: output.stopReason,
          type: "error",
        });
        events.end();
      } finally {
        for (const attempt of recovery.attempts) {
          if (attempt.finalDecision !== "pending") {
            continue;
          }
          if (output.stopReason === "aborted") {
            finishInferenceAttempt(attempt, "abort", "aborted");
          } else if (output.stopReason === "error") {
            const error =
              observedError instanceof Error ? observedError : new Error(String(observedError));
            finishInferenceAttempt(
              attempt,
              classifyInferenceAttemptFailure(error, options?.signal),
              "fail_closed",
            );
          } else {
            finishInferenceAttempt(attempt, "none", "completed");
          }
        }
        const observedMetadata =
          observedBody !== undefined && isRecord(observedBody.client_metadata)
            ? observedBody.client_metadata
            : undefined;
        observability.record(sessionId, "request", {
          durationMs: Date.now() - startedAt,
          error: observedError === undefined ? undefined : requestErrorObservation(observedError),
          model: model.id,
          outcome: output.stopReason,
          reasoning: options?.reasoningEffort,
          request: observedBody === undefined ? undefined : requestObservation(observedBody),
          response: {
            cacheReadTokens: output.usage.cacheRead,
            cacheWriteTokens: output.usage.cacheWrite,
            id: output.responseId,
            inputTokens: output.usage.input,
            outputTokens: output.usage.output,
            reasoningTokens: output.usage.reasoning,
            totalTokens: output.usage.totalTokens,
          },
          serviceTier: observedBody === undefined ? undefined : requestServiceTier(observedBody),
          transport: {
            configured: options?.transport ?? "auto",
            ...trace,
            freshReplayBudget: recovery.budget,
            inferenceAttempts: recovery.attempts,
            inferenceDispatches: recovery.dispatches,
          },
          turnId: Value.Check(StringValueSchema, observedMetadata?.turn_id)
            ? observedMetadata.turn_id
            : undefined,
          windowId: Value.Check(StringValueSchema, observedMetadata?.["x-codex-window-id"])
            ? observedMetadata["x-codex-window-id"]
            : undefined,
        });
      }
    })();
    return events;
  };

  const streamSimple: Provider<"openai-codex-responses">["streamSimple"] = (
    model,
    context,
    options,
  ) => {
    const baseOptions = buildBaseOptions(model, context, options, options?.apiKey);
    const level =
      options?.reasoning !== undefined && options.reasoning.length > 0
        ? clampThinkingLevel(model, options.reasoning)
        : undefined;
    return stream(model, context, {
      ...baseOptions,
      reasoningEffort: level === "off" ? undefined : level,
      toolChoice: options?.toolChoice,
    } satisfies OpenAICodexResponsesOptions);
  };

  const closeSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      closeSocket(session);
      sessions.delete(sessionId);
    }
  };

  const provider: Provider<"openai-codex-responses"> = {
    ...base,
    getModels: catalog.getModels,
    refreshModels: catalog.refreshModels,
    stream,
    streamSimple,
  };

  return {
    beginTurn(sessionId: string) {
      const session = getSession(sessionId);
      session.turn = {
        fastModeEnabled: isFastModeEnabled(),
        id: uuidv7(),
        prewarmed: false,
        startedAt: Date.now(),
      };
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
      return catalog.getModelMetadata(modelId);
    },
    getModelWindow(model: SupportedModel) {
      return catalog.getModelWindow(model);
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
      },
    ) {
      const session = getSession(sessionId);
      if (
        session.window.currentId === window.currentWindowId &&
        session.window.number === window.windowNumber &&
        (session.window.previousId ?? null) === window.previousWindowId
      ) {
        return { ...session.window };
      }
      const nextWindow: typeof session.window = {
        currentId: window.currentWindowId,
        number: window.windowNumber,
      };
      if (window.previousWindowId !== null && window.previousWindowId.length > 0) {
        nextWindow.previousId = window.previousWindowId;
      }
      session.window = nextWindow;
      session.continuation = undefined;
      return { ...session.window };
    },
    provider,
    supportsFastMode: catalog.supportsFastMode,
  };
};

export type CodexProviderRuntime = ReturnType<typeof createCodexProviderRuntime>;
