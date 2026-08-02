import { setTimeout as delay } from "node:timers/promises";

import { uuidv7 } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  FetchFunction,
  Model,
  Provider,
  ProviderEnv,
  ProviderHeaders,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  buildSessionContext,
  calculateContextTokens,
  convertToLlm,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
  CompactionResult,
  ContextEvent,
  ExtensionContext,
  ExtensionFactory,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { convertResponsesMessages } from "#pi-responses";

import {
  CHECKPOINT_CUSTOM_TYPE,
  CHECKPOINT_PROTOCOL,
  CHECKPOINT_SCHEMA,
  REMOTE_USER_IMAGE_PLACEHOLDER,
  canUseInlineLocalFallback,
  decideCheckpointCompatibility,
  normalizeBaseUrl,
  parseCheckpoint,
  parseRealUserInputItem,
  resolveActiveCheckpointBoundary,
  sha256Canonical,
} from "./checkpoint.js";
import type {
  CanonicalCompactionItem,
  Checkpoint,
  RealUserInputItem,
} from "./checkpoint.js";
import { collectCompactionSse, isCompactionSseFailure } from "./remote.js";
import { registerCheckpointRenderer } from "./renderer.js";
import {
  buildCheckpointReplacement,
  buildTransientCheckpointReplacement,
  contextWindowDecision,
  estimateModelVisibleTokens,
  extractFinalizedFrame,
  frameContiguousBaseline,
  frameMarkerText,
  normalizeToolHistory,
  omitUnsupportedUserImages,
  rewriteFramedInput,
  shouldAutoCompact,
  shrinkTrailingOutputs,
} from "./replay.js";
import type { ResponsesInputItem } from "./replay.js";

export const ENCRYPTED_CHECKPOINT_MARKER =
  "[OpenAI encrypted compaction checkpoint]";
export const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
export const CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE = "codex-compaction.diagnostic";

const ALLOWED_TOOL_CALL_PROVIDERS = new Set([
  "openai",
  "openai-codex",
  "opencode",
]);
const RETRY_DELAYS_MS = [500, 1000] as const;
const STATUS_KEY = "codex-compaction";
const STATUS_MESSAGE = "Compacting with OpenAI Codex…";

type SupportedModel = Model<"openai-codex-responses">;
interface SessionBeforeCompactResult {
  readonly cancel?: boolean;
  readonly compaction?: CompactionResult;
}

export interface LifecycleSource {
  readonly branchSha256: string;
  readonly contextMessages: Context["messages"];
  readonly ignoredInvalidInlineCheckpoint: boolean;
  readonly inputPrefix: readonly ResponsesInputItem[];
  readonly retainedUsers: readonly RealUserInputItem[];
}

export type LifecycleFailureKind =
  | "abort"
  | "http"
  | "invalid-output"
  | "network"
  | "premature"
  | "provider";

export interface LifecycleFailure {
  readonly kind: LifecycleFailureKind;
  readonly status?: number;
}

export interface LifecycleExecutionSuccess {
  readonly compaction: CanonicalCompactionItem;
  readonly estimatedSourceTokens: number;
  readonly ok: true;
  readonly responseId: string;
  readonly usage: Usage;
}

export type LifecycleExecutionResult =
  | LifecycleExecutionSuccess
  | {
      readonly failure: LifecycleFailure;
      readonly ok: false;
    };

export interface RegisteredProviderCompactionOptions {
  readonly apiKey?: string;
  readonly authoritativeEnvelope?: Readonly<Record<string, unknown>>;
  readonly authoritativeInput?: readonly ResponsesInputItem[];
  readonly context: Context;
  readonly env?: ProviderEnv;
  readonly headers?: Readonly<ProviderHeaders>;
  readonly inputPrefix: readonly ResponsesInputItem[];
  readonly model: SupportedModel;
  readonly provider: Provider;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly thinkingLevel: SimpleStreamOptions["reasoning"];
}

interface PreparedInput {
  readonly estimatedSourceTokens: number;
}

interface PendingInstall {
  readonly generation: number;
  readonly replacementSha256: string;
  readonly responseId: string;
}

type ActiveNativeCheckpoint = Extract<
  ReturnType<typeof resolveActiveCheckpointBoundary>,
  { kind: "checkpoint" }
>;

interface RequestFrame {
  readonly activeCheckpoint?: ActiveNativeCheckpoint;
  readonly branchSha256: string;
  readonly fallbackAssistantIds: Readonly<Record<string, string>>;
  readonly generation: number;
  readonly leafId: string | null;
  readonly modelIdentity: string;
  readonly nonce: string;
  readonly phase: "mid-turn" | "pre-sampling";
  readonly requestStateSha256: string;
}

interface UnframedCandidate {
  readonly activeCheckpoint?: undefined;
  readonly branchSha256: string;
  readonly generation: number;
  readonly leafId: string | null;
  readonly modelIdentity: string;
  readonly phase: "mid-turn" | "pre-sampling";
  readonly requestStateSha256: string;
}

interface LifecycleState {
  candidate?: UnframedCandidate;
  controller: AbortController;
  customInstructionsWarned: boolean;
  frame?: RequestFrame;
  generation: number;
  inFlight?:
    | {
        kind: "inline";
        key: string;
        promise: Promise<InlineOperationResult>;
      }
    | {
        kind: "lifecycle";
        key: string;
        promise: Promise<SessionBeforeCompactResult>;
      };
  notified: Set<string>;
  pendingInstall?: PendingInstall;
  requestHeaders?: {
    readonly generation: number;
    readonly headers: ProviderHeaders;
    readonly leafId: string | null;
    readonly modelIdentity: string;
  };
}

type InlineOperationResult =
  | {
      checkpoint: Checkpoint;
      kind: "success";
      requestReplacement: readonly ResponsesInputItem[];
    }
  | {
      kind: "persistence" | "remote" | "stale" | "unsupported-input";
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const failure = (
  kind: LifecycleFailureKind,
  status?: number
): LifecycleFailure => ({
  kind,
  ...(status === undefined ? {} : { status }),
});

export const isSupportedLifecycleModel = (
  model: Model<string> | undefined
): model is SupportedModel =>
  model?.provider === "openai-codex" && model.api === "openai-codex-responses";

export const hasResolvedLifecycleAuth = (apiKey?: string) =>
  typeof apiKey === "string" && apiKey.trim().length > 0;

const branchSha256 = (branch: readonly SessionEntry[]) => {
  const serialized = JSON.stringify(branch);
  if (!serialized) {
    throw new Error("Active branch is not serializable");
  }
  return sha256Canonical(JSON.parse(serialized));
};

const serializeRealUserEntries = (
  entries: readonly SessionEntry[],
  model: SupportedModel
) => {
  const users: RealUserInputItem[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") {
      continue;
    }
    const input = convertResponsesMessages(
      model,
      { messages: convertToLlm([entry.message]) },
      ALLOWED_TOOL_CALL_PROVIDERS,
      { includeSystemPrompt: false }
    );
    if (input.length !== 1 || !isRecord(input[0])) {
      throw new Error("A real user entry did not serialize to one input item");
    }
    const serialized: Record<string, unknown> = {
      ...input[0],
      type: "message",
    };
    const content = isUnknownArray(serialized.content)
      ? serialized.content.map((item) => {
          if (
            !isRecord(item) ||
            item.type !== "input_image" ||
            typeof item.image_url !== "string"
          ) {
            return item;
          }
          return /^data:image\//iu.test(item.image_url)
            ? { image_url: item.image_url, type: "input_image" }
            : {
                text: REMOTE_USER_IMAGE_PLACEHOLDER,
                type: "input_text",
              };
        })
      : serialized.content;
    users.push(parseRealUserInputItem({ ...serialized, content }));
  }
  return users;
};

const omitUnsupportedImagesFromUsers = (
  users: readonly RealUserInputItem[],
  model: SupportedModel
) =>
  omitUnsupportedUserImages(
    users.map((user) => ({ ...user })),
    model.input.includes("image")
  ).map((item, index) =>
    parseRealUserInputItem(item, `retainedUsers[${index}]`)
  );

