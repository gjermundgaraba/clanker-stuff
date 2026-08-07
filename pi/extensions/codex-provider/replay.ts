import { createHash } from "node:crypto";

import {
  RETAINED_USER_TOKEN_BUDGET,
  RETAINED_USER_IMAGE_PLACEHOLDER,
  canonicalJson,
  parseAgentMessageItem,
  parseCompactionItem,
  parseRealUserInputItem,
} from "./checkpoint.js";
import type {
  CheckpointUserInputItem,
  CheckpointAgentMessageItem,
  RealUserContentItem,
  RealUserInputItem,
} from "./checkpoint.js";

export const CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE =
  "Output exceeded the available model context and was truncated";
export const FIXED_IMAGE_BYTE_ESTIMATE = 7373;
export const NON_VISION_USER_IMAGE_PLACEHOLDER =
  "(image omitted: model does not support images)";
export const FRAME_MARKER_PREFIX = "[codex-provider:frame:";

const SYNTHETIC_OUTPUT_NAMESPACE = "90d38d3e-6a5b-4d52-bfe2-2f1e634bfac4";
const encoder = new TextEncoder();

export type ResponsesInputItem = Readonly<Record<string, unknown>>;

export interface ContextWindowDecision {
  readonly autoCompactTokens: number;
  readonly effectiveWindowTokens: number;
}

export type ContextFrameResult<T> =
  | {
      readonly kind: "ambiguous" | "missing";
    }
  | {
      readonly framed: readonly T[];
      readonly kind: "ok";
      readonly messages: readonly T[];
      readonly prefix: readonly T[];
      readonly suffix: readonly T[];
    };

export type FinalizedFrameResult =
  | {
      readonly kind: "invalid";
    }
  | {
      readonly framed: readonly ResponsesInputItem[];
      readonly kind: "ok";
      readonly prefix: readonly ResponsesInputItem[];
      readonly suffix: readonly ResponsesInputItem[];
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const utf8Bytes = (value: string) => encoder.encode(value).byteLength;

export const frameMarkerText = (edge: "end" | "start", nonce: string) =>
  `${FRAME_MARKER_PREFIX}${edge}:${nonce}]`;

const canonicalJsonValue = (value: unknown) => {
  try {
    const serialized = JSON.stringify(
      isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== "timestamp")
          )
        : value
    );
    return serialized === undefined
      ? null
      : canonicalJson(JSON.parse(serialized));
  } catch {
    return null;
  }
};

