import { uuidv7 } from "@earendil-works/pi-ai";
import type {
  Context,
  Model,
  ProviderHeaders,
  Usage,
} from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  buildSessionContext,
  calculateContextTokens,
  compact,
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
  LEGACY_CHECKPOINT_SUMMARY as LEGACY_MARKER,
  REMOTE_USER_IMAGE_PLACEHOLDER,
  canUseInlineLocalFallback,
  decideCheckpointCompatibility,
  isPortableLifecycleCompaction,
  normalizeBaseUrl,
  parseAgentMessageItem,
  parseCheckpoint,
  parseRealUserInputItem,
  resolveActiveCheckpointBoundary,
  sha256Canonical,
} from "./checkpoint.js";
import type {
  CanonicalCompactionItem,
  Checkpoint,
  CheckpointAgentMessageItem,
  CheckpointV5,
  RealUserInputItem,
} from "./checkpoint.js";
import {
  createCodexProviderRuntime,
  isCodexCompactionCurrentModelFallbackError,
} from "./provider.js";
import type {
  CodexCompactionRequest,
  CodexProviderRuntime,
} from "./provider.js";
import { registerCheckpointRenderer } from "./renderer.js";
import {
  buildCheckpointReplacement,
  buildTransientCheckpointReplacement,
  contextWindowDecision,
  estimateModelVisibleTokens,
  extractFinalizedFrame,
  frameContiguousBaseline,
  frameMarkerText,
  omitUnsupportedUserImages,
  rewriteFramedInput,
  shouldAutoCompact,
} from "./replay.js";
import type { ResponsesInputItem } from "./replay.js";

export { LEGACY_CHECKPOINT_SUMMARY as ENCRYPTED_CHECKPOINT_MARKER } from "./checkpoint.js";
export const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
export const CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE = "codex-compaction.diagnostic";

const ALLOWED_TOOL_CALL_PROVIDERS = new Set([
  "openai",
  "openai-codex",
  "opencode",
]);
const STATUS_KEY = "codex-provider";
const STATUS_MESSAGE = "Compacting with OpenAI Codex…";

type SupportedModel = Model<"openai-codex-responses">;
export type CompactionFailurePolicy = "ask" | "cancel" | "fallback";

export interface ParsedCompactionFailurePolicy {
  readonly invalid: boolean;
  readonly policy: CompactionFailurePolicy;
}

interface SessionBeforeCompactResult {
  readonly cancel?: boolean;
  readonly compaction?: CompactionResult;
}

export interface LifecycleSource {
  readonly branchSha256: string;
  readonly contextMessages: Context["messages"];
  readonly ignoredInvalidInlineCheckpoint: boolean;
  readonly inputPrefix: readonly ResponsesInputItem[];
  readonly retainedItems: readonly (
    | CheckpointAgentMessageItem
    | RealUserInputItem
  )[];
  readonly retainedUsers: readonly RealUserInputItem[];
}

export interface LifecycleExecutionSuccess {
  readonly compaction: CanonicalCompactionItem;
  readonly estimatedSourceTokens: number;
  readonly ok: true;
  readonly responseId: string;
  readonly usage: Usage;
}

type ProviderCompactionResult =
  | LifecycleExecutionSuccess
  | {
      readonly currentModelFallback: boolean;
      readonly kind: "aborted" | "remote" | "unavailable";
      readonly ok: false;
    };

type ProviderCompactionOptions = Omit<
  CodexCompactionRequest,
  "effectiveTokenLimit"
>;

interface PendingInstall {
  readonly generation: number;
  readonly replacementSha256: string;
  readonly responseId: string;
  readonly runtime: CheckpointV5["runtime"];
  readonly sessionId: string;
  readonly summarySha256: string;
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
  failurePolicyWarned: boolean;
  frame?: RequestFrame;
  generation: number;
  inFlight?:
    | {
        kind: "inline";
        promise: Promise<InlineOperationResult>;
      }
    | {
        abort: () => void;
        cancelOverlap: () => void;
        completion: Promise<null>;
        finish: () => void;
        kind: "lifecycle";
        promise: Promise<SessionBeforeCompactResult>;
        settled: boolean;
      };
  notified: Set<string>;
  pendingInstall?: PendingInstall;
  requestHeaders?: {
    readonly generation: number;
    readonly headers: ProviderHeaders;
    readonly leafId: string | null;
    readonly modelIdentity: string;
  };
  transition?: {
    readonly currentIdentity: string;
    readonly previousCompHash?: string | null;
    readonly previousEffectiveTokenLimit?: number;
    readonly previousModel: SupportedModel;
  };
  transitionRestored: boolean;
}

type InlineOperationResult =
  | {
      checkpoint: Checkpoint;
      kind: "success";
      requestReplacement: readonly ResponsesInputItem[];
    }
  | {
      kind: "persistence" | "remote" | "stale";
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

export const parseCompactionFailurePolicy = (
  value: string | undefined
): ParsedCompactionFailurePolicy => {
  if (value === undefined) {
    return { invalid: false, policy: "ask" };
  }
  const policy = value.trim().toLowerCase();
  return policy === "ask" || policy === "cancel" || policy === "fallback"
    ? { invalid: false, policy }
    : { invalid: true, policy: "ask" };
};

export const combineCompactionUsage = (first: Usage, second: Usage): Usage => ({
  cacheRead: first.cacheRead + second.cacheRead,
  cacheWrite: first.cacheWrite + second.cacheWrite,
  ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
    ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
    : {}),
  cost: {
    cacheRead: first.cost.cacheRead + second.cost.cacheRead,
    cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
    input: first.cost.input + second.cost.input,
    output: first.cost.output + second.cost.output,
    total: first.cost.total + second.cost.total,
  },
  input: first.input + second.input,
  output: first.output + second.output,
  ...(first.reasoning !== undefined || second.reasoning !== undefined
    ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
    : {}),
  totalTokens: first.totalTokens + second.totalTokens,
});

