import { createHash } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { CHECKPOINT_CUSTOM_TYPE } from "./checkpoint-marker.js";

export { CHECKPOINT_CUSTOM_TYPE } from "./checkpoint-marker.js";

export const CHECKPOINT_PROTOCOL = "openai-responses-compaction-v2";
export const CHECKPOINT_SCHEMA = "clanker.codex-provider/checkpoint";
export const nativeCheckpointSummary = (windowId: string) =>
  `History is stored in OpenAI Codex checkpoint ${windowId}. Continue with a compatible Codex provider.`;
export const RETAINED_USER_TOKEN_BUDGET = 64_000;
export const RETAINED_USER_IMAGE_PLACEHOLDER = "image content omitted from compacted history";
export const REMOTE_USER_IMAGE_PLACEHOLDER =
  "image content omitted because remote image URLs are not supported";

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

type MutableCompactionItem = {
  -readonly [K in keyof CanonicalCompactionItem]: CanonicalCompactionItem[K];
};

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

const strict = { additionalProperties: false };
const WireValueSchema = Type.Unknown();
export type CheckpointInput = Static<typeof WireValueSchema>;
type WireValue = CheckpointInput;

const StringValueSchema = Type.String();
const BooleanValueSchema = Type.Boolean();
const NumberValueSchema = Type.Number();
const UnknownArraySchema = Type.Array(Type.Unknown());
const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
type UnknownRecord = Static<typeof UnknownRecordSchema>;
const IdentifierSchema = Type.String({
  maxLength: 1024,
  minLength: 1,
  pattern: "^(?!\\s)(?![\\s\\S]*\\s$)(?![\\s\\S]*[\\x00-\\x1F\\x7F])[\\s\\S]+$",
});
const NonnegativeSafeIntegerSchema = Type.Integer({
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: 0,
});
const MetadataSchema = Type.Object({ turn_id: Type.Optional(IdentifierSchema) }, strict);
const InputTextItemSchema = Type.Object(
  { text: Type.String(), type: Type.Literal("input_text") },
  strict,
);
const InputImageItemSchema = Type.Object(
  {
    image_url: Type.String({ pattern: "^[dD][aA][tT][aA]:[iI][mM][aA][gG][eE]/" }),
    type: Type.Literal("input_image"),
  },
  strict,
);
const RealUserInputItemSchema = Type.Object(
  {
    content: Type.Array(Type.Union([InputTextItemSchema, InputImageItemSchema]), { minItems: 1 }),
    role: Type.Literal("user"),
    type: Type.Literal("message"),
  },
  strict,
);
const CheckpointUserInputItemSchema = Type.Object(
  {
    content: Type.Array(InputTextItemSchema, { minItems: 1 }),
    role: Type.Literal("user"),
    type: Type.Literal("message"),
  },
  strict,
);
const EncryptedContentSchema = Type.Object(
  {
    encrypted_content: Type.String({ minLength: 1 }),
    type: Type.Literal("encrypted_content"),
  },
  strict,
);
const CheckpointAgentMessageItemSchema = Type.Object(
  {
    author: IdentifierSchema,
    content: Type.Array(Type.Union([InputTextItemSchema, EncryptedContentSchema]), {
      minItems: 1,
    }),
    id: Type.Optional(IdentifierSchema),
    internal_chat_message_metadata_passthrough: Type.Optional(MetadataSchema),
    recipient: IdentifierSchema,
    type: Type.Literal("agent_message"),
  },
  strict,
);
const CanonicalCompactionItemSchema = Type.Object(
  {
    encrypted_content: Type.String({ minLength: 1 }),
    id: Type.Optional(IdentifierSchema),
    internal_chat_message_metadata_passthrough: Type.Optional(MetadataSchema),
    type: Type.Literal("compaction"),
  },
  strict,
);
const CompactionWireSchema = Type.Object(
  {
    encrypted_content: Type.String({ minLength: 1 }),
    id: Type.Optional(IdentifierSchema),
    internal_chat_message_metadata_passthrough: Type.Optional(MetadataSchema),
    metadata: Type.Optional(Type.Unknown()),
    type: Type.Union([Type.Literal("compaction"), Type.Literal("compaction_summary")]),
  },
  strict,
);
const CheckpointReplacementSchema = Type.Array(
  Type.Union([
    CheckpointUserInputItemSchema,
    CheckpointAgentMessageItemSchema,
    CanonicalCompactionItemSchema,
  ]),
  { minItems: 1 },
);
const CheckpointSchema = Type.Object(
  {
    identity: Type.Object(
      {
        api: Type.Literal("openai-codex-responses"),
        baseUrl: Type.Union([Type.String(), Type.Null()]),
        model: IdentifierSchema,
        provider: Type.Literal("openai-codex"),
      },
      strict,
    ),
    phase: Type.Union([
      Type.Literal("mid-turn"),
      Type.Literal("overflow-retry"),
      Type.Literal("pre-sampling"),
      Type.Literal("standalone"),
    ]),
    protocol: Type.Literal("openai-responses-compaction-v2"),
    reason: Type.Union([
      Type.Literal("manual"),
      Type.Literal("overflow"),
      Type.Literal("threshold"),
    ]),
    replacement: CheckpointReplacementSchema,
    replacementSha256: Type.String({ pattern: "^[\\da-f]{64}$" }),
    response: Type.Object(
      {
        id: IdentifierSchema,
        usage: Type.Object(
          {
            cacheRead: NonnegativeSafeIntegerSchema,
            cacheWrite: NonnegativeSafeIntegerSchema,
            input: NonnegativeSafeIntegerSchema,
            output: NonnegativeSafeIntegerSchema,
            totalTokens: NonnegativeSafeIntegerSchema,
          },
          strict,
        ),
      },
      strict,
    ),
    runtime: Type.Object(
      {
        compHash: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
        currentWindowId: IdentifierSchema,
        effectiveTokenLimit: NonnegativeSafeIntegerSchema,
        previousWindowId: Type.Union([IdentifierSchema, Type.Null()]),
        requestSchemaVersion: Type.Literal(1),
        windowNumber: NonnegativeSafeIntegerSchema,
      },
      strict,
    ),
    schema: Type.Literal("clanker.codex-provider/checkpoint"),
    sourceTokens: NonnegativeSafeIntegerSchema,
    version: Type.Literal(1),
  },
  strict,
);
const LifecycleMarkerSchema = Type.Object({ type: Type.Literal(CHECKPOINT_CUSTOM_TYPE) });
const LifecycleDetailsSchema = Type.Object(
  { checkpoint: Type.Unknown(), type: Type.Literal(CHECKPOINT_CUSTOM_TYPE) },
  strict,
);
const validationError = (message: string): never => {
  throw new Error(message);
};