export const frameContiguousBaseline = <T>(
  messages: readonly T[],
  baseline: readonly T[],
  framedSegment: readonly T[],
  startMarker: T,
  endMarker: T,
  canOmitBaselineMessage?: (message: T) => boolean
): ContextFrameResult<T> => {
  if (baseline.length === 0 || framedSegment.length > baseline.length) {
    return { kind: "missing" };
  }
  const baselineValues = baseline.map(canonicalJsonValue);
  const messageValues = messages.map(canonicalJsonValue);
  const framedSegmentValues = framedSegment.map(canonicalJsonValue);
  if (
    [...baselineValues, ...messageValues, ...framedSegmentValues].includes(null)
  ) {
    return { kind: "missing" };
  }
  const segmentOffset = baseline.length - framedSegment.length;
  if (
    framedSegmentValues.some(
      (value, index) => value !== baselineValues[segmentOffset + index]
    )
  ) {
    return { kind: "missing" };
  }
  const omittable = baseline.map(
    (message) => canOmitBaselineMessage?.(message) === true
  );
  const requiredMessages = omittable.filter((value) => !value).length;
  if (requiredMessages > messages.length) {
    return { kind: "missing" };
  }
  const matches: {
    end: number;
    framed: T[];
    start: number;
  }[] = [];
  for (let start = 0; start <= messages.length - requiredMessages; start += 1) {
    let messageIndex = start;
    let matched = true;
    const effectiveSegment: T[] = [];
    for (
      let baselineIndex = 0;
      baselineIndex < baseline.length;
      baselineIndex += 1
    ) {
      if (
        messageIndex < messages.length &&
        baselineValues[baselineIndex] === messageValues[messageIndex]
      ) {
        if (baselineIndex >= segmentOffset) {
          effectiveSegment.push(messages[messageIndex]);
        }
        messageIndex += 1;
      } else if (!omittable[baselineIndex]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push({
        end: messageIndex,
        framed: effectiveSegment,
        start,
      });
    }
  }
  if (matches.length === 0) {
    return { kind: "missing" };
  }
  if (matches.length !== 1) {
    return { kind: "ambiguous" };
  }
  const [match] = matches;
  const prefix = messages.slice(0, match.start);
  const suffix = messages.slice(match.end);
  return {
    framed: match.framed,
    kind: "ok",
    messages: [...prefix, startMarker, ...match.framed, endMarker, ...suffix],
    prefix,
    suffix,
  };
};

const serializedMarker = (
  item: ResponsesInputItem,
  nonce: string
): "end" | "start" | undefined => {
  if (item.role !== "user" || !isUnknownArray(item.content)) {
    return undefined;
  }
  if (item.content.length !== 1) {
    return undefined;
  }
  const [content] = item.content;
  if (
    !isRecord(content) ||
    content.type !== "input_text" ||
    typeof content.text !== "string"
  ) {
    return undefined;
  }
  if (content.text === frameMarkerText("start", nonce)) {
    return "start";
  }
  return content.text === frameMarkerText("end", nonce) ? "end" : undefined;
};

export const extractFinalizedFrame = (
  input: readonly ResponsesInputItem[],
  nonce: string
): FinalizedFrameResult => {
  const markers = input.flatMap((item, index) => {
    const edge = serializedMarker(item, nonce);
    return edge ? [{ edge, index }] : [];
  });
  if (
    markers.length !== 2 ||
    markers[0]?.edge !== "start" ||
    markers[1]?.edge !== "end" ||
    markers[0].index >= markers[1].index
  ) {
    return { kind: "invalid" };
  }
  return {
    framed: input.slice(markers[0].index + 1, markers[1].index),
    kind: "ok",
    prefix: input.slice(0, markers[0].index),
    suffix: input.slice(markers[1].index + 1),
  };
};

export const rewriteFramedInput = (
  frame: Extract<FinalizedFrameResult, { kind: "ok" }>,
  replacement: readonly ResponsesInputItem[] = []
) => [...frame.prefix, ...replacement, ...frame.framed, ...frame.suffix];

export const omitUnsupportedUserImages = (
  input: readonly ResponsesInputItem[],
  supportsImages: boolean
): readonly ResponsesInputItem[] => {
  if (supportsImages) {
    return input;
  }
  return input.map((item) => {
    if (
      item.type !== "message" ||
      item.role !== "user" ||
      !Array.isArray(item.content)
    ) {
      return item;
    }
    const content: unknown[] = [];
    let previousWasPlaceholder = false;
    for (const block of item.content) {
      if (isRecord(block) && block.type === "input_image") {
        if (!previousWasPlaceholder) {
          content.push({
            text: NON_VISION_USER_IMAGE_PLACEHOLDER,
            type: "input_text",
          });
        }
        previousWasPlaceholder = true;
        continue;
      }
      content.push(block);
      previousWasPlaceholder =
        isRecord(block) &&
        block.type === "input_text" &&
        block.text === NON_VISION_USER_IMAGE_PLACEHOLDER;
    }
    return { ...item, content };
  });
};

export const tokensForUtf8 = (value: string) => {
  const bytes = utf8Bytes(value);
  return Math.ceil(bytes / 4);
};

export const estimateModelVisibleItemTokens = (item: unknown) => {
  let imageCount = 0;
  const serialized = JSON.stringify(
    item,
    function modelVisibleReplacer(this: unknown, key: string, value: unknown) {
      if (
        key === "image_url" &&
        isRecord(this) &&
        this.type === "input_image" &&
        typeof value === "string"
      ) {
        imageCount += 1;
        return "";
      }
      return value;
    }
  );
  if (serialized === undefined) {
    throw new Error("Model-visible input is not JSON serializable");
  }
  return Math.ceil(
    (utf8Bytes(serialized) + imageCount * FIXED_IMAGE_BYTE_ESTIMATE) / 4
  );
};

export const estimateModelVisibleTokens = (
  instructions: string,
  input: readonly unknown[]
): number => {
  let tokens = tokensForUtf8(instructions);
  for (const item of input) {
    tokens += estimateModelVisibleItemTokens(item);
  }
  return tokens;
};

const percentOf = (value: number, percent: number) =>
  Math.floor((value * percent) / 100);

export const contextWindowDecision = (
  contextWindow: number
): ContextWindowDecision | undefined => {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  return {
    autoCompactTokens: percentOf(contextWindow, 90),
    effectiveWindowTokens: percentOf(contextWindow, 95),
  };
};

export const shouldAutoCompact = (
  estimatedTokens: number,
  contextWindow: number
) => {
  const decision = contextWindowDecision(contextWindow);
  return (
    decision !== undefined && estimatedTokens >= decision.autoCompactTokens
  );
};

const splitForByteBudget = (
  value: string,
  beginningBytes: number,
  endBytes: number
) => {
  const totalBytes = utf8Bytes(value);
  const tailTarget = Math.max(0, totalBytes - endBytes);
  let byteIndex = 0;
  let jsIndex = 0;
  let prefixEnd = 0;
  let suffixStart = value.length;
  let suffixStarted = false;

  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    const characterEnd = byteIndex + characterBytes;
    if (characterEnd <= beginningBytes) {
      prefixEnd = jsIndex + character.length;
    } else if (byteIndex >= tailTarget && !suffixStarted) {
      suffixStart = jsIndex;
      suffixStarted = true;
    }
    byteIndex = characterEnd;
    jsIndex += character.length;
  }
  if (suffixStart < prefixEnd) {
    suffixStart = prefixEnd;
  }
  return {
    prefix: value.slice(0, prefixEnd),
    suffix: value.slice(suffixStart),
  };
};

