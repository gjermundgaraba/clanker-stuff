import { describe, it, expect } from "vite-plus/test";

import { WatchDecoder, MAX_RECORD_BYTES } from "../protocol.js";

const record = (data: string) =>
  Buffer.from(`{"v":1,"type":"event","data":${data}}\n`);

describe("WatchDecoder", () => {
  it("decodes byte-fragmented UTF8, LF framing and JSON newlines", () => {
    const decoder = new WatchDecoder();
    const records: unknown[] = [];

    for (const byte of Buffer.from(
      '{"v":1,"type":"event","data":"😀\\nnext"}\n'
    )) {
      decoder.push(Buffer.from([byte]), (decoded) => {
        records.push(decoded);
      });
    }

    decoder.finish();
    expect(records).toStrictEqual([{ v: 1, type: "event", data: "😀\nnext" }]);
  });

  it.each([
    "not JSON\n",
    '{"v":2,"type":"event","data":0}\n',
    '{"v":1,"type":"event","data":0,"extra":true}\n',
    '{"v":1,"type":"event"}\n',
    "\n",
    '{"v":1,"type":"unknown","data":0}\n',
  ])("rejects invalid record %s", (line) => {
    expect(() => {
      new WatchDecoder().push(Buffer.from(line), () => {});
    }).toThrow(
      /^stdout record (?:is not valid UTF-8 JSON|violates events-v1)$/u
    );
  });

  it("rejects invalid UTF8, oversized and incomplete final records", () => {
    expect(() => {
      new WatchDecoder().push(Buffer.from([255, 10]), () => {});
    }).toThrow("stdout record is not valid UTF-8 JSON");
    const decoder = new WatchDecoder();
    decoder.push(Buffer.alloc(MAX_RECORD_BYTES, 32), () => {});
    expect(() => {
      decoder.push(Buffer.from(" "), () => {});
    }).toThrow(`stdout record exceeds ${MAX_RECORD_BYTES} bytes`);
    const partial = new WatchDecoder();
    partial.push(Buffer.from('{"v":1,"type":"result","data":0}'), () => {});
    expect(() => {
      partial.finish();
    }).toThrow("stdout ended with an incomplete record (missing LF)");
  });

  it("bounds data as tool text renders it, as well as the line", () => {
    // The longest plain string the line allows; plain text renders at its own size.
    const fits = record(JSON.stringify("x".repeat(MAX_RECORD_BYTES - 32)));
    const numbers = `[${Array.from({ length: 3200 }, () => "1e20").join(",")}]`;
    // Under the limit even serialized again, but each bidi control renders as a 6-byte escape.
    const escapes = JSON.stringify("\u202E".repeat(5400));
    expect(fits).toHaveLength(MAX_RECORD_BYTES + 1);
    expect(Buffer.byteLength(JSON.stringify(JSON.parse(escapes)))).toBeLessThan(
      MAX_RECORD_BYTES
    );
    const records: unknown[] = [];

    new WatchDecoder().push(fits, (r) => {
      records.push(r);
    });
    expect(records).toHaveLength(1);

    for (const data of [numbers, escapes]) {
      expect(record(data).length).toBeLessThanOrEqual(MAX_RECORD_BYTES + 1);
      expect(() => {
        new WatchDecoder().push(record(data), () => {});
      }).toThrow(/as rendered JSON/u);
    }
  });

  it("stops decoding after a result record", () => {
    const decoder = new WatchDecoder();
    const records: unknown[] = [];
    decoder.push(
      Buffer.from('{"v":1,"type":"result","data":1}\ninvalid\n'),
      (r) => {
        records.push(r);
      }
    );
    decoder.push(Buffer.from("also invalid"), () => {
      throw new Error("late callback");
    });
    decoder.finish();
    expect(records).toHaveLength(1);
  });
});
