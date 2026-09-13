// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import type { RuntimeToolResult, RuntimeToolTrace } from "./types.js";

const MAX_TRACE_TEXT_CHARS = 32_768;
const MAX_TRACE_DETAILS_CHARS = 65_536;
const MAX_SERIALIZED_NODES = 4096;
/** Appended to a string the trace budget cut short; renderers treat such arguments as partial. */
export const TRACE_VALUE_TRUNCATED_MARKER = "[value truncated]";

type SanitizedValue =
  | boolean
  | null
  | number
  | string
  | undefined
  | SanitizedValue[]
  | { [key: string]: SanitizedValue };

export function toolResultFromValue(value: unknown): RuntimeToolResult {
  return {
    content: [
      {
        text:
          typeof value === "string"
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

export function sanitizeTraceInput(value: unknown, maxChars: number): SanitizedValue {
  return sanitizeValue(value, { remaining: maxChars });
}

interface SerializationBudget {
  remaining: number;
  nodesRemaining?: number;
  seen?: WeakSet<object>;
  depth?: number;
}

function sanitizeValue(value: unknown, budget: SerializationBudget): SanitizedValue {
  const depth = budget.depth ?? 0;
  const nodesRemaining = budget.nodesRemaining ?? MAX_SERIALIZED_NODES;
  if (nodesRemaining <= 0 || budget.remaining <= 0) {
    return "[value limit]";
  }
  budget.nodesRemaining = nodesRemaining - 1;
  budget.remaining = Math.max(0, budget.remaining - 1);
  if (value === null || value === undefined || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    budget.remaining = Math.max(0, budget.remaining - 8);
    return value;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return sanitizeValue(String(value), budget);
  }
  if (typeof value === "string") {
    const available = Math.max(0, budget.remaining);
    budget.remaining -= Math.min(value.length, available);
    return value.length <= available
      ? value
      : `${value.slice(0, Math.max(0, available - 21))}${TRACE_VALUE_TRUNCATED_MARKER}`;
  }
  if (depth >= 12) {
    return "[depth limit]";
  }
  try {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value !== "object") {
      return "[unavailable object]";
    }
    const seen = budget.seen ?? new WeakSet<object>();
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    const childBudget = { ...budget, depth: depth + 1, seen };
    if (Array.isArray(value)) {
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
    const output: { [key: string]: SanitizedValue } = {};
    for (const [key, entry] of Object.entries(value)) {
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
  } catch {
    return "[unavailable object]";
  }
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

function safeStringify(value: unknown, fallback: string): string {
  try {
    return JSON.stringify(sanitizeValue(value, { remaining: MAX_TRACE_TEXT_CHARS })) ?? fallback;
  } catch {
    return fallback;
  }
}