const isAbortError = (error: unknown) =>
  isRecord(error) &&
  (error.name === "AbortError" ||
    (isRecord(error.cause) && error.cause.name === "AbortError"));

export const isSupportedLifecycleModel = (
  model: Model<string> | undefined
): model is SupportedModel =>
  model?.provider === "openai-codex" && model.api === "openai-codex-responses";

export const hasResolvedLifecycleAuth = (apiKey?: string): apiKey is string =>
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

const omitUnsupportedImagesFromRetained = (
  items: readonly (CheckpointAgentMessageItem | RealUserInputItem)[],
  model: SupportedModel
) => {
  const users = omitUnsupportedImagesFromUsers(
    items.filter((item): item is RealUserInputItem => item.type === "message"),
    model
  );
  let userIndex = 0;
  return items.map((item) => {
    if (item.type === "agent_message") {
      return item;
    }
    const user = users[userIndex];
    userIndex += 1;
    return user;
  });
};

const retainedFinalizedInput = (
  input: readonly ResponsesInputItem[],
  model: SupportedModel
) => {
  const retained: (CheckpointAgentMessageItem | RealUserInputItem)[] = [];
  for (const [index, item] of input.entries()) {
    if (item.type === "agent_message") {
      retained.push(parseAgentMessageItem(item, `finalized input[${index}]`));
      continue;
    }
    if (
      (item.type !== undefined && item.type !== "message") ||
      item.role !== "user"
    ) {
      continue;
    }
    const content = Array.isArray(item.content)
      ? item.content.map((part: unknown) => {
          if (
            !isRecord(part) ||
            part.type !== "input_image" ||
            typeof part.image_url !== "string"
          ) {
            return part;
          }
          return /^data:image\//iu.test(part.image_url)
            ? { image_url: part.image_url, type: "input_image" }
            : { text: REMOTE_USER_IMAGE_PLACEHOLDER, type: "input_text" };
        })
      : item.content;
    retained.push(
      parseRealUserInputItem(
        { ...item, content, type: "message" },
        `finalized input[${index}]`
      )
    );
  }
  return omitUnsupportedImagesFromRetained(retained, model);
};

const isRequestStateInput = (item: ResponsesInputItem) =>
  item.type === "additional_tools" ||
  item.role === "developer" ||
  item.role === "system";

// Responses Lite carries current tools and instructions beside history in input.
const splitUnframedInput = (input: readonly ResponsesInputItem[]) => {
  let start = 0;
  while (start < input.length && isRequestStateInput(input[start] ?? {})) {
    start += 1;
  }
  let end = input.length;
  while (end > start && isRequestStateInput(input[end - 1] ?? {})) {
    end -= 1;
  }
  return {
    durable: input.slice(start, end),
    prefix: input.slice(0, start),
    suffix: input.slice(end),
  };
};

export const buildLifecycleSource = (
  branch: readonly SessionEntry[],
  model: SupportedModel,
  compHash?: string | null
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
      compHash,
      model: model.id,
      provider: model.provider,
    });
    if (!compatibility.compatible) {
      throw new Error("The active checkpoint identity is incompatible");
    }
    const previousItems: (CheckpointAgentMessageItem | RealUserInputItem)[] =
      [];
    for (const [index, item] of boundary.checkpoint.replacement.entries()) {
      if (item.type === "agent_message") {
        previousItems.push(
          parseAgentMessageItem(item, `checkpoint agent[${index}]`)
        );
      } else if (item.type === "message") {
        previousItems.push(
          parseRealUserInputItem(item, `checkpoint user[${index}]`)
        );
      }
    }
    const safePreviousItems = omitUnsupportedImagesFromRetained(
      previousItems,
      model
    );
    const previousUsers = previousItems.filter(
      (item): item is RealUserInputItem => item.type === "message"
    );
    const tailUsers = omitUnsupportedImagesFromUsers(
      serializeRealUserEntries(boundary.tail, model),
      model
    );
    const compaction = boundary.checkpoint.replacement.at(-1);
    if (compaction?.type !== "compaction") {
      throw new Error("The active checkpoint compaction is unavailable");
    }
    const inputPrefix = [...safePreviousItems, { ...compaction }].map(
      (item) => ({ ...item })
    );
    return {
      branchSha256: branchSha256(branch),
      contextMessages: convertToLlm(
        boundary.tail.flatMap(sessionEntryToContextMessages)
      ),
      ignoredInvalidInlineCheckpoint: false,
      inputPrefix,
      retainedItems: [...safePreviousItems, ...tailUsers],
      retainedUsers: [...previousUsers, ...tailUsers],
    };
  }

  const contextEntries = buildContextEntries([...branch]);
  const users = serializeRealUserEntries(contextEntries, model);
  const retainedUsers = omitUnsupportedImagesFromUsers(users, model);
  return {
    branchSha256: branchSha256(branch),
    contextMessages: convertToLlm(buildSessionContext([...branch]).messages),
    ignoredInvalidInlineCheckpoint:
      boundary.kind === "invalid-checkpoint" && boundary.carrier === "inline",
    inputPrefix: [],
    retainedItems: retainedUsers,
    retainedUsers,
  };
};

