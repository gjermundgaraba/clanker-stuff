import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import { describe, expect, it } from "vite-plus/test";
import { EVENT_BYTES, EVENT_RECORDS, TaskNotices } from "../notices.js";
import { MAX_RECORD_BYTES } from "../protocol.js";

const renderedBytes = (notices: TaskNotices) =>
  notices.events.reduce((total, event) => total + Buffer.byteLength(jsonText(event)), 0);

describe("TaskNotices", () => {
  it("announces new events and a ready outcome once, until cleared", () => {
    const notices = new TaskNotices();
    expect(notices.unread(undefined)).toBeUndefined();
    notices.record(1);
    notices.record(null);
    expect(notices.unread(undefined)).toEqual({ events: 2 });
    notices.clear(false);
    expect(notices.unread(undefined)).toBeUndefined();
    // Clearing events alone leaves a later outcome to announce.
    expect(notices.unread("completed")).toEqual({ events: 0, outcome: "completed" });
    notices.record(2);
    notices.clear(true);
    expect(notices.unread("completed")).toBeUndefined();
    expect(notices.events.map((event) => event.data)).toEqual([1, null, 2]);
  });
  it("replaces only an unannounced snapshot with the same key, moving it last", () => {
    const notices = new TaskNotices();
    notices.record("a1", "a");
    notices.clear(false);
    notices.record("b1", "b");
    notices.record("a2", "a");
    notices.record("a3", "a");
    notices.record("plain");
    expect(notices.events).toEqual([
      { seq: 1, key: "a", data: "a1" },
      { seq: 2, key: "b", data: "b1" },
      { seq: 4, key: "a", data: "a3" },
      { seq: 5, data: "plain" },
    ]);
    expect(notices.unread(undefined)).toEqual({ events: 3 });
    expect(notices.omitted).toBe(0);
  });
  it("counts unannounced events that retention dropped, but not announced ones", () => {
    const notices = new TaskNotices();

    for (let n = 0; n < EVENT_RECORDS + 3; n++) notices.record(n);
    expect(notices.unread(undefined)).toEqual({ events: EVENT_RECORDS + 3 });
    notices.clear(false);

    for (let n = 0; n < 3; n++) notices.record(n);
    expect(notices.omitted).toBe(6);
    expect(notices.unread(undefined)).toEqual({ events: 3 });
  });
  it("drops the oldest events beyond the record and byte caps", () => {
    const counted = new TaskNotices();

    for (let n = 0; n < EVENT_RECORDS + 3; n++) counted.record(n);
    expect(counted.events).toHaveLength(EVENT_RECORDS);
    expect(counted.events[0]?.data).toBe(3);
    expect(counted.omitted).toBe(3);

    // Each U+202E renders as a 6-byte escape: four such events fill the cap as rendered,
    // counting their seq and key, though their data is under a third of it in UTF-8.
    const sized = new TaskNotices();
    const large = "\u202e".repeat(677);

    for (let n = 0; n < 4; n++) sized.record(large, `k${n}`);
    expect(renderedBytes(sized)).toBeLessThanOrEqual(EVENT_BYTES);
    expect(sized.omitted).toBe(0);
    sized.record("tail");
    expect(sized.omitted).toBe(1);
    expect(sized.events.map((event) => event.seq)).toEqual([2, 3, 4, 5]);
    expect(renderedBytes(sized)).toBeLessThanOrEqual(EVENT_BYTES);
  });
  it("keeps the newest event alone when a maximal record passes the byte cap", () => {
    const notices = new TaskNotices();
    notices.record("earlier");
    const largest = "x".repeat(MAX_RECORD_BYTES - 2);
    notices.record(largest);
    expect(notices.events).toEqual([{ seq: 2, data: largest }]);
    expect(notices.omitted).toBe(1);
  });
});
