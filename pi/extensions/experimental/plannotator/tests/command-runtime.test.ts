import assert from "node:assert/strict";

import { describe, expect, it, vi } from "vite-plus/test";

import { tokenizeArguments } from "../command-runtime.js";
import type { PendingProcess } from "./helpers.js";
import { exited, setup, signaled } from "./helpers.js";

describe("command runtime", () => {
  it("tokenizes quotes and escapes", () => {
    expect(
      tokenizeArguments(`--gate "docs/my file.md" 'two words' escaped\\ value`)
    ).toStrictEqual([
      "--gate",
      "docs/my file.md",
      "two words",
      "escaped value",
    ]);
  });

  it.each([`"unterminated`, `'unterminated`, "trailing\\"])(
    "rejects malformed arguments without starting the CLI: %s",
    async (args) => {
      const { ctx, host, pending } = setup();
      await host.runCommand("plannotator-review", args, ctx);
      expect(pending).toHaveLength(0);
      expect(host.getNotifications().at(-1)).toMatchObject({ type: "error" });
    }
  );

  it("shows stderr lines while the CLI runs, then reports a nonzero exit code", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);

    const [child] = pending;
    assert.ok(child);
    child.options.onStderrLine("Fetching pull request...");
    child.options.onStderrLine("   ");
    child.options.onStderrLine("bad repository");
    expect(host.getNotifications().slice(1)).toStrictEqual([
      { message: "Fetching pull request...", type: "info" },
      { message: "bad repository", type: "info" },
    ]);

    child.resolve(exited("", { code: 2 }));

    await vi.waitFor(() => {
      expect(host.getNotifications().at(-1)).toStrictEqual({
        message: "Plannotator code review: exited with code 2",
        type: "error",
      });
    });
  });

  it("awaits process termination during shutdown and suppresses cancellation output", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);

    let shutdownFinished = false;

    const shutdown = (async () => {
      await host.emitSessionShutdown(ctx);
      shutdownFinished = true;
    })();

    await Promise.resolve();
    const [child] = pending;
    assert.ok(child);
    expect(child.options.signal.aborted).toBeTruthy();
    expect(shutdownFinished).toBeFalsy();

    child.options.onStderrLine("Stopping server");
    child.resolve(signaled("SIGTERM"));
    await shutdown;
    expect(shutdownFinished).toBeTruthy();
    expect(host.getSentUserMessages()).toHaveLength(0);
    expect(host.getNotifications()).toStrictEqual([
      { message: "Plannotator code review opened.", type: "info" },
    ]);
  });

  it("keeps repeated shutdowns quiet while the cancelled process exits", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);

    const firstShutdown = host.emitSessionShutdown(ctx);
    await Promise.resolve();
    const secondShutdown = host.emitSessionShutdown(ctx);
    await Promise.resolve();

    const [child] = pending;
    assert.ok(child);
    expect(child.options.signal.aborted).toBeTruthy();

    child.resolve(signaled("SIGTERM"));
    await Promise.all([firstShutdown, secondShutdown]);
    expect(host.getNotifications()).toStrictEqual([
      { message: "Plannotator code review opened.", type: "info" },
    ]);
  });

  it("bounds shutdown when a child never reports completion", async () => {
    vi.useFakeTimers();

    try {
      const { ctx, host, pending } = setup();
      await host.runCommand("plannotator-review", "", ctx);

      const shutdown = host.emitSessionShutdown(ctx);
      await vi.advanceTimersByTimeAsync(2500);
      await shutdown;

      const [child] = pending;
      assert.ok(child);
      expect(child.options.signal.aborted).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      finish: (child: PendingProcess) => {
        child.resolve(signaled("SIGTERM"));
      },
      message: "Plannotator code review: terminated by SIGTERM",
    },
    {
      finish: (child: PendingProcess) => {
        child.reject(new Error("spawn plannotator EIO"));
      },
      message: "Plannotator code review: spawn plannotator EIO",
    },
  ])("reports $message", async (testCase) => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);
    const [child] = pending;
    assert.ok(child);
    testCase.finish(child);

    await vi.waitFor(() => {
      expect(host.getNotifications().slice(1)).toStrictEqual([
        { message: testCase.message, type: "error" },
      ]);
    });
  });
});
