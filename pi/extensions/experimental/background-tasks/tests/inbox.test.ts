import assert from "node:assert/strict";
import { describe, it, expect } from "vite-plus/test";
import { Inbox } from "../inbox.js";
import { toolResult, MAX_TOOL_BYTES } from "../task.js";

const limits = { progress: 2, bytes: 4096, protectedTasks: 2, history: 2 };

describe("Inbox", () => {
  it("consumes exact in-flight IDs without replacing the receipt or replaying them on retry", () => {
    const inbox = new Inbox({ ...limits, protectedTasks: 1 });
    inbox.reserve("a");
    const progress = inbox.add({ taskId: "a", terminal: false, reason: "observation", data: 1 });
    const terminal = inbox.add({ taskId: "a", terminal: true, reason: "completed" });
    const batch = inbox.take()!;
    inbox.consume([terminal.id, "unknown"]);
    expect(inbox.outstanding).toBe(batch.id);
    expect(batch.events).toEqual([progress]);
    expect(inbox.lookup("a")).toEqual([progress, terminal]);
    expect(inbox.protected("a")).toBe(true);
    expect(() => inbox.reserve("b")).toThrow(/full/);
    inbox.retry();
    const retry = inbox.take()!;
    expect(retry.events).toEqual([progress]);
    inbox.consume([progress.id]);
    expect(inbox.count).toBe(0);
    expect(inbox.outstanding).toBe(retry.id);
    expect(inbox.protected("a")).toBe(false);
    expect(inbox.acknowledge(retry.id)).toBe(true);
    expect(inbox.lookup("a")).toEqual([progress, terminal]);
    inbox.consume([terminal.id], "a");
    expect(inbox.protected("a")).toBe(false);
    inbox.reserve("b");
  });
  it("remembers a terminal read before capture without releasing protection prematurely", () => {
    const inbox = new Inbox({ ...limits, protectedTasks: 1 });
    inbox.reserve("a");
    const progress = inbox.add({ taskId: "a", terminal: false, reason: "observation" });
    inbox.consume([], "a");
    expect(inbox.protected("a")).toBe(true);
    expect(() => inbox.reserve("b")).toThrow(/full/);
    const terminal = inbox.add({ taskId: "a", terminal: true, reason: "result", data: "done" });
    expect(inbox.lookup("a")).toEqual([progress, terminal]);
    expect(inbox.count).toBe(1);
    expect(inbox.protected("a")).toBe(true);
    const batch = inbox.take()!;
    expect(batch.events).toEqual([progress]);
    inbox.acknowledge(batch.id);
    expect(inbox.protected("a")).toBe(false);
    inbox.consume([], "a");
    inbox.reserve("b");
    expect(inbox.lookup("a")).toEqual([progress, terminal]);
  });
  it("releases task protection when overflow drops its last unread notice", () => {
    const inbox = new Inbox({ ...limits, progress: 1 });
    inbox.reserve("a");
    inbox.add({ taskId: "a", terminal: false, reason: "observation" });
    const terminal = inbox.add({ taskId: "a", terminal: true, reason: "completed" });
    inbox.consume([terminal.id]);
    expect(inbox.protected("a")).toBe(true);
    inbox.add({ taskId: "b", terminal: false, reason: "observation" });
    expect(inbox.omitted).toBe(1);
    expect(inbox.protected("a")).toBe(false);
    expect(inbox.lookup("a")).toEqual([terminal]);
  });
  it("keeps completed tasks with unread progress in the 32-task budget", () => {
    const inbox = new Inbox();

    for (let n = 0; n < 32; n++) {
      const taskId = `task${n}`;
      inbox.reserve(taskId);
      inbox.add({ taskId, terminal: false, reason: "observation" });
      inbox.add({ taskId, terminal: true, reason: "completed" });
      inbox.consume([], taskId);
    }

    expect(inbox.count).toBe(32);
    expect(() => inbox.reserve("next")).toThrow(/inspect completed task summaries/);
    inbox.consume([], "task0");
    expect(() => inbox.reserve("next")).toThrow(/full/);
    inbox.consume(inbox.lookup("task0").map((event) => event.id));
    expect(inbox.protected("task0")).toBe(false);
    expect(inbox.protected("task1")).toBe(true);
    expect(inbox.count).toBe(31);
    inbox.reserve("next");
    expect(() => inbox.reserve("another")).toThrow(/full/);
  });
  it("evicts chronological history only on capture after out-of-order consumption", () => {
    const inbox = new Inbox({ ...limits, progress: 10 });

    const events = Array.from({ length: 4 }, (_, data) =>
      inbox.add({ taskId: "a", terminal: false, reason: "observation", data }),
    );

    const [first, second, third, fourth] = events;
    assert.ok(first && second && third && fourth);
    inbox.consume([fourth.id]);
    expect(inbox.lookup("a")).toEqual(events);
    inbox.consume([third.id, first.id]);
    expect(inbox.lookup("a")).toEqual(events);
    inbox.consume([second.id]);
    expect(inbox.lookup("a")).toEqual(events);
    expect(inbox.evicted).toBe(0);
    expect(inbox.count).toBe(0);
    const next = inbox.add({ taskId: "a", terminal: false, reason: "observation" });
    expect(inbox.lookup("a")).toEqual([third, fourth, next]);
    expect(inbox.evicted).toBe(2);
  });
  it("trims history when an already-observed terminal is captured", () => {
    const inbox = new Inbox({ ...limits, progress: 4 });

    const events = Array.from({ length: 3 }, () =>
      inbox.add({ taskId: "a", terminal: false, reason: "observation" }),
    );

    inbox.consume(events.map((event) => event.id));
    expect(inbox.lookup("a")).toEqual(events);
    inbox.reserve("b");
    inbox.consume([], "b");
    const terminal = inbox.add({ taskId: "b", terminal: true, reason: "result", data: "done" });
    expect(inbox.count).toBe(0);
    expect(inbox.lookup("a")).toEqual(events.slice(-1));
    expect(inbox.lookup("b")).toEqual([terminal]);
    expect(inbox.evicted).toBe(2);
    expect(inbox.protected("b")).toBe(false);
  });

  it("keeps the aggregate default bound while retirement temporarily exceeds the history target", () => {
    const inbox = new Inbox();
    inbox.reserve("a");

    for (let n = 0; n < 64; n++) {
      inbox.add({ taskId: "a", terminal: false, reason: "observation" });
      inbox.acknowledge(inbox.take()!.id);
    }

    for (let n = 0; n < 8; n++) inbox.add({ taskId: "a", terminal: false, reason: "observation" });
    const flight = inbox.take()!;

    for (let n = 0; n < 64; n++) inbox.add({ taskId: "a", terminal: false, reason: "observation" });
    const ids = ["a", ...Array.from({ length: 31 }, (_, n) => `b${n}`)];

    for (const taskId of ids) {
      if (taskId !== "a") inbox.reserve(taskId);
      inbox.add({ taskId, terminal: true, reason: "completed" });
    }

    const events = ids.flatMap((id) => inbox.lookup(id));
    expect(events).toHaveLength(168);
    expect(inbox.evicted).toBe(0);
    // Leave flight to be acknowledged only after history has exceeded its target.
    const inFlight = new Set(flight.events.map((event) => event.id));
    inbox.consume(events.filter((event) => !inFlight.has(event.id)).map((event) => event.id));
    expect(inbox.acknowledge(flight.id)).toBe(true);
    expect(ids.flatMap((id) => inbox.lookup(id))).toHaveLength(168);
    expect(inbox.count).toBe(0);
    expect(inbox.evicted).toBe(0);
    inbox.reserve("next");
    inbox.add({ taskId: "next", terminal: false, reason: "observation" });
    expect(
      ids
        .flatMap((id) => inbox.lookup(id))
        .map((event) => event.seq)
        .sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 64 }, (_, n) => 105 + n));
    expect(inbox.lookup("next")).toHaveLength(1);
    expect(inbox.evicted).toBe(104);
  });

  it.each(["abandon", "clear"] as const)("discards precapture terminal state on %s", (action) => {
    const inbox = new Inbox({ ...limits, protectedTasks: 1 });
    inbox.reserve("a");
    inbox.consume([], "a");

    if (action === "abandon") inbox.abandon("a");
    else inbox.clear();
    expect(inbox.protected("a")).toBe(false);
    inbox.consume([], "a");
    expect(inbox.protected("a")).toBe(false);
    expect(() => inbox.add({ taskId: "a", terminal: true, reason: "cancelled" })).toThrow(
      /reservation/,
    );
    inbox.reserve("b");
    const next = inbox.add({ taskId: "b", terminal: true, reason: "completed" });
    expect(inbox.take()?.events).toEqual([next]);
  });
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
    expect(inbox.evicted).toBe(0);
    expect(inbox.lookup("a")).toHaveLength(1);
    expect(inbox.lookup("b")).toHaveLength(2);
    inbox.add({ taskId: "c", terminal: true, reason: "completed" });
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
