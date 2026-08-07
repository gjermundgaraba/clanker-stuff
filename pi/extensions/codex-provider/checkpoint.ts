import { createHash } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const CHECKPOINT_CUSTOM_TYPE = "codex-provider.checkpoint";
export const CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE = "codex-provider.diagnostic";
export const CHECKPOINT_PROTOCOL = "openai-responses-compaction-v2";
export const CHECKPOINT_SCHEMA = "clanker.codex-provider/checkpoint";
export const RETAINED_USER_TOKEN_BUDGET = 64_000;
export const RETAINED_USER_IMAGE_PLACEHOLDER =
  "image content omitted from compacted history";
export const REMOTE_USER_IMAGE_PLACEHOLDER =
  "image content omitted because remote image URLs are not supported";

const SHA256_PATTERN = /^[\da-f]{64}$/u;

export interface InputTextItem {
  readonly text: string;
  readonly type: "input_text";
}

export interface InputImageItem {
  readonly image_url: string;
  readonly type: "input_image";
}

export type RealUserContentItem = InputImageItem | InputTextItem;

export interface RealUserInputItem {
  readonly content: readonly RealUserContentItem[];
  readonly role: "user";
  readonly type: "message";
}

export interface CheckpointUserInputItem {
  readonly content: readonly InputTextItem[];
  readonly role: "user";
  readonly type: "message";
}

export interface CheckpointAgentMessageItem {
  readonly author: string;
  readonly content: readonly (
    | InputTextItem
    | { readonly encrypted_content: string; readonly type: "encrypted_content" }
  )[];
  readonly id?: string;
  readonly internal_chat_message_metadata_passthrough?: {
    readonly turn_id?: string;
  };
  readonly recipient: string;
  readonly type: "agent_message";
}

export interface CanonicalCompactionItem {
  readonly encrypted_content: string;
  readonly id?: string;
  readonly internal_chat_message_metadata_passthrough?: {
    readonly turn_id?: string;
  };
  readonly type: "compaction";
}

export type CheckpointReplacementItem =
  | CanonicalCompactionItem
  | CheckpointUserInputItem
  | CheckpointAgentMessageItem;

export interface Checkpoint {
  readonly identity: {
    readonly api: "openai-codex-responses";
    readonly baseUrl: string | null;
    readonly model: string;
    readonly provider: "openai-codex";
  };
  readonly phase: "mid-turn" | "overflow-retry" | "pre-sampling" | "standalone";
  readonly protocol: "openai-responses-compaction-v2";
  readonly reason: "manual" | "overflow" | "threshold";
  readonly replacement: readonly CheckpointReplacementItem[];
  readonly replacementSha256: string;
  readonly response: {
    readonly id: string;
    readonly usage: {
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly input: number;
      readonly output: number;
      readonly totalTokens: number;
    };
  };
  readonly runtime: {
    readonly compHash: string | null;
    readonly currentWindowId: string;
    readonly effectiveTokenLimit: number;
    readonly previousWindowId: string | null;
    readonly requestSchemaVersion: 1;
    readonly windowNumber: number;
  };
  readonly schema: "clanker.codex-provider/checkpoint";
  readonly sourceTokens: number;
  readonly version: 1;
}

export type CheckpointParseResult =
  | {
      readonly checkpoint: Checkpoint;
      readonly ok: true;
    }
  | {
      readonly error: string;
      readonly ok: false;
    };

export interface CheckpointIdentity {
  readonly api: string;
  readonly baseUrl?: string | null;
  readonly provider: string;
  readonly compHash?: string | null;
}

export type CompatibilityDecision =
  | { readonly compatible: true }
  | {
      readonly compatible: false;
      readonly field: "api" | "baseUrl" | "compHash" | "provider";
    };

