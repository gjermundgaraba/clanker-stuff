import type { BodyFormat } from "./snapshot.js";

export const MAX_CAPTURE_BYTES = 1024 * 1024;

// oxlint-disable anti-slop/no-known-value-widening -- JSON.stringify must receive opaque non-string values unchanged; narrowing or normalizing them here would alter foreign payload serialization.
const omitMedia = function (
  this: unknown,
  key: string,
  value: unknown
): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (
    /^data:[^,]*;base64,/iu.test(value) ||
    (key === "data" &&
      typeof this === "object" &&
      this !== null &&
      (("type" in this && this.type === "base64") ||
        ("mimeType" in this && typeof this.mimeType === "string")))
  ) {
    return "[base64 media omitted]";
  }

  return value;
};
// oxlint-enable anti-slop/no-known-value-widening

export interface Observation {
  readonly capturedAt: number;
  readonly body: string;
  readonly format: BodyFormat;
  readonly truncated: boolean;
}

const serialize = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value, omitMedia, 2);
  } catch {
    return undefined;
  }
};

export const observe = (value: unknown, label: string): Observation => {
  let body = serialize(value);

  if (body === undefined) {
    return {
      capturedAt: Date.now(),
      body: `${label} could not be serialized as JSON.`,
      format: "text",
      truncated: false,
    };
  }

  const bytes = Buffer.from(body, "utf-8");
  const truncated = bytes.length > MAX_CAPTURE_BYTES;

  if (truncated) {
    const suffix = "\n[preview truncated]";
    body =
      new TextDecoder().decode(
        bytes.subarray(0, MAX_CAPTURE_BYTES - Buffer.byteLength(suffix)),
        {
          stream: true,
        }
      ) + suffix;
  }

  return {
    capturedAt: Date.now(),
    body,
    format: truncated ? "text" : "json",
    truncated,
  };
};
