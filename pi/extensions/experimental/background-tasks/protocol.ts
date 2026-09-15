import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const MAX_RECORD_BYTES = 16 * 1024;
const eventSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("event"),
    key: Type.Optional(Type.String({ maxLength: 128 })),
    data: Type.Unknown(),
  },
  { additionalProperties: false },
);
const resultSchema = Type.Object(
  {
    v: Type.Literal(1),
    type: Type.Literal("result"),
    data: Type.Unknown(),
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
        throw new Error("stdout record exceeds 16384 bytes");
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