export const truncateMiddleToTokenBudget = (
  value: string,
  maxTokens: number
) => {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new Error("maxTokens must be a nonnegative safe integer");
  }
  if (value.length === 0) {
    return "";
  }

  const totalBytes = utf8Bytes(value);
  const maxBytes = maxTokens * 4;
  if (maxTokens > 0 && totalBytes <= maxBytes) {
    return value;
  }
  const initialMarker = `…${tokensForUtf8(value)} tokens truncated…`;
  const contentBudget = maxBytes - utf8Bytes(initialMarker);
  if (contentBudget < 0) {
    return "";
  }
  const leftBudget = Math.floor(contentBudget / 2);
  const { prefix, suffix } = splitForByteBudget(
    value,
    leftBudget,
    contentBudget - leftBudget
  );
  const removedTokens = Math.ceil(
    (totalBytes - utf8Bytes(prefix) - utf8Bytes(suffix)) / 4
  );
  return `${prefix}…${removedTokens} tokens truncated…${suffix}`;
};

const userMessageTextTokens = (item: RealUserInputItem) => {
  let tokens = 0;
  for (const content of item.content) {
    if (content.type === "input_text") {
      tokens += tokensForUtf8(content.text);
    }
  }
  return Math.max(1, tokens);
};

const truncateUserMessage = (
  item: RealUserInputItem,
  tokenBudget: number
): RealUserInputItem | undefined => {
  let remaining = tokenBudget;
  const content: RealUserContentItem[] = [];
  for (const contentItem of item.content) {
    if (contentItem.type === "input_image") {
      content.push(contentItem);
      continue;
    }
    if (remaining === 0) {
      continue;
    }
    const tokens = tokensForUtf8(contentItem.text);
    const text =
      tokens <= remaining
        ? contentItem.text
        : truncateMiddleToTokenBudget(contentItem.text, remaining);
    remaining = tokens <= remaining ? remaining - tokens : 0;
    if (text.length > 0) {
      content.push({ text, type: "input_text" });
    }
  }
  return content.length === 0
    ? undefined
    : { content, role: "user", type: "message" };
};

