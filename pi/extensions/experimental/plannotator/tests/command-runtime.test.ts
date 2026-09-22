import assert from "node:assert/strict";
import type { PendingProcess } from "./helpers.js";
import { describe, expect, it, vi } from "vite-plus/test";

import { tokenizeArguments } from "../command-runtime.js";
import { exited, setup, signaled } from "./helpers.js";

describe("command runtime", () => {
  it("tokenizes quotes and escapes", () => {
    expect(tokenizeArguments(`--gate "docs/my file.md" 'two words' escaped\\ value`)).toStrictEqual(
      ["--gate", "docs/my file.md", "two words", "escaped value"],
    );
  });

  it.each([`"unterminated`, `'unterminated`, "trailing\\"])(
    "rejects malformed arguments without starting the CLI: %s",
    async (args) => {
      const { ctx, host, pending } = setup();
      await host.runCommand("plannotator-review", args, ctx);
      expect(pending).toHaveLength(0);
      expect(host.getNotifications().at(-1)).toMatchObject({ type: "error" });
    },
  );

  it("streams complete stderr lines before the CLI exits", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "--git", ctx);

    const [child] = pending;
    assert.ok(child);
    child.options.onStderr?.("Plannotator session rea");
    expect(host.getNotifications()).toHaveLength(1);

    child.options.onStderr?.("dy:\nhttps://plannotator.example/review\nOpening review...\n");

    expect(host.getNotifications().slice(1)).toStrictEqual([
      { message: "Plannotator session ready:", type: "info" },
      { message: "https://plannotator.example/review", type: "info" },
      { message: "Opening review...", type: "info" },
    ]);
  });

  it("does not repeat streamed stderr in a nonzero exit error", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);

    const [child] = pending;
    assert.ok(child);
    child.options.onStderr?.("Fetching pull request...\nbad repository\n");
    child.resolve(
      exited("", {
        code: 2,
        stderr: "Fetching pull request...\nbad repository\n",
      }),
    );

    await vi.waitFor(() => {
      expect(host.getNotifications().at(-1)).toStrictEqual({
        message: "Plannotator code review: exited with code 2",
        type: "error",
      });
    });

    for (const message of ["Fetching pull request...", "bad repository"]) {
      expect(
        host.getNotifications().filter((notification) => notification.message.includes(message)),
      ).toHaveLength(1);
    }
  });

  it("keeps a nonzero exit's unterminated stderr tail in the final error", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);

    const [child] = pending;
    assert.ok(child);
    child.options.onStderr?.("Fetching pull request...\nbad repository");
    child.resolve(
      exited("", {
        code: 2,
        stderr: "Fetching pull request...\nbad repository",
      }),
    );

    await vi.waitFor(() => {
      expect(host.getNotifications().slice(1)).toStrictEqual([
        { message: "Fetching pull request...", type: "info" },
        { message: "Plannotator code review: bad repository", type: "error" },
      ]);
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
    expect(child.cancel).toHaveBeenCalledOnce();
    expect(shutdownFinished).toBeFalsy();

    child.resolve({ kind: "cancelled" });
    await shutdown;
    expect(shutdownFinished).toBeTruthy();
    expect(host.getSentUserMessages()).toHaveLength(0);
    expect(host.getNotifications()).toStrictEqual([
      { message: "Plannotator code review opened.", type: "info" },
    ]);
  });

  it("does not cancel an active process twice across repeated shutdowns", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);

    const firstShutdown = host.emitSessionShutdown(ctx);
    await Promise.resolve();
    const secondShutdown = host.emitSessionShutdown(ctx);
    await Promise.resolve();

    const [child] = pending;
    assert.ok(child);
    expect(child.signal.aborted).toBeTruthy();
    expect(child.cancel).toHaveBeenCalledOnce();

    child.resolve({ kind: "cancelled" });
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
      expect(child.cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      completion: exited("", { code: 2, stderr: "bad repository" }),
      label: "nonzero exit",
      message: "Plannotator code review: bad repository",
    },
    {
      completion: signaled("SIGTERM"),
      label: "unexpected signal",
      message: "Plannotator code review: terminated by SIGTERM",
    },
  ])("reports $label as an error notification", async ({ completion, message }) => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);
    const [child] = pending;
    assert.ok(child);
    child.resolve(completion);
    await vi.waitFor(() => {
      expect(host.getNotifications().at(-1)).toStrictEqual({
        message,
        type: "error",
      });
    });
  });

  it("reports asynchronous spawn failures", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);
    const [child] = pending;
    assert.ok(child);
    child.reject(new Error("spawn plannotator ENOENT"));
    await vi.waitFor(() => {
      expect(host.getNotifications().at(-1)).toHaveProperty("type", "error");
      expect(host.getNotifications().at(-1)).toHaveProperty(
        "message",
        expect.stringContaining("ENOENT"),
      );
    });
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
  ])("flushes an unterminated stderr tail before $message", async (testCase) => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);
    const [child] = pending;
    assert.ok(child);
    child.options.onStderr?.("final stderr detail");
    testCase.finish(child);

    await vi.waitFor(() => {
      expect(host.getNotifications().slice(1)).toStrictEqual([
        { message: "final stderr detail", type: "info" },
        { message: testCase.message, type: "error" },
      ]);
    });
  });
});