export type ActiveCheckpointBoundary =
  | { readonly kind: "none" }
  | {
      readonly boundaryEntryId: string;
      readonly boundaryIndex: number;
      readonly carrier: "inline" | "lifecycle";
      readonly checkpoint: Checkpoint;
      readonly kind: "checkpoint";
      readonly tail: readonly SessionEntry[];
    }
  | {
      readonly boundaryIndex: number;
      readonly carrier: "inline";
      readonly kind: "invalid-checkpoint";
    }
  | {
      readonly carrier: "lifecycle";
      readonly kind: "invalid-checkpoint";
    }
  | {
      readonly kind: "pi-compaction";
    };

type JsonRecord = Record<string, unknown>;

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const isCheckpointPhase = (value: unknown): value is Checkpoint["phase"] =>
  value === "mid-turn" ||
  value === "overflow-retry" ||
  value === "pre-sampling" ||
  value === "standalone";

const isCheckpointReason = (value: unknown): value is Checkpoint["reason"] =>
  value === "manual" || value === "overflow" || value === "threshold";

const isRecord = (value: unknown): value is JsonRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const validationError = (message: string): never => {
  throw new Error(message);
};

const expectRecord = (value: unknown, path: string): JsonRecord => {
  if (!isRecord(value)) {
    throw new Error(`${path} must be a plain object`);
  }
  return value;
};

const expectExactKeys = (
  value: JsonRecord,
  allowedKeys: readonly string[],
  path: string
) => {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    validationError(`${path}.${unknown} is not recognized`);
  }
};

const expectIdentifier = (value: unknown, path: string): string => {
  let hasControlCharacter = false;
  if (typeof value === "string") {
    for (const character of value) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 31 || codePoint === 127) {
        hasControlCharacter = true;
        break;
      }
    }
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value !== value.trim() ||
    hasControlCharacter
  ) {
    throw new Error(`${path} must be a non-empty identifier`);
  }
  return value;
};

const expectString = (value: unknown, path: string): string =>
  typeof value === "string"
    ? value
    : validationError(`${path} must be a string`);

const expectNonnegativeInteger = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a nonnegative safe integer`);
  }
  return value;
};

const expectSha256 = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
};

export const normalizeBaseUrl = (value: string | null | undefined) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (value.length === 0 || value !== value.trim()) {
    validationError("baseUrl must be a non-empty absolute URL");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl must be a valid absolute URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    validationError(
      "baseUrl must be an HTTP(S) URL without credentials or query"
    );
  }
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path}`;
};

const parseMetadata = (
  value: unknown,
  path: string
): CanonicalCompactionItem["internal_chat_message_metadata_passthrough"] => {
  if (value === undefined) {
    return undefined;
  }
  const metadata = expectRecord(value, path);
  expectExactKeys(metadata, ["turn_id"], path);
  if (metadata.turn_id === undefined) {
    return {};
  }
  return { turn_id: expectIdentifier(metadata.turn_id, `${path}.turn_id`) };
};

export const parseCompactionItem = (
  value: unknown,
  options: {
    readonly allowAlias?: boolean;
    readonly allowResponseMetadata?: boolean;
  } = {}
): CanonicalCompactionItem => {
  const item = expectRecord(value, "compaction");
  expectExactKeys(
    item,
    [
      "encrypted_content",
      "id",
      "internal_chat_message_metadata_passthrough",
      ...(options.allowResponseMetadata === true ? ["metadata"] : []),
      "type",
    ],
    "compaction"
  );
  if (
    item.type !== "compaction" &&
    !(options.allowAlias === true && item.type === "compaction_summary")
  ) {
    validationError("compaction.type is not canonical");
  }
  const encryptedContent = expectString(
    item.encrypted_content,
    "compaction.encrypted_content"
  );
  if (encryptedContent.length === 0) {
    validationError("compaction.encrypted_content must not be empty");
  }

  const parsed: {
    encrypted_content: string;
    id?: string;
    internal_chat_message_metadata_passthrough?: {
      turn_id?: string;
    };
    type: "compaction";
  } = {
    encrypted_content: encryptedContent,
    type: "compaction",
  };
  if (item.id !== undefined) {
    parsed.id = expectIdentifier(item.id, "compaction.id");
  }
  const metadata = parseMetadata(
    item.internal_chat_message_metadata_passthrough,
    "compaction.internal_chat_message_metadata_passthrough"
  );
  if (metadata !== undefined) {
    parsed.internal_chat_message_metadata_passthrough = metadata;
  }
  return parsed;
};