const buildReplacement = (
  retainedItems: readonly (RealUserInputItem | CheckpointAgentMessageItem)[],
  newCompaction: unknown,
  tokenBudget: number
) => {
  const compaction = parseCompactionItem(newCompaction);
  let remaining = tokenBudget;
  const retainedReversed: (RealUserInputItem | CheckpointAgentMessageItem)[] =
    [];

  for (const item of retainedItems.toReversed()) {
    if (remaining === 0) {
      continue;
    }
    if (item.type === "agent_message") {
      const text = item.content
        .filter((part) => part.type === "input_text")
        .map((part) => part.text)
        .join("");
      const tokens = Math.max(1, tokensForUtf8(text));
      if (
        tokens <= 10_000 &&
        tokens <= remaining &&
        !text.startsWith("Message Type: FINAL_ANSWER\n")
      ) {
        retainedReversed.push(item);
        remaining -= tokens;
      }
      continue;
    }
    const itemTokens = userMessageTextTokens(item);
    if (itemTokens <= remaining) {
      retainedReversed.push(item);
      remaining -= itemTokens;
      continue;
    }
    const truncated = truncateUserMessage(item, remaining);
    if (truncated) {
      retainedReversed.push(truncated);
    }
    remaining = 0;
  }

  return [...retainedReversed.toReversed(), compaction] as const;
};

export const buildCheckpointReplacement = (
  provableItems: readonly unknown[],
  newCompaction: unknown,
  tokenBudget = RETAINED_USER_TOKEN_BUDGET
) => {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) {
    throw new Error("tokenBudget must be a nonnegative safe integer");
  }
  const items = provableItems.map((item, index) => {
    if (isRecord(item) && item.type === "agent_message") {
      return parseAgentMessageItem(item, `provableItems[${index}]`);
    }
    const user = parseRealUserInputItem(item, `provableItems[${index}]`);
    return {
      ...user,
      content: user.content.map((content) =>
        content.type === "input_image"
          ? {
              text: RETAINED_USER_IMAGE_PLACEHOLDER,
              type: "input_text" as const,
            }
          : content
      ),
    } satisfies CheckpointUserInputItem;
  });
  return buildReplacement(items, newCompaction, tokenBudget);
};

export const buildTransientCheckpointReplacement = (
  provableItems: readonly unknown[],
  newCompaction: unknown,
  tokenBudget = RETAINED_USER_TOKEN_BUDGET
) => {
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) {
    throw new Error("tokenBudget must be a nonnegative safe integer");
  }
  return buildReplacement(
    provableItems.map((item, index) =>
      isRecord(item) && item.type === "agent_message"
        ? parseAgentMessageItem(item, `provableItems[${index}]`)
        : parseRealUserInputItem(item, `provableItems[${index}]`)
    ),
    newCompaction,
    tokenBudget
  );
};

const uuidBytes = (uuid: string) =>
  Buffer.from(uuid.replaceAll("-", ""), "hex");

