/* oxlint-disable eslint/no-use-before-define, eslint/func-style, eslint/complexity -- bounded serializer is kept aligned with upstream */
// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import type { RuntimeToolResult, RuntimeToolTrace } from "./types.js";

const MAX_TRACE_TEXT_CHARS = 32_768;
const MAX_TRACE_DETAILS_CHARS = 65_536;
const MAX_SERIALIZED_NODES = 4096;

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
  return {
    id: trace.id,
    input: sanitizeValue(trace.input, {
      remaining: Number.MAX_SAFE_INTEGER,
    }),
    name: trace.name,
    status: trace.status,
    ...(trace.error === undefined ? {} : { error: trace.error }),
    ...(trace.result === undefined
      ? {}
      : { result: cloneRuntimeToolResult(trace.result) }),
  };
}

export function boundRuntimeToolResult(
  result: RuntimeToolResult,
  imageCharsRemaining: number
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
  return {
    content,
    ...(result.details === undefined
      ? {}
      : {
          details: sanitizeValue(result.details, {
            remaining: MAX_TRACE_DETAILS_CHARS,
          }),
        }),
  };
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

export function sanitizeTraceInput(value: unknown, maxChars: number): unknown {
  return sanitizeValue(value, { remaining: maxChars });
}

interface SerializationBudget {
  remaining: number;
  nodesRemaining?: number;
  seen?: WeakSet<object>;
  depth?: number;
}

function sanitizeValue(value: unknown, budget: SerializationBudget): unknown {
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
  if (typeof value === "number") {
    budget.remaining = Math.max(0, budget.remaining - 8);
    return Number.isFinite(value) ? value : String(value);
  }
  if (
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return sanitizeValue(String(value), budget);
  }
  if (typeof value === "string") {
    const available = Math.max(0, budget.remaining);
    budget.remaining -= Math.min(value.length, available);
    return value.length <= available
      ? value
      : `${value.slice(0, Math.max(0, available - 21))}[value truncated]`;
  }
  if (depth >= 12) {
    return "[depth limit]";
  }
  const seen = budget.seen ?? new WeakSet<object>();
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  const childBudget = { ...budget, depth: depth + 1, seen };
  if (Array.isArray(value)) {
    const output: unknown[] = [];
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
  if (value instanceof Date) {
    return value.toISOString();
  }
  const output: Record<string, unknown> = {};
  let entries: [string, unknown][];
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
  return {
    content: result.content.map((item) => ({ ...item })),
    ...(result.details === undefined
      ? {}
      : {
          details: sanitizeValue(result.details, {
            remaining: Number.MAX_SAFE_INTEGER,
          }),
        }),
  };
}

function safeStringify(value: unknown, fallback: string): string {
  try {
    return (
      JSON.stringify(
        sanitizeValue(value, { remaining: MAX_TRACE_TEXT_CHARS })
      ) ?? fallback
    );
  } catch {
    return fallback;
  }
}