export const buildLifecycleSource = (
  branch: readonly SessionEntry[],
  model: SupportedModel
): LifecycleSource => {
  const boundary = resolveActiveCheckpointBoundary(branch);
  if (
    boundary.kind === "invalid-checkpoint" &&
    (boundary.carrier === "lifecycle" ||
      !canUseInlineLocalFallback(branch, boundary.boundaryIndex))
  ) {
    throw new Error("The active checkpoint boundary is invalid");
  }

  if (boundary.kind === "checkpoint") {
    const compatibility = decideCheckpointCompatibility(boundary.checkpoint, {
      api: model.api,
      baseUrl: model.baseUrl,
      model: model.id,
      provider: model.provider,
    });
    if (!compatibility.compatible) {
      throw new Error("The active checkpoint identity is incompatible");
    }
    const replacement = omitUnsupportedUserImages(
      boundary.checkpoint.replacement.map((item) => ({ ...item })),
      model.input.includes("image")
    );
    const previousUsers = replacement
      .filter((item) => item.type === "message")
      .map((item, index) =>
        parseRealUserInputItem(item, `checkpoint user[${index}]`)
      );
    const inputPrefix = replacement.map((item) => ({ ...item }));
    return {
      branchSha256: branchSha256(branch),
      contextMessages: convertToLlm(
        boundary.tail.flatMap(sessionEntryToContextMessages)
      ),
      ignoredInvalidInlineCheckpoint: false,
      inputPrefix,
      retainedUsers: [
        ...previousUsers,
        ...omitUnsupportedImagesFromUsers(
          serializeRealUserEntries(boundary.tail, model),
          model
        ),
      ],
    };
  }

  const contextEntries = buildContextEntries([...branch]);
  const users = serializeRealUserEntries(contextEntries, model);
  return {
    branchSha256: branchSha256(branch),
    contextMessages: convertToLlm(buildSessionContext([...branch]).messages),
    ignoredInvalidInlineCheckpoint:
      boundary.kind === "invalid-checkpoint" && boundary.carrier === "inline",
    inputPrefix: [],
    retainedUsers: omitUnsupportedImagesFromUsers(users, model),
  };
};

const withRemoteCompactionFeature = (features: readonly string[]) => {
  const merged = [...features];
  if (
    !merged.some(
      (feature) =>
        feature.toLowerCase() === REMOTE_COMPACTION_FEATURE.toLowerCase()
    )
  ) {
    merged.push(REMOTE_COMPACTION_FEATURE);
  }
  return merged.filter(
    (feature, index) =>
      merged.findIndex(
        (candidate) => candidate.toLowerCase() === feature.toLowerCase()
      ) === index
  );
};

export const mergeRemoteCompactionHeaders = (
  headers: Readonly<ProviderHeaders> | undefined,
  ...inheritedHeaders: readonly (
    | Readonly<Record<string, string | null>>
    | undefined
  )[]
) => {
  const merged: ProviderHeaders = {};
  let featureKey = "x-codex-beta-features";
  const features: string[] = [];

  for (const [sourceIndex, source] of [
    headers,
    ...inheritedHeaders,
  ].entries()) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (key.toLowerCase() !== "x-codex-beta-features") {
        if (sourceIndex === 0) {
          merged[key] = value;
        }
        continue;
      }
      if (value === null) {
        continue;
      }
      if (features.length === 0) {
        featureKey = key;
      }
      features.push(
        ...value
          .split(",")
          .map((feature) => feature.trim())
          .filter(Boolean)
      );
    }
  }
  merged[featureKey] = withRemoteCompactionFeature(features).join(",");
  return merged;
};

export const mergeRemoteCompactionFeatureHeader = (
  headers: Record<string, string | null>
) => {
  const matchingKeys = Object.keys(headers).filter(
    (key) => key.toLowerCase() === "x-codex-beta-features"
  );
  const featureKey = matchingKeys[0] ?? "x-codex-beta-features";
  const features = matchingKeys.flatMap((key) =>
    (headers[key] ?? "")
      .split(",")
      .map((feature) => feature.trim())
      .filter(Boolean)
  );
  for (const key of matchingKeys.slice(1)) {
    headers[key] = null;
  }
  headers[featureKey] = withRemoteCompactionFeature(features).join(",");
};

export const isRetryableLifecycleFailure = (
  value: LifecycleFailure
): boolean => {
  if (value.kind === "network" || value.kind === "premature") {
    return true;
  }
  return (
    value.kind === "http" &&
    value.status !== undefined &&
    (value.status === 408 ||
      value.status === 409 ||
      (value.status >= 500 && value.status <= 599))
  );
};

const classifySseFailure = (
  error: unknown,
  signal: AbortSignal
): LifecycleFailure => {
  if (signal.aborted) {
    return failure("abort");
  }
  if (!isCompactionSseFailure(error)) {
    return failure("network");
  }
  if (error.compactionSseCode === "http") {
    return failure("http", error.status);
  }
  if (error.compactionSseCode === "premature") {
    return failure("premature");
  }
  return failure("invalid-output");
};

const validUsage = (usage: Usage) =>
  [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);

export const hasUnsupportedCompactionInput = (
  input: readonly ResponsesInputItem[]
) => input.some((item) => item.type === "agent_message");

const prepareProviderPayload = (
  payload: unknown,
  options: RegisteredProviderCompactionOptions
): {
  readonly payload: Record<string, unknown>;
  readonly prepared: PreparedInput;
} => {
  if (!isRecord(payload) || !Array.isArray(payload.input)) {
    throw new Error("Provider payload does not contain Responses input");
  }
  const serializedInput = JSON.stringify(payload.input);
  if (!serializedInput) {
    throw new Error("Provider payload input is not serializable");
  }
  const providerInput: unknown = JSON.parse(serializedInput);
  if (!Array.isArray(providerInput) || !providerInput.every(isRecord)) {
    throw new Error("Provider payload input is malformed");
  }
  const effectiveInput = [
    ...options.inputPrefix,
    ...(options.authoritativeInput ?? providerInput),
  ];
  if (hasUnsupportedCompactionInput(effectiveInput)) {
    throw new Error("agent_message input cannot be retained safely");
  }
  if (effectiveInput.some((item) => item.type === "compaction_trigger")) {
    throw new Error("Provider payload already contains a compaction trigger");
  }
  const modalitySafeInput = omitUnsupportedUserImages(
    effectiveInput,
    options.model.input.includes("image")
  );
  const normalized = normalizeToolHistory(modalitySafeInput);
  const window = contextWindowDecision(options.model.contextWindow);
  if (!window) {
    throw new Error("Model context window is unavailable");
  }
  const sourceInput = shrinkTrailingOutputs(
    normalized,
    typeof options.authoritativeEnvelope?.instructions === "string"
      ? options.authoritativeEnvelope.instructions
      : (options.context.systemPrompt ?? ""),
    window.effectiveWindowTokens
  );
  const estimatedSourceTokens = estimateModelVisibleTokens(
    typeof options.authoritativeEnvelope?.instructions === "string"
      ? options.authoritativeEnvelope.instructions
      : (options.context.systemPrompt ?? ""),
    sourceInput
  );
  return {
    payload: {
      ...(options.authoritativeEnvelope ?? payload),
      input: [...sourceInput, { type: "compaction_trigger" }],
    },
    prepared: {
      estimatedSourceTokens,
    },
  };
};

const consumeProviderStream = async (
  stream: AssistantMessageEventStream
): Promise<{
  readonly failure?: LifecycleFailure;
  readonly message?: AssistantMessage;
}> => {
  let message: AssistantMessage | undefined;
  let streamFailure: LifecycleFailure | undefined;
  for await (const event of stream) {
    if (event.type === "done") {
      const { message: completedMessage } = event;
      message = completedMessage;
    } else if (event.type === "error") {
      streamFailure = failure(
        event.error.stopReason === "aborted" ? "abort" : "provider"
      );
    }
  }
  return { failure: streamFailure, message };
};

