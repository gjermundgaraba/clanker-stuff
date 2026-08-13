import { describe, expect, it, vi } from "vitest";

import { tokenizeArguments } from "../command-runtime.js";
import { exited, setup, signaled } from "./helpers.js";

vi.mock(import("../command-runtime.js"), { spy: true });

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

  it("returns before the CLI completes", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "--git", ctx);
    expect(pending).toHaveLength(1);
    expect(host.getNotifications()).toStrictEqual([
      {
        message: "Plannotator code review opened.",
        type: "info",
      },
    ]);
  });

  it("streams complete stderr lines before the CLI exits", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "--git", ctx);

    pending[0].options.onStderr?.("Plannotator session rea");
    expect(host.getNotifications()).toHaveLength(1);

    pending[0].options.onStderr?.(
      "dy:\nhttps://plannotator.example/review\nOpening review...\n"
    );

    expect(host.getNotifications().slice(1)).toStrictEqual([
      { message: "Plannotator session ready:", type: "info" },
      { message: "https://plannotator.example/review", type: "info" },
      { message: "Opening review...", type: "info" },
    ]);
  });

  it("does not repeat streamed stderr in a nonzero exit error", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);

    pending[0].options.onStderr?.("Fetching pull request...\nbad repository\n");
    pending[0].resolve(
      exited("", {
        code: 2,
        stderr: "Fetching pull request...\nbad repository\n",
      })
    );

    await vi.waitFor(() => {
      expect(host.getNotifications().at(-1)).toStrictEqual({
        message: "Plannotator code review: exited with code 2",
        type: "error",
      });
    });
    for (const message of ["Fetching pull request...", "bad repository"]) {
      expect(
        host
          .getNotifications()
          .filter((notification) => notification.message.includes(message))
      ).toHaveLength(1);
    }
  });

  it("keeps a nonzero exit's unterminated stderr tail in the final error", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);

    pending[0].options.onStderr?.("Fetching pull request...\nbad repository");
    pending[0].resolve(
      exited("", {
        code: 2,
        stderr: "Fetching pull request...\nbad repository",
      })
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
    expect(pending[0].cancel).toHaveBeenCalledOnce();
    expect(shutdownFinished).toBeFalsy();

    pending[0].resolve({ kind: "cancelled" });
    await shutdown;
    expect(shutdownFinished).toBeTruthy();
    expect(host.getSentUserMessages()).toHaveLength(0);
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

      expect(pending[0].cancel).toHaveBeenCalledOnce();
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
  ])(
    "reports $label as an error notification",
    async ({ completion, message }) => {
      const { ctx, host, pending } = setup();
      await host.runCommand("plannotator-review", "", ctx);
      pending[0].resolve(completion);
      await vi.waitFor(() => {
        expect(host.getNotifications().at(-1)).toStrictEqual({
          message,
          type: "error",
        });
      });
    }
  );

  it("reports asynchronous spawn failures", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);
    pending[0].reject(new Error("spawn plannotator ENOENT"));
    await vi.waitFor(() => {
      expect(host.getNotifications().at(-1)).toMatchObject({
        message: expect.stringContaining("ENOENT"),
        type: "error",
      });
    });
  });

  it.each([
    {
      finish: (pending: ReturnType<typeof setup>["pending"]) => {
        pending[0].resolve(signaled("SIGTERM"));
      },
      message: "Plannotator code review: terminated by SIGTERM",
    },
    {
      finish: (pending: ReturnType<typeof setup>["pending"]) => {
        pending[0].reject(new Error("spawn plannotator EIO"));
      },
      message: "Plannotator code review: spawn plannotator EIO",
    },
  ])(
    "flushes an unterminated stderr tail before $message",
    async (testCase) => {
      const { ctx, host, pending } = setup();
      await host.runCommand("plannotator-review", "", ctx);
      pending[0].options.onStderr?.("final stderr detail");
      testCase.finish(pending);

      await vi.waitFor(() => {
        expect(host.getNotifications().slice(1)).toStrictEqual([
          { message: "final stderr detail", type: "info" },
          { message: testCase.message, type: "error" },
        ]);
      });
    }
  );
});
