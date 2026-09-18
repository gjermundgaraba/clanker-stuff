// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import type { JsonValue } from "@earendil-works/pi-ai";
import { configure } from "safe-stable-stringify";
import type { RuntimeToolResult } from "./types.js";

const MAX_TRACE_TEXT_CHARS = 32_768;

const MAX_TRACE_DETAILS_CHARS = 65_536;

const MAX_SERIALIZED_NODES = 4096;

/** Appended to a string the trace budget cut short; renderers treat such arguments as partial. */
export const TRACE_VALUE_TRUNCATED_MARKER = "[value truncated]";

const stringify = configure({
  bigint: false,
  circularValue: "[circular]",
  deterministic: false,
  maximumDepth: 12,
});

const VALUE_LIMIT = "[value limit]";

const budgetExhausted = new Error("Trace serialization budget exhausted");

// Nested tools may return any JavaScript value; this display boundary preserves
// strings and normalizes everything else through the diagnostic serializer.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Delegated tools may return any value; normalize valid tool results or serialize the arbitrary return value for display.
export function toolResultFromValue(value: unknown): RuntimeToolResult {
  return {
    content: [
      {
        text:
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Diagnostic serializer handles arbitrary JS values; classify strings without rejecting cycles or other supported inputs.
          typeof value === "string"
            ? value
            : JSON.stringify(sanitizeTraceInput(value, MAX_TRACE_TEXT_CHARS)),
        type: "text",
      },
    ],
  };
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
    bounded.details = sanitizeTraceInput(result.details, MAX_TRACE_DETAILS_CHARS);
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

// Never split a surrogate pair: JSON escapes a lone surrogate, which can make
// the serialized prefix larger rather than smaller.
function prefix(text: string, length: number): string {
  const previous = text.charCodeAt(length - 1);
  const next = text.charCodeAt(length);

  return text.slice(
    0,
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
      ? length - 1
      : length,
  );
}

function shortenString(text: string, maxEncodedChars: number): string {
  const body = text.endsWith(TRACE_VALUE_TRUNCATED_MARKER)
    ? text.slice(0, -TRACE_VALUE_TRUNCATED_MARKER.length)
    : text;

  let low = 0;
  let high = body.length;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = prefix(body, middle) + TRACE_VALUE_TRUNCATED_MARKER;

    if (JSON.stringify(candidate).length <= maxEncodedChars) low = middle;
    else high = middle - 1;
  }

  return prefix(body, low) + TRACE_VALUE_TRUNCATED_MARKER;
}

interface TraceString {
  text: string;
  encodedLength: number;
  replace: (text: string) => void;
}

// Reduction touches only detached JSON. Each string is considered at most once,
// longest encoded string first; stable sorting breaks ties in traversal order.
function fitSnapshot(value: JsonValue, size: number, maxChars: number): JsonValue {
  const root = { value };
  const strings: TraceString[] = [];

  const collect = (entry: JsonValue, replace: (text: string) => void): void => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Budget reduction traverses an already-detached JsonValue union; preserve structured values while shortening strings.
    if (typeof entry === "string") {
      strings.push({ text: entry, encodedLength: JSON.stringify(entry).length, replace });
    } else if (Array.isArray(entry)) {
      entry.forEach((item, index) =>
        collect(item, (text) => {
          entry[index] = text;
        }),
      );
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Budget reduction traverses an already-detached JsonValue union; preserve structured values while shortening strings.
    } else if (entry !== null && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        collect(item, (text) => {
          entry[key] = text;
        });
      }
    }
  };

  collect(value, (text) => {
    root.value = text;
  });
  strings.sort((left, right) => right.encodedLength - left.encodedLength);

  for (const item of strings) {
    if (size <= maxChars) break;

    const shortened = shortenString(item.text, item.encodedLength - (size - maxChars));
    const length = JSON.stringify(shortened).length;

    if (length >= item.encodedLength) continue;

    item.replace(shortened);
    size -= item.encodedLength - length;
  }

  return size <= maxChars ? root.value : VALUE_LIMIT;
}

// Diagnostic JSON, not a lossless JavaScript clone or a sandbox for getters,
// proxies, or toJSON hooks. Normalize once, then reduce only the detached data.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Trace capture must bound arbitrary arguments, including cycles and unsupported JavaScript values, before storing JSON.
export function sanitizeTraceInput(value: unknown, maxChars: number): JsonValue {
  if (maxChars <= 0) return VALUE_LIMIT;

  let nodes = MAX_SERIALIZED_NODES;
  // An allocation guard, not an estimate of final JSON size. Markers add at most
  // MAX_SERIALIZED_NODES * marker.length; escaping adds a bounded factor.
  let textChars = maxChars * 2;

  try {
    const serialized = stringify(value, (_key, entry) => {
      if (nodes-- <= 0) throw budgetExhausted;

      // Replacing a short string with a marker would expand it and erase useful
      // discriminants. These fit within the per-node marker reservation.
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Diagnostic serializer handles arbitrary JS values; classify strings without rejecting cycles or other supported inputs.
      if (typeof entry !== "string" || entry.length <= TRACE_VALUE_TRUNCATED_MARKER.length)
        return entry;

      const allowance = Math.min(maxChars, textChars);
      const body = prefix(entry, Math.min(entry.length, allowance));
      textChars -= body.length;

      return body.length === entry.length ? entry : body + TRACE_VALUE_TRUNCATED_MARKER;
    });

    if (serialized === undefined) return null;

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: JSON.parse without a reviver returns only JSON values; the input is serialized JSON and parsing failures are contained here.
    const snapshot = JSON.parse(serialized) as JsonValue;

    return serialized.length <= maxChars
      ? snapshot
      : fitSnapshot(snapshot, serialized.length, maxChars);
  } catch (error) {
    return error === budgetExhausted ? VALUE_LIMIT : "[unavailable object]";
  }
}