const runSingleAttempt = async (
  options: RegisteredProviderCompactionOptions
): Promise<LifecycleExecutionResult> => {
  const attemptController = new AbortController();
  const signal = AbortSignal.any([options.signal, attemptController.signal]);
  let fetchFailure: LifecycleFailure | undefined;
  let observed: ReturnType<typeof collectCompactionSse> | undefined;
  let payloadFailure: LifecycleFailure | undefined;
  let prepared: PreparedInput | undefined;

  const fetch: FetchFunction = async (input, init) => {
    let response: Response;
    try {
      response = await globalThis.fetch(input, {
        ...init,
        redirect: "manual",
      });
    } catch (error) {
      fetchFailure = failure(signal.aborted ? "abort" : "network");
      throw error;
    }
    observed = collectCompactionSse(response.clone(), signal);
    // The same promise is awaited after Pi's provider stream terminates.
    void Promise.allSettled([observed]);
    return response;
  };

  const onPayload = (payload: unknown) => {
    try {
      const { payload: preparedPayload, prepared: nextPrepared } =
        prepareProviderPayload(payload, options);
      prepared = nextPrepared;
      return preparedPayload;
    } catch (error) {
      payloadFailure = failure("invalid-output");
      throw error;
    }
  };

  let providerMessage: AssistantMessage | undefined;
  let providerFailure: LifecycleFailure | undefined;
  try {
    const providerResult = await consumeProviderStream(
      options.provider.streamSimple(options.model, options.context, {
        apiKey: options.apiKey,
        env: options.env,
        fetch,
        headers: mergeRemoteCompactionHeaders(
          options.headers,
          options.model.headers,
          options.provider.headers
        ),
        maxRetries: 0,
        onPayload,
        reasoning: options.thinkingLevel,
        sessionId: options.sessionId,
        signal,
        transport: "sse",
      })
    );
    providerMessage = providerResult.message;
    providerFailure = providerResult.failure;
  } catch {
    providerFailure =
      fetchFailure ?? failure(signal.aborted ? "abort" : "network");
  }

  if (payloadFailure) {
    attemptController.abort();
    return { failure: payloadFailure, ok: false };
  }
  if (fetchFailure && !observed) {
    attemptController.abort();
    return { failure: fetchFailure, ok: false };
  }
  if (signal.aborted) {
    attemptController.abort();
    return { failure: failure("abort"), ok: false };
  }

  let raw: Awaited<ReturnType<typeof collectCompactionSse>>;
  try {
    if (!observed) {
      attemptController.abort();
      return { failure: failure("premature"), ok: false };
    }
    raw = await observed;
  } catch (error) {
    attemptController.abort();
    return { failure: classifySseFailure(error, options.signal), ok: false };
  }

  if (
    providerFailure ||
    !providerMessage ||
    providerMessage.stopReason !== "stop"
  ) {
    attemptController.abort();
    return {
      failure: providerFailure ?? failure("provider"),
      ok: false,
    };
  }
  if (
    typeof providerMessage.responseId !== "string" ||
    providerMessage.responseId.length === 0 ||
    providerMessage.responseId !== raw.responseId ||
    !validUsage(providerMessage.usage) ||
    !prepared
  ) {
    attemptController.abort();
    return { failure: failure("invalid-output"), ok: false };
  }

  attemptController.abort();
  return {
    ...prepared,
    compaction: raw.compaction,
    ok: true,
    responseId: raw.responseId,
    usage: providerMessage.usage,
  };
};

export const runRegisteredProviderCompaction = async (
  options: RegisteredProviderCompactionOptions
): Promise<LifecycleExecutionResult> => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- retries are sequential
    const result = await runSingleAttempt(options);
    if (
      result.ok ||
      !isRetryableLifecycleFailure(result.failure) ||
      attempt === 3
    ) {
      return result;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- retry delays are sequential
      await delay(RETRY_DELAYS_MS[attempt - 1] ?? 0, null, {
        signal: options.signal,
      });
    } catch {
      return {
        failure: failure("abort"),
        ok: false,
      };
    }
  }
  throw new Error("Compaction retry loop ended unexpectedly");
};

const checkpointUsage = (
  usage: Usage
): NonNullable<Checkpoint["response"]["usage"]> => ({
  cacheRead: usage.cacheRead,
  cacheWrite: usage.cacheWrite,
  input: usage.input,
  output: usage.output,
  totalTokens: usage.totalTokens,
});

export const buildLifecycleCheckpoint = (options: {
  readonly execution: LifecycleExecutionSuccess;
  readonly model: SupportedModel;
  readonly phase: Checkpoint["phase"];
  readonly reason: Checkpoint["reason"];
  readonly retainedUsers: readonly RealUserInputItem[];
}): Checkpoint => {
  const { execution, model, phase, reason, retainedUsers } = options;
  const { compaction } = execution;
  const replacement = buildCheckpointReplacement(retainedUsers, compaction);
  const candidate = {
    identity: {
      api: "openai-codex-responses",
      baseUrl: normalizeBaseUrl(model.baseUrl),
      model: model.id,
      provider: "openai-codex",
    },
    phase,
    protocol: CHECKPOINT_PROTOCOL,
    reason,
    replacement,
    replacementSha256: sha256Canonical(replacement),
    response: {
      id: execution.responseId,
      usage: checkpointUsage(execution.usage),
    },
    schema: CHECKPOINT_SCHEMA,
    sourceTokens: execution.estimatedSourceTokens,
    version: 4,
  };
  const parsed = parseCheckpoint(candidate);
  if (!parsed.ok) {
    throw new Error("Constructed checkpoint failed strict validation");
  }
  return parsed.checkpoint;
};

export const isLifecycleInstallationResolvable = (
  branch: readonly SessionEntry[],
  responseId: string,
  replacementSha256: string
) => {
  const active = resolveActiveCheckpointBoundary(branch);
  return (
    active.kind === "checkpoint" &&
    active.carrier === "lifecycle" &&
    active.checkpoint.response.id === responseId &&
    active.checkpoint.replacementSha256 === replacementSha256
  );
};

export const shouldCompactFinalizedInput = (options: {
  readonly contextWindow: number;
  readonly estimatedTokens: number;
  readonly freshUsageTokens?: number;
  readonly unchangedReplacement?: boolean;
}) => {
  const freshUsage =
    options.freshUsageTokens !== undefined &&
    Number.isSafeInteger(options.freshUsageTokens) &&
    options.freshUsageTokens >= 0
      ? options.freshUsageTokens
      : undefined;
  const tokens =
    freshUsage === undefined
      ? options.estimatedTokens
      : Math.max(options.estimatedTokens, freshUsage);
  return (
    options.unchangedReplacement !== true &&
    shouldAutoCompact(tokens, options.contextWindow)
  );
};

export const isInlineInstallationResolvable = (
  branch: readonly SessionEntry[],
  previousLeafId: string | null,
  responseId: string,
  replacementSha256: string
) => {
  const active = resolveActiveCheckpointBoundary(branch);
  if (
    active.kind !== "checkpoint" ||
    active.carrier !== "inline" ||
    active.checkpoint.response.id !== responseId ||
    active.checkpoint.replacementSha256 !== replacementSha256
  ) {
    return false;
  }
  const boundary = branch[active.boundaryIndex];
  return (
    boundary?.type === "custom" &&
    boundary.id === branch.at(-1)?.id &&
    boundary.parentId === previousLeafId
  );
};

const modelIdentity = (model: SupportedModel) =>
  [model.provider, model.api, model.id, normalizeBaseUrl(model.baseUrl)].join(
    "\n"
  );

