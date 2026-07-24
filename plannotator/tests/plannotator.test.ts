import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import type { CliCompletion, CliStarter, CliStartOptions } from "../cli.js";
import { tokenizeArguments } from "../cli.js";
import { createMinimalPlannotatorExtension } from "../index.js";

interface PendingProcess {
  args: string[];
  cancel: Mock<() => void>;
  options: CliStartOptions;
  reject: (error: unknown) => void;
  resolve: (result: CliCompletion) => void;
}

const createStarter = () => {
  const pending: PendingProcess[] = [];
  const starter = vi.fn<CliStarter>((args, options) => {
    const {
      promise: completion,
      reject,
      resolve,
    } = Promise.withResolvers<CliCompletion>();
    const process = {
      args: [...args],
      cancel: vi.fn<() => void>(),
      options: { ...options },
      reject,
      resolve,
    };
    pending.push(process);
    return { cancel: process.cancel, completion };
  });
  return { pending, starter };
};

const setup = (entries: SessionEntry[] = [], leafId: string | null = null) => {
  const { pending, starter } = createStarter();
  const host = createExtensionHost(createMinimalPlannotatorExtension(starter), {
    entries,
    leafId,
  });
  const ctx = host.createContext({ cwd: "/work/project" });
  return { ctx, host, pending, starter };
};

const exited = (
  stdout: string,
  options: { code?: number; stderr?: string } = {}
): CliCompletion => ({
  code: options.code ?? 0,
  kind: "exited",
  stderr: options.stderr ?? "",
  stdout,
});

const waitForMessages = async (
  host: ReturnType<typeof setup>["host"],
  count: number
) => {
  await vi.waitFor(() => {
    expect(host.getSentUserMessages()).toHaveLength(count);
  });
};

const assistantEntry = (
  id: string,
  parentId: string | null,
  text: string
): SessionEntry => ({
  id,
  message: {
    api: "test",
    content: [{ text, type: "text" }],
    model: "test",
    provider: "test",
    role: "assistant",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  },
  parentId,
  timestamp: new Date().toISOString(),
  type: "message",
});

const userEntry = (
  id: string,
  parentId: string,
  text: string
): SessionEntry => ({
  id,
  message: {
    content: [{ text, type: "text" }],
    role: "user",
    timestamp: Date.now(),
  },
  parentId,
  timestamp: new Date().toISOString(),
  type: "message",
});

const signaled = (signal: NodeJS.Signals): CliCompletion => ({
  kind: "signaled",
  signal,
});

describe("plannotator", () => {
  it("registers the three Plannotator commands", () => {
    const { host } = setup();
    expect([...host.getRegisteredCommands().keys()]).toStrictEqual([
      "plannotator-review",
      "plannotator-annotate",
      "plannotator-last",
    ]);
  });

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

  it("passes the last assistant message through controlled stdin flags", async () => {
    const entry = assistantEntry("assistant", null, "Original answer");
    const { ctx, host, pending } = setup([entry], entry.id);
    await host.runCommand(
      "plannotator-last",
      "--gate --stdin --json --stdin",
      ctx
    );
    expect(pending[0]).toMatchObject({
      args: ["annotate-last", "--stdin", "--json", "--gate"],
      options: { cwd: "/work/project", stdin: "Original answer" },
    });
  });

  it("does not start last-message annotation without an assistant message", async () => {
    const entry = userEntry("user", "root", "hello");
    const { ctx, host, pending } = setup([entry], entry.id);
    await host.runCommand("plannotator-last", "", ctx);
    expect(pending).toHaveLength(0);
    expect(host.getNotifications().at(-1)).toStrictEqual({
      message: "No assistant message found in session.",
      type: "error",
    });
  });

  it("anchors last-message feedback after the active branch moves", async () => {
    const assistant = assistantEntry("assistant", null, "Original answer");
    const user = userEntry("later-user", assistant.id, "Another request");
    const { ctx, host, pending } = setup([assistant, user], assistant.id);
    await host.runCommand("plannotator-last", "", ctx);
    host.setLeafId(user.id);

    pending[0].resolve(
      exited(JSON.stringify({ decision: "annotated", feedback: "Clarify it." }))
    );
    await waitForMessages(host, 1);
    const content = host.getSentUserMessages()[0]?.content;
    expect(content).toBeTypeOf("string");
    if (typeof content !== "string") {
      throw new TypeError("Expected text feedback");
    }
    expect(content).toContain("> Original answer");
    expect(content).toContain("User feedback:\nClarify it.");
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
      args: "",
      command: "plannotator-review",
      completion: exited("", { code: 2, stderr: "bad repository" }),
      label: "nonzero exit",
      message: "Plannotator code review: bad repository",
    },
    {
      args: "",
      command: "plannotator-review",
      completion: signaled("SIGTERM"),
      label: "unexpected signal",
      message: "Plannotator code review: terminated by SIGTERM",
    },
    {
      args: "file.md",
      command: "plannotator-annotate",
      completion: exited("not json"),
      label: "malformed JSON",
      message:
        "Plannotator annotation: Plannotator returned malformed annotation JSON",
    },
    {
      args: "file.md",
      command: "plannotator-annotate",
      completion: exited(JSON.stringify({ decision: "mystery" })),
      label: "unknown decision",
      message:
        "Plannotator annotation: Plannotator returned an invalid annotation decision",
    },
  ])(
    "reports $label as an error notification",
    async ({ args, command, completion, message }) => {
      const { ctx, host, pending } = setup();
      await host.runCommand(command, args, ctx);
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
