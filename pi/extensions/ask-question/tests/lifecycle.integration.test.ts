import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { toolRenderContext } from "../../../tests/harness/tool-rendering.js";
import {
  createCustomUiDriver,
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { MESSAGE_TYPE } from "../delivery.js";
import extension from "../index.js";
import { STATE_TYPE } from "../journal.js";

const question = {
  wait: true,
  title: "Deploy target",
  questions: [
    {
      id: "target",
      header: "Target",
      question: "Where?",
      options: [
        {
          id: "local",
          label: "Local",
          preview: "```ts\nconst local = true;\n```",
        },
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

const setup = async (
  mode: ExtensionContext["mode"] = "tui",
  persisted = true
) => {
  initTheme("dark");
  const dir = mkdtempSync(path.join(tmpdir(), "question-lifecycle-"));
  let component: Component | undefined;

  const driver = createCustomUiDriver({
    tui: createMockTui(),
    keybindings: keys,
    onComponent: (c) => {
      component = c;
    },
  });

  const custom = vi.fn<ExtensionUIContext["custom"]>(driver.custom);

  const select = vi.fn<ExtensionUIContext["select"]>(
    async (_title, choices) => choices[0]
  );

  const screen = () => component?.render(80).join("\n");

  const uiContext = Object.assign(
    createExtensionHost(() => {}).createContext().ui,
    {
      custom,
      select,
      notify: vi.fn<ExtensionUIContext["notify"]>(),
      setWidget: vi.fn<ExtensionUIContext["setWidget"]>(),
    }
  );

  const harness = await createAgentSessionHarness({
    extensionFactories: [extension],
    mode,
    uiContext,
    ...(persisted ? { sessionDir: dir } : {}),
  });

  const press = async (...input: string[]) => {
    for (const key of input) {
      component?.handleInput?.(key);
      await setTimeout(30);
    }
  };

  const checkpoint = () =>
    harness.sessionManager
      .getBranch()
      .findLast((e) => e.type === "custom" && e.customType === STATE_TYPE);

  return {
    harness,
    select,
    custom,
    uiContext,
    press,
    checkpoint,
    screen,
    get component() {
      return component;
    },
    cleanup: async () => {
      await harness.session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      harness.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const asyncQuestion = { ...question, wait: false };

const outcomeMessages = (env: Awaited<ReturnType<typeof setup>>) =>
  env.harness
    .messages()
    .filter((m) => m.role === "custom" && m.customType === MESSAGE_TYPE);

const toolResults = (env: Awaited<ReturnType<typeof setup>>) =>
  env.harness.messages().filter((m) => m.role === "toolResult");

describe("durable questionnaires in AgentSession", () => {
  it("waits for explicit Review and returns structured answers without another message", async () => {
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
      expect(env.custom).toHaveBeenCalledWith(expect.any(Function), {
        blocked: { kind: "question", message: "Deploy target" },
      });
      expect(env.screen()).toContain("( ) 1. Local");
      await env.press("1");
      expect(env.screen()).toContain("Review");
      await env.press("\r");
      await running;

      expect(toolResults(env)).toMatchObject([
        {
          isError: false,
          details: {
            type: "questionnaire",
            status: "answered",
            answers: {
              target: { selections: [{ option_id: "local", label: "Local" }] },
            },
          },
        },
      ]);
      expect(
        env.harness.messages().filter((m) => m.role === "user")
      ).toHaveLength(1);
      expect(outcomeMessages(env)).toHaveLength(0);
      const branch = env.harness.sessionManager.getBranch();

      const closed = branch.findIndex(
        (e) =>
          e.type === "custom" &&
          e.customType === STATE_TYPE &&
          !JSON.stringify(e.data).includes('"draft"')
      );

      const delivered = branch.findIndex(
        (e) => e.type === "message" && e.message.role === "toolResult"
      );

      expect(closed).toBeGreaterThan(-1);
      expect(closed).toBeLessThan(delivered);
    } finally {
      await env.cleanup();
    }
  });

  it("accepts async durably, survives replay, and starts a turn with the answers as a custom message", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("request_user_input", asyncQuestion),
          {
            stopReason: "toolUse",
          }
        ),
        fauxAssistantMessage("Independent work"),
        fauxAssistantMessage("Answer received"),
      ]);
      await env.harness.prompt("Ask async");
      expect(env.harness.getPendingResponseCount()).toBe(1);
      expect(toolResults(env)).toMatchObject([
        { details: { type: "questionnaire", status: "pending" } },
      ]);
      await env.harness.session.extensionRunner.emit({
        type: "session_tree",
        newLeafId: env.harness.sessionManager.getLeafId(),
        oldLeafId: null,
      });
      const answering = env.harness.prompt("/answers");
      await expect.poll(() => !!env.component).toBe(true);
      expect(env.custom).toHaveBeenCalledWith(expect.any(Function), undefined);
      await env.press("2");
      expect(env.screen()).toContain("Send answers (starts or steers a turn)");
      await env.press("\r");
      await answering;
      await expect.poll(() => env.harness.getPendingResponseCount()).toBe(0);
      await expect.poll(() => env.harness.session.isIdle).toBe(true);

      const [message] = outcomeMessages(env);
      assert.ok(message?.role === "custom");

      const answer = {
        type: "questionnaire",
        title: "Deploy target",
        status: "answered",
        answers: {
          target: {
            question: "Where?",
            header: "Target",
            selections: [{ option_id: "remote", label: "Remote" }],
          },
        },
      };

      expect(message.details).toMatchObject(answer);
      expect(message.content).toBe(JSON.stringify(message.details));
      expect(message.display).toBe(true);
      expect(
        env.harness.messages().filter((m) => m.role === "user")
      ).toHaveLength(1);

      const renderer =
        env.harness.session.extensionRunner.getMessageRenderer(MESSAGE_TYPE);

      assert.ok(renderer);

      const rendered = renderer(
        message,
        toolRenderContext(),
        createIdentityTheme()
      )?.render(80);

      expect(rendered?.join("\n")).toContain("✓ Remote");

      expect(JSON.stringify(env.checkpoint())).not.toContain('"draft"');
      await env.harness.prompt("/answers");
      expect(env.uiContext.notify).toHaveBeenLastCalledWith(
        "No questionnaires await you on this branch",
        "info"
      );
    } finally {
      await env.cleanup();
    }
  });

  it("returns answers that a Stop dropped from Pi's queue to the inbox", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("request_user_input", asyncQuestion),
          {
            stopReason: "toolUse",
          }
        ),
        fauxAssistantMessage("Independent"),
      ]);
      await env.harness.prompt("Ask async");
      const providerStarted = Promise.withResolvers<undefined>();

      env.harness.setResponses([
        async (_context, options) => {
          providerStarted.resolve(undefined);
          const aborted = Promise.withResolvers<undefined>();
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted.resolve(undefined);
            },
            { once: true }
          );
          await aborted.promise;

          return fauxAssistantMessage("Stopped", { stopReason: "aborted" });
        },
        fauxAssistantMessage("Answer received"),
      ]);
      const running = env.harness.prompt("Independent work");
      await providerStarted.promise;
      const answering = env.harness.prompt("/answers");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("1", "\r");
      await answering;
      expect(JSON.stringify(env.checkpoint())).not.toContain('"draft"');

      env.harness.session.clearQueue();
      await env.harness.session.abort();
      await running;
      expect(outcomeMessages(env)).toHaveLength(0);
      expect(JSON.stringify(env.checkpoint())).toContain('"draft"');
      expect(env.uiContext.notify).toHaveBeenCalledWith(
        expect.stringContaining("/answers to send them again"),
        "warning"
      );

      const resending = env.harness.prompt("/answers");
      await expect.poll(env.screen).toContain("Send answers");
      expect(env.screen()).toContain("✓ Local");
      await env.press("\r");
      await resending;
      await expect.poll(() => env.harness.session.isIdle).toBe(true);
      expect(outcomeMessages(env)).toMatchObject([
        { details: { status: "answered" } },
      ]);
      expect(env.harness.getPendingResponseCount()).toBe(0);
    } finally {
      await env.cleanup();
    }
  });

  it("tells a waiting call the questionnaire was dismissed and lets the run continue", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Continuing without an answer"),
      ]);
      const running = env.harness.prompt("Ask");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("d");
      await running;
      expect(toolResults(env)).toMatchObject([
        { isError: false, details: { status: "dismissed" } },
      ]);
      expect(env.harness.getPendingResponseCount()).toBe(0);
      expect(outcomeMessages(env)).toHaveLength(0);
      expect(JSON.stringify(env.checkpoint())).not.toContain('"draft"');
    } finally {
      await env.cleanup();
    }
  });

  it("records an async dismissal for the agent without starting a turn while idle", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("request_user_input", asyncQuestion),
          {
            stopReason: "toolUse",
          }
        ),
        fauxAssistantMessage("Independent"),
        fauxAssistantMessage("Not expected"),
      ]);
      await env.harness.prompt("Ask async");
      const dismissing = env.harness.prompt("/answers");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("d");
      await dismissing;
      expect(outcomeMessages(env)).toMatchObject([
        { details: { status: "dismissed" } },
      ]);
      expect(env.harness.getPendingResponseCount()).toBe(1);
      expect(env.uiContext.setWidget).toHaveBeenLastCalledWith(
        "questionnaires",
        undefined
      );
    } finally {
      await env.cleanup();
    }
  });

  it("stops the run and keeps the draft when a waiting questionnaire is closed", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Not expected"),
      ]);
      const running = env.harness.prompt("Ask");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("j", "n", "kept note", "\r", "\u001B");
      await running;
      expect(toolResults(env)).toMatchObject([
        { details: { status: "closed" } },
      ]);
      expect(env.harness.getPendingResponseCount()).toBe(1);
      expect(JSON.stringify(env.checkpoint())).toContain("kept note");
    } finally {
      await env.cleanup();
    }
  });

  it("flushes a waiting draft on Stop and returns no invented answer", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input", question), {
          stopReason: "toolUse",
        }),
      ]);
      const running = env.harness.prompt("Ask");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("n");
      env.component?.handleInput?.("last typed note");
      await env.harness.session.abort();
      await running;
      expect(JSON.stringify(env.checkpoint())).toContain("last typed note");
    } finally {
      await env.cleanup();
    }
  });

  it("flushes before tree navigation and fences the old dialog from the active branch", async () => {
    const env = await setup();

    try {
      env.harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("request_user_input", asyncQuestion),
          {
            stopReason: "toolUse",
          }
        ),
        fauxAssistantMessage("Independent"),
      ]);
      await env.harness.prompt("Ask async");
      const [root] = env.harness.sessionManager.getBranch();
      assert.ok(root);
      const answering = env.harness.prompt("/answers");
      await expect.poll(() => !!env.component).toBe(true);
      await env.press("n");
      env.component?.handleInput?.("branch-local draft note");
      const stale = env.component;
      await env.harness.session.navigateTree(root.id, { summarize: false });
      await answering;
      expect(env.checkpoint()).toBeUndefined();
      stale?.handleInput?.("1");
      stale?.handleInput?.("\r");
      expect(env.checkpoint()).toBeUndefined();
      expect(JSON.stringify(env.harness.sessionManager.getEntries())).toContain(
        "branch-local draft note"
      );
    } finally {
      await env.cleanup();
    }
  });

  it("declares the questionnaire tool in the TUI", async () => {
    const env = await setup();

    try {
      expect(env.harness.session.getActiveToolNames()).toContain(
        "request_user_input"
      );
    } finally {
      await env.cleanup();
    }
  });

  it.each(["rpc", "json", "print"] as const)(
    "withdraws questionnaires in %s so nothing can activate them",
    async (mode) => {
      const env = await setup(mode);

      try {
        const active = env.harness.session.getActiveToolNames();
        expect(active).not.toContain("request_user_input");
        env.harness.session.setActiveToolsByName([
          ...active,
          "request_user_input",
        ]);
        expect(env.harness.session.getActiveToolNames()).toStrictEqual(active);
        await env.harness.prompt("/answers");
        expect(env.component).toBeUndefined();
        expect(env.select).not.toHaveBeenCalled();
      } finally {
        await env.cleanup();
      }
    }
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
      expect(toolResults(env)).toMatchObject([
        { isError: false, details: { status: "answered" } },
      ]);
    } finally {
      await env.cleanup();
    }
  });
});