export const parseRealUserInputItem = (
  value: unknown,
  path = "replacement item"
): RealUserInputItem => {
  const item = expectRecord(value, path);
  expectExactKeys(item, ["content", "role", "type"], path);
  if (item.type !== "message" || item.role !== "user") {
    validationError(`${path} must be a canonical user message`);
  }
  const rawContent = item.content;
  if (!isUnknownArray(rawContent) || rawContent.length === 0) {
    throw new Error(`${path}.content must be a non-empty array`);
  }

  const content = rawContent.map((rawContentItem, index) => {
    const contentPath = `${path}.content[${index}]`;
    const contentItem = expectRecord(rawContentItem, contentPath);
    if (contentItem.type === "input_text") {
      expectExactKeys(contentItem, ["text", "type"], contentPath);
      return {
        text: expectString(contentItem.text, `${contentPath}.text`),
        type: "input_text" as const,
      };
    }
    if (contentItem.type === "input_image") {
      expectExactKeys(contentItem, ["image_url", "type"], contentPath);
      const imageUrl = expectString(
        contentItem.image_url,
        `${contentPath}.image_url`
      );
      if (!/^data:image\//iu.test(imageUrl)) {
        validationError(`${contentPath}.image_url must be an inline image`);
      }
      return {
        image_url: imageUrl,
        type: "input_image" as const,
      };
    }
    return validationError(`${contentPath}.type is not permitted`);
  });

  return { content, role: "user", type: "message" };
};

export const parseAgentMessageItem = (
  value: unknown,
  path: string
): CheckpointAgentMessageItem => {
  const item = expectRecord(value, path);
  expectExactKeys(
    item,
    [
      "author",
      "content",
      "id",
      "internal_chat_message_metadata_passthrough",
      "recipient",
      "type",
    ],
    path
  );
  if (item.type !== "agent_message") {
    validationError(`${path}.type is not permitted`);
  }
  const rawContent = item.content;
  if (!isUnknownArray(rawContent)) {
    throw new Error(`${path}.content must be an array`);
  }
  if (rawContent.length === 0) {
    validationError(`${path}.content must be a non-empty array`);
  }
  const content = rawContent.map((rawPart, index) => {
    const contentPath = `${path}.content[${index}]`;
    const part = expectRecord(rawPart, contentPath);
    if (part.type === "input_text") {
      expectExactKeys(part, ["text", "type"], contentPath);
      return {
        text: expectString(part.text, `${contentPath}.text`),
        type: "input_text" as const,
      };
    }
    if (part.type === "encrypted_content") {
      expectExactKeys(part, ["encrypted_content", "type"], contentPath);
      const encryptedContent = expectString(
        part.encrypted_content,
        `${contentPath}.encrypted_content`
      );
      if (encryptedContent.length === 0) {
        validationError(`${contentPath}.encrypted_content must not be empty`);
      }
      return {
        encrypted_content: encryptedContent,
        type: "encrypted_content" as const,
      };
    }
    return validationError(`${contentPath}.type is not permitted`);
  });
  const parsed: CheckpointAgentMessageItem = {
    author: expectIdentifier(item.author, `${path}.author`),
    content,
    recipient: expectIdentifier(item.recipient, `${path}.recipient`),
    type: "agent_message",
  };
  const id =
    item.id === undefined ? undefined : expectIdentifier(item.id, `${path}.id`);
  const metadata = parseMetadata(
    item.internal_chat_message_metadata_passthrough,
    `${path}.internal_chat_message_metadata_passthrough`
  );
  return {
    ...parsed,
    ...(id === undefined ? {} : { id }),
    ...(metadata
      ? { internal_chat_message_metadata_passthrough: metadata }
      : {}),
  };
};