const snapshotLifecycleRequestState = (
  pi: Parameters<ExtensionFactory>[0],
  ctx: ExtensionContext
) => {
  const activeNames = new Set(pi.getActiveTools());
  const tools = pi
    .getAllTools()
    .filter((tool) => activeNames.has(tool.name))
    .map((tool) => ({
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
    }));
  const systemPrompt = ctx.getSystemPrompt();
  const thinkingLevel = pi.getThinkingLevel();
  const serialized = JSON.stringify({ systemPrompt, thinkingLevel, tools });
  if (!serialized) {
    throw new Error("Lifecycle request state is not serializable");
  }
  return {
    hash: sha256Canonical(JSON.parse(serialized)),
    systemPrompt,
    thinkingLevel,
    tools,
  };
};

const notifyOnce = (
  state: LifecycleState,
  key: string,
  ctx: ExtensionContext,
  message: string,
  type: "error" | "warning"
) => {
  if (state.notified.has(key)) {
    return;
  }
  state.notified.add(key);
  ctx.ui.notify(message, type);
};

const resetGeneration = (state: LifecycleState) => {
  state.controller.abort();
  state.controller = new AbortController();
  state.candidate = undefined;
  state.customInstructionsWarned = false;
  state.frame = undefined;
  state.generation += 1;
  state.inFlight = undefined;
  state.notified.clear();
  state.pendingInstall = undefined;
  state.requestHeaders = undefined;
};

const consumeRequestHeaders = (
  state: LifecycleState,
  ctx: ExtensionContext
) => {
  const { requestHeaders } = state;
  state.requestHeaders = undefined;
  const { model } = ctx;
  return requestHeaders !== undefined &&
    isSupportedLifecycleModel(model) &&
    requestHeaders.generation === state.generation &&
    requestHeaders.leafId === ctx.sessionManager.getLeafId() &&
    requestHeaders.modelIdentity === modelIdentity(model)
    ? requestHeaders.headers
    : undefined;
};

const runLifecycleHook = async (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext
): Promise<SessionBeforeCompactResult | undefined> => {
  const { model } = ctx;
  if (!isSupportedLifecycleModel(model)) {
    return undefined;
  }
  if (
    event.customInstructions !== undefined &&
    event.customInstructions.length > 0 &&
    !state.customInstructionsWarned
  ) {
    state.customInstructionsWarned = true;
    ctx.ui.notify(
      "OpenAI remote compaction ignores custom /compact instructions.",
      "warning"
    );
  }

  let source: LifecycleSource;
  let operationKey: string;
  let requestSnapshot: ReturnType<typeof snapshotLifecycleRequestState>;
  try {
    normalizeBaseUrl(model.baseUrl);
    source = buildLifecycleSource(event.branchEntries, model);
    requestSnapshot = snapshotLifecycleRequestState(pi, ctx);
    operationKey = sha256Canonical({
      branch: source.branchSha256,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      model: modelIdentity(model),
      reason: event.reason,
      requestState: requestSnapshot.hash,
      tokensBefore: event.preparation.tokensBefore,
    });
  } catch {
    notifyOnce(
      state,
      "unsafe-source",
      ctx,
      "OpenAI remote compaction was cancelled because active context is unsafe.",
      "error"
    );
    return { cancel: true };
  }
  if (source.ignoredInvalidInlineCheckpoint) {
    notifyOnce(
      state,
      `${source.branchSha256}:invalid-inline`,
      ctx,
      "A corrupt inline OpenAI checkpoint was ignored because authoritative Pi context is still available.",
      "warning"
    );
  }

  if (state.inFlight) {
    if (
      state.inFlight.kind === "lifecycle" &&
      state.inFlight.key === operationKey
    ) {
      return await state.inFlight.promise;
    }
    return { cancel: true };
  }

  const { generation } = state;
  const leafId = ctx.sessionManager.getLeafId();
  const identity = modelIdentity(model);
  const signal = AbortSignal.any([event.signal, state.controller.signal]);

  const operation = (async (): Promise<SessionBeforeCompactResult> => {
    ctx.ui.setStatus(STATUS_KEY, STATUS_MESSAGE);
    try {
      const provider = ctx.modelRegistry.getProvider(model.provider);
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!provider || !auth.ok || !hasResolvedLifecycleAuth(auth.apiKey)) {
        notifyOnce(
          state,
          `${operationKey}:auth`,
          ctx,
          "OpenAI remote compaction was cancelled because provider authentication is unavailable.",
          "error"
        );
        return { cancel: true };
      }

      const execution = await runRegisteredProviderCompaction({
        apiKey: auth.apiKey,
        context: {
          messages: source.contextMessages,
          systemPrompt: requestSnapshot.systemPrompt,
          tools: requestSnapshot.tools,
        },
        env: auth.env,
        headers: auth.headers,
        inputPrefix: source.inputPrefix,
        model,
        provider,
        sessionId: ctx.sessionManager.getSessionId(),
        signal,
        thinkingLevel:
          requestSnapshot.thinkingLevel === "off"
            ? undefined
            : requestSnapshot.thinkingLevel,
      });
      if (!execution.ok) {
        notifyOnce(
          state,
          `${operationKey}:remote`,
          ctx,
          "OpenAI remote compaction failed; local context was left unchanged.",
          "error"
        );
        return { cancel: true };
      }
      if (
        signal.aborted ||
        state.generation !== generation ||
        ctx.sessionManager.getLeafId() !== leafId ||
        branchSha256(ctx.sessionManager.getBranch()) !== source.branchSha256 ||
        !isSupportedLifecycleModel(ctx.model) ||
        modelIdentity(ctx.model) !== identity ||
        snapshotLifecycleRequestState(pi, ctx).hash !== requestSnapshot.hash
      ) {
        notifyOnce(
          state,
          `${operationKey}:stale`,
          ctx,
          "OpenAI remote compaction was discarded because the session changed.",
          "error"
        );
        return { cancel: true };
      }

      const checkpoint = buildLifecycleCheckpoint({
        execution,
        model,
        phase: event.reason === "overflow" ? "overflow-retry" : "standalone",
        reason: event.reason,
        retainedUsers: source.retainedUsers,
      });
      state.pendingInstall = {
        generation,
        replacementSha256: checkpoint.replacementSha256,
        responseId: checkpoint.response.id,
      };
      return {
        compaction: {
          details: {
            checkpoint,
            type: CHECKPOINT_CUSTOM_TYPE,
          },
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          summary: ENCRYPTED_CHECKPOINT_MARKER,
          tokensBefore: event.preparation.tokensBefore,
          usage: execution.usage,
        } satisfies CompactionResult,
      };
    } catch {
      notifyOnce(
        state,
        `${operationKey}:failure`,
        ctx,
        "OpenAI remote compaction failed; local context was left unchanged.",
        "error"
      );
      return { cancel: true };
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  })();

  state.inFlight = {
    key: operationKey,
    kind: "lifecycle",
    promise: operation,
  };
  try {
    return await operation;
  } finally {
    if (state.inFlight?.promise === operation) {
      state.inFlight = undefined;
    }
  }
};

type ReplayBoundaryDecision =
  | { readonly kind: "active"; readonly boundary: ActiveNativeCheckpoint }
  | { readonly kind: "blocked" | "fallback" | "none" };

const replayBoundaryDecision = (
  branch: readonly SessionEntry[],
  model: Model<string> | undefined
): ReplayBoundaryDecision => {
  const boundary = resolveActiveCheckpointBoundary(branch);
  if (boundary.kind === "invalid-checkpoint") {
    return boundary.carrier === "inline" &&
      canUseInlineLocalFallback(branch, boundary.boundaryIndex)
      ? { kind: "fallback" }
      : { kind: "blocked" };
  }
  if (boundary.kind !== "checkpoint") {
    return { kind: "none" };
  }
  const compatibility = model
    ? decideCheckpointCompatibility(boundary.checkpoint, {
        api: model.api,
        baseUrl: model.baseUrl,
        model: model.id,
        provider: model.provider,
      })
    : undefined;
  if (compatibility?.compatible === true) {
    return { boundary, kind: "active" };
  }
  return boundary.carrier === "inline" &&
    canUseInlineLocalFallback(branch, boundary.boundaryIndex)
    ? { kind: "fallback" }
    : { kind: "blocked" };
};

