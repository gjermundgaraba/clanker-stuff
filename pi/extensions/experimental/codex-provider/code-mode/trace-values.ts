// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { RuntimeToolResult, RuntimeToolTrace, RuntimeValue } from "./types.js";

const MAX_TRACE_TEXT_CHARS = 32_768;
const MAX_TRACE_DETAILS_CHARS = 65_536;
const MAX_SERIALIZED_NODES = 4096;

const UnknownArraySchema = Type.Array(Type.Unknown());
const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
const BooleanValueSchema = Type.Boolean();
const NumberValueSchema = Type.Number();
const StringValueSchema = Type.String();
const FunctionValueSchema = Type.Function([], Type.Unknown());
const BigIntValueSchema = Type.BigInt();
const SymbolValueSchema = Type.Symbol();

const isUnknownArray = (value: RuntimeValue): value is RuntimeValue[] => {
  try {
    return Value.Check(UnknownArraySchema, value);
  } catch {
    return false;
  }
};

const isUnknownRecord = (value: RuntimeValue): value is { [key: string]: RuntimeValue } => {
  try {
    return Value.Check(UnknownRecordSchema, value);
  } catch {
    return false;
  }
};

type SanitizedValue =
  | boolean
  | null
  | number
  | string
  | undefined
  | SanitizedValue[]
  | { [key: string]: SanitizedValue };

export function toolResultFromValue(value: RuntimeValue): RuntimeToolResult {
  return {
    content: [
      {
        text: Value.Check(StringValueSchema, value)
          ? value
          : safeStringify(value, "(non-serializable tool result)"),
        type: "text",
      },
    ],
  };
}

export function cloneTrace(trace: RuntimeToolTrace): RuntimeToolTrace {
  const clone: RuntimeToolTrace = {
    id: trace.id,
    input: sanitizeValue(trace.input, {
      remaining: Number.MAX_SAFE_INTEGER,
    }),
    name: trace.name,
    status: trace.status,
  };
  if (trace.error !== undefined) {
    clone.error = trace.error;
  }
  if (trace.result !== undefined) {
    clone.result = cloneRuntimeToolResult(trace.result);
  }
  return clone;
}

export function boundRuntimeToolResult(
  result: RuntimeToolResult,
  imageCharsRemaining: number,
): RuntimeToolResult {
  let textRemaining = MAX_TRACE_TEXT_CHARS;
  let imageRemaining = imageCharsRemaining;
  let omittedImages = 0;
  const content: RuntimeToolResult["content"] = [];
  for (const item of result.content) {
    if (item.type === "text") {
      const text = truncateTraceText(item.text, textRemaining);
      textRemaining = Math.max(0, textRemaining - text.length);
      if (text.length > 0) {
        content.push({ ...item, text });
      }
      continue;
    }
    if (item.data.length <= imageRemaining) {
      imageRemaining -= item.data.length;
      content.push({ ...item });
    } else {
      omittedImages += 1;
    }
  }
  if (omittedImages > 0) {
    content.push({
      text: `[${omittedImages} nested image${omittedImages === 1 ? "" : "s"} omitted from trace]`,
      type: "text",
    });
  }
  const bounded: RuntimeToolResult = { content };
  if (result.details !== undefined) {
    bounded.details = sanitizeValue(result.details, {
      remaining: MAX_TRACE_DETAILS_CHARS,
    });
  }
  return bounded;
}

export function truncateTraceText(text: string, remaining: number): string {
  if (remaining <= 0) {
    return "";
  }
  if (text.length <= remaining) {
    return text;
  }
  const marker = "\n[Trace output truncated]";
  return `${text.slice(0, Math.max(0, remaining - marker.length))}${marker}`;
}

export function sanitizeTraceInput(value: RuntimeValue, maxChars: number): SanitizedValue {
  return sanitizeValue(value, { remaining: maxChars });
}

interface SerializationBudget {
  remaining: number;
  nodesRemaining?: number;
  seen?: WeakSet<object>;
  depth?: number;
}

function sanitizeValue(value: RuntimeValue, budget: SerializationBudget): SanitizedValue {
  const depth = budget.depth ?? 0;
  const nodesRemaining = budget.nodesRemaining ?? MAX_SERIALIZED_NODES;
  if (nodesRemaining <= 0 || budget.remaining <= 0) {
    return "[value limit]";
  }
  budget.nodesRemaining = nodesRemaining - 1;
  budget.remaining = Math.max(0, budget.remaining - 1);
  if (value === null || value === undefined || Value.Check(BooleanValueSchema, value)) {
    return value;
  }
  if (Value.Check(NumberValueSchema, value)) {
    budget.remaining = Math.max(0, budget.remaining - 8);
    return Number.isFinite(value) ? value : String(value);
  }
  if (
    Value.Check(BigIntValueSchema, value) ||
    Value.Check(SymbolValueSchema, value) ||
    Value.Check(FunctionValueSchema, value)
  ) {
    return sanitizeValue(String(value), budget);
  }
  if (Value.Check(StringValueSchema, value)) {
    const available = Math.max(0, budget.remaining);
    budget.remaining -= Math.min(value.length, available);
    return value.length <= available
      ? value
      : `${value.slice(0, Math.max(0, available - 21))}[value truncated]`;
  }
  if (depth >= 12) {
    return "[depth limit]";
  }
  try {
    if (value instanceof Date) {
      return value.toISOString();
    }
  } catch {
    return "[unavailable object]";
  }
  const seen = budget.seen ?? new WeakSet<object>();
  try {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
  } catch {
    return "[unavailable object]";
  }
  const childBudget = { ...budget, depth: depth + 1, seen };
  if (isUnknownArray(value)) {
    const output: SanitizedValue[] = [];
    for (const item of value) {
      if (budget.remaining <= 0) {
        output.push("[values omitted]");
        break;
      }
      output.push(sanitizeValue(item, childBudget));
      budget.remaining = childBudget.remaining;
      budget.nodesRemaining = childBudget.nodesRemaining ?? 0;
    }
    return output;
  }
  if (!isUnknownRecord(value)) {
    return "[unavailable object]";
  }
  const output: { [key: string]: SanitizedValue } = {};
  let entries: [string, RuntimeValue][];
  try {
    entries = Object.entries(value);
  } catch {
    return "[unavailable object]";
  }
  for (const [key, entry] of entries) {
    if (budget.remaining <= 0) {
      output.trace_truncated = true;
      break;
    }
    childBudget.remaining = Math.max(0, childBudget.remaining - key.length - 1);
    output[key] = sanitizeValue(entry, childBudget);
    budget.remaining = childBudget.remaining;
    budget.nodesRemaining = childBudget.nodesRemaining ?? 0;
  }
  return output;
}

function cloneRuntimeToolResult(result: RuntimeToolResult): RuntimeToolResult {
  const clone: RuntimeToolResult = {
    content: result.content.map((item) => ({ ...item })),
  };
  if (result.details !== undefined) {
    clone.details = sanitizeValue(result.details, {
      remaining: Number.MAX_SAFE_INTEGER,
    });
  }
  return clone;
}

function safeStringify(value: RuntimeValue, fallback: string): string {
  try {
    return JSON.stringify(sanitizeValue(value, { remaining: MAX_TRACE_TEXT_CHARS })) ?? fallback;
  } catch {
    return fallback;
  }
}
