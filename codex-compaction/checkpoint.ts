import { createHash } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const CHECKPOINT_CUSTOM_TYPE = "codex-compaction.checkpoint";
export const CHECKPOINT_PROTOCOL = "openai-responses-compaction-v2";
export const CHECKPOINT_SCHEMA = "clanker.codex-compaction/checkpoint";
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
  | CheckpointUserInputItem;

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
  readonly schema: "clanker.codex-compaction/checkpoint";
  readonly sourceTokens: number;
  readonly version: 4;
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
  readonly model: string;
  readonly provider: string;
}

export type CompatibilityDecision =
  | { readonly compatible: true }
  | {
      readonly compatible: false;
      readonly field: "api" | "baseUrl" | "model" | "provider";
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
  options: { readonly allowAlias?: boolean } = {}
): CanonicalCompactionItem => {
  const item = expectRecord(value, "compaction");
  expectExactKeys(
    item,
    [
      "encrypted_content",
      "id",
      "internal_chat_message_metadata_passthrough",
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
      "schema",
      "sourceTokens",
      "version",
    ],
    "checkpoint"
  );
  if (
    value.schema !== CHECKPOINT_SCHEMA ||
    value.protocol !== CHECKPOINT_PROTOCOL ||
    value.version !== 4
  ) {
    validationError("checkpoint schema/protocol/version is invalid");
  }
  if (
    value.reason !== "manual" &&
    value.reason !== "overflow" &&
    value.reason !== "threshold"
  ) {
    throw new Error("checkpoint.reason is invalid");
  }
  if (
    value.phase !== "mid-turn" &&
    value.phase !== "overflow-retry" &&
    value.phase !== "pre-sampling" &&
    value.phase !== "standalone"
  ) {
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
    phase: value.phase,
    protocol: CHECKPOINT_PROTOCOL,
    reason: value.reason,
    replacement,
    replacementSha256,
    response: parseResponse(value.response),
    schema: CHECKPOINT_SCHEMA,
    sourceTokens: expectNonnegativeInteger(
      value.sourceTokens,
      "checkpoint.sourceTokens"
    ),
    version: 4,
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
  checkpoint: Pick<Checkpoint, "identity">,
  current: CheckpointIdentity
): CompatibilityDecision => {
  if (checkpoint.identity.provider !== current.provider) {
    return { compatible: false, field: "provider" };
  }
  if (checkpoint.identity.api !== current.api) {
    return { compatible: false, field: "api" };
  }
  if (checkpoint.identity.model !== current.model) {
    return { compatible: false, field: "model" };
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

export const canUseInlineLocalFallback = (
  branch: readonly SessionEntry[],
  inlineBoundaryIndex: number
) => {
  const nearestCompaction = branch
    .slice(0, inlineBoundaryIndex)
    .findLast((entry) => entry.type === "compaction");
  return !(
    nearestCompaction?.type === "compaction" &&
    isRecord(nearestCompaction.details) &&
    nearestCompaction.details.type === CHECKPOINT_CUSTOM_TYPE
  );
};

export const resolveActiveCheckpointBoundary = (
  branch: readonly SessionEntry[]
): ActiveCheckpointBoundary => {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      entry?.type === "custom" &&
      entry.customType === CHECKPOINT_CUSTOM_TYPE
    ) {
      const parsed = parseCheckpoint(entry.data);
      if (!parsed.ok) {
        return {
          boundaryIndex: index,
          carrier: "inline",
          kind: "invalid-checkpoint",
        };
      }
      return {
        boundaryEntryId: entry.id,
        boundaryIndex: index,
        carrier: "inline",
        checkpoint: parsed.checkpoint,
        kind: "checkpoint",
        tail: branch.slice(index + 1),
      };
    }
    if (entry?.type !== "compaction") {
      continue;
    }

    if (
      !isRecord(entry.details) ||
      entry.details.type !== CHECKPOINT_CUSTOM_TYPE
    ) {
      return { kind: "pi-compaction" };
    }
    try {
      expectExactKeys(
        entry.details,
        ["checkpoint", "type"],
        "compaction.details"
      );
    } catch {
      return { carrier: "lifecycle", kind: "invalid-checkpoint" };
    }
    const parsed = parseCheckpoint(entry.details.checkpoint);
    if (!parsed.ok) {
      return { carrier: "lifecycle", kind: "invalid-checkpoint" };
    }
    return {
      boundaryEntryId: entry.id,
      boundaryIndex: index,
      carrier: "lifecycle",
      checkpoint: parsed.checkpoint,
      kind: "checkpoint",
      tail: branch.slice(index + 1),
    };
  }
  return { kind: "none" };
};
