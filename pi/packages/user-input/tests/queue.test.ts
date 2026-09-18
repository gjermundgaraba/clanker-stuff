import { describe, expect, it, vi } from "vite-plus/test";
import {
  createExtensionRuntime,
  ExtensionRunner,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { runQueuedPrompt } from "../queue.js";

describe("prompt coordination", () => {
  it("serializes callers sharing a UI without blocking other UI surfaces", async () => {
    const host = createExtensionHost(() => {});
    const ctx = host.createContext();
    const hold = Promise.withResolvers<void>();
    const order: string[] = [];

    const first = runQueuedPrompt(ctx, undefined, async () => {
      order.push("first");
      await hold.promise;
    });

    const second = runQueuedPrompt(ctx, undefined, async () => {
      order.push("second");
    });

    const other: Pick<ExtensionContext, "ui"> = { ui: { ...ctx.ui } };
    await runQueuedPrompt(other, undefined, async () => {
      order.push("other");
    });
    expect(order).toEqual(["first", "other"]);
    hold.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "other", "second"]);
  });

  it("cancels queued work before it can take over the editor", async () => {
    const ctx = createExtensionHost(() => {}).createContext();
    const hold = Promise.withResolvers<void>();
    const first = runQueuedPrompt(ctx, undefined, () => hold.promise);
    const abort = new AbortController();
    const show = vi.fn(async () => {});
    const second = runQueuedPrompt(ctx, abort.signal, show);
    const thirdShown = vi.fn(async () => {});
    const third = runQueuedPrompt(ctx, undefined, thirdShown);
    abort.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(thirdShown).not.toHaveBeenCalled();
    hold.resolve();
    await Promise.all([first, third]);
    expect(thirdShown).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalled();
  });

  it("forwards cancellation to active UI and releases the next prompt after settlement", async () => {
    const ctx = createExtensionHost(() => {}).createContext();
    const abort = new AbortController();
    const started = Promise.withResolvers<AbortSignal>();
    const settled = Promise.withResolvers<void>();

    const first = runQueuedPrompt(ctx, abort.signal, (signal) => {
      started.resolve(signal);

      return settled.promise;
    });

    const activeSignal = await started.promise;
    const show = vi.fn(async () => "next");
    const second = runQueuedPrompt(ctx, undefined, show);
    abort.abort();
    await Promise.resolve();
    expect(activeSignal.aborted).toBe(true);
    expect(show).not.toHaveBeenCalled();
    settled.resolve();
    await first;
    await expect(second).resolves.toBe("next");
  });

  it("finishes cancelled queue cleanup after the originating runner is invalidated", async () => {
    const modelRegistry = createExtensionHost(() => {}).createContext().modelRegistry;

    const runner = new ExtensionRunner(
      [],
      createExtensionRuntime(),
      process.cwd(),
      SessionManager.inMemory(),
      modelRegistry,
    );

    const ctx = runner.createContext();
    const started = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<void>();

    const first = runQueuedPrompt(ctx, undefined, () => {
      started.resolve();

      return hold.promise;
    });

    try {
      await started.promise;
      const abort = new AbortController();
      const show = vi.fn(async () => {});
      const second = runQueuedPrompt(ctx, abort.signal, show);
      abort.abort();
      await expect(second).rejects.toMatchObject({ name: "AbortError" });
      runner.invalidate();
      expect(() => ctx.ui).toThrow("stale");
      hold.resolve();
      await first;
      // Let deferred cleanup and unhandled-rejection reporting run before the test ends.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(show).not.toHaveBeenCalled();
    } finally {
      hold.resolve();
      await first;
      runner.invalidate();
    }
  });

  it("releases the queue after a failed prompt", async () => {
    const ctx = createExtensionHost(() => {}).createContext();

    const first = runQueuedPrompt(ctx, undefined, async () => {
      throw new Error("Prompt failed");
    });

    const second = runQueuedPrompt(ctx, undefined, async () => "next");
    await expect(first).rejects.toThrow("Prompt failed");
    await expect(second).resolves.toBe("next");
  });
});
