import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vite-plus/test";

import { exited, setup, waitForMessages } from "../helpers.js";

describe("plannotator-review", () => {
  it("passes review arguments and forwards trimmed output", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", `--git "https://example.test/pull/1"`, ctx);
    expect(pending[0]).toMatchObject({
      args: ["review", "--git", "https://example.test/pull/1"],
      options: { cwd: "/work/project" },
    });

    const [child] = pending;
    assert.ok(child);
    child.resolve(exited("\n  review feedback\n"));
    await waitForMessages(host, 1);
    expect(host.getSentUserMessages()[0]).toStrictEqual({
      content: "review feedback",
      options: { deliverAs: "followUp" },
    });
  });

  it("forwards the standard review approval prompt", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-review", "", ctx);
    const [child] = pending;
    assert.ok(child);
    child.resolve(exited("# Code Review\n\nCode review completed — no changes requested.\n"));
    await waitForMessages(host, 1);
    expect(host.getSentUserMessages()[0]?.content).toContain(
      "Code review completed — no changes requested.",
    );
  });

  it.each(["", "Review session closed without feedback.\n"])(
    "suppresses closed-without-feedback review output: %j",
    async (output) => {
      const { ctx, host, pending } = setup();
      await host.runCommand("plannotator-review", "", ctx);
      const [child] = pending;
      assert.ok(child);
      child.resolve(exited(output));
      await vi.waitFor(() => {
        expect(host.getNotifications().at(-1)?.message).toContain("closed without feedback");
      });
      expect(host.getSentUserMessages()).toHaveLength(0);
    },
  );
});
