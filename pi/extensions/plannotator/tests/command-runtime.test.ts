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
});
