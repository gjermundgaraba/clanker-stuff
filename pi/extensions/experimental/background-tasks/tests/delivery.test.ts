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
  it("automatically delivers successive batches", () => {
    const { delivery, inbox, batches } = setup();
    for (let i = 0; i < 20; i++) {
      add(inbox);
      delivery.schedule();
      vi.advanceTimersByTime(100);
      expect(batches).toHaveLength(i + 1);
      delivery.acknowledge(batches[i].id);
      delivery.settled();
    }
    expect(inbox.count).toBe(0);
  });
  it("waits for both observation and settle before dispatching the next batch", () => {
    const { delivery, inbox, batches } = setup();
    add(inbox);
    delivery.schedule();
    vi.advanceTimersByTime(100);
    add(inbox);
    delivery.schedule();
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(1);
    delivery.acknowledge(batches[0].id);
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
    expect(s.batches[1].events[0].id).toBe(event.id);
  });
  it("retries an unobserved notice only after the agent settles", () => {
    const { delivery, inbox, batches } = setup();
    const event = add(inbox);
    delivery.schedule();
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(10000);
    expect(batches).toHaveLength(1);
    delivery.settled();
    vi.advanceTimersByTime(999);
    expect(batches).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(batches).toHaveLength(2);
    expect(batches[1].events[0].id).toBe(event.id);
  });
  it("releases terminal capacity when Pi observes the notification", () => {
    const { delivery, inbox, batches } = setup();
    inbox.reserve("a");
    inbox.add({ taskId: "a", terminal: true, reason: "completed" });
    delivery.schedule();
    vi.advanceTimersByTime(100);
    expect(inbox.protected("a")).toBe(true);
    delivery.acknowledge(batches[0].id);
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
