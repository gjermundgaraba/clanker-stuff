import { zstdDecompressSync } from "node:zlib";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export const WireRecordSchema = Type.Record(Type.String(), Type.Unknown());

export type WireRecord = Static<typeof WireRecordSchema>;

export const FunctionValueSchema = Type.Function([], Type.Unknown());

export const isWireRecord = (value: unknown): value is WireRecord =>
  Value.Check(WireRecordSchema, value);

export const fetchRequestUrl = (input: Parameters<typeof fetch>[0]): string => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Fetch adapter discriminates the platform string/URL/Request and body unions before decoding transport bytes.
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
};

export const fetchRequestBody = async (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<string | undefined> => {
  const value =
    init?.body ??
    (input instanceof Request ? Buffer.from(await input.clone().arrayBuffer()) : undefined);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Fetch adapter discriminates the platform string/URL/Request and body unions before decoding transport bytes.
  if (typeof value === "string") {
    return value;
  }

  let bytes: Buffer | undefined;

  if (value instanceof ArrayBuffer) {
    bytes = Buffer.from(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  if (bytes === undefined) {
    return undefined;
  }

  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );

  return (headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString(
    "utf-8",
  );
};

export const parseCompactionRequestBody = (body: string | undefined): WireRecord | undefined => {
  if (body === undefined) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(body);

    if (!isWireRecord(value) || !Array.isArray(value.input)) {
      return undefined;
    }

    const trigger: unknown = value.input.at(-1);

    return isWireRecord(trigger) && trigger.type === "compaction_trigger" ? value : undefined;
  } catch {
    return undefined;
  }
};
