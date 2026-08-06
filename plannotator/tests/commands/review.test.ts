import { describe, expect, it, vi } from "vitest";

import { exited, setup, waitForMessages } from "../helpers.js";

vi.mock(import("../../command-runtime.js"), { spy: true });

describe("plannotator-review", () => {
  it("passes review arguments and forwards trimmed output", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand(
      "plannotator-review",
      `--git "https://example.test/pull/1"`,
      ctx
    );
    expect(pending[0]).toMatchObject({
      args: ["review", "--git", "https://example.test/pull/1"],
      options: { cwd: "/work/project" },
    });

    pending[0].resolve(exited("\n  review feedback\n"));
    await waitForMessages(host, 1);
    expect(host.getSentUserMessages()[0]).toStrictEqual({
      content: "review feedback",
      options: { deliverAs: "followUp" },
    });
  });

  it("forwards the standard review approval prompt", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);
    pending[0].resolve(
      exited("# Code Review\n\nCode review completed — no changes requested.\n")
    );
    await waitForMessages(host, 1);
    expect(host.getSentUserMessages()[0]?.content).toContain(
      "Code review completed — no changes requested."
    );
  });

  it.each(["", "Review session closed without feedback.\n"])(
    "suppresses closed-without-feedback review output: %j",
    async (output) => {
      const { ctx, host, pending } = setup();
      await host.runCommand("plannotator-review", "", ctx);
      pending[0].resolve(exited(output));
      await vi.waitFor(() => {
        expect(host.getNotifications().at(-1)?.message).toContain(
          "closed without feedback"
        );
      });
      expect(host.getSentUserMessages()).toHaveLength(0);
    }
  );
});
