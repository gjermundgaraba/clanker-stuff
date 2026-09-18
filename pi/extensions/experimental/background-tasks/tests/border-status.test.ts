import { Value } from "typebox/value";
import type { Static } from "typebox";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BORDER_READY_EVENT,
  BORDER_STATUS_EVENT,
  BorderUpdateSchema,
  borderScope,
} from "@clanker-stuff/border-status-protocol";
import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { TaskRuntime } from "../runtime.js";

const runtimes: TaskRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function setup(mode: "tui" | "rpc" = "tui") {
  vi.useFakeTimers();
  let runtime!: TaskRuntime;

  const host = createExtensionHost((pi) => {
    runtime = new TaskRuntime(pi);
  });

  await host.ready;
  runtimes.push(runtime);
  const setStatus = vi.fn();
  const ctx = host.createContext({ mode, isIdle: () => false, ui: { setStatus } });
  const updates = vi.fn<(update: Static<typeof BorderUpdateSchema>) => void>();
  host.events.on(BORDER_STATUS_EVENT, (raw) => updates(Value.Parse(BorderUpdateSchema, raw)));
  const ready = { version: 1, instanceId: "border", scope: borderScope(ctx) };
  const active = vi.spyOn(runtime.supervisor, "activeCount", "get").mockReturnValue(0);
  runtime.startSession(ctx);
  const announce = () => host.events.emit(BORDER_READY_EVENT, ready);

  return { runtime, host, ctx, updates, ready, active, announce, setStatus };
}

const tick = () => vi.advanceTimersByTimeAsync(100);

describe("background task border indicators", () => {
  it("hides zeros and independently publishes active tasks and pending events", async () => {
    const { runtime, ctx, updates, active, announce, setStatus } = await setup();
    announce();
    await tick();
    expect(updates.mock.calls).toMatchObject([
      [{ type: "clear", key: "active" }],
      [{ type: "clear", key: "pending" }],
    ]);
    active.mockReturnValue(2);
    runtime.inbox.add({ taskId: "task", terminal: false, reason: "observation" });
    runtime.inbox.add({ taskId: "task", terminal: false, reason: "observation" });
    await runtime.tree(ctx, null);
    announce();
    await tick();
    expect(updates.mock.calls.at(-2)?.[0]).toMatchObject({
      type: "set",
      key: "active",
      status: { text: "2", icon: { nerd: "\uF085", unicode: "⚙", ascii: "tasks" } },
    });
    expect(updates.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "set",
      key: "pending",
      status: { text: "2", icon: { nerd: "\uF0F3", unicode: "🔔", ascii: "pending" } },
    });
    const batch = runtime.inbox.take()!;
    active.mockReturnValue(0);
    await runtime.tree(ctx, null);
    announce();
    await tick();
    expect(updates.mock.calls.at(-2)?.[0]).toEqual(
      expect.objectContaining({ type: "clear", key: "active" }),
    );
    expect(updates.mock.calls.at(-1)?.[0]).toMatchObject({ key: "pending", status: { text: "2" } });
    active.mockReturnValue(1);
    runtime.delivery.acknowledge(batch.id);
    await tick();
    expect(updates.mock.calls.at(-2)?.[0]).toMatchObject({
      type: "set",
      key: "active",
      status: { text: "1" },
    });
    expect(updates).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "clear", key: "pending" }),
    );
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("replays on late readiness, scopes navigation, and clears on shutdown", async () => {
    const { runtime, ctx, host, ready, active, updates, announce, setStatus } = await setup();
    active.mockReturnValue(1);
    await tick();
    expect(updates).not.toHaveBeenCalled();
    announce();
    expect(updates).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "set", key: "active" }),
    );
    await runtime.tree(ctx, "branch-target");
    updates.mockClear();
    announce();
    await tick();
    expect(updates).not.toHaveBeenCalled();
    const next = { ...ready, scope: borderScope(ctx, "branch-target"), instanceId: "next-border" };
    host.events.emit(BORDER_READY_EVENT, next);
    expect(updates).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...next, type: "set", key: "active" }),
    );
    await runtime.shutdown();
    expect(updates).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...next, type: "clear-owner" }),
    );
    updates.mockClear();
    host.events.emit(BORDER_READY_EVENT, next);
    await tick();
    expect(updates).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("does not use the footer or border in RPC mode", async () => {
    const { active, announce, updates, setStatus } = await setup("rpc");
    active.mockReturnValue(1);
    announce();
    await tick();
    expect(updates).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