const lifecycleSourceSha256 = (source: LifecycleSource) => {
  const serialized = JSON.stringify({
    contextMessages: source.contextMessages,
    inputPrefix: source.inputPrefix,
    retainedItems: source.retainedItems,
  });
  if (!serialized) {
    throw new Error("Lifecycle compaction source is not serializable");
  }
  return sha256Canonical(JSON.parse(serialized));
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

const runEffectiveProviderCompaction = async (
  runtime: CodexProviderRuntime,
  options: ProviderCompactionOptions
): Promise<ProviderCompactionResult> => {
  const window = runtime.getModelWindow(options.model);
  if (window === undefined) {
    return {
      currentModelFallback: false,
      kind: "unavailable",
      ok: false,
    };
  }
  const headers = { ...options.headers };
  mergeRemoteCompactionFeatureHeader(headers);
  try {
    const result = await runtime.compact({
      ...options,
      effectiveTokenLimit: window.effectiveWindowTokens,
      headers,
    });
    return { ...result, ok: true };
  } catch (error) {
    return {
      currentModelFallback: isCodexCompactionCurrentModelFallbackError(error),
      kind:
        options.signal.aborted || isAbortError(error) ? "aborted" : "remote",
      ok: false,
    };
  }
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
  readonly retainedItems?: readonly (
    | CheckpointAgentMessageItem
    | RealUserInputItem
  )[];
  readonly retainedUsers?: readonly RealUserInputItem[];
  readonly runtime?: CheckpointV5["runtime"];
}): Checkpoint => {
  const { execution, model, phase, reason, runtime } = options;
  const retainedItems = options.retainedItems ?? options.retainedUsers ?? [];
  const { compaction } = execution;
  const replacement = buildCheckpointReplacement(retainedItems, compaction);
  const common = {
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
  };
  const candidate = runtime
    ? { ...common, runtime, version: 5 }
    : { ...common, version: 4 };
  const parsed = parseCheckpoint(candidate);
  if (!parsed.ok) {
    throw new Error("Constructed checkpoint failed strict validation");
  }
  return parsed.checkpoint;
};

