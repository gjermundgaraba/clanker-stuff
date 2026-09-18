import { describe, it, expect } from "vite-plus/test";
import { WatchDecoder, MAX_RECORD_BYTES } from "../protocol.js";

describe("WatchDecoder", () => {
  it("decodes byte-fragmented UTF8, LF framing and JSON newlines", () => {
    const decoder = new WatchDecoder();
    const records: unknown[] = [];

    for (const byte of Buffer.from('{"v":1,"type":"event","data":"😀\\nnext"}\n')) {
      decoder.push(Buffer.from([byte]), (record) => {
        records.push(record);

        return true;
      });
    }

    decoder.finish();
    expect(records).toEqual([{ v: 1, type: "event", data: "😀\nnext" }]);
  });
  it.each([
    "not JSON\n",
    '{"v":2,"type":"event","data":0}\n',
    '{"v":1,"type":"event","data":0,"extra":true}\n',
    '{"v":1,"type":"event"}\n',
    "\n",
    '{"v":1,"type":"unknown","data":0}\n',
  ])("rejects invalid record %s", (line) => {
    expect(() => new WatchDecoder().push(Buffer.from(line), () => true)).toThrow();
  });
  it("rejects invalid UTF8, oversized and incomplete final records", () => {
    expect(() => new WatchDecoder().push(Buffer.from([255, 10]), () => true)).toThrow();
    const decoder = new WatchDecoder();
    decoder.push(Buffer.alloc(MAX_RECORD_BYTES, 32), () => true);
    expect(() => decoder.push(Buffer.from(" "), () => true)).toThrow();
    const partial = new WatchDecoder();
    partial.push(Buffer.from('{"v":1,"type":"result","data":0}'), () => true);
    expect(() => partial.finish()).toThrow();
  });
  it("stops decoding after a terminal decision", () => {
    const decoder = new WatchDecoder();
    const records: unknown[] = [];
    decoder.push(Buffer.from('{"v":1,"type":"result","data":1}\ninvalid\n'), (r) => {
      records.push(r);

      return false;
    });
    decoder.push(Buffer.from("also invalid"), () => {
      throw new Error("late callback");
    });
    decoder.finish();
    expect(records).toHaveLength(1);
  });
});
