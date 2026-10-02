import type { BodyFormat } from "./snapshot.js";

export const MAX_REQUEST_BYTES = 1024 * 1024;

const SECRET_KEY =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|cookie|^(?:auth|authentication|token|credentials?)$/i;

// oxlint-disable anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- JSON.stringify must receive opaque non-string values unchanged; narrowing or normalizing them here would alter foreign payload serialization.
function omit(this: unknown, key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;

  if (SECRET_KEY.test(key)) return "[credential omitted]";

  if (
    /^data:[^,]*;base64,/i.test(value) ||
    (key === "data" &&
      typeof this === "object" &&
      this !== null &&
      (("type" in this && this.type === "base64") ||
        ("mimeType" in this && typeof this.mimeType === "string")))
  )
    return "[base64 media omitted]";

  return value;
}
// oxlint-enable anti-slop/no-unknown-returns, anti-slop/no-known-value-widening

export interface ObservedRequest {
  readonly capturedAt: number;
  readonly body: string;
  readonly format: BodyFormat;
  readonly truncated: boolean;
}

/** Retain one JSON preview, not the original object; serialization may invoke getters/toJSON. */
export function observeRequest(payload: unknown): ObservedRequest {
  let body: string | undefined;

  try {
    body = JSON.stringify(payload, omit, 2);
  } catch {
    // Cycles, throwing getters/toJSON, and other non-JSON inputs are inspection failures.
    body = undefined;
  }

  if (body === undefined)
    return {
      capturedAt: Date.now(),
      body: "Provider payload could not be serialized as JSON.",
      format: "text",
      truncated: false,
    };

  let format: BodyFormat = "json";
  const bytes = Buffer.from(body, "utf8");
  const truncated = bytes.length > MAX_REQUEST_BYTES;

  if (truncated) {
    const suffix = "\n[request preview truncated]";
    // Streaming decode omits an incomplete trailing UTF-8 character rather than expanding it.
    body =
      new TextDecoder().decode(bytes.subarray(0, MAX_REQUEST_BYTES - Buffer.byteLength(suffix)), {
        stream: true,
      }) + suffix;
    format = "text";
  }

  return { capturedAt: Date.now(), body, format, truncated };
}
