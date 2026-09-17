import {
  BORDER_READY_EVENT,
  BORDER_STATUS_EVENT,
  BORDER_UNAVAILABLE_EVENT,
  borderScope,
} from "@clanker-stuff/border-status-protocol";
import { describe, expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createInboxStatus } from "../status.js";

it("keeps the widget alongside the mail count, clears zero, and isolates branch state", async () => {
  let status: ReturnType<typeof createInboxStatus> | undefined;
  const host = createExtensionHost((pi) => {
    status = createInboxStatus(pi);
  });
  await host.ready;
  const ctx = host.createContext();
  const updates = vi.fn();
  host.events.on(BORDER_STATUS_EVENT, updates);
  status!.attach(ctx);
  status!.update(3, 1);
  expect(host.getWidget("questionnaires")).toBe(
    "3 questionnaires awaiting you · 1 paused · /answers",
  );
  const ready = { version: 1, instanceId: "host", scope: borderScope(ctx) };
  host.events.emit(BORDER_READY_EVENT, ready);
  expect(host.getWidget("questionnaires")).toBe(
    "3 questionnaires awaiting you · 1 paused · /answers",
  );
  expect(updates).toHaveBeenLastCalledWith(
    expect.objectContaining({
      owner: "ask-question",
      key: "inbox",
      status: {
        icon: { nerd: "\uF0E0", unicode: "✉", ascii: "mail" },
        text: "3",
        tone: "warning",
        priority: 100,
      },
    }),
  );
  status!.update(0, 0);
  expect(host.getWidget("questionnaires")).toBeUndefined();
  expect(updates).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "clear", key: "inbox" }),
  );
  status!.update(1, 0);
  host.events.emit(BORDER_UNAVAILABLE_EVENT, ready);
  expect(host.getWidget("questionnaires")).toBe("1 questionnaire awaiting you · /answers");
  status!.attach(host.createContext(), "other");
  status!.update(2, 0);
  updates.mockClear();
  host.events.emit(BORDER_READY_EVENT, ready);
  expect(updates).not.toHaveBeenCalled();
  expect(host.getWidget("questionnaires")).toBe("2 questionnaires awaiting you · /answers");
  host.events.emit(BORDER_READY_EVENT, {
    ...ready,
    instanceId: "next-host",
    scope: borderScope(ctx, "other"),
  });
  expect(updates).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "set", status: expect.objectContaining({ text: "2" }) }),
  );
  expect(host.getWidget("questionnaires")).toBe("2 questionnaires awaiting you · /answers");
  status!.dispose();
  expect(host.getWidget("questionnaires")).toBeUndefined();
});

describe("non-TUI status", () => {
  it("does not show widgets outside the terminal", async () => {
    let status: ReturnType<typeof createInboxStatus> | undefined;
    const host = createExtensionHost((pi) => {
      status = createInboxStatus(pi);
    });
    await host.ready;
    status!.attach(host.createContext({ mode: "rpc" }));
    status!.update(1, 0);
    expect(host.getWidget("questionnaires")).toBeUndefined();
    status!.dispose();
  });
});