const formatUuid = (bytes: Uint8Array) => {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

export const syntheticOutputId = (
  prefix: "ctco" | "fco" | "tso",
  sourceItemId: unknown
): string | undefined => {
  if (typeof sourceItemId !== "string" || sourceItemId.length === 0) {
    return undefined;
  }
  const digest = createHash("sha1")
    .update(uuidBytes(SYNTHETIC_OUTPUT_NAMESPACE))
    .update(`${prefix}:${sourceItemId}`)
    .digest();
  digest[6] = ((digest[6] ?? 0) % 16) + 80;
  digest[8] = ((digest[8] ?? 0) % 64) + 128;
  return `${prefix}_${formatUuid(digest.subarray(0, 16))}`;
};

type OutputFamily = "custom" | "function" | "tool-search";

const outputFamily = (item: ResponsesInputItem): OutputFamily | undefined => {
  if (item.type === "function_call_output") {
    return "function";
  }
  if (item.type === "custom_tool_call_output") {
    return "custom";
  }
  if (item.type === "tool_search_output") {
    return "tool-search";
  }
  return undefined;
};

const callId = (item: ResponsesInputItem) =>
  typeof item.call_id === "string" && item.call_id.length > 0
    ? item.call_id
    : undefined;

const familyKey = (family: OutputFamily, id: string) => `${family}:${id}`;

const supportedCall = (
  item: ResponsesInputItem
):
  | {
      readonly callId: string;
      readonly family: OutputFamily;
      readonly prefix: "ctco" | "fco" | "tso";
    }
  | undefined => {
  const id = callId(item);
  if (id === undefined) {
    return undefined;
  }
  if (item.type === "function_call" || item.type === "local_shell_call") {
    return { callId: id, family: "function", prefix: "fco" };
  }
  if (item.type === "custom_tool_call") {
    return { callId: id, family: "custom", prefix: "ctco" };
  }
  if (item.type === "tool_search_call" && item.execution === "client") {
    return { callId: id, family: "tool-search", prefix: "tso" };
  }
  return undefined;
};

const syntheticOutput = (
  item: ResponsesInputItem,
  call: NonNullable<ReturnType<typeof supportedCall>>
): ResponsesInputItem => {
  const id = syntheticOutputId(call.prefix, item.id);
  if (call.family === "tool-search") {
    return {
      ...(id === undefined ? {} : { id }),
      call_id: call.callId,
      execution: "client",
      status: "completed",
      tools: [],
      type: "tool_search_output",
    };
  }
  return {
    ...(id === undefined ? {} : { id }),
    call_id: call.callId,
    output: "aborted",
    type:
      call.family === "custom"
        ? "custom_tool_call_output"
        : "function_call_output",
  };
};

export const normalizeToolHistory = (
  input: readonly ResponsesInputItem[]
): readonly ResponsesInputItem[] => {
  const validCalls = new Set<string>();
  for (const item of input) {
    const call = supportedCall(item);
    if (call !== undefined) {
      validCalls.add(familyKey(call.family, call.callId));
    }
  }

  const seenOutputs = new Set<string>();
  const withoutOrphans = input.filter((item) => {
    const family = outputFamily(item);
    if (family === undefined) {
      return true;
    }
    if (family === "tool-search" && item.execution === "server") {
      const serverCallId = callId(item);
      if (serverCallId === undefined) {
        return true;
      }
      const serverKey = `server-tool-search:${serverCallId}`;
      if (seenOutputs.has(serverKey)) {
        return false;
      }
      seenOutputs.add(serverKey);
      return true;
    }
    const id = callId(item);
    if (id === undefined) {
      return false;
    }
    const key = familyKey(family, id);
    if (!validCalls.has(key) || seenOutputs.has(key)) {
      return false;
    }
    seenOutputs.add(key);
    return true;
  });

  const normalized: ResponsesInputItem[] = [];
  for (const item of withoutOrphans) {
    normalized.push(item);
    const call = supportedCall(item);
    if (call === undefined) {
      continue;
    }
    const key = familyKey(call.family, call.callId);
    if (seenOutputs.has(key)) {
      continue;
    }
    normalized.push(syntheticOutput(item, call));
    seenOutputs.add(key);
  }
  return normalized;
};

const rewriteOutput = (
  item: ResponsesInputItem
): ResponsesInputItem | undefined => {
  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    const output = isRecord(item.output)
      ? {
          ...item.output,
          body: CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
        }
      : CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE;
    return { ...item, output };
  }
  if (item.type === "tool_search_output") {
    return { ...item, tools: [] };
  }
  return undefined;
};

export const shrinkTrailingOutputs = (
  input: readonly ResponsesInputItem[],
  instructions: string,
  effectiveTokenLimit: number
) => {
  if (!Number.isSafeInteger(effectiveTokenLimit) || effectiveTokenLimit < 0) {
    throw new Error("effectiveTokenLimit must be a nonnegative safe integer");
  }
  const rewritten = [...input];
  let estimatedTokens = estimateModelVisibleTokens(instructions, rewritten);

  for (
    let index = rewritten.length - 1;
    index >= 0 && estimatedTokens > effectiveTokenLimit;
    index -= 1
  ) {
    const replacement = rewriteOutput(rewritten[index] ?? {});
    if (!replacement) {
      break;
    }
    rewritten[index] = replacement;
    // ponytail: contiguous output suffixes are small; cache per-item estimates
    // only if profiling shows repeated full estimates matter.
    estimatedTokens = estimateModelVisibleTokens(instructions, rewritten);
  }

  return rewritten;
};