const nextCheckpointRuntime = (
  runtime: CodexProviderRuntime,
  sessionId: string,
  model: SupportedModel
): CheckpointV5["runtime"] => {
  const current = runtime.getWindow(sessionId);
  const window = runtime.getModelWindow(model);
  if (!window) {
    throw new Error("Model context window is unavailable");
  }
  return {
    compHash: runtime.getModelMetadata(model.id)?.comp_hash ?? null,
    currentWindowId: uuidv7(),
    effectiveTokenLimit: window.effectiveWindowTokens,
    previousWindowId: current.currentId,
    requestSchemaVersion: 1,
    windowNumber: current.number + 1,
  };
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

const isPendingInstallationResolvable = (
  state: LifecycleState,
  pending: PendingInstall,
  ctx: ExtensionContext
) => {
  const branch = ctx.sessionManager.getBranch();
  const active = resolveActiveCheckpointBoundary(branch);
  const boundaryIndex =
    active.kind === "checkpoint" ? active.boundaryIndex : -1;
  const installedEntry =
    boundaryIndex === -1 ? undefined : branch[boundaryIndex];
  return (
    state.generation === pending.generation &&
    ctx.sessionManager.getSessionId() === pending.sessionId &&
    installedEntry?.type === "compaction" &&
    sha256Canonical(installedEntry.summary) === pending.summarySha256 &&
    isPortableLifecycleCompaction(branch, boundaryIndex) &&
    isLifecycleInstallationResolvable(
      branch,
      pending.responseId,
      pending.replacementSha256
    )
  );
};

export const shouldCompactFinalizedInput = (options: {
  readonly autoCompactTokens?: number;
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
    (options.autoCompactTokens === undefined
      ? shouldAutoCompact(tokens, options.contextWindow)
      : tokens >= options.autoCompactTokens)
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
): void => {
  if (state.notified.has(key)) {
    return;
  }
  state.notified.add(key);
  ctx.ui.notify(message, type);
};

const releaseLifecycleOperation = (state: LifecycleState, abort = false) => {
  const operation = state.inFlight;
  if (operation?.kind !== "lifecycle") {
    return;
  }
  state.inFlight = undefined;
  if (abort) {
    operation.abort();
  }
  operation.finish();
};

const releaseSettledLifecycleOperation = (
  state: LifecycleState,
  ctx: ExtensionContext,
  providerRuntime: CodexProviderRuntime
) => {
  const pending = state.pendingInstall;
  state.pendingInstall = undefined;
  if (pending && isPendingInstallationResolvable(state, pending, ctx)) {
    providerRuntime.installWindow(pending.sessionId, pending.runtime);
  }
  releaseLifecycleOperation(state);
};

const resetGeneration = (state: LifecycleState) => {
  state.controller.abort();
  releaseLifecycleOperation(state, true);
  state.controller = new AbortController();
  state.candidate = undefined;
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

const canUseCheckpointLocalFallback = (
  branch: readonly SessionEntry[],
  boundary: ActiveNativeCheckpoint
) =>
  boundary.carrier === "lifecycle"
    ? isPortableLifecycleCompaction(branch, boundary.boundaryIndex)
    : canUseInlineLocalFallback(branch, boundary.boundaryIndex);

const lifecycleSourceSafety = (branch: readonly SessionEntry[]) => {
  const boundary = resolveActiveCheckpointBoundary(branch);
  if (boundary.kind === "invalid-checkpoint") {
    return {
      remoteFailureFallbackAllowed: false,
      sourceAuthoritative:
        boundary.carrier === "inline" &&
        canUseInlineLocalFallback(branch, boundary.boundaryIndex),
    };
  }
  const sourceAuthoritative =
    boundary.kind !== "checkpoint" ||
    canUseCheckpointLocalFallback(branch, boundary);
  return {
    remoteFailureFallbackAllowed: sourceAuthoritative,
    sourceAuthoritative,
  };
};

const runLifecycleHook = async (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  providerRuntime: CodexProviderRuntime | undefined,
  failurePolicy: CompactionFailurePolicy
): Promise<SessionBeforeCompactResult | undefined> => {
  const { model } = ctx;
  const { remoteFailureFallbackAllowed, sourceAuthoritative } =
    lifecycleSourceSafety(event.branchEntries);
  if (!sourceAuthoritative) {
    return { cancel: true };
  }
  if (!providerRuntime) {
    return undefined;
  }
  if (!isSupportedLifecycleModel(model)) {
    return undefined;
  }

  let source: LifecycleSource;
  let sourceSha256: string;
  let operationKey: string;
  let requestSnapshot: ReturnType<typeof snapshotLifecycleRequestState>;
  try {
    normalizeBaseUrl(model.baseUrl);
    source = buildLifecycleSource(
      event.branchEntries,
      model,
      providerRuntime?.getModelMetadata(model.id)?.comp_hash
    );
    sourceSha256 = lifecycleSourceSha256(source);
    requestSnapshot = snapshotLifecycleRequestState(pi, ctx);
    operationKey = sha256Canonical({
      branch: source.branchSha256,
      customInstructions: event.customInstructions ?? null,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      model: modelIdentity(model),
      reason: event.reason,
      requestState: requestSnapshot.hash,
      tokensBefore: event.preparation.tokensBefore,
    });
  } catch {
    const boundary = resolveActiveCheckpointBoundary(event.branchEntries);
    if (
      boundary.kind === "checkpoint" &&
      canUseCheckpointLocalFallback(event.branchEntries, boundary)
    ) {
      return undefined;
    }
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
    const active = state.inFlight;
    if (active.kind === "lifecycle") {
      active.cancelOverlap();
      if (active.settled) {
        releaseSettledLifecycleOperation(state, ctx, providerRuntime);
      } else {
        await active.completion;
      }
    }
    return { cancel: true };
  }

  const { generation } = state;
  const leafId = ctx.sessionManager.getLeafId();
  const identity = modelIdentity(model);
  const sessionId = ctx.sessionManager.getSessionId();
  const operationController = new AbortController();
  const completion = Promise.withResolvers<null>();
  let cancelledByOverlap = false;
  const signal = AbortSignal.any([
    event.signal,
    state.controller.signal,
    operationController.signal,
  ]);
  const isCurrent = () => {
    try {
      if (
        cancelledByOverlap ||
        event.signal.aborted ||
        state.controller.signal.aborted ||
        state.generation !== generation ||
        ctx.sessionManager.getSessionId() !== sessionId ||
        ctx.sessionManager.getLeafId() !== leafId ||
        !isSupportedLifecycleModel(ctx.model) ||
        modelIdentity(ctx.model) !== identity ||
        snapshotLifecycleRequestState(pi, ctx).hash !== requestSnapshot.hash
      ) {
        return false;
      }
      const branch = ctx.sessionManager.getBranch();
      return (
        branchSha256(branch) === source.branchSha256 &&
        lifecycleSourceSha256(
          buildLifecycleSource(
            branch,
            model,
            providerRuntime.getModelMetadata(model.id)?.comp_hash
          )
        ) === sourceSha256
      );
    } catch {
      return false;
    }
  };
  const notifyStale = (key: string, message: string) => {
    if (!cancelledByOverlap) {
      notifyOnce(state, key, ctx, message, "error");
    }
  };

  const operation = (async (): Promise<SessionBeforeCompactResult> => {
    ctx.ui.setStatus(STATUS_KEY, STATUS_MESSAGE);
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !hasResolvedLifecycleAuth(auth.apiKey)) {
        notifyOnce(
          state,
          `${operationKey}:auth`,
          ctx,
          "OpenAI remote compaction was cancelled because provider authentication is unavailable.",
          "error"
        );
        return { cancel: true };
      }

      if (!isCurrent()) {
        notifyStale(
          `${operationKey}:stale`,
          "OpenAI compaction was discarded because the session changed."
        );
        return { cancel: true };
      }

      const phase =
        event.reason === "overflow" ? "overflow-retry" : "standalone";
      const runPortableCompaction = async () => {
        try {
          const streamPortableSummary: NonNullable<
            Parameters<typeof compact>[7]
          > = (_summaryModel, context, options) =>
            providerRuntime.streamPortableSummary(model, context, options);
          const result = await compact(
            event.preparation,
            model,
            auth.apiKey,
            auth.headers,
            event.customInstructions,
            signal,
            requestSnapshot.thinkingLevel,
            streamPortableSummary,
            auth.env
          );
          if (
            result.summary.trim().length === 0 ||
            result.summary.trim() === LEGACY_MARKER ||
            result.firstKeptEntryId !== event.preparation.firstKeptEntryId ||
            result.tokensBefore !== event.preparation.tokensBefore ||
            !result.usage
          ) {
            operationController.abort();
            return { kind: "failure", ok: false } as const;
          }
          return {
            ok: true,
            result: { ...result, usage: result.usage },
          } as const;
        } catch (error) {
          operationController.abort();
          return {
            kind:
              event.signal.aborted ||
              state.controller.signal.aborted ||
              isAbortError(error)
                ? ("aborted" as const)
                : ("failure" as const),
            ok: false as const,
          };
        }
      };
      const portablePromise = runPortableCompaction();
      const [execution, portable] = await Promise.all([
        runEffectiveProviderCompaction(providerRuntime, {
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
          phase,
          reason: event.reason,
          sessionId,
          signal,
          thinkingLevel:
            requestSnapshot.thinkingLevel === "off"
              ? undefined
              : requestSnapshot.thinkingLevel,
        }),
        portablePromise,
      ]);

      if (!isCurrent()) {
        notifyStale(
          `${operationKey}:stale`,
          "OpenAI compaction was discarded because the session changed."
        );
        return { cancel: true };
      }

      if (!portable.ok) {
        notifyOnce(
          state,
          `${operationKey}:portable`,
          ctx,
          execution.ok
            ? "OpenAI compaction was cancelled because no portable summary was produced."
            : "OpenAI compaction failed because no usable native or portable result was produced.",
          "error"
        );
        return { cancel: true };
      }

      if (!execution.ok) {
        if (execution.kind !== "remote") {
          notifyOnce(
            state,
            `${operationKey}:${execution.kind}`,
            ctx,
            "OpenAI compaction was cancelled; local context was left unchanged.",
            "error"
          );
          return { cancel: true };
        }
        if (!remoteFailureFallbackAllowed) {
          notifyOnce(
            state,
            `${operationKey}:unsafe-fallback`,
            ctx,
            "OpenAI remote compaction failed; active checkpoint context cannot use portable fallback.",
            "error"
          );
          return { cancel: true };
        }
        let usePortable = failurePolicy === "fallback";
        if (failurePolicy === "ask" && ctx.hasUI) {
          let choice: string | undefined;
          try {
            choice = await ctx.ui.select(
              "OpenAI remote compaction failed",
              ["Use portable text summary", "Keep context unchanged"],
              { signal }
            );
          } catch {
            choice = undefined;
          }
          usePortable = choice === "Use portable text summary";
          if (!isCurrent()) {
            notifyStale(
              `${operationKey}:choice-stale`,
              "Portable compaction was discarded because the session changed."
            );
            return { cancel: true };
          }
        }
        if (!usePortable || !isCurrent()) {
          notifyOnce(
            state,
            `${operationKey}:remote`,
            ctx,
            "OpenAI remote compaction failed; local context was left unchanged.",
            "error"
          );
          return { cancel: true };
        }
        return { compaction: portable.result };
      }

      const runtime = nextCheckpointRuntime(providerRuntime, sessionId, model);
      const checkpoint = buildLifecycleCheckpoint({
        execution,
        model,
        phase,
        reason: event.reason,
        retainedItems: source.retainedItems,
        runtime,
      });
      const compaction = {
        details: {
          checkpoint,
          type: CHECKPOINT_CUSTOM_TYPE,
        },
        firstKeptEntryId: portable.result.firstKeptEntryId,
        summary: portable.result.summary,
        tokensBefore: portable.result.tokensBefore,
        usage: combineCompactionUsage(execution.usage, portable.result.usage),
      } satisfies CompactionResult;
      state.pendingInstall = {
        generation,
        replacementSha256: checkpoint.replacementSha256,
        responseId: checkpoint.response.id,
        runtime,
        sessionId,
        summarySha256: sha256Canonical(compaction.summary),
      };
      return {
        compaction: {
          ...compaction,
        },
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

  const lifecycleOperation = {
    abort: () => {
      operationController.abort();
    },
    cancelOverlap: () => {
      cancelledByOverlap = true;
      operationController.abort();
    },
    completion: completion.promise,
    finish: () => {
      completion.resolve(null);
    },
    kind: "lifecycle" as const,
    promise: operation,
    settled: false,
  };
  state.inFlight = lifecycleOperation;
  let result: SessionBeforeCompactResult | undefined;
  try {
    result = await operation;
    lifecycleOperation.settled = true;
    return result;
  } finally {
    if (state.inFlight?.promise === operation && !result?.compaction) {
      releaseLifecycleOperation(state);
    }
  }
};

type ReplayBoundaryDecision =
  | { readonly kind: "active"; readonly boundary: ActiveNativeCheckpoint }
  | { readonly kind: "blocked" | "fallback" | "none" };

const replayBoundaryDecision = (
  branch: readonly SessionEntry[],
  model: Model<string> | undefined,
  providerRuntime?: CodexProviderRuntime,
  previousModel?: SupportedModel,
  previousCompHash?: string | null
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
        compHash: providerRuntime?.getModelMetadata(model.id)?.comp_hash,
        model: model.id,
        provider: model.provider,
      })
    : undefined;
  if (compatibility?.compatible === true) {
    return { boundary, kind: "active" };
  }
  const previousCompatibility = previousModel
    ? decideCheckpointCompatibility(boundary.checkpoint, {
        api: previousModel.api,
        baseUrl: previousModel.baseUrl,
        compHash:
          previousCompHash === undefined
            ? providerRuntime?.getModelMetadata(previousModel.id)?.comp_hash
            : previousCompHash,
        model: previousModel.id,
        provider: previousModel.provider,
      })
    : undefined;
  if (previousCompatibility?.compatible === true) {
    return { boundary, kind: "active" };
  }
  return canUseCheckpointLocalFallback(branch, boundary)
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
  return "OpenAI checkpoint generation failed; the model request was cancelled.";
};

const isPossibleAutomaticThreshold = (
  model: SupportedModel,
  usage: ReturnType<ExtensionContext["getContextUsage"]>,
  providerRuntime: CodexProviderRuntime
) => {
  const window = providerRuntime.getModelWindow(model);
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

const prepareContextReplay = (
  state: LifecycleState,
  branch: readonly SessionEntry[],
  ctx: ExtensionContext,
  providerRuntime?: CodexProviderRuntime
):
  | {
      readonly activeCheckpoint?: ActiveNativeCheckpoint;
      readonly model: SupportedModel;
    }
  | undefined => {
  const currentModel = isSupportedLifecycleModel(ctx.model)
    ? ctx.model
    : undefined;
  const previousModel =
    currentModel &&
    state.transition?.currentIdentity === modelIdentity(currentModel)
      ? state.transition.previousModel
      : undefined;
  const decision = replayBoundaryDecision(
    branch,
    ctx.model,
    providerRuntime,
    previousModel,
    state.transition?.previousCompHash
  );
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
      "An incompatible OpenAI checkpoint was ignored because authoritative Pi context is available.",
      "warning"
    );
    return undefined;
  }
  if (!currentModel) {
    return undefined;
  }
  const activeCheckpoint =
    decision.kind === "active" ? decision.boundary : undefined;
  if (activeCheckpoint?.checkpoint.version === 5) {
    providerRuntime?.installWindow(
      ctx.sessionManager.getSessionId(),
      activeCheckpoint.checkpoint.runtime
    );
  }
  return { activeCheckpoint, model: currentModel };
};

const runContextHook = (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  event: ContextEvent,
  ctx: ExtensionContext,
  providerRuntime?: CodexProviderRuntime
): { readonly messages: ContextEvent["messages"] } | undefined => {
  state.candidate = undefined;
  state.frame = undefined;
  state.requestHeaders = undefined;
  const branch = ctx.sessionManager.getBranch();
  const replay = prepareContextReplay(state, branch, ctx, providerRuntime);
  if (!replay) {
    return undefined;
  }
  const { activeCheckpoint, model } = replay;
  if (!activeCheckpoint && !providerRuntime) {
    return undefined;
  }
  const usage = ctx.getContextUsage();
  const possibleThreshold = providerRuntime
    ? isPossibleAutomaticThreshold(model, usage, providerRuntime)
    : false;
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
  branch: readonly SessionEntry[],
  providerRuntime?: CodexProviderRuntime
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
    shouldCompact:
      providerRuntime !== undefined &&
      shouldCompactFinalizedInput({
        autoCompactTokens:
          providerRuntime.getModelWindow(model)?.autoCompactTokens,
        contextWindow: model.contextWindow,
        estimatedTokens,
        freshUsageTokens,
        unchangedReplacement,
      }),
  };
};

export const decideModelTransitionReason = (options: {
  readonly currentCompHash?: string | null;
  readonly currentEffectiveTokenLimit?: number;
  readonly currentModel: string;
  readonly estimatedTokens: number;
  readonly previousCompHash?: string | null;
  readonly previousEffectiveTokenLimit: number;
  readonly previousModel: string;
}): "comp_hash_changed" | "model_downshift" | undefined => {
  if (
    options.previousCompHash !== undefined &&
    options.previousCompHash !== null &&
    options.currentCompHash !== undefined &&
    options.currentCompHash !== null &&
    options.previousCompHash !== options.currentCompHash
  ) {
    return "comp_hash_changed";
  }
  return options.currentEffectiveTokenLimit !== undefined &&
    options.previousModel !== options.currentModel &&
    options.previousEffectiveTokenLimit > options.currentEffectiveTokenLimit &&
    options.estimatedTokens > options.currentEffectiveTokenLimit
    ? "model_downshift"
    : undefined;
};

const transitionCompactionModel = (
  state: LifecycleState,
  runtime: CodexProviderRuntime | undefined,
  currentModel: SupportedModel,
  instructions: string,
  input: readonly ResponsesInputItem[]
):
  | {
      readonly codexReason: "comp_hash_changed" | "model_downshift";
      readonly model: SupportedModel;
    }
  | undefined => {
  const { transition } = state;
  if (
    !runtime ||
    !transition ||
    transition.currentIdentity !== modelIdentity(currentModel)
  ) {
    return undefined;
  }
  const previousMetadata = runtime.getModelMetadata(
    transition.previousModel.id
  );
  const currentMetadata = runtime.getModelMetadata(currentModel.id);
  const previousCompHash =
    transition.previousCompHash === undefined
      ? previousMetadata?.comp_hash
      : transition.previousCompHash;
  const window =
    runtime.getModelWindow(currentModel) ??
    contextWindowDecision(currentModel.contextWindow);
  const reason = decideModelTransitionReason({
    currentCompHash: currentMetadata?.comp_hash,
    currentEffectiveTokenLimit: window?.effectiveWindowTokens,
    currentModel: currentModel.id,
    estimatedTokens: estimateModelVisibleTokens(instructions, input),
    previousCompHash,
    previousEffectiveTokenLimit:
      transition.previousEffectiveTokenLimit ??
      transition.previousModel.contextWindow,
    previousModel: transition.previousModel.id,
  });
  if (reason) {
    return {
      codexReason: reason,
      model: transition.previousModel,
    };
  }
  state.transition = undefined;
  return undefined;
};

const runInlineCompactionOperation = async (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  ctx: ExtensionContext,
  providerRuntime: CodexProviderRuntime,
  options: {
    readonly authoritativeEnvelope: Record<string, unknown>;
    readonly authoritativeInput: readonly ResponsesInputItem[];
    readonly codexReason?: "comp_hash_changed" | "model_downshift";
    readonly compactionModel?: SupportedModel;
    readonly current: () => boolean;
    readonly discriminator: string;
    readonly durableInput: readonly ResponsesInputItem[];
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
    codexReason,
    compactionModel,
    current,
    discriminator,
    durableInput,
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
    retained: hashJsonClone(durableInput),
    source: sourceSha256,
  });
  const signals = [state.controller.signal];
  if (ctx.signal) {
    signals.push(ctx.signal);
  }
  const signal = AbortSignal.any(signals);
  // oxlint-disable-next-line eslint/complexity -- one fail-closed compaction and checkpoint transaction
  const operation = (async (): Promise<InlineOperationResult> => {
    ctx.ui.setStatus(STATUS_KEY, STATUS_MESSAGE);
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !hasResolvedLifecycleAuth(auth.apiKey) || !headers) {
        return { kind: "remote" };
      }
      const requestSnapshot = snapshotLifecycleRequestState(pi, ctx);
      if (requestSnapshot.hash !== request.requestStateSha256) {
        return { kind: "stale" };
      }
      const retainedItems = retainedFinalizedInput(durableInput, model);
      const compactionOptions: ProviderCompactionOptions = {
        apiKey: auth.apiKey,
        authoritativeEnvelope,
        authoritativeInput,
        codexReason,
        context: {
          messages: [],
          systemPrompt: requestSnapshot.systemPrompt,
          tools: requestSnapshot.tools,
        },
        env: auth.env,
        headers,
        inputPrefix: [],
        model: compactionModel ?? model,
        phase: request.phase,
        reason: "threshold",
        sessionId: ctx.sessionManager.getSessionId(),
        signal,
        thinkingLevel:
          requestSnapshot.thinkingLevel === "off"
            ? undefined
            : requestSnapshot.thinkingLevel,
      };
      let execution = await runEffectiveProviderCompaction(
        providerRuntime,
        compactionOptions
      );
      if (
        !execution.ok &&
        compactionModel &&
        execution.currentModelFallback &&
        !signal.aborted
      ) {
        execution = await runEffectiveProviderCompaction(providerRuntime, {
          ...compactionOptions,
          model,
        });
      }
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
      const runtime = nextCheckpointRuntime(
        providerRuntime,
        ctx.sessionManager.getSessionId(),
        model
      );
      const checkpoint = buildLifecycleCheckpoint({
        execution,
        model,
        phase: request.phase,
        reason: "threshold",
        retainedItems,
        runtime,
      });
      const requestReplacement = buildTransientCheckpointReplacement(
        retainedItems,
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
      providerRuntime.installWindow(ctx.sessionManager.getSessionId(), runtime);
      state.transition = undefined;
      return { checkpoint, kind: "success", requestReplacement };
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  })();
  state.inFlight = {
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
  ctx: ExtensionContext,
  providerRuntime?: CodexProviderRuntime
): Promise<unknown> => {
  if (!providerRuntime) {
    state.candidate = undefined;
    return payload;
  }
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
  const split = splitUnframedInput(authoritativeInput);
  const instructions =
    typeof envelope.instructions === "string" ? envelope.instructions : "";
  const transitionCompaction = transitionCompactionModel(
    state,
    providerRuntime,
    model,
    instructions,
    authoritativeInput
  );
  const compactionModel = transitionCompaction?.model;
  const shouldCompact = shouldCompactFinalizedInput({
    autoCompactTokens: providerRuntime.getModelWindow(model)?.autoCompactTokens,
    contextWindow: model.contextWindow,
    estimatedTokens: estimateModelVisibleTokens(
      instructions,
      authoritativeInput
    ),
    freshUsageTokens: freshAssistantUsageTokens(branch, -1, model),
  });
  if (!shouldCompact && !compactionModel) {
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
    providerRuntime,
    {
      authoritativeEnvelope,
      authoritativeInput,
      codexReason: transitionCompaction?.codexReason,
      compactionModel,
      current: () => state.candidate === candidate,
      discriminator: "unframed",
      durableInput: split.durable,
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
    input: [...split.prefix, ...result.requestReplacement, ...split.suffix],
  };
};

const runBeforeProviderRequestHook = async (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  headers: Readonly<ProviderHeaders> | undefined,
  payload: unknown,
  ctx: ExtensionContext,
  providerRuntime?: CodexProviderRuntime
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
          ctx,
          providerRuntime
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
  const prepared = prepareFinalizedReplay(
    payload,
    ctx.model,
    frame,
    branch,
    providerRuntime
  );
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
  const transitionCompaction = transitionCompactionModel(
    state,
    providerRuntime,
    model,
    typeof envelope.instructions === "string" ? envelope.instructions : "",
    effectiveInput
  );
  const compactionModel = transitionCompaction?.model;
  if (!shouldCompact && !compactionModel) {
    state.frame = undefined;
    return { ...envelope, input: effectiveInput };
  }
  if (!providerRuntime) {
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
    providerRuntime,
    {
      authoritativeEnvelope,
      authoritativeInput,
      codexReason: transitionCompaction?.codexReason,
      compactionModel,
      current: () => state.frame === frame,
      discriminator: frame.nonce,
      durableInput: [
        ...(frame.activeCheckpoint?.checkpoint.replacement.map((item) => ({
          ...item,
        })) ?? []),
        ...extracted.framed,
      ],
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
  failurePolicyWarned: false,
  generation: 0,
  notified: new Set(),
  transitionRestored: false,
});

const findPreviousModelMessage = (entries: readonly SessionEntry[]) =>
  entries.findLast(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.provider === "openai-codex" &&
      entry.message.api === "openai-codex-responses"
  );

export const resolvePreviousTurnTransition = (
  branch: readonly SessionEntry[],
  currentModel: SupportedModel,
  findModel: (provider: string, model: string) => Model<string> | undefined
): LifecycleState["transition"] => {
  const boundary = resolveActiveCheckpointBoundary(branch);
  const durableCheckpoint =
    boundary.kind === "checkpoint" && boundary.checkpoint.version === 5
      ? boundary.checkpoint
      : undefined;
  const tailMessage =
    boundary.kind === "checkpoint"
      ? findPreviousModelMessage(boundary.tail)
      : undefined;
  const previousMessage = tailMessage ?? findPreviousModelMessage(branch);
  const durableIdentity = tailMessage ? undefined : durableCheckpoint?.identity;
  let previousModel: Model<string> | undefined;
  if (durableIdentity) {
    previousModel =
      durableIdentity.provider === currentModel.provider &&
      durableIdentity.model === currentModel.id
        ? currentModel
        : findModel(durableIdentity.provider, durableIdentity.model);
  } else if (
    previousMessage?.type === "message" &&
    previousMessage.message.role === "assistant"
  ) {
    previousModel = findModel(
      previousMessage.message.provider,
      previousMessage.message.model
    );
  }
  if (!isSupportedLifecycleModel(previousModel)) {
    return undefined;
  }
  return {
    currentIdentity: modelIdentity(currentModel),
    ...(durableCheckpoint?.identity.model === previousModel.id
      ? {
          previousCompHash: durableCheckpoint.runtime.compHash,
          previousEffectiveTokenLimit:
            durableCheckpoint.runtime.effectiveTokenLimit,
        }
      : {}),
    previousModel,
  };
};

const restoreTransition = (
  state: LifecycleState,
  ctx: ExtensionContext,
  providerRuntime: CodexProviderRuntime | undefined
) => {
  state.transition = undefined;
  const currentModel = ctx.model;
  if (!providerRuntime || !isSupportedLifecycleModel(currentModel)) {
    return;
  }
  const branch = ctx.sessionManager.getBranch();
  state.transition = resolvePreviousTurnTransition(
    branch,
    currentModel,
    (provider, model) =>
      ctx.modelRegistry
        .getAll()
        .find(
          (candidate) =>
            candidate.provider === provider && candidate.id === model
        )
  );
};

const registerLifecycleHooks = (
  pi: Parameters<ExtensionFactory>[0],
  state: LifecycleState,
  providerRuntime: CodexProviderRuntime | undefined,
  failurePolicy: ParsedCompactionFailurePolicy
) => {
  pi.on("session_start", (_event, ctx) => {
    providerRuntime?.resetSession(ctx.sessionManager.getSessionId());
    state.transition = undefined;
    state.transitionRestored = false;
    resetGeneration(state);
    if (failurePolicy.invalid && !state.failurePolicyWarned) {
      state.failurePolicyWarned = true;
      ctx.ui.notify(
        "Invalid CLANKER_CODEX_COMPACTION_FAILURE value; using ask.",
        "warning"
      );
    }
  });
  pi.on("model_select", (event) => {
    resetGeneration(state);
    state.transition =
      providerRuntime &&
      isSupportedLifecycleModel(event.model) &&
      isSupportedLifecycleModel(event.previousModel)
        ? {
            currentIdentity: modelIdentity(event.model),
            previousCompHash: providerRuntime.getModelMetadata(
              event.previousModel.id
            )?.comp_hash,
            previousEffectiveTokenLimit: providerRuntime.getModelWindow(
              event.previousModel
            )?.effectiveWindowTokens,
            previousModel: event.previousModel,
          }
        : undefined;
    state.transitionRestored =
      state.transition !== undefined ||
      event.source !== "restore" ||
      !providerRuntime ||
      !isSupportedLifecycleModel(event.model);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!state.transitionRestored) {
      restoreTransition(state, ctx, providerRuntime);
      state.transitionRestored = true;
    }
    providerRuntime?.beginTurn(ctx.sessionManager.getSessionId());
  });
  pi.on("agent_settled", (_event, ctx) => {
    providerRuntime?.endTurn(ctx.sessionManager.getSessionId());
  });
  pi.on("session_shutdown", (_event, ctx) => {
    providerRuntime?.closeSession(ctx.sessionManager.getSessionId());
    state.controller.abort();
    state.candidate = undefined;
    state.frame = undefined;
    state.generation += 1;
    releaseLifecycleOperation(state, true);
    state.inFlight = undefined;
    state.pendingInstall = undefined;
    state.requestHeaders = undefined;
    state.transition = undefined;
    state.transitionRestored = false;
  });
  pi.on("session_before_compact", (event, ctx) =>
    runLifecycleHook(
      pi,
      state,
      event,
      ctx,
      providerRuntime,
      failurePolicy.policy
    )
  );
  pi.on("session_compact", (event, ctx) => {
    const pending = state.pendingInstall;
    state.pendingInstall = undefined;
    releaseLifecycleOperation(state);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (!pending) {
      return;
    }
    if (
      !event.fromExtension ||
      !isPendingInstallationResolvable(state, pending, ctx)
    ) {
      notifyOnce(
        state,
        `install:${pending.responseId}`,
        ctx,
        "OpenAI compaction checkpoint installation could not be verified.",
        "error"
      );
      return;
    }
    providerRuntime?.installWindow(pending.sessionId, pending.runtime);
  });
};

export const codexCompactionExtension: ExtensionFactory = (pi) => {
  const failurePolicy = parseCompactionFailurePolicy(
    process.env.CLANKER_CODEX_COMPACTION_FAILURE
  );
  const providerRuntime =
    process.env.CLANKER_CODEX_PROVIDER_REPLACEMENT === "0"
      ? undefined
      : createCodexProviderRuntime();
  if (providerRuntime) {
    pi.registerProvider(providerRuntime.provider);
  }
  registerCheckpointRenderer(pi);
  const state = createLifecycleState();
  registerLifecycleHooks(pi, state, providerRuntime, failurePolicy);
  pi.on("context", (event, ctx): ReturnType<typeof runContextHook> => {
    try {
      return runContextHook(pi, state, event, ctx, providerRuntime);
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
        ctx,
        providerRuntime
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
    if (!isSupportedLifecycleModel(ctx.model)) {
      state.requestHeaders = undefined;
      return;
    }
    mergeRemoteCompactionFeatureHeader(event.headers);
    state.requestHeaders = providerRuntime
      ? {
          generation: state.generation,
          headers: { ...event.headers },
          leafId: ctx.sessionManager.getLeafId(),
          modelIdentity: modelIdentity(ctx.model),
        }
      : undefined;
  });
};