const contextSourceMessages = (
  branch: readonly SessionEntry[],
  activeCheckpoint?: ActiveNativeCheckpoint
) =>
  activeCheckpoint
    ? activeCheckpoint.tail.flatMap(sessionEntryToContextMessages)
    : buildSessionContext([...branch]).messages;

const hashJsonClone = (value: unknown) => {
  const serialized = JSON.stringify(value);
  if (!serialized) {
    throw new Error("Value is not JSON serializable");
  }
  return sha256Canonical(JSON.parse(serialized));
};

const messageDiagnostic = (
  message: ContextEvent["messages"][number] | undefined
): Readonly<Record<string, unknown>> | undefined => {
  if (!message) {
    return undefined;
  }
  const content = "content" in message ? message.content : undefined;
  const contentTypes = Array.isArray(content)
    ? content.map((contentItem: unknown) =>
        isRecord(contentItem) && typeof contentItem.type === "string"
          ? contentItem.type
          : typeof contentItem
      )
    : [typeof content];
  return {
    contentTypes,
    hash: hashJsonClone(message),
    role: message.role,
    ...("stopReason" in message && typeof message.stopReason === "string"
      ? { stopReason: message.stopReason }
      : {}),
    ...("toolName" in message && typeof message.toolName === "string"
      ? { toolName: message.toolName }
      : {}),
  };
};

export const buildContextFrameDiagnostic = (options: {
  readonly baseline: readonly ContextEvent["messages"][number][];
  readonly boundaryEntryId: string;
  readonly branchSha256: string;
  readonly eventMessages: readonly ContextEvent["messages"][number][];
  readonly frameResult: "ambiguous" | "missing";
  readonly framedSegment: readonly ContextEvent["messages"][number][];
}) => {
  const eventHashes = options.eventMessages.map(hashJsonClone);
  const baselineHashes = options.baseline.map(hashJsonClone);
  const comparableLength = Math.min(eventHashes.length, baselineHashes.length);
  let commonPrefixMessages = 0;
  while (
    commonPrefixMessages < comparableLength &&
    eventHashes[commonPrefixMessages] === baselineHashes[commonPrefixMessages]
  ) {
    commonPrefixMessages += 1;
  }
  let commonSuffixMessages = 0;
  while (
    commonPrefixMessages + commonSuffixMessages < comparableLength &&
    eventHashes[eventHashes.length - 1 - commonSuffixMessages] ===
      baselineHashes[baselineHashes.length - 1 - commonSuffixMessages]
  ) {
    commonSuffixMessages += 1;
  }

  return {
    baseline: {
      hash: hashJsonClone(options.baseline),
      messageCount: options.baseline.length,
      mismatch: messageDiagnostic(options.baseline[commonPrefixMessages]),
    },
    boundaryEntryId: options.boundaryEntryId,
    branchSha256: options.branchSha256,
    commonPrefixMessages,
    commonSuffixMessages,
    event: {
      hash: hashJsonClone(options.eventMessages),
      messageCount: options.eventMessages.length,
      mismatch: messageDiagnostic(options.eventMessages[commonPrefixMessages]),
    },
    frameResult: options.frameResult,
    framedSegment: {
      hash: hashJsonClone(options.framedSegment),
      messageCount: options.framedSegment.length,
    },
    kind: "context-frame",
    version: 1,
  } as const;
};

const jsonInputClone = (
  input: readonly unknown[]
): readonly ResponsesInputItem[] => {
  const serialized = JSON.stringify(input);
  if (!serialized) {
    throw new Error("Responses input is not JSON serializable");
  }
  const cloned: unknown = JSON.parse(serialized);
  if (!Array.isArray(cloned) || !cloned.every(isRecord)) {
    throw new Error("Responses input clone is invalid");
  }
  return cloned;
};

const FALLBACK_ASSISTANT_ID = /^msg_pi_\d+(?:_\d+)?$/u;

const assistantMessageItems = (input: readonly unknown[]) =>
  input.filter(
    (
      item
    ): item is Readonly<Record<string, unknown>> & {
      readonly id: string;
    } =>
      isRecord(item) &&
      item.type === "message" &&
      item.role === "assistant" &&
      typeof item.id === "string"
  );

export const buildFallbackAssistantIdMap = (
  markerfulInput: readonly unknown[],
  logicalInput: readonly unknown[]
): Readonly<Record<string, string>> => {
  const markerful = assistantMessageItems(markerfulInput);
  const logical = assistantMessageItems(logicalInput);
  if (markerful.length !== logical.length) {
    throw new Error("Framing changed assistant message cardinality");
  }
  const mapping: Record<string, string> = {};
  for (const [index, item] of markerful.entries()) {
    const oldId = item.id;
    const newId = logical[index]?.id;
    if (typeof newId !== "string" || oldId === newId) {
      continue;
    }
    if (
      !FALLBACK_ASSISTANT_ID.test(oldId) ||
      !FALLBACK_ASSISTANT_ID.test(newId) ||
      mapping[oldId] !== undefined
    ) {
      throw new Error("Framing changed a non-fallback assistant identity");
    }
    mapping[oldId] = newId;
  }
  return mapping;
};

export const correctFallbackAssistantIds = (
  input: readonly ResponsesInputItem[],
  mapping: Readonly<Record<string, string>>
): readonly ResponsesInputItem[] => {
  const pending = new Map(Object.entries(mapping).map(([id]) => [id, 0]));
  const corrected = input.map((item) => {
    if (
      item.type !== "message" ||
      item.role !== "assistant" ||
      typeof item.id !== "string"
    ) {
      return item;
    }
    const replacement = mapping[item.id];
    if (!replacement) {
      return item;
    }
    pending.set(item.id, (pending.get(item.id) ?? 0) + 1);
    return { ...item, id: replacement };
  });
  if ([...pending.values()].some((count) => count !== 1)) {
    throw new Error("Finalized fallback assistant identity is ambiguous");
  }
  return corrected;
};

export const hasMarkerFreeStructuralParity = (
  markerfulInput: readonly unknown[],
  logicalInput: readonly unknown[],
  nonce: string,
  fallbackAssistantIds: Readonly<Record<string, string>>
) => {
  try {
    const markerful = jsonInputClone(markerfulInput);
    const logical = jsonInputClone(logicalInput);
    const extracted = extractFinalizedFrame(markerful, nonce);
    if (extracted.kind !== "ok") {
      return false;
    }
    const corrected = correctFallbackAssistantIds(
      rewriteFramedInput(extracted, []),
      fallbackAssistantIds
    );
    return sha256Canonical(corrected) === sha256Canonical(logical);
  } catch {
    return false;
  }
};

const sentinelMessage = (
  edge: "end" | "start",
  nonce: string
): ContextEvent["messages"][number] => ({
  content: [{ text: frameMarkerText(edge, nonce), type: "text" }],
  role: "user",
  timestamp: Date.now(),
});

// Pi persists auto-retry errors but removes them from live agent context.
const isPersistedRetryError = (message: ContextEvent["messages"][number]) =>
  message.role === "assistant" && message.stopReason === "error";

const isMidTurnBranch = (branch: readonly SessionEntry[]) => {
  for (const entry of branch.toReversed()) {
    const messages = sessionEntryToContextMessages(entry);
    if (messages.length === 0) {
      continue;
    }
    return messages.at(-1)?.role === "toolResult";
  }
  return false;
};

const abortUnsafeRequest = (
  state: LifecycleState,
  ctx: ExtensionContext,
  key: string,
  message: string
) => {
  ctx.abort();
  notifyOnce(state, key, ctx, message, "error");
};

