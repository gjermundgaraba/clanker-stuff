import { jsonText } from "@clanker-stuff/pi-tool-rendering/text";
import { describe, expect, it } from "vite-plus/test";

import { EVENT_BYTES, EVENT_RECORDS, TaskNotices } from "../notices.js";
import { MAX_RECORD_BYTES } from "../protocol.js";

const renderedBytes = (notices: TaskNotices) =>
  notices.events.reduce(
    (total, event) => total + Buffer.byteLength(jsonText(event)),
    0
  );

describe("TaskNotices", () => {
  it("keeps updates unread after a wake and only retries newer updates", () => {
    const notices = new TaskNotices();
    notices.record(1);
    expect(notices.wake(undefined)).toStrictEqual({ events: true });
    notices.cover(false);
    expect(notices.wake(undefined)).toBeUndefined();
    expect(notices.unread(undefined)).toStrictEqual({ events: true });

    notices.record(2);
    expect(notices.wake("completed")).toStrictEqual({
      events: true,
      outcome: "completed",
    });
    notices.cover(true);
    expect(notices.wake("completed")).toBeUndefined();
    expect(notices.unread("completed")).toStrictEqual({
      events: true,
      outcome: "completed",
    });

    notices.clear(true);
    expect(notices.unread("completed")).toBeUndefined();
    expect(notices.wake("completed")).toBeUndefined();
    notices.record(3);
    expect(notices.wake("completed")).toStrictEqual({ events: true });
  });

  it("lets inspection of a decided outcome suppress its later cleanup notice", () => {
    const notices = new TaskNotices();
    notices.clear(true);
    expect(notices.unread("completed")).toBeUndefined();
    expect(notices.wake("completed")).toBeUndefined();
  });

  it("replaces keyed snapshots only until they are inspected or covered by a wake", () => {
    const notices = new TaskNotices();
    notices.record("a1", "a");
    notices.cover(false);
    notices.record("a2", "a");
    notices.record("a3", "a");
    notices.clear(false);
    notices.record("a4", "a");
    notices.record("a5", "a");
    expect(notices.events).toStrictEqual([
      { seq: 1, key: "a", data: "a1" },
      { seq: 3, key: "a", data: "a3" },
      { seq: 5, key: "a", data: "a5" },
    ]);
    expect(notices.unread(undefined)).toStrictEqual({ events: true });
    expect(notices.omitted).toBe(0);
  });

  it("keeps evicted updates unread until inspection and recognizes new updates after it", () => {
    const notices = new TaskNotices();

    for (let n = 0; n < EVENT_RECORDS + 3; n += 1) {
      notices.record(n);
    }

    notices.cover(false);
    expect(notices.omitted).toBe(3);
    expect(notices.unread(undefined)).toStrictEqual({ events: true });
    expect(notices.wake(undefined)).toBeUndefined();
    notices.clear(false);
    expect(notices.unread(undefined)).toBeUndefined();
    notices.record("new");
    expect(notices.wake(undefined)).toStrictEqual({ events: true });
  });

  it("drops the oldest events beyond the record and byte caps", () => {
    const counted = new TaskNotices();

    for (let n = 0; n < EVENT_RECORDS + 3; n += 1) {
      counted.record(n);
    }

    expect(counted.events).toHaveLength(EVENT_RECORDS);
    expect(counted.events[0]?.data).toBe(3);
    expect(counted.omitted).toBe(3);

    const sized = new TaskNotices();
    const large = "\u202E".repeat(677);

    for (let n = 0; n < 4; n += 1) {
      sized.record(large, `k${n}`);
    }

    expect(renderedBytes(sized)).toBeLessThanOrEqual(EVENT_BYTES);
    expect(sized.omitted).toBe(0);
    sized.record("tail");
    expect(sized.omitted).toBe(1);
    expect(sized.events.map((event) => event.seq)).toStrictEqual([2, 3, 4, 5]);
    expect(renderedBytes(sized)).toBeLessThanOrEqual(EVENT_BYTES);
  });

  it("keeps the newest event alone when a maximal record passes the byte cap", () => {
    const notices = new TaskNotices();
    notices.record("earlier");
    const largest = "x".repeat(MAX_RECORD_BYTES - 2);
    notices.record(largest);
    expect(notices.events).toStrictEqual([{ seq: 2, data: largest }]);
    expect(notices.omitted).toBe(1);
  });
});