const parseReplacement = (
  value: unknown
): readonly CheckpointReplacementItem[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("checkpoint.replacement must be a non-empty array");
  }

  let compactionCount = 0;
  const rawReplacement: unknown[] = value;
  const replacement = rawReplacement.map((item, index) => {
    if (isRecord(item) && item.type === "compaction") {
      compactionCount += 1;
      if (index !== rawReplacement.length - 1) {
        validationError("checkpoint compaction item must be final");
      }
      return parseCompactionItem(item);
    }
    if (isRecord(item) && item.type === "agent_message") {
      return parseAgentMessageItem(item, `checkpoint.replacement[${index}]`);
    }
    const user = parseRealUserInputItem(
      item,
      `checkpoint.replacement[${index}]`
    );
    const textContent = user.content.filter(
      (content): content is InputTextItem => content.type === "input_text"
    );
    if (textContent.length !== user.content.length) {
      validationError("checkpoint replacement users must be text-only");
    }
    return { ...user, content: textContent } satisfies CheckpointUserInputItem;
  });
  if (compactionCount !== 1) {
    validationError("checkpoint replacement requires exactly one compaction");
  }
  return replacement;
};

const parseIdentity = (value: unknown): Checkpoint["identity"] => {
  const identity = expectRecord(value, "checkpoint.identity");
  expectExactKeys(
    identity,
    ["api", "baseUrl", "model", "provider"],
    "checkpoint.identity"
  );
  if (
    identity.provider !== "openai-codex" ||
    identity.api !== "openai-codex-responses"
  ) {
    validationError("checkpoint identity provider/API is not supported");
  }
  if (identity.baseUrl !== null && typeof identity.baseUrl !== "string") {
    throw new Error("checkpoint.identity.baseUrl must be a string or null");
  }
  const baseUrl = normalizeBaseUrl(identity.baseUrl);
  if (identity.baseUrl !== baseUrl) {
    validationError("checkpoint.identity.baseUrl must be canonical");
  }
  return {
    api: "openai-codex-responses",
    baseUrl,
    model: expectIdentifier(identity.model, "checkpoint.identity.model"),
    provider: "openai-codex",
  };
};

const parseUsage = (value: unknown): Checkpoint["response"]["usage"] => {
  const usage = expectRecord(value, "checkpoint.response.usage");
  expectExactKeys(
    usage,
    ["cacheRead", "cacheWrite", "input", "output", "totalTokens"],
    "checkpoint.response.usage"
  );
  return {
    cacheRead: expectNonnegativeInteger(
      usage.cacheRead,
      "checkpoint.response.usage.cacheRead"
    ),
    cacheWrite: expectNonnegativeInteger(
      usage.cacheWrite,
      "checkpoint.response.usage.cacheWrite"
    ),
    input: expectNonnegativeInteger(
      usage.input,
      "checkpoint.response.usage.input"
    ),
    output: expectNonnegativeInteger(
      usage.output,
      "checkpoint.response.usage.output"
    ),
    totalTokens: expectNonnegativeInteger(
      usage.totalTokens,
      "checkpoint.response.usage.totalTokens"
    ),
  };
};

const parseResponse = (value: unknown): Checkpoint["response"] => {
  const response = expectRecord(value, "checkpoint.response");
  expectExactKeys(response, ["id", "usage"], "checkpoint.response");
  return {
    id: expectIdentifier(response.id, "checkpoint.response.id"),
    usage: parseUsage(response.usage),
  };
};