const isPlainRecord = (value: WireValue): value is UnknownRecord => {
  try {
    if (!Value.Check(UnknownRecordSchema, value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
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
    validationError("baseUrl must be an HTTP(S) URL without credentials or query");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path}`;
};

export const parseCompactionItem = (
  value: WireValue,
  options: {
    readonly allowAlias?: boolean;
    readonly allowResponseMetadata?: boolean;
  } = {},
): CanonicalCompactionItem => {
  if (!Value.Check(CompactionWireSchema, value)) {
    throw new Error("compaction is invalid");
  }
  const item = Value.Clone(Value.Parse(CompactionWireSchema, value));
  if (item.type === "compaction_summary" && options.allowAlias !== true) {
    validationError("compaction.type is not canonical");
  }
  if ("metadata" in item && options.allowResponseMetadata !== true) {
    validationError("compaction.metadata is not recognized");
  }
  const parsed: MutableCompactionItem = {
    encrypted_content: item.encrypted_content,
    type: "compaction",
  };
  if (item.id !== undefined) {
    parsed.id = item.id;
  }
  if (item.internal_chat_message_metadata_passthrough !== undefined) {
    parsed.internal_chat_message_metadata_passthrough =
      item.internal_chat_message_metadata_passthrough;
  }
  return parsed;
};

export const parseRealUserInputItem = (
  value: WireValue,
  path = "replacement item",
): RealUserInputItem => {
  if (!Value.Check(RealUserInputItemSchema, value)) {
    throw new Error(`${path} must be a canonical user message`);
  }
  return Value.Clone(Value.Parse(RealUserInputItemSchema, value));
};

export const parseAgentMessageItem = (
  value: WireValue,
  path: string,
): CheckpointAgentMessageItem => {
  if (!Value.Check(CheckpointAgentMessageItemSchema, value)) {
    throw new Error(`${path} must be a canonical agent message`);
  }
  return Value.Clone(Value.Parse(CheckpointAgentMessageItemSchema, value));
};

const canonicalize = (value: WireValue, ancestors: WeakSet<object>): string => {
  if (value === null) {
    return "null";
  }
  if (Value.Check(StringValueSchema, value) || Value.Check(BooleanValueSchema, value)) {
    return JSON.stringify(value) ?? validationError("canonical JSON contains a non-JSON value");
  }
  if (Value.Check(NumberValueSchema, value)) {
    if (!Number.isFinite(value)) {
      validationError("canonical JSON cannot contain non-finite numbers");
    }
    return Object.is(value, -0)
      ? "0"
      : (JSON.stringify(value) ?? validationError("canonical JSON contains a non-JSON value"));
  }
  if (Value.Check(UnknownArraySchema, value)) {
    if (ancestors.has(value)) {
      return validationError("canonical JSON cannot contain cycles");
    }
    ancestors.add(value);
    const serialized = `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return serialized;
  }
  if (isPlainRecord(value)) {
    if (ancestors.has(value)) {
      return validationError("canonical JSON cannot contain cycles");
    }
    ancestors.add(value);
    const serialized = `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`)
      .join(",")}}`;
    ancestors.delete(value);
    return serialized;
  }
  return validationError("canonical JSON contains a non-JSON value");
};

export const canonicalJson = (value: WireValue) => canonicalize(value, new WeakSet());

export const sha256Canonical = (value: WireValue) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const parseCheckpointValue = (value: WireValue): Checkpoint => {
  const checkpoint = Value.Clone(Value.Parse(CheckpointSchema, value));
  const compactionIndexes = checkpoint.replacement.flatMap((item, index) =>
    item.type === "compaction" ? [index] : [],
  );
  if (compactionIndexes.length !== 1) {
    validationError("checkpoint replacement requires exactly one compaction");
  }
  if (compactionIndexes[0] !== checkpoint.replacement.length - 1) {
    validationError("checkpoint compaction item must be final");
  }
  if (normalizeBaseUrl(checkpoint.identity.baseUrl) !== checkpoint.identity.baseUrl) {
    validationError("checkpoint.identity.baseUrl must be canonical");
  }
  if (sha256Canonical(checkpoint.replacement) !== checkpoint.replacementSha256) {
    validationError("checkpoint replacement integrity does not match");
  }
  return checkpoint;
};

const deepFreeze = <T>(value: T): T => {
  if (!Object.isFrozen(value) && Value.Check(UnknownArraySchema, value)) {
    for (const child of value) {
      deepFreeze(child);
    }
    Object.freeze(value);
  } else if (!Object.isFrozen(value) && Value.Check(UnknownRecordSchema, value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

export const parseCheckpoint = (value: WireValue): CheckpointParseResult => {
  if (!Value.Check(CheckpointSchema, value)) {
    return {
      error: "checkpoint is invalid",
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
  current: CheckpointIdentity,
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
  if (!Value.Check(LifecycleMarkerSchema, entry.details)) {
    return { kind: "pi-compaction" } as const;
  }
  if (!Value.Check(LifecycleDetailsSchema, entry.details)) {
    return { carrier: "lifecycle", kind: "invalid-checkpoint" } as const;
  }
  const details = Value.Parse(LifecycleDetailsSchema, entry.details);
  const parsed = parseCheckpoint(details.checkpoint);
  return parsed.ok
    ? ({
        carrier: "lifecycle",
        checkpoint: parsed.checkpoint,
        kind: "checkpoint",
      } as const)
    : ({ carrier: "lifecycle", kind: "invalid-checkpoint" } as const);
};

export const canUseInlineLocalFallback = (
  branch: readonly SessionEntry[],
  inlineBoundaryIndex: number,
) => {
  const nearestCompactionIndex = branch
    .slice(0, inlineBoundaryIndex)
    .findLastIndex((entry) => entry.type === "compaction");
  if (nearestCompactionIndex === -1) {
    return true;
  }
  const carrier = resolveCheckpointCarrier(branch[nearestCompactionIndex]);
  return carrier.kind === "pi-compaction";
};

export const resolveActiveCheckpointBoundary = (
  branch: readonly SessionEntry[],
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
      return carrier.carrier === "inline" ? { ...carrier, boundaryIndex: index } : carrier;
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
