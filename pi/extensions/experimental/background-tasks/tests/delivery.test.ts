import assert from "node:assert/strict";
import { afterEach, describe, it, expect, vi } from "vite-plus/test";
import { Delivery } from "../delivery.js";
import { Inbox, type Batch } from "../inbox.js";

const deliveries: Delivery[] = [];

afterEach(() => {
  for (const d of deliveries.splice(0)) d.close();
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const inbox = new Inbox();
  const batches: Batch[] = [];
  let ready = true;
  let fail = false;

  const delivery = new Delivery(inbox, {
    ready: () => ready,
    send: (batch) => {
      batches.push(batch);

      if (fail) throw new Error("send failed");
    },
    changed: () => {},
  });

  deliveries.push(delivery);

  return {
    inbox,
    delivery,
    batches,
    propose: () => {
      const batch = delivery.beforeSettle();

      if (batch) batches.push(batch);

      return batch;
    },
    busy: () => {
      ready = false;
    },
    idle: () => {
      ready = true;
    },
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
  };
}

const add = (inbox: Inbox) => inbox.add({ taskId: "a", terminal: false, reason: "observation" });

describe("Delivery", () => {
  it("does not send or retry a consumed boundary batch", () => {
    const s = setup();
    const event = add(s.inbox);
    const batch = s.propose();
    assert.ok(batch);
    s.inbox.consume([event.id]);
    expect(s.inbox.outstanding).toBe(batch.id);
    expect(s.delivery.beforeSettle()).toBeUndefined();
    s.delivery.settled();
    vi.advanceTimersByTime(1100);
    expect(s.batches).toHaveLength(1);
    expect(s.inbox.outstanding).toBeUndefined();
    expect(s.inbox.lookup("a")).toEqual([event]);
    const next = add(s.inbox);
    s.delivery.schedule();
    vi.advanceTimersByTime(100);
    expect(s.batches[1]?.events).toEqual([next]);
  });
  it("retries only unseen notices from a partially consumed boundary proposal", () => {
    const s = setup();
    const consumed = add(s.inbox);
    const unseen = s.inbox.add({ taskId: "b", terminal: false, reason: "observation" });
    const batch = s.propose();
    assert.ok(batch);
    s.inbox.consume([consumed.id]);
    expect(s.inbox.outstanding).toBe(batch.id);
    expect(s.propose()).toBeUndefined();
    s.delivery.settled();
    vi.advanceTimersByTime(999);
    expect(s.batches).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(s.batches).toHaveLength(2);
    expect(s.batches[1]?.events).toEqual([unseen]);
    expect(s.batches[1]?.id).not.toBe(batch.id);
    expect(s.inbox.lookup("a")).toEqual([consumed]);
  });
  it("keeps idle receipt ownership and activity admission after all its events are consumed", () => {
    const s = setup();
    const event = add(s.inbox);
    s.delivery.flush();
    const batch = s.batches[0];
    assert.ok(batch);
    s.inbox.consume([event.id]);
    const next = add(s.inbox);
    s.delivery.settled();
    s.delivery.schedule();
    vi.advanceTimersByTime(2000);
    expect(s.batches).toHaveLength(1);
    expect(s.inbox.outstanding).toBe(batch.id);
    s.delivery.acknowledge(batch.id);
    s.delivery.schedule();
    vi.advanceTimersByTime(100);
    expect(s.batches[1]?.events).toEqual([next]);
    s.inbox.consume([next.id]);
    s.delivery.acknowledge(s.batches[1]!.id);
    add(s.inbox);
    expect(s.propose()).toBeUndefined();
    s.delivery.flush();
    expect(s.batches).toHaveLength(2);
  });
  it("admits one pre-settlement batch, cancels the idle timer, and waits for actual settlement", () => {
    const { delivery, inbox, batches, propose } = setup();

    for (let i = 0; i < 10; i++) add(inbox);
    delivery.schedule();
    propose();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.events).toHaveLength(8);
    expect(vi.getTimerCount()).toBe(0);
    const batch = batches[0];
    assert.ok(batch);
    delivery.acknowledge(batch.id);
    propose();
    delivery.flush();
    expect(batches).toHaveLength(1);
    delivery.settled();
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(2);
    expect(batches[1]?.events).toHaveLength(2);
  });

  it("retries an unrecorded boundary proposal only after settlement and backoff", () => {
    const s = setup();
    const event = add(s.inbox);
    const batch = s.propose();
    assert.ok(batch);
    expect(s.inbox.outstanding).toBe(batch.id);
    s.propose();
    vi.advanceTimersByTime(1000);
    expect(s.batches).toHaveLength(1);
    s.delivery.settled();
    vi.advanceTimersByTime(999);
    expect(s.batches).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(s.batches).toHaveLength(2);
    expect(s.batches[1]?.events[0]?.id).toBe(event.id);
    expect(s.batches[1]?.id).not.toBe(batch.id);
  });

  it("automatically delivers successive batches", () => {
    const { delivery, inbox, batches } = setup();

    for (let i = 0; i < 20; i++) {
      add(inbox);
      delivery.schedule();
      vi.advanceTimersByTime(100);
      expect(batches).toHaveLength(i + 1);
      const batch = batches[i];
      assert.ok(batch);
      delivery.acknowledge(batch.id);
      delivery.settled();
    }

    expect(inbox.count).toBe(0);
  });
  it("waits for both receipt and settlement before dispatching the next batch", () => {
    const { delivery, inbox, batches } = setup();
    add(inbox);
    delivery.schedule();
    vi.advanceTimersByTime(100);
    add(inbox);
    delivery.schedule();
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(1);
    const [batch] = batches;
    assert.ok(batch);
    delivery.acknowledge(batch.id);
    delivery.schedule();
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(1);
    delivery.settled();
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(2);
  });
  it("buffers while busy and delivers automatically after settle", () => {
    const s = setup();
    s.busy();
    add(s.inbox);
    s.delivery.schedule();
    vi.advanceTimersByTime(100);
    expect(s.batches).toHaveLength(0);
    s.idle();
    s.delivery.settled();
    vi.advanceTimersByTime(1000);
    expect(s.batches).toHaveLength(1);
  });
  it("rechecks readiness until idle without requiring a settled event", () => {
    const s = setup();
    s.busy();
    add(s.inbox);
    s.delivery.schedule();
    vi.advanceTimersByTime(3100);
    expect(s.batches).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    s.idle();
    vi.advanceTimersByTime(1000);
    expect(s.batches).toHaveLength(1);
    add(s.inbox);
    s.delivery.schedule();
    vi.advanceTimersByTime(10000);
    expect(s.batches).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a pending readiness check on close", () => {
    const s = setup();
    s.busy();
    add(s.inbox);
    s.delivery.schedule();
    vi.advanceTimersByTime(100);
    s.delivery.close();
    expect(vi.getTimerCount()).toBe(0);
    s.idle();
    vi.advanceTimersByTime(1000);
    expect(s.batches).toHaveLength(0);
  });
  it("retries a failed handoff automatically without a tight loop", () => {
    const s = setup();
    const event = add(s.inbox);
    s.fail();
    s.delivery.schedule();
    vi.advanceTimersByTime(100);
    expect(s.batches).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(s.batches).toHaveLength(1);
    s.recover();
    vi.advanceTimersByTime(1);
    expect(s.batches).toHaveLength(2);
    expect(s.batches[1]?.events[0]?.id).toBe(event.id);
  });
  it("does not infer a lost idle handoff from settlement or elapsed time", () => {
    const { delivery, inbox, batches } = setup();
    add(inbox);
    delivery.schedule();
    vi.advanceTimersByTime(100);
    const batch = batches[0];
    assert.ok(batch);
    delivery.settled();
    delivery.flush();
    expect(delivery.beforeSettle()).toBeUndefined();
    vi.advanceTimersByTime(10000);
    expect(batches).toHaveLength(1);
    expect(inbox.outstanding).toBe(batch.id);
    expect(vi.getTimerCount()).toBe(0);
    // A later receipt releases the inbox without inventing another settlement.
    add(inbox);
    delivery.acknowledge(batch.id);
    delivery.schedule();
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(2);
  });
  it("releases the task reservation when its only notice is recorded", () => {
    const { delivery, inbox, batches } = setup();
    inbox.reserve("a");
    inbox.add({ taskId: "a", terminal: true, reason: "completed" });
    delivery.schedule();
    vi.advanceTimersByTime(100);
    expect(inbox.protected("a")).toBe(true);
    const [batch] = batches;
    assert.ok(batch);
    delivery.acknowledge(batch.id);
    expect(inbox.protected("a")).toBe(false);
    expect(inbox.count).toBe(0);
    expect(inbox.lookup("a")).toHaveLength(1);
  });
  it("cancels scheduled deliveries and retries on close", () => {
    const s = setup();
    add(s.inbox);
    s.fail();
    s.delivery.schedule();
    vi.advanceTimersByTime(100);
    s.delivery.close();
    s.delivery.settled();
    s.delivery.schedule();
    vi.advanceTimersByTime(10000);
    s.delivery.flush();
    expect(s.batches).toHaveLength(1);
  });
});
