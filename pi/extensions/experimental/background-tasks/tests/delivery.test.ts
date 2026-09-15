import { afterEach, describe, it, expect } from "vite-plus/test";
import { Delivery, CHECKPOINT, CHECKPOINT_VERSION } from "../delivery.js";
import { Inbox, type Batch } from "../inbox.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const deliveries: Delivery[] = [];
afterEach(() => {
  for (const d of deliveries.splice(0)) d.close();
});
function setup() {
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
    checkpoint: () => {},
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
  };
}
describe("Delivery", () => {
  it("starts held and user messages cannot authorize wakes", () => {
    const { delivery } = setup();
    for (let i = 0; i < 3; i++) {
      delivery.message({
        type: "message_end",
        message: { role: "user", content: "ping", timestamp: i },
      });
      delivery.settled();
    }
    expect(delivery.remaining).toBe(0);
    expect(delivery.held).toBe(true);
    delivery.rearm();
    expect(delivery.remaining).toBe(8);
    expect(delivery.held).toBe(false);
  });
  it("spends eight dispatch attempts, waiting for observation AND settle", () => {
    const { delivery: d, inbox, batches } = setup();
    d.rearm();
    for (let i = 0; i < 9; i++) {
      inbox.add({ taskId: "a", terminal: false, reason: "observation", data: i });
      d.flush();
      if (i < 8) {
        expect(d.remaining).toBe(7 - i);
        d.acknowledge(batches[i].id);
        d.flush();
        expect(batches).toHaveLength(i + 1);
        d.settled();
      }
    }
    expect(batches).toHaveLength(8);
    expect(inbox.count).toBe(1);
    d.rearm();
    d.flush();
    expect(batches).toHaveLength(9);
  });
  it("buffers busy runs and holds unobserved failed attempts without refund or eager retry", () => {
    const s = setup();
    s.delivery.rearm();
    s.inbox.add({ taskId: "a", terminal: false, reason: "observation" });
    s.busy();
    s.delivery.flush();
    expect(s.batches).toHaveLength(0);
    s.idle();
    s.fail();
    s.delivery.flush();
    expect(s.delivery.remaining).toBe(7);
    expect(s.delivery.held).toBe(true);
    s.delivery.settled();
    s.delivery.flush();
    expect(s.batches).toHaveLength(1);
    expect(s.inbox.count).toBe(1);
    s.delivery.rearm();
    s.delivery.flush();
    expect(s.batches).toHaveLength(2);
    expect(s.batches[1].events[0].id).toBe(s.batches[0].events[0].id);
  });
  it("abort holds even an acknowledged wake at settle", () => {
    const s = setup();
    s.delivery.rearm();
    s.inbox.add({ taskId: "a", terminal: false, reason: "observation" });
    s.delivery.flush();
    const controller = new AbortController();
    s.delivery.agentStart(controller.signal);
    s.delivery.acknowledge(s.batches[0].id);
    controller.abort();
    s.delivery.settled();
    expect(s.delivery.held).toBe(true);
    expect(s.delivery.remaining).toBe(7);
  });
  it("records one held checkpoint for overlapping abort paths", () => {
    const inbox = new Inbox();
    const checkpoints: { remaining: number; held: boolean }[] = [];
    const d = new Delivery(inbox, {
      ready: () => true,
      send: () => {},
      checkpoint: (remaining, held) => checkpoints.push({ remaining, held }),
      changed: () => {},
    });
    deliveries.push(d);
    d.rearm();
    inbox.add({ taskId: "a", terminal: false, reason: "observation" });
    d.flush();
    const controller = new AbortController();
    d.agentStart(controller.signal);
    controller.abort();
    d.message({
      type: "message_end",
      message: fauxAssistantMessage("", { stopReason: "aborted" }),
    });
    d.settled();
    d.pause();
    expect(checkpoints).toEqual([
      { remaining: 8, held: false },
      { remaining: 7, held: false },
      { remaining: 7, held: true },
    ]);
  });
  it("holds on a provider abortion without an aborted signal", () => {
    const { delivery } = setup();
    const controller = new AbortController();
    delivery.rearm();
    delivery.agentStart(controller.signal);
    delivery.message({
      type: "message_end",
      message: fauxAssistantMessage("", { stopReason: "aborted" }),
    });
    delivery.settled();
    expect(controller.signal.aborted).toBe(false);
    expect(delivery.held).toBe(true);
  });
  it("retries a failed held checkpoint even when already held", () => {
    let fail = false;
    const checkpoints: boolean[] = [];
    const d = new Delivery(new Inbox(), {
      ready: () => true,
      send: () => {},
      checkpoint: (_remaining, held) => {
        if (fail) throw new Error("disk");
        checkpoints.push(held);
      },
      changed: () => {},
    });
    deliveries.push(d);
    d.rearm();
    fail = true;
    d.pause();
    expect(d.held).toBe(true);
    expect(d.error).toBeDefined();
    expect(checkpoints).toEqual([false]);
    fail = false;
    d.pause();
    d.pause();
    expect(d.error).toBeUndefined();
    expect(checkpoints).toEqual([false, true]);
  });
  it("restores only valid checkpoints owned by this session from the entire log", () => {
    const { delivery } = setup();
    const entry = (sessionId: string, remaining: number): SessionEntry => ({
      id: String(remaining),
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "custom",
      customType: CHECKPOINT,
      data: { v: CHECKPOINT_VERSION, sessionId, remaining, held: false },
    });
    const legacy = { ...entry("a", 8), data: { v: 1, sessionId: "a", remaining: 8, held: false } };
    delivery.restore([legacy], "a");
    expect(delivery.remaining).toBe(0);
    expect(delivery.held).toBe(true);
    delivery.restore([entry("a", 3), entry("b", 8), entry("a", -1), legacy], "a");
    expect(delivery.remaining).toBe(3);
    expect(delivery.held).toBe(false);
  });
  it("dismissal releases capacity without retracting or refunding an outstanding wake", () => {
    const { delivery, inbox, batches } = setup();
    delivery.rearm();
    inbox.reserve("a");
    inbox.add({ taskId: "a", terminal: true, reason: "result", data: 1 });
    delivery.flush();
    const batchId = batches[0].id;
    inbox.abandon("a");
    expect(inbox.protected("a")).toBe(false);
    expect(inbox.outstanding).toBe(batchId);
    inbox.reserve("b");
    inbox.add({ taskId: "b", terminal: true, reason: "result", data: 2 });
    delivery.flush();
    expect(batches).toHaveLength(1);
    expect(delivery.remaining).toBe(7);
    delivery.acknowledge(batchId);
    delivery.flush();
    expect(batches).toHaveLength(1);
    delivery.settled();
    delivery.flush();
    expect(batches).toHaveLength(2);
    expect(delivery.remaining).toBe(6);
  });
  it("does not send when checkpoint persistence throws", () => {
    const inbox = new Inbox();
    let sends = 0;
    let fail = false;
    const d = new Delivery(inbox, {
      ready: () => true,
      changed: () => {},
      send: () => {
        sends++;
      },
      checkpoint: () => {
        if (fail) throw new Error("disk");
      },
    });
    deliveries.push(d);
    d.rearm();
    fail = true;
    inbox.add({ taskId: "a", terminal: false, reason: "observation" });
    d.flush();
    expect(sends).toBe(0);
    expect(d.held).toBe(true);
  });
});
