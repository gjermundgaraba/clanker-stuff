import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/** Custom message type of automatic task notifications. */
export const WAKE_TYPE = "background-tasks:wake";

export const MAX_RECORD_BYTES = 16 * 1024;

const eventSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("event"),
    key: Type.Optional(Type.String({ maxLength: 128 })),
    data: Type.Unsafe<JsonValue>(Type.Unknown()),
  },
  { additionalProperties: false },
);

const resultSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("result"),
    data: Type.Unsafe<JsonValue>(Type.Unknown()),
  },
  { additionalProperties: false },
);

const recordSchema = Type.Union([eventSchema, resultSchema]);

export type WatchRecord = Static<typeof recordSchema>;

/** Strict byte framing: Unicode separators are data, and a final LF is required. */
export class WatchDecoder {
  private pending = Buffer.alloc(0);
  private ended = false;
  private decoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: Buffer, accept: (record: WatchRecord) => boolean): void {
    if (this.ended) return;
    let offset = 0;

    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const fragment = chunk.subarray(offset, end);

      if (this.pending.length + fragment.length > MAX_RECORD_BYTES) {
        throw new Error(`stdout record exceeds ${MAX_RECORD_BYTES} bytes`);
      }

      this.pending = Buffer.concat([this.pending, fragment]);

      if (newline < 0) return;
      let record: unknown;

      try {
        record = JSON.parse(this.decoder.decode(this.pending));
      } catch {
        throw new Error("stdout record is not valid UTF-8 JSON");
      }

      this.pending = Buffer.alloc(0);

      if (!Value.Check(recordSchema, record)) throw new Error("stdout record violates events-v1");

      // Parsed values can render larger than their source (1e20 becomes 21 digits, U+202E a
      // 6-byte escape); bound the JSON tool text carries, so a result leaves room for logs.
      if (Buffer.byteLength(jsonText(record.data)) > MAX_RECORD_BYTES)
        throw new Error(`stdout record data exceeds ${MAX_RECORD_BYTES} bytes as rendered JSON`);

      if (!accept(record)) {
        this.ended = true;

        return;
      }

      offset = newline + 1;
    }
  }

  finish(): void {
    if (!this.ended && this.pending.length)
      throw new Error("stdout ended with an incomplete record (missing LF)");
    this.ended = true;
  }
}