const inlineFailureMessage = (
  kind: Exclude<InlineOperationResult["kind"], "success">
) => {
  if (kind === "stale") {
    return "OpenAI checkpoint input changed before completion; the result was discarded.";
  }
  if (kind === "persistence") {
    return "OpenAI checkpoint persistence could not be verified; the model request was cancelled.";
  }
  if (kind === "unsupported-input") {
    return "OpenAI checkpoint generation was blocked because agent_message input cannot be retained safely.";
  }
  return "OpenAI checkpoint generation failed; the model request was cancelled.";
};

const isPossibleAutomaticThreshold = (
  model: SupportedModel,
  usage: ReturnType<ExtensionContext["getContextUsage"]>
) => {
  const window = contextWindowDecision(model.contextWindow);
  if (!window) {
    return false;
  }
  return (
    usage?.tokens === null ||
    usage?.tokens === undefined ||
    usage.tokens >= window.autoCompactTokens
  );
};

const captureUnframedCandidate = (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  branch: readonly SessionEntry[],
  model: SupportedModel,
  ctx: ExtensionContext
) => {
  const requestSnapshot = snapshotLifecycleRequestState(pi, ctx);
  state.candidate = {
    branchSha256: branchSha256(branch),
    generation: state.generation,
    leafId: ctx.sessionManager.getLeafId(),
    modelIdentity: modelIdentity(model),
    phase: isMidTurnBranch(branch) ? "mid-turn" : "pre-sampling",
    requestStateSha256: requestSnapshot.hash,
  };
};

const runContextHook = (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  event: ContextEvent,
  ctx: ExtensionContext
): { readonly messages: ContextEvent["messages"] } | undefined => {
  state.candidate = undefined;
  state.frame = undefined;
  state.requestHeaders = undefined;
  const branch = ctx.sessionManager.getBranch();
  const decision = replayBoundaryDecision(branch, ctx.model);
  if (decision.kind === "blocked") {
    abortUnsafeRequest(
      state,
      ctx,
      `context:${branchSha256(branch)}`,
      "OpenAI checkpoint replay was blocked because active native context is unsafe."
    );
    return undefined;
  }
  if (decision.kind === "fallback") {
    notifyOnce(
      state,
      `fallback:${branchSha256(branch)}`,
      ctx,
      "An incompatible inline OpenAI checkpoint was ignored because authoritative Pi context is available.",
      "warning"
    );
  }
  const { model } = ctx;
  if (!isSupportedLifecycleModel(model) || decision.kind === "fallback") {
    return undefined;
  }

  const activeCheckpoint =
    decision.kind === "active" ? decision.boundary : undefined;
  const usage = ctx.getContextUsage();
  const possibleThreshold = isPossibleAutomaticThreshold(model, usage);
  if (!activeCheckpoint && !possibleThreshold) {
    captureUnframedCandidate(pi, state, branch, model, ctx);
    return undefined;
  }

  const baseline = buildSessionContext([...branch]).messages;
  const framedSegment = contextSourceMessages(branch, activeCheckpoint);
  const nonce = uuidv7();
  const framed = frameContiguousBaseline(
    event.messages,
    baseline,
    framedSegment,
    sentinelMessage("start", nonce),
    sentinelMessage("end", nonce),
    isPersistedRetryError
  );
  if (framed.kind !== "ok") {
    if (activeCheckpoint) {
      const notificationKey = `frame:${activeCheckpoint.boundaryEntryId}`;
      let diagnosticRecorded = false;
      if (!state.notified.has(notificationKey)) {
        try {
          pi.appendEntry(
            CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE,
            buildContextFrameDiagnostic({
              baseline,
              boundaryEntryId: activeCheckpoint.boundaryEntryId,
              branchSha256: branchSha256(branch),
              eventMessages: event.messages,
              frameResult: framed.kind,
              framedSegment,
            })
          );
          diagnosticRecorded = true;
        } catch {
          // The request still fails closed if diagnostic persistence fails.
        }
      }
      abortUnsafeRequest(
        state,
        ctx,
        notificationKey,
        `OpenAI checkpoint replay was blocked because request context could not be framed safely.${
          diagnosticRecorded
            ? " A redacted diagnostic was saved with the session."
            : ""
        }`
      );
    } else {
      captureUnframedCandidate(pi, state, branch, model, ctx);
    }
    return undefined;
  }
  const requestSnapshot = snapshotLifecycleRequestState(pi, ctx);
  const markerfulInput = convertResponsesMessages(
    model,
    { messages: convertToLlm([...framed.messages]) },
    ALLOWED_TOOL_CALL_PROVIDERS,
    { includeSystemPrompt: false }
  );
  const logicalInput = convertResponsesMessages(
    model,
    {
      messages: convertToLlm([
        ...framed.prefix,
        ...framed.framed,
        ...framed.suffix,
      ]),
    },
    ALLOWED_TOOL_CALL_PROVIDERS,
    { includeSystemPrompt: false }
  );
  let fallbackAssistantIds: Readonly<Record<string, string>> = {};
  let structuralParity = false;
  try {
    fallbackAssistantIds = buildFallbackAssistantIdMap(
      markerfulInput,
      logicalInput
    );
    structuralParity = hasMarkerFreeStructuralParity(
      markerfulInput,
      logicalInput,
      nonce,
      fallbackAssistantIds
    );
  } catch {
    structuralParity = false;
  }
  if (!structuralParity) {
    if (activeCheckpoint) {
      abortUnsafeRequest(
        state,
        ctx,
        `frame-parity:${activeCheckpoint.boundaryEntryId}`,
        "OpenAI checkpoint replay was blocked because marker framing changed the serialized request."
      );
    } else {
      captureUnframedCandidate(pi, state, branch, model, ctx);
    }
    return undefined;
  }
  state.frame = {
    ...(activeCheckpoint ? { activeCheckpoint } : {}),
    branchSha256: branchSha256(branch),
    fallbackAssistantIds,
    generation: state.generation,
    leafId: ctx.sessionManager.getLeafId(),
    modelIdentity: modelIdentity(model),
    nonce,
    phase: isMidTurnBranch(branch) ? "mid-turn" : "pre-sampling",
    requestStateSha256: requestSnapshot.hash,
  };
  return { messages: [...framed.messages] };
};

export interface FinalizedResponsesEnvelope extends Record<string, unknown> {
  readonly input: readonly ResponsesInputItem[];
}

export const parseFinalizedResponsesEnvelope = (
  payload: unknown,
  model: SupportedModel
): FinalizedResponsesEnvelope | undefined => {
  if (
    !isRecord(payload) ||
    payload.model !== model.id ||
    payload.stream !== true ||
    payload.store !== false ||
    !Array.isArray(payload.input) ||
    !payload.input.every(isRecord) ||
    payload.input.some((item) => item.type === "compaction_trigger")
  ) {
    return undefined;
  }
  return { ...payload, input: payload.input };
};

export const freshAssistantUsageTokens = (
  branch: readonly SessionEntry[],
  boundaryIndex: number,
  model: SupportedModel
): number | undefined => {
  for (let index = branch.length - 1; index > boundaryIndex; index -= 1) {
    const entry = branch[index];
    if (sessionEntryToContextMessages(entry).length === 0) {
      continue;
    }
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    const { message } = entry;
    if (
      message.stopReason === "aborted" ||
      message.stopReason === "error" ||
      message.provider !== model.provider ||
      message.api !== model.api ||
      message.model !== model.id
    ) {
      return undefined;
    }
    const tokens = calculateContextTokens(message.usage);
    return tokens > 0 ? tokens : undefined;
  }
  return undefined;
};

const jsonCloneEnvelope = (
  envelope: FinalizedResponsesEnvelope
): Record<string, unknown> => {
  const serialized = JSON.stringify(envelope);
  if (!serialized) {
    throw new Error("Finalized provider envelope is not serializable");
  }
  const cloned: unknown = JSON.parse(serialized);
  if (!isRecord(cloned)) {
    throw new Error("Finalized provider envelope clone is invalid");
  }
  return cloned;
};

