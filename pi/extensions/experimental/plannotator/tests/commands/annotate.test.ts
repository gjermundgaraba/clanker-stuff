import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vite-plus/test";

import { exited, setup, waitForMessages } from "../helpers.js";

describe("plannotator-annotate", () => {
  it("forwards quoted arguments for Plannotator to validate and wraps feedback", async () => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-annotate", ` "docs/my file.md" --gate `, ctx);
    expect(pending[0]).toMatchObject({
      args: ["annotate", "docs/my file.md", "--gate", "--json"],
      options: { cwd: "/work/project" },
    });

    const [child] = pending;
    assert.ok(child);
    child.resolve(exited(JSON.stringify({ decision: "annotated", feedback: "Fix this." })));
    await waitForMessages(host, 1);
    expect(host.getSentUserMessages()[0]?.content).toBe(
      `# Markdown Annotations\n\nFile: "docs/my file.md" --gate\n\nFix this.\n\nPlease address the annotation feedback above.`,
    );
  });

  it.each(["  ", `""`, `''`, "--gate"])(
    "shows annotate usage without a target: %s",
    async (args) => {
      const { ctx, host, pending } = setup();
      await host.runCommand("plannotator-annotate", args, ctx);
      expect(pending).toHaveLength(0);
      expect(host.getNotifications().at(-1)).toMatchObject({ type: "error" });
      expect(host.getNotifications().at(-1)?.message).toMatch(/^Usage: \/plannotator-annotate /u);
    },
  );

  it.each([
    { decision: "approved" },
    { decision: "dismissed" },
    { decision: "annotated", feedback: "   " },
  ])("does not send annotation feedback for $decision", async (outcome) => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-annotate", "file.md", ctx);
    const [child] = pending;
    assert.ok(child);
    child.resolve(exited(JSON.stringify(outcome)));
    await vi.waitFor(() => {
      expect(host.getNotifications()).toHaveLength(2);
    });
    expect(host.getSentUserMessages()).toHaveLength(0);
  });

  it.each([
    {
      completion: exited("not json"),
      label: "malformed JSON",
      message: "Plannotator annotation: Plannotator returned malformed annotation JSON",
    },
    {
      completion: exited(JSON.stringify({ decision: "mystery" })),
      label: "unknown decision",
      message: "Plannotator annotation: Plannotator returned an invalid annotation decision",
    },
  ])("reports $label as an error notification", async ({ completion, message }) => {
    const { ctx, host, pending } = setup();
    await host.runCommand("plannotator-annotate", "file.md", ctx);
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
});
