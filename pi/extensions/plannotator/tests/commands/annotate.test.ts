import { describe, expect, it, vi } from "vitest";

import { exited, setup, waitForMessages } from "../helpers.js";

vi.mock(import("../../command-runtime.js"), { spy: true });

describe("plannotator-annotate", () => {
  it("normalizes annotate flags, supports flags before the target, and wraps feedback", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand(
      "plannotator-annotate",
      `--gate "docs/my file.md" --json --json`,
      ctx
    );
    expect(pending[0]).toMatchObject({
      args: ["annotate", "--gate", "docs/my file.md", "--json"],
      options: { cwd: "/work/project" },
    });

    pending[0].resolve(
      exited(JSON.stringify({ decision: "annotated", feedback: "Fix this." }))
    );
    await waitForMessages(host, 1);
    expect(host.getSentUserMessages()[0]?.content).toBe(
      "# Markdown Annotations\n\nFile: docs/my file.md\n\nFix this.\n\nPlease address the annotation feedback above."
    );
  });

  it("shows annotate usage when no target is present", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-annotate", "--gate --json", ctx);
    expect(pending).toHaveLength(0);
    expect(host.getNotifications().at(-1)).toMatchObject({ type: "error" });
  });

  it.each([
    { decision: "approved" },
    { decision: "dismissed" },
    { decision: "annotated", feedback: "   " },
  ])("does not send annotation feedback for $decision", async (outcome) => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-annotate", "file.md", ctx);
    pending[0].resolve(exited(JSON.stringify(outcome)));
    await vi.waitFor(() => {
      expect(host.getNotifications()).toHaveLength(2);
    });
    expect(host.getSentUserMessages()).toHaveLength(0);
  });

  it.each([
    {
      completion: exited("not json"),
      label: "malformed JSON",
      message:
        "Plannotator annotation: Plannotator returned malformed annotation JSON",
    },
    {
      completion: exited(JSON.stringify({ decision: "mystery" })),
      label: "unknown decision",
      message:
        "Plannotator annotation: Plannotator returned an invalid annotation decision",
    },
  ])(
    "reports $label as an error notification",
    async ({ completion, message }) => {
      const { ctx, host, pending } = setup();
      await host.runCommand("plannotator-annotate", "file.md", ctx);
      pending[0].resolve(completion);
      await vi.waitFor(() => {
        expect(host.getNotifications().at(-1)).toStrictEqual({
          message,
          type: "error",
        });
      });
    }
  );
});