type FinalizedReplayPreparation =
  | { readonly kind: "invalid-markers" | "invalid-payload" }
  | {
      readonly effectiveInput: readonly ResponsesInputItem[];
      readonly envelope: FinalizedResponsesEnvelope;
      readonly extracted: Extract<
        ReturnType<typeof extractFinalizedFrame>,
        { kind: "ok" }
      >;
      readonly kind: "ok";
      readonly model: SupportedModel;
      readonly shouldCompact: boolean;
    };

const prepareFinalizedReplay = (
  payload: unknown,
  model: Model<string> | undefined,
  frame: RequestFrame,
  branch: readonly SessionEntry[]
): FinalizedReplayPreparation => {
  if (!isSupportedLifecycleModel(model)) {
    return { kind: "invalid-payload" };
  }
  const envelope = parseFinalizedResponsesEnvelope(payload, model);
  if (!envelope) {
    return { kind: "invalid-payload" };
  }
  const extracted = extractFinalizedFrame(envelope.input, frame.nonce);
  if (extracted.kind !== "ok") {
    return { kind: "invalid-markers" };
  }
  const replacement =
    frame.activeCheckpoint?.checkpoint.replacement.map((item) => ({
      ...item,
    })) ?? [];
  const effectiveInput = jsonInputClone(
    correctFallbackAssistantIds(
      rewriteFramedInput(extracted, replacement),
      frame.fallbackAssistantIds
    )
  );
  const instructions =
    typeof envelope.instructions === "string" ? envelope.instructions : "";
  const estimatedTokens = estimateModelVisibleTokens(
    instructions,
    effectiveInput
  );
  const freshUsageTokens = freshAssistantUsageTokens(
    branch,
    frame.activeCheckpoint?.boundaryIndex ?? -1,
    model
  );
  const unchangedReplacement =
    Boolean(frame.activeCheckpoint) &&
    extracted.prefix.length === 0 &&
    extracted.framed.length === 0 &&
    extracted.suffix.length === 0 &&
    sha256Canonical(effectiveInput) ===
      frame.activeCheckpoint?.checkpoint.replacementSha256;
  return {
    effectiveInput,
    envelope,
    extracted,
    kind: "ok",
    model,
    shouldCompact: shouldCompactFinalizedInput({
      contextWindow: model.contextWindow,
      estimatedTokens,
      freshUsageTokens,
      unchangedReplacement,
    }),
  };
};

const runInlineCompactionOperation = async (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  ctx: ExtensionContext,
  options: {
    readonly authoritativeEnvelope: Record<string, unknown>;
    readonly authoritativeInput: readonly ResponsesInputItem[];
    readonly branch: readonly SessionEntry[];
    readonly current: () => boolean;
    readonly discriminator: string;
    readonly headers?: Readonly<ProviderHeaders>;
    readonly model: SupportedModel;
    readonly request: RequestFrame | UnframedCandidate;
  }
): Promise<{
  readonly operationKey: string;
  readonly result: InlineOperationResult;
}> => {
  const {
    authoritativeEnvelope,
    authoritativeInput,
    branch,
    current,
    discriminator,
    headers,
    model,
    request,
  } = options;
  const sourceSha256 = sha256Canonical(authoritativeInput);
  const operationKey = sha256Canonical({
    branch: request.branchSha256,
    discriminator,
    envelope: hashJsonClone(authoritativeEnvelope),
    requestState: request.requestStateSha256,
    source: sourceSha256,
  });
  const signals = [state.controller.signal];
  if (ctx.signal) {
    signals.push(ctx.signal);
  }
  const signal = AbortSignal.any(signals);
  const operation = (async (): Promise<InlineOperationResult> => {
    ctx.ui.setStatus(STATUS_KEY, STATUS_MESSAGE);
    try {
      if (hasUnsupportedCompactionInput(authoritativeInput)) {
        return { kind: "unsupported-input" };
      }
      const provider = ctx.modelRegistry.getProvider(model.provider);
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (
        !provider ||
        !auth.ok ||
        !hasResolvedLifecycleAuth(auth.apiKey) ||
        !headers
      ) {
        return { kind: "remote" };
      }
      const requestSnapshot = snapshotLifecycleRequestState(pi, ctx);
      if (requestSnapshot.hash !== request.requestStateSha256) {
        return { kind: "stale" };
      }
      const source = buildLifecycleSource(branch, model);
      const execution = await runRegisteredProviderCompaction({
        apiKey: auth.apiKey,
        authoritativeEnvelope,
        authoritativeInput,
        context: {
          messages: [],
          systemPrompt: requestSnapshot.systemPrompt,
          tools: requestSnapshot.tools,
        },
        env: auth.env,
        headers,
        inputPrefix: [],
        model,
        provider,
        sessionId: ctx.sessionManager.getSessionId(),
        signal,
        thinkingLevel:
          requestSnapshot.thinkingLevel === "off"
            ? undefined
            : requestSnapshot.thinkingLevel,
      });
      const currentBranch = ctx.sessionManager.getBranch();
      if (!execution.ok) {
        return { kind: "remote" };
      }
      if (
        signal.aborted ||
        state.generation !== request.generation ||
        ctx.sessionManager.getLeafId() !== request.leafId ||
        branchSha256(currentBranch) !== request.branchSha256 ||
        !isSupportedLifecycleModel(ctx.model) ||
        modelIdentity(ctx.model) !== request.modelIdentity ||
        !current() ||
        snapshotLifecycleRequestState(pi, ctx).hash !==
          request.requestStateSha256 ||
        sha256Canonical(authoritativeInput) !== sourceSha256
      ) {
        return { kind: "stale" };
      }
      const checkpoint = buildLifecycleCheckpoint({
        execution,
        model,
        phase: request.phase,
        reason: "threshold",
        retainedUsers: source.retainedUsers,
      });
      const requestReplacement = buildTransientCheckpointReplacement(
        omitUnsupportedImagesFromUsers(source.retainedUsers, model),
        execution.compaction
      ).map((item) => ({ ...item }));
      pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, checkpoint);
      const installedBranch = ctx.sessionManager.getBranch();
      if (
        state.generation !== request.generation ||
        !isInlineInstallationResolvable(
          installedBranch,
          request.leafId,
          checkpoint.response.id,
          checkpoint.replacementSha256
        )
      ) {
        return { kind: "persistence" };
      }
      return { checkpoint, kind: "success", requestReplacement };
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  })();
  state.inFlight = {
    key: operationKey,
    kind: "inline",
    promise: operation,
  };
  let result: InlineOperationResult;
  try {
    result = await operation;
  } catch {
    result = { kind: "remote" };
  } finally {
    if (state.inFlight?.promise === operation) {
      state.inFlight = undefined;
    }
  }
  return { operationKey, result };
};