const parseRuntime = (value: unknown): Checkpoint["runtime"] => {
  const runtime = expectRecord(value, "checkpoint.runtime");
  expectExactKeys(
    runtime,
    [
      "compHash",
      "currentWindowId",
      "effectiveTokenLimit",
      "previousWindowId",
      "requestSchemaVersion",
      "windowNumber",
    ],
    "checkpoint.runtime"
  );
  if (
    runtime.compHash !== null &&
    (typeof runtime.compHash !== "string" || runtime.compHash.length === 0)
  ) {
    validationError("checkpoint.runtime.compHash must be null or non-empty");
  }
  if (
    runtime.previousWindowId !== null &&
    typeof runtime.previousWindowId !== "string"
  ) {
    validationError(
      "checkpoint.runtime.previousWindowId must be null or an identifier"
    );
  }
  if (runtime.requestSchemaVersion !== 1) {
    validationError("checkpoint.runtime.requestSchemaVersion is invalid");
  }
  return {
    compHash: typeof runtime.compHash === "string" ? runtime.compHash : null,
    currentWindowId: expectIdentifier(
      runtime.currentWindowId,
      "checkpoint.runtime.currentWindowId"
    ),
    effectiveTokenLimit: expectNonnegativeInteger(
      runtime.effectiveTokenLimit,
      "checkpoint.runtime.effectiveTokenLimit"
    ),
    previousWindowId:
      runtime.previousWindowId === null
        ? null
        : expectIdentifier(
            runtime.previousWindowId,
            "checkpoint.runtime.previousWindowId"
          ),
    requestSchemaVersion: 1,
    windowNumber: expectNonnegativeInteger(
      runtime.windowNumber,
      "checkpoint.runtime.windowNumber"
    ),
  };
};

const canonicalize = (value: unknown, ancestors: WeakSet<object>): string => {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      validationError("canonical JSON cannot contain non-finite numbers");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    return validationError("canonical JSON contains a non-JSON value");
  }
  if (ancestors.has(value)) {
    return validationError("canonical JSON cannot contain cycles");
  }

  ancestors.add(value);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value
      .map((item) => canonicalize(item, ancestors))
      .join(",")}]`;
  } else {
    const record = expectRecord(value, "canonical JSON value");
    serialized = `{${Object.keys(record)
      .toSorted()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`
      )
      .join(",")}}`;
  }
  ancestors.delete(value);
  return serialized;
};

export const canonicalJson = (value: unknown) =>
  canonicalize(value, new WeakSet());

