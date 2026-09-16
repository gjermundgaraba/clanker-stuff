import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";
import { Value } from "typebox/value";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  BORDER_READY_EVENT,
  BORDER_STATUS_EVENT,
  BORDER_UNAVAILABLE_EVENT,
  BorderStatusSchema,
  borderScope,
  createBorderStatusClient,
} from "../index.js";

const setup = () => {
  const events = createEventBus();
  const ctx = createExtensionHost(() => {}).createContext();
  const ready = { version: 1, scope: borderScope(ctx), instanceId: "host-1" };
  const updates = vi.fn();
  events.on(BORDER_STATUS_EVENT, updates);
  return { events, ctx, ready, updates };
};

describe("border status producer", () => {
  it("replays snapshots on readiness and scopes mutations to its owner", () => {
    const { events, ctx, ready, updates } = setup();
    const client = createBorderStatusClient({ events }, { owner: "questions" });
    client.attach(ctx);
    const status = { text: "3" };
    client.set("inbox", status);
    status.text = "4";
    expect(updates).not.toHaveBeenCalled();
    events.emit(BORDER_READY_EVENT, ready);
    expect(updates).toHaveBeenLastCalledWith({
      ...ready,
      owner: "questions",
      type: "set",
      key: "inbox",
      status: { text: "3" },
    });
    client.set("inbox", { text: "2" });
    client.clear("inbox");
    expect(updates).toHaveBeenLastCalledWith({
      ...ready,
      owner: "questions",
      type: "clear",
      key: "inbox",
    });
    client.dispose();
    expect(updates).toHaveBeenLastCalledWith({ ...ready, owner: "questions", type: "clear-owner" });
    updates.mockClear();
    events.emit(BORDER_READY_EVENT, ready);
    expect(updates).not.toHaveBeenCalled();
  });
  it("ignores stale/unrelated readiness and clears cached state on attach", () => {
    const { events, ctx, ready, updates } = setup();
    const change = vi.fn();
    const client = createBorderStatusClient(
      { events },
      { owner: "questions", onAvailabilityChange: change },
    );
    client.attach(ctx);
    events.emit(BORDER_READY_EVENT, { ...ready, scope: "old-session" });
    expect(client.available).toBe(false);
    events.emit(BORDER_READY_EVENT, ready);
    client.set("inbox", { text: "3" });
    events.emit(BORDER_UNAVAILABLE_EVENT, { ...ready, instanceId: "old-host" });
    expect(client.available).toBe(true);
    events.emit(BORDER_UNAVAILABLE_EVENT, ready);
    expect(client.available).toBe(false);
    client.attach(ctx);
    updates.mockClear();
    events.emit(BORDER_READY_EVENT, { ...ready, instanceId: "host-2" });
    expect(updates).not.toHaveBeenCalled();
    expect(change).toHaveBeenLastCalledWith(true);
    client.dispose();
  });
  it("rejects terminal controls, multiline text, unknown fields and oversized statuses", () => {
    for (const status of [
      { text: "\n" },
      { text: "\u2028" },
      { text: "\u2029" },
      { text: "3", icon: { unicode: "\x1b[31m" } },
      { text: "3", icon: { unicode: "\u2028" } },
      { text: "3", icon: { emoji: "✉" } },
      { text: "\x1b[31m" },
      { text: "x", html: true },
      { text: "x".repeat(257) },
      { text: "x", priority: Infinity },
    ]) {
      expect(Value.Check(BorderStatusSchema, status)).toBe(false);
    }
    expect(
      Value.Check(BorderStatusSchema, {
        text: "3",
        icon: { nerd: "\uF0E0", unicode: "✉", ascii: "mail" },
      }),
    ).toBe(true);
  });
});

it.each([false, true])("validates clear keys before emitting, available=%s", (available) => {
  const { events, ctx, ready, updates } = setup();
  const client = createBorderStatusClient({ events }, { owner: "test" });
  client.attach(ctx);
  if (available) events.emit(BORDER_READY_EVENT, ready);
  updates.mockClear();
  for (const key of ["", "\n", "x".repeat(129)]) {
    expect(() => client.clear(key)).toThrow("Invalid border status key");
  }
  expect(updates).not.toHaveBeenCalled();
  expect(() => client.clear("absent")).not.toThrow();
  if (available) {
    expect(updates).toHaveBeenCalledExactlyOnceWith({
      ...ready,
      owner: "test",
      type: "clear",
      key: "absent",
    });
  } else {
    expect(updates).not.toHaveBeenCalled();
  }
  client.dispose();
});

it("allows joiners in display content while keeping identifiers and other controls strict", () => {
  const { events, ctx, ready, updates } = setup();
  const client = createBorderStatusClient({ events }, { owner: "test" });
  client.attach(ctx);
  events.emit(BORDER_READY_EVENT, ready);
  for (const text of ["👩‍💻", "می\u200Cروم"]) {
    const status = { text, icon: { unicode: text } };
    expect(Value.Check(BorderStatusSchema, status)).toBe(true);
    expect(() => client.set("display", status)).not.toThrow();
    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ status }));
  }
  for (const control of ["\u200C", "\u200D"]) {
    expect(() => createBorderStatusClient({ events }, { owner: control })).toThrow();
    expect(() => client.set(control, { text: "valid" })).toThrow();
    expect(() => client.clear(control)).toThrow();
  }
  for (const control of ["\x1b", "\n", "\u2028", "\u2029", "\u202E", "\u2066", "\u200B"]) {
    expect(Value.Check(BorderStatusSchema, { text: control })).toBe(false);
    expect(Value.Check(BorderStatusSchema, { text: "x", icon: { unicode: control } })).toBe(false);
  }
  client.dispose();
});
