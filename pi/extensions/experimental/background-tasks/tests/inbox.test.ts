import assert from "node:assert/strict";
import { describe, it, expect } from "vite-plus/test";
import { Inbox } from "../inbox.js";
import { toolResult, MAX_TOOL_BYTES } from "../task.js";

const limits = { progress: 2, bytes: 4096, terminals: 2, history: 2 };

describe("Inbox", () => {
  it("replaces only pending snapshots with the same task and key, moving latest last", () => {
    const inbox = new Inbox();
    inbox.add({ taskId: "a", terminal: false, reason: "observation", data: 1, key: "key" });

    const b = inbox.add({
      taskId: "b",
      terminal: false,
      reason: "observation",
      data: 2,
      key: "key",
    });

    const a = inbox.add({
      taskId: "a",
      terminal: false,
      reason: "observation",
      data: 3,
      key: "key",
    });

    expect(inbox.take()?.events).toEqual([b, a]);
    inbox.add({ taskId: "a", terminal: false, reason: "observation", data: 4, key: "key" });
    expect(inbox.lookup("a").map((e) => e.data)).toEqual([3, 4]);
  });
  it("drops oldest progress but preserves reserved terminal outcomes", () => {
    const inbox = new Inbox(limits);
    inbox.reserve("a");
    inbox.reserve("b");
    inbox.add({ taskId: "a", terminal: true, reason: "result", data: "terminal" });
    inbox.add({ taskId: "b", terminal: false, reason: "observation", data: 1 });
    inbox.add({ taskId: "b", terminal: false, reason: "observation", data: 2 });
    inbox.add({ taskId: "b", terminal: false, reason: "observation", data: 3 });
    expect(inbox.omitted).toBe(1);
    expect(() => inbox.reserve("c")).toThrow(/full/);
    const batch = inbox.take()!;
    expect(batch.events.map((e) => e.data)).toEqual(["terminal", 2, 3]);
    expect(inbox.acknowledge("wrong")).toBe(false);
    expect(inbox.protected("a")).toBe(true);
    inbox.acknowledge(batch.id);
    expect(inbox.protected("a")).toBe(false);
    inbox.reserve("c");
    expect(inbox.evicted).toBe(1);
  });
  it("retains unobserved IDs across retry, and abandons eligibility", () => {
    const inbox = new Inbox();
    inbox.reserve("a");
    const event = inbox.add({ taskId: "a", terminal: true, reason: "completed" });
    const batch = inbox.take()!;
    expect(inbox.take()).toBeUndefined();
    inbox.retry();
    expect(inbox.take()?.events[0]?.id).toBe(event.id);
    expect(inbox.outstanding).not.toBe(batch.id);
    inbox.abandon("a");
    expect(inbox.count).toBe(0);
    expect(inbox.protected("a")).toBe(false);
    inbox.clear();
    expect(inbox.outstanding).toBeUndefined();
  });
  it("keeps reservation protection through earlier progress batches and retries", () => {
    const inbox = new Inbox();
    inbox.reserve("a");

    for (let i = 0; i < 9; i++)
      inbox.add({ taskId: "a", terminal: false, reason: "observation", data: i });
    inbox.add({ taskId: "a", terminal: true, reason: "result" });
    const first = inbox.take()!;
    expect(first.events.every((event) => !event.terminal)).toBe(true);
    inbox.retry();
    expect(inbox.protected("a")).toBe(true);
    inbox.acknowledge(inbox.take()!.id);
    expect(inbox.protected("a")).toBe(true);
    const last = inbox.take()!;
    expect(last.events.map((event) => event.terminal)).toEqual([false, true]);
    inbox.acknowledge(last.id);
    expect(inbox.count).toBe(0);
    expect(inbox.protected("a")).toBe(false);
  });
  it("discovers every retained event across history, in-flight and pending capacity", () => {
    const inbox = new Inbox();
    inbox.reserve("a");

    for (let batch = 0; batch < 8; batch++) {
      for (let i = 0; i < 8; i++)
        inbox.add({ taskId: "a", terminal: false, reason: "observation", data: i });
      inbox.acknowledge(inbox.take()!.id);
    }

    for (let i = 0; i < 8; i++)
      inbox.add({ taskId: "a", terminal: false, reason: "observation", data: i });
    inbox.take();

    for (let i = 0; i < 64; i++)
      inbox.add({ taskId: "a", terminal: false, reason: "observation", data: i });
    inbox.add({ taskId: "a", terminal: true, reason: "result", data: "done" });
    const events = inbox.lookup("a");
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 137 }, (_, i) => i + 1));
    const [first] = events;
    assert.ok(first);
    expect(inbox.lookup("a", first.id)).toEqual([first]);
    expect(inbox.lookup("other")).toEqual([]);
    expect(inbox.omitted).toBe(0);
    expect(inbox.evicted).toBe(0);

    const result = toolResult({
      events: events.map((e) => ({ id: e.id, seq: Number.MAX_SAFE_INTEGER, reason: e.reason })),
    });

    // Leave space for task metadata and logs, which summary inspection budgets separately.
    expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(MAX_TOOL_BYTES - 8192);
  });
  it("bounds progress by bytes independently of count", () => {
    const inbox = new Inbox({ ...limits, progress: 100, bytes: 200 });
    inbox.add({ taskId: "a", terminal: false, reason: "observation", data: "x".repeat(300) });
    expect(inbox.count).toBe(0);
    expect(inbox.omitted).toBe(1);
  });
});