const runUnframedCandidateHook = async (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  candidate: UnframedCandidate,
  headers: Readonly<ProviderHeaders> | undefined,
  payload: unknown,
  ctx: ExtensionContext
): Promise<unknown> => {
  const { model } = ctx;
  if (
    candidate.generation !== state.generation ||
    candidate.requestStateSha256 !==
      snapshotLifecycleRequestState(pi, ctx).hash ||
    !isSupportedLifecycleModel(model) ||
    candidate.modelIdentity !== modelIdentity(model)
  ) {
    state.candidate = undefined;
    abortUnsafeRequest(
      state,
      ctx,
      `candidate-state:${candidate.branchSha256}`,
      "OpenAI inline compaction was blocked because the finalized request is unsafe."
    );
    return payload;
  }
  const branch = ctx.sessionManager.getBranch();
  if (
    ctx.sessionManager.getLeafId() !== candidate.leafId ||
    branchSha256(branch) !== candidate.branchSha256
  ) {
    state.candidate = undefined;
    abortUnsafeRequest(
      state,
      ctx,
      `candidate-branch:${candidate.branchSha256}`,
      "OpenAI inline compaction was blocked because session context changed after context preparation."
    );
    return payload;
  }
  const envelope = parseFinalizedResponsesEnvelope(payload, model);
  if (!envelope) {
    state.candidate = undefined;
    abortUnsafeRequest(
      state,
      ctx,
      `candidate-payload:${candidate.branchSha256}`,
      "OpenAI inline compaction was blocked because the finalized request is unsafe."
    );
    return payload;
  }
  const authoritativeInput = jsonInputClone(envelope.input);
  const instructions =
    typeof envelope.instructions === "string" ? envelope.instructions : "";
  const shouldCompact = shouldCompactFinalizedInput({
    contextWindow: model.contextWindow,
    estimatedTokens: estimateModelVisibleTokens(
      instructions,
      authoritativeInput
    ),
    freshUsageTokens: freshAssistantUsageTokens(branch, -1, model),
  });
  if (!shouldCompact) {
    state.candidate = undefined;
    return payload;
  }
  if (state.inFlight) {
    state.candidate = undefined;
    abortUnsafeRequest(
      state,
      ctx,
      `candidate-concurrent:${candidate.branchSha256}`,
      "OpenAI inline compaction was cancelled because another compaction is active."
    );
    return payload;
  }

  const authoritativeEnvelope = jsonCloneEnvelope(envelope);
  const { operationKey, result } = await runInlineCompactionOperation(
    pi,
    state,
    ctx,
    {
      authoritativeEnvelope,
      authoritativeInput,
      branch,
      current: () => state.candidate === candidate,
      discriminator: "unframed",
      headers,
      model,
      request: candidate,
    }
  );
  state.candidate = undefined;
  if (result.kind !== "success") {
    abortUnsafeRequest(
      state,
      ctx,
      `candidate:${result.kind}:${operationKey}`,
      inlineFailureMessage(result.kind)
    );
    return payload;
  }
  return {
    ...envelope,
    input: result.requestReplacement,
  };
};

const runBeforeProviderRequestHook = async (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  headers: Readonly<ProviderHeaders> | undefined,
  payload: unknown,
  ctx: ExtensionContext
): Promise<unknown> => {
  const { frame } = state;
  if (!frame) {
    const { candidate } = state;
    return candidate
      ? await runUnframedCandidateHook(
          pi,
          state,
          candidate,
          headers,
          payload,
          ctx
        )
      : payload;
  }
  if (
    frame.generation !== state.generation ||
    frame.requestStateSha256 !== snapshotLifecycleRequestState(pi, ctx).hash
  ) {
    state.frame = undefined;
    abortUnsafeRequest(
      state,
      ctx,
      `payload:${frame.nonce}`,
      "OpenAI checkpoint replay was blocked because the finalized request is unsafe."
    );
    return payload;
  }
  const branch = ctx.sessionManager.getBranch();
  if (
    ctx.sessionManager.getLeafId() !== frame.leafId ||
    branchSha256(branch) !== frame.branchSha256
  ) {
    state.frame = undefined;
    abortUnsafeRequest(
      state,
      ctx,
      `stale-frame:${frame.nonce}`,
      "OpenAI checkpoint replay was blocked because session context changed after framing."
    );
    return payload;
  }
  const prepared = prepareFinalizedReplay(payload, ctx.model, frame, branch);
  if (prepared.kind !== "ok") {
    state.frame = undefined;
    abortUnsafeRequest(
      state,
      ctx,
      `${prepared.kind}:${frame.nonce}`,
      prepared.kind === "invalid-markers"
        ? "OpenAI checkpoint replay was blocked because request markers are invalid."
        : "OpenAI checkpoint replay was blocked because the finalized request is unsafe."
    );
    return payload;
  }
  const { effectiveInput, envelope, extracted, model, shouldCompact } =
    prepared;
  if (frame.modelIdentity !== modelIdentity(model)) {
    state.frame = undefined;
    abortUnsafeRequest(
      state,
      ctx,
      `identity:${frame.nonce}`,
      "OpenAI checkpoint replay was blocked because model identity changed."
    );
    return payload;
  }
  if (!shouldCompact) {
    state.frame = undefined;
    return { ...envelope, input: effectiveInput };
  }
  if (state.inFlight) {
    state.frame = undefined;
    abortUnsafeRequest(
      state,
      ctx,
      `concurrent:${frame.nonce}`,
      "OpenAI inline compaction was cancelled because another compaction is active."
    );
    return payload;
  }

  const authoritativeEnvelope = jsonCloneEnvelope(envelope);
  const authoritativeInput = structuredClone(effectiveInput);
  const { operationKey, result } = await runInlineCompactionOperation(
    pi,
    state,
    ctx,
    {
      authoritativeEnvelope,
      authoritativeInput,
      branch,
      current: () => state.frame === frame,
      discriminator: frame.nonce,
      headers,
      model,
      request: frame,
    }
  );
  state.frame = undefined;
  if (result.kind !== "success") {
    abortUnsafeRequest(
      state,
      ctx,
      `inline:${result.kind}:${operationKey}`,
      inlineFailureMessage(result.kind)
    );
    return payload;
  }
  return {
    ...envelope,
    input: [
      ...extracted.prefix,
      ...result.requestReplacement,
      ...extracted.suffix,
    ],
  };
};

const createLifecycleState = (): LifecycleState => ({
  controller: new AbortController(),
  customInstructionsWarned: false,
  generation: 0,
  notified: new Set(),
});

const registerLifecycleHooks = (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState
) => {
  pi.on("session_start", () => {
    resetGeneration(state);
  });
  pi.on("model_select", () => {
    resetGeneration(state);
  });
  pi.on("session_shutdown", () => {
    state.controller.abort();
    state.candidate = undefined;
    state.frame = undefined;
    state.generation += 1;
    state.inFlight = undefined;
    state.pendingInstall = undefined;
    state.requestHeaders = undefined;
  });
  pi.on("session_before_compact", (event, ctx) =>
    runLifecycleHook(pi, state, event, ctx)
  );
  pi.on("session_compact", (_event, ctx) => {
    const pending = state.pendingInstall;
    state.pendingInstall = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (!pending) {
      return;
    }
    if (
      state.generation !== pending.generation ||
      !isLifecycleInstallationResolvable(
        ctx.sessionManager.getBranch(),
        pending.responseId,
        pending.replacementSha256
      )
    ) {
      notifyOnce(
        state,
        `install:${pending.responseId}`,
        ctx,
        "OpenAI compaction checkpoint installation could not be verified.",
        "error"
      );
    }
  });
};

export const lifecycleExtension: ExtensionFactory = (pi) => {
  registerLifecycleHooks(pi, createLifecycleState());
};

export const codexCompactionExtension: ExtensionFactory = (pi) => {
  registerCheckpointRenderer(pi);
  const state = createLifecycleState();
  registerLifecycleHooks(pi, state);
  pi.on("context", (event, ctx): ReturnType<typeof runContextHook> => {
    try {
      return runContextHook(pi, state, event, ctx);
    } catch {
      state.candidate = undefined;
      state.frame = undefined;
      abortUnsafeRequest(
        state,
        ctx,
        "context:failure",
        "OpenAI checkpoint context preparation failed; the model request was cancelled."
      );
      return undefined;
    }
  });
  pi.on("before_provider_request", async (event, ctx) => {
    const headers = consumeRequestHeaders(state, ctx);
    try {
      return await runBeforeProviderRequestHook(
        pi,
        state,
        headers,
        event.payload,
        ctx
      );
    } catch {
      state.candidate = undefined;
      state.frame = undefined;
      abortUnsafeRequest(
        state,
        ctx,
        "payload:failure",
        "OpenAI checkpoint request preparation failed; the model request was cancelled."
      );
      return event.payload;
    }
  });
  pi.on("before_provider_headers", (event, ctx) => {
    if (isSupportedLifecycleModel(ctx.model)) {
      mergeRemoteCompactionFeatureHeader(event.headers);
      state.requestHeaders = {
        generation: state.generation,
        headers: { ...event.headers },
        leafId: ctx.sessionManager.getLeafId(),
        modelIdentity: modelIdentity(ctx.model),
      };
    } else {
      state.requestHeaders = undefined;
    }
  });
};