export const sha256Canonical = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const parseCheckpointValue = (value: JsonRecord): Checkpoint => {
  expectExactKeys(
    value,
    [
      "identity",
      "phase",
      "protocol",
      "reason",
      "replacement",
      "replacementSha256",
      "response",
      "runtime",
      "schema",
      "sourceTokens",
      "version",
    ],
    "checkpoint"
  );
  if (
    value.schema !== CHECKPOINT_SCHEMA ||
    value.protocol !== CHECKPOINT_PROTOCOL ||
    value.version !== 1
  ) {
    validationError("checkpoint schema/protocol/version is invalid");
  }
  const { phase, reason } = value;
  if (!isCheckpointReason(reason)) {
    throw new Error("checkpoint.reason is invalid");
  }
  if (!isCheckpointPhase(phase)) {
    throw new Error("checkpoint.phase is invalid");
  }

  const replacement = parseReplacement(value.replacement);
  const replacementSha256 = expectSha256(
    value.replacementSha256,
    "checkpoint.replacementSha256"
  );
  if (sha256Canonical(replacement) !== replacementSha256) {
    validationError("checkpoint replacement integrity does not match");
  }

  return {
    identity: parseIdentity(value.identity),
    phase,
    protocol: "openai-responses-compaction-v2" as const,
    reason,
    replacement,
    replacementSha256,
    response: parseResponse(value.response),
    runtime: parseRuntime(value.runtime),
    schema: CHECKPOINT_SCHEMA,
    sourceTokens: expectNonnegativeInteger(
      value.sourceTokens,
      "checkpoint.sourceTokens"
    ),
    version: 1,
  };
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

export const parseCheckpoint = (value: unknown): CheckpointParseResult => {
  if (!isRecord(value)) {
    return {
      error: "checkpoint must be a plain object",
      ok: false,
    };
  }
  try {
    return { checkpoint: deepFreeze(parseCheckpointValue(value)), ok: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "checkpoint is invalid",
      ok: false,
    };
  }
};

export const decideCheckpointCompatibility = (
  checkpoint: Pick<Checkpoint, "identity" | "runtime">,
  current: CheckpointIdentity
): CompatibilityDecision => {
  if (checkpoint.identity.provider !== current.provider) {
    return { compatible: false, field: "provider" };
  }
  if (checkpoint.identity.api !== current.api) {
    return { compatible: false, field: "api" };
  }
  if (
    checkpoint.runtime.compHash !== null &&
    current.compHash !== null &&
    current.compHash !== undefined &&
    checkpoint.runtime.compHash !== current.compHash
  ) {
    return { compatible: false, field: "compHash" };
  }
  let currentBaseUrl: string | null;
  try {
    currentBaseUrl = normalizeBaseUrl(current.baseUrl);
  } catch {
    return { compatible: false, field: "baseUrl" };
  }
  if (checkpoint.identity.baseUrl !== currentBaseUrl) {
    return { compatible: false, field: "baseUrl" };
  }
  return { compatible: true };
};

const isReadablePortableLifecycleSummary = (summary: unknown) =>
  typeof summary === "string" && summary.trim().length > 0;

export const resolveCheckpointCarrier = (entry: SessionEntry) => {
  if (entry.type === "custom" && entry.customType === CHECKPOINT_CUSTOM_TYPE) {
    const parsed = parseCheckpoint(entry.data);
    return parsed.ok
      ? ({
          carrier: "inline",
          checkpoint: parsed.checkpoint,
          kind: "checkpoint",
        } as const)
      : ({ carrier: "inline", kind: "invalid-checkpoint" } as const);
  }
  if (entry.type !== "compaction") {
    return { kind: "none" } as const;
  }
  if (
    !isRecord(entry.details) ||
    entry.details.type !== CHECKPOINT_CUSTOM_TYPE
  ) {
    return { kind: "pi-compaction" } as const;
  }
  try {
    expectExactKeys(
      entry.details,
      ["checkpoint", "type"],
      "compaction.details"
    );
  } catch {
    return { carrier: "lifecycle", kind: "invalid-checkpoint" } as const;
  }
  const parsed = parseCheckpoint(entry.details.checkpoint);
  return parsed.ok
    ? ({
        carrier: "lifecycle",
        checkpoint: parsed.checkpoint,
        kind: "checkpoint",
      } as const)
    : ({ carrier: "lifecycle", kind: "invalid-checkpoint" } as const);
};

export const isPortableLifecycleCompaction = (
  branch: readonly SessionEntry[],
  lifecycleBoundaryIndex: number
) => {
  const entry = branch[lifecycleBoundaryIndex];
  if (
    entry?.type !== "compaction" ||
    !isReadablePortableLifecycleSummary(entry.summary) ||
    resolveCheckpointCarrier(entry).kind !== "checkpoint"
  ) {
    return false;
  }
  return branch
    .slice(0, lifecycleBoundaryIndex)
    .some((candidate) => candidate.id === entry.firstKeptEntryId);
};

export const canUseInlineLocalFallback = (
  branch: readonly SessionEntry[],
  inlineBoundaryIndex: number
) => {
  const nearestCompactionIndex = branch
    .slice(0, inlineBoundaryIndex)
    .findLastIndex((entry) => entry.type === "compaction");
  if (nearestCompactionIndex === -1) {
    return true;
  }
  const carrier = resolveCheckpointCarrier(branch[nearestCompactionIndex]);
  if (carrier.kind === "checkpoint" && carrier.carrier === "lifecycle") {
    return isPortableLifecycleCompaction(branch, nearestCompactionIndex);
  }
  return !(
    carrier.kind === "invalid-checkpoint" && carrier.carrier === "lifecycle"
  );
};

export const resolveActiveCheckpointBoundary = (
  branch: readonly SessionEntry[]
): ActiveCheckpointBoundary => {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    const carrier = resolveCheckpointCarrier(entry);
    if (carrier.kind === "none") {
      continue;
    }
    if (carrier.kind === "pi-compaction") {
      return carrier;
    }
    if (carrier.kind === "invalid-checkpoint") {
      return carrier.carrier === "inline"
        ? { ...carrier, boundaryIndex: index }
        : carrier;
    }
    return {
      ...carrier,
      boundaryEntryId: entry.id,
      boundaryIndex: index,
      tail: branch.slice(index + 1),
    };
  }
  return { kind: "none" };
};
