import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";
import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createCustomUiDriver, createKeybindings } from "../../../tests/harness/tui.js";
import extension from "../index.js";
import backgroundTasks from "../../experimental/background-tasks/index.js";
import { WAKE_TYPE } from "../../experimental/background-tasks/protocol.js";
import { Value } from "typebox/value";
import { AnswerEnvelopeSchema } from "../delivery.js";
import { STATE_TYPE } from "../journal.js";

const question = {
  title: "Deploy target",
  questions: [
    {
      id: "target",
      header: "Target",
      question: "Where?",
      options: [
        { id: "local", label: "Local", preview: "```ts\nconst local = true;\n```" },
        { id: "remote", label: "Remote" },
      ],
    },
  ],
};

const keys = createKeybindings({
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape"],
  "tui.input.submit": ["enter"],
  "tui.input.newLine": ["ctrl+j"],
  "tui.input.tab": ["tab"],
});

async function setup(
  mode: ExtensionContext["mode"] = "tui",
  persisted = true,
  extra: ExtensionFactory[] = [],
) {
  initTheme("dark");
  const dir = mkdtempSync(join(tmpdir(), "question-lifecycle-"));
  let component: Component | undefined;

  const driver = createCustomUiDriver({
    keybindings: keys,
    onComponent: (c) => {
      component = c;
    },
  });

  const select = vi.fn(async (_title: string, choices: string[]) => choices[0]);

  const screen = () => component?.render(80).join("\n");

  const uiContext = Object.assign(createExtensionHost(() => {}).createContext().ui, {
    custom: driver.custom,
    select,
    notify: vi.fn(),
    setWidget: vi.fn(),
  });

  const harness = await createAgentSessionHarness({
    extensionFactories: [extension, ...extra],
    mode,
    uiContext,
    ...(persisted ? { sessionDir: dir } : {}),
  });

  const press = async (...input: string[]) => {
    for (const key of input) {
      component?.handleInput?.(key);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };

  const checkpoint = () =>
    harness.sessionManager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === STATE_TYPE)
      .at(-1);

  return {
    harness,
    select,
    uiContext,
    press,
    checkpoint,
    screen,
    get component() {
      return component;
    },
    cleanup: async () => {
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      harness.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("durable questionnaires in AgentSession", () => {
  it("opens submitted answers directly and only revises on an explicit action", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input_async", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Independent work"),
      ]);
      await env.harness.prompt("Ask async");
      const answering = env.harness.prompt("/answers");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("1", "k");
      await answering;
      const reviewing = env.harness.prompt("/answers");
      await expect
        .poll(() => env.component?.render(80).join("\n"))
        .toContain("Read-only · revision 1");
      expect(JSON.stringify(env.checkpoint())).not.toContain('"draft"');
      const beforeDetails = JSON.stringify(env.checkpoint());
      expect(env.component?.render(80).join("\n")).not.toContain("ID:");
      await env.press("i");
      expect(env.component?.render(80).join("\n")).toContain("ID:");
      expect(env.component?.render(80).join("\n")).toContain("Requested by:");
      await env.press("\u001b");
      expect(env.component?.render(80).join("\n")).not.toContain("ID:");
      expect(JSON.stringify(env.checkpoint())).toBe(beforeDetails);
      await env.press("r"); // A fully answered draft reopens on Review.
      await expect
        .poll(() => env.component?.render(80).join("\n"))
        .toContain("revising revision 1");
      await env.press("1");
      expect(env.component?.render(80).join("\n")).toContain("> (•) 1. Local");
      await env.press("2", "k");
      await reviewing;
      const history = env.harness.prompt("/answers");
      await expect
        .poll(() => env.component?.render(80).join("\n"))
        .toContain("Read-only · revision 2");
      await env.press("\u001b[D");
      expect(env.component?.render(80).join("\n")).toContain("Read-only · revision 1");
      expect(env.component?.render(80).join("\n")).not.toContain("r Revise");
      await env.press("r"); // Older revisions cannot overwrite the latest draft.
      expect(env.component?.render(80).join("\n")).toContain("Read-only · revision 1");
      await env.press("\u001b[C", "\u001b");
      await history;
      expect(env.select).toHaveBeenCalledTimes(3);
      expect(env.harness.messages().filter((m) => m.role === "user")).toHaveLength(1);
      expect(JSON.stringify(env.checkpoint())).not.toContain('"draft"');
    } finally {
      await env.cleanup();
    }
  });
  it("opens cancelled questionnaires read-only without creating an answer or draft", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input_async", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Independent work"),
      ]);
      await env.harness.prompt("Ask async");
      const cancelling = env.harness.prompt("/answers");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("x");
      expect(env.component?.render(80).join("\n")).toContain("Press x again");
      await env.press("j"); // Any other key disarms cancellation.
      await env.press("x");
      expect(env.checkpoint()).not.toBeUndefined();
      expect(JSON.stringify(env.checkpoint())).toContain('"cancelled":false');
      await env.press("x", "x");
      await cancelling;
      const inspecting = env.harness.prompt("/answers");
      await expect
        .poll(() => env.component?.render(80).join("\n"))
        .toContain("Cancelled · no submitted answers");
      expect(env.component?.render(80).join("\n")).toContain("Where?");
      await env.press("r", "s", "\u001b");
      await inspecting;
      expect(JSON.stringify(env.checkpoint())).toContain('"submissions":[]');
      expect(JSON.stringify(env.checkpoint())).not.toContain('"draft"');
    } finally {
      await env.cleanup();
    }
  });
  it("blocks for explicit Review and returns structured answers without another user message", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Done"),
      ]);
      const running = env.harness.prompt("Ask a question");
      await expect.poll(() => !!env.component).toBe(true);
      expect(env.component?.render(80).join("\n")).toContain("( ) 1. Local");
      await env.press("1");
      expect(env.component?.render(80).join("\n")).toContain("Review");
      await env.press("\r");
      await running;
      const result = env.harness.messages().find((m) => m.role === "toolResult");
      expect(result).toMatchObject({
        isError: false,
        details: {
          type: "questionnaire_answer",
          revision: 1,
          answers: { target: { selections: [{ option_id: "local", label: "Local" }] } },
        },
      });
      expect(env.harness.messages().filter((m) => m.role === "user")).toHaveLength(1);
      // The answer is recorded as sent before the tool result that delivers it.
      const branch = env.harness.sessionManager.getBranch();
      const sent = branch.findIndex((e) => JSON.stringify(e).includes('"sent_at"'));

      const delivered = branch.findIndex(
        (e) => e.type === "message" && e.message.role === "toolResult",
      );

      expect(sent).toBeGreaterThan(-1);
      expect(sent).toBeLessThan(delivered);
    } finally {
      await env.cleanup();
    }
  });
  it("accepts async durably, survives replay, keeps submission in inbox and explicitly sends it", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input_async", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Independent work"),
        fauxAssistantMessage("Answer received"),
      ]);
      await env.harness.prompt("Ask async");
      expect(env.harness.getPendingResponseCount()).toBe(1);
      expect(env.harness.messages().find((m) => m.role === "toolResult")).toMatchObject({
        details: { accepted: true, status: "pending" },
      });
      await env.harness.session.extensionRunner.emit({
        type: "session_tree",
        newLeafId: env.harness.sessionManager.getLeafId(),
        oldLeafId: null,
      });
      const answering = env.harness.prompt("/answers");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("2", "k");
      await answering;
      expect(env.select).toHaveBeenCalledTimes(1); // Selecting an item opens it directly.
      expect(env.harness.getPendingResponseCount()).toBe(1);
      const sending = env.harness.prompt("/answers");
      await expect
        .poll(() => env.component?.render(80).join("\n"))
        .toContain("Read-only · revision 1");
      expect(env.harness.getPendingResponseCount()).toBe(1);
      await env.press("s");
      await sending;
      await expect.poll(() => env.harness.getPendingResponseCount()).toBe(0);
      await expect.poll(() => env.harness.session.isIdle).toBe(true);
      expect(JSON.stringify(env.harness.messages())).toContain('\\"option_id\\":\\"remote\\"');
      expect(JSON.stringify(env.checkpoint())).toContain('"sent_at"');

      const answer = env.harness
        .messages()
        .filter((m) => m.role === "user")
        .at(-1)!;

      const wire =
        typeof answer.content === "string"
          ? answer.content
          : answer.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");

      const transformer = env.harness.session.extensionRunner.getMarkdownTransformers()[0];
      assert(transformer);

      const displayContext = {
        messageType: "user" as const,
        isStreaming: false,
        availableWidth: 80,
      };

      expect(transformer(wire, displayContext)).toContain("✓ Remote");
      expect(transformer(wire, displayContext)).not.toContain('"type":"questionnaire_answer"');
      // Reattached branch state must render the same answer, without rewriting history.
      await env.harness.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      expect(transformer(wire, displayContext)).toContain("✓ Remote");
      expect(JSON.stringify(env.harness.messages())).toContain('\\"option_id\\":\\"remote\\"');
    } finally {
      await env.cleanup();
    }
  });
  it.each([false, true])(
    "keeps saved answers explicit across a background wake (inbox open=%s)",
    async (inboxOpen) => {
      const env = await setup("tui", true, [backgroundTasks]);
      const { harness } = env;

      const wakeMessages = () =>
        harness.messages().filter((m) => m.role === "custom" && m.customType === WAKE_TYPE);

      const answerMessages = () =>
        harness
          .messages()
          .filter(
            (m) => m.role === "user" && JSON.stringify(m.content).includes("questionnaire_answer"),
          );

      try {
        harness.setResponses([
          fauxAssistantMessage(fauxToolCall("request_user_input_async", question), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Independent work"),
          fauxAssistantMessage(
            fauxToolCall("task_start", {
              name: "independent work",
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
            }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Task started"),
          fauxAssistantMessage("Notification processed"),
          fauxAssistantMessage("Explicit answer received"),
        ]);
        await harness.prompt("Ask async");
        const answering = harness.prompt("/answers");
        await expect.poll(() => !!env.component).toBe(true);
        await env.press("2", "k");
        await answering;
        expect(answerMessages()).toHaveLength(0);

        // The background run and its wake happen while the submitted answer is on screen.
        const reviewing = inboxOpen ? harness.prompt("/answers") : undefined;

        if (reviewing) await expect.poll(env.screen).toContain("Read-only · revision 1");
        await harness.prompt("Do independent background work");

        if (reviewing) {
          await env.press("\u001b");
          await reviewing;
        }

        await expect.poll(() => wakeMessages().length).toBe(1);
        await expect.poll(() => harness.session.isIdle).toBe(true);
        // An automatic continuation is not user approval: the saved answer stays unsent.
        expect(answerMessages()).toHaveLength(0);
        expect(JSON.stringify(env.checkpoint())).not.toContain('"sent_at"');

        const previousView = env.component;
        const sending = harness.prompt("/answers");
        await expect.poll(() => env.component !== previousView).toBe(true);
        await expect.poll(env.screen).toContain("Read-only · revision 1 · Not sent");
        await env.press("s");
        await sending;
        await expect.poll(() => harness.getPendingResponseCount()).toBe(0);
        await expect.poll(() => harness.session.isIdle).toBe(true);
        expect(answerMessages()).toHaveLength(1);
        expect(JSON.stringify(answerMessages())).toContain("remote");
        expect(wakeMessages()).toHaveLength(1);
        expect(JSON.stringify(env.checkpoint())).toContain('"sent_at"');
      } finally {
        await harness.session.abort();
        await env.cleanup();
      }
    },
  );
  it("hands an explicit Send to Pi's queue and can send again after Stop restores it", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input_async", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Independent"),
      ]);
      await env.harness.prompt("Ask async");
      env.harness.setResponses([
        async (_context, options) => {
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );

          return fauxAssistantMessage("Stopped", { stopReason: "aborted" });
        },
        fauxAssistantMessage("Answer received"),
      ]);
      const running = env.harness.prompt("Independent work");
      await expect.poll(() => env.harness.session.isStreaming).toBe(true);
      await env.harness.session.steer("Unrelated queued text");
      const answering = env.harness.prompt("/answers");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("1", "\r");
      await answering;
      expect(env.harness.session.getSteeringMessages()).toHaveLength(2);
      expect(JSON.stringify(env.checkpoint())).toContain('"sent_at"');
      // The real TUI's abort handler restores Pi's queue to the editor; the answer is Pi's now.
      const restored = env.harness.session.clearQueue();
      expect(restored.steering[0]).toBe("Unrelated queued text");
      expect(restored.steering[1]).toContain('"type":"questionnaire_answer"');
      await env.harness.session.abort();
      await running;
      const resending = env.harness.prompt("/answers");
      await expect.poll(env.screen).toContain("Read-only · revision 1 · Sent");
      expect(env.screen()).toContain("s Send again");
      await env.press("s");
      await resending;
      await expect.poll(() => env.harness.session.isIdle).toBe(true);
      expect(
        env.harness
          .messages()
          .filter(
            (m) => m.role === "user" && JSON.stringify(m.content).includes("questionnaire_answer"),
          ),
      ).toHaveLength(1);
    } finally {
      await env.cleanup();
    }
  });
  it("flushes a blocking draft on Stop and returns no invented answer", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input", question), {
          stopReason: "toolUse",
        }),
      ]);
      const running = env.harness.prompt("Ask");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("g");
      env.component?.handleInput?.("last typed note");
      await env.harness.session.abort();
      await running;
      expect(JSON.stringify(env.checkpoint())).toContain("last typed note");
      expect(JSON.stringify(env.checkpoint())).not.toContain('"revision":1');
    } finally {
      await env.cleanup();
    }
  });
  it("agent revisions share the same immutable user-revision path and report supersession", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("First recorded"),
      ]);
      const first = env.harness.prompt("Ask");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("1", "\r");
      await first;
      const result = env.harness.messages().find((m) => m.role === "toolResult");

      if (result?.role !== "toolResult") throw new Error("Missing result");
      const original = Value.Parse(AnswerEnvelopeSchema, result.details);
      const oldView = env.component;
      env.harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("revise_user_input", {
            interaction_id: original.interaction_id,
            base_revision: 1,
            reason: "Synthetic reconsideration",
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Revision recorded"),
      ]);
      const revision = env.harness.prompt("Revise");
      await expect.poll(() => env.component !== oldView).toBe(true);
      oldView?.handleInput?.("2"); // Closed callbacks cannot edit a reopened revision.
      await env.press("1", "2", "d");
      expect(env.component?.render(80).join("\n")).toContain("Before · revision 1");
      await env.press("\u001b", "\r");
      await revision;
      const results = env.harness.messages().filter((m) => m.role === "toolResult");
      expect(results.at(-1)).toMatchObject({
        details: {
          revision: 2,
          changed: ["Target"],
          answers: { target: { selections: [{ option_id: "remote" }] } },
        },
      });
      expect(results[0]).toMatchObject({ details: original });
      expect(env.harness.messages().filter((m) => m.role === "user")).toHaveLength(2);
    } finally {
      await env.cleanup();
    }
  });
  it("flushes before tree navigation and fences the old dialog from the active branch", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input_async", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Independent"),
      ]);
      await env.harness.prompt("Ask async");
      const root = env.harness.sessionManager.getBranch()[0];
      assert(root);
      const answering = env.harness.prompt("/answers");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("g");
      env.component?.handleInput?.("branch-local draft note");
      const stale = env.component;
      await env.harness.session.navigateTree(root.id, { summarize: false });
      await answering;
      expect(env.checkpoint()).toBeUndefined();
      stale?.handleInput?.("1");
      stale?.handleInput?.("\r");
      expect(env.checkpoint()).toBeUndefined();
      expect(JSON.stringify(env.harness.sessionManager.getEntries())).toContain(
        "branch-local draft note",
      );
    } finally {
      await env.cleanup();
    }
  });
  it("declares the questionnaire tools in the TUI", async () => {
    const env = await setup();

    try {
      expect(env.harness.session.getActiveToolNames()).toEqual(
        expect.arrayContaining([
          "request_user_input",
          "request_user_input_async",
          "revise_user_input",
        ]),
      );
    } finally {
      await env.cleanup();
    }
  });
  it.each(["rpc", "json", "print"] as const)(
    "withdraws questionnaires in %s so nothing can activate them",
    async (mode) => {
      const env = await setup(mode);
      const tools = ["request_user_input", "request_user_input_async", "revise_user_input"];

      try {
        const active = env.harness.session.getActiveToolNames();
        expect(active.filter((name) => tools.includes(name))).toEqual([]);
        env.harness.session.setActiveToolsByName([...active, ...tools]);
        expect(env.harness.session.getActiveToolNames()).toEqual(active);
        await env.harness.prompt("/answers");
        expect(env.component).toBeUndefined();
        expect(env.select).not.toHaveBeenCalled();
      } finally {
        await env.cleanup();
      }
    },
  );
  it("answers questionnaires in a session without a file", async () => {
    const env = await setup("tui", false);

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Done"),
      ]);
      const running = env.harness.prompt("Ask");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("1", "\r");
      await running;
      expect(env.harness.sessionManager.getSessionFile()).toBeUndefined();
      expect(env.harness.messages().find((m) => m.role === "toolResult")).toMatchObject({
        isError: false,
        details: { type: "questionnaire_answer", revision: 1 },
      });
      expect(JSON.stringify(env.checkpoint())).toContain('"sent_at"');
    } finally {
      await env.cleanup();
    }
  });
});
