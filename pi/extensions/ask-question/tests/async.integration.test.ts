import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import { createCustomUiDriver, createKeybindings } from "../../../tests/harness/tui.js";
import extension from "../index.js";

const question = { questions: [{ title: "Choose a color", options: ["Blue", "Green"] }] };

const setup = async (additional: ExtensionFactory[] = []) => {
  initTheme("dark");
  const driver = createCustomUiDriver({
    keys: ["\t", "\r"],
    keybindings: createKeybindings({
      "tui.select.confirm": ["\r"],
      "tui.select.cancel": ["\u001b"],
    }),
  });
  // SAFETY: Async input uses only these UI operations in this test.
  const uiContext = Object.assign({} as ExtensionUIContext, {
    custom: driver.custom,
    setWidget: vi.fn(),
    notify: vi.fn(),
  });
  const harness = await createAgentSessionHarness({
    extensionFactories: [extension, ...additional],
    mode: "tui",
    uiContext,
  });
  return { harness, driver };
};

describe("async answers in a real AgentSession", () => {
  it("renders an attention entry without steering or adding user context", async () => {
    const { harness } = await setup();
    try {
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("send_message_to_user_async", { message: "Attention only" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Finished"),
        fauxAssistantMessage("Must not be sampled"),
      ]);
      await harness.prompt("Send an attention update");
      expect(harness.getPendingResponseCount()).toBe(1);
      expect(harness.sessionManager.getBranch()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "custom",
            customType: "async-attention",
            data: { message: "Attention only" },
          }),
        ]),
      );
      expect(harness.messages().filter((message) => message.role === "user")).toHaveLength(1);
      expect(harness.messages().some((message) => message.role === "custom")).toBe(false);
    } finally {
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      harness.cleanup();
    }
  });

  it("continues past the tool and starts an idle turn with a durable user answer", async () => {
    const { harness } = await setup();
    try {
      harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input_async", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Continuing without waiting"),
        fauxAssistantMessage("Received the answer"),
      ]);
      await harness.prompt("Ask and continue");
      expect(harness.getPendingResponseCount()).toBe(1);
      expect(
        harness
          .messages()
          .some(
            (message) =>
              message.role === "assistant" &&
              JSON.stringify(message.content).includes("Continuing without waiting"),
          ),
      ).toBe(true);
      await harness.prompt("/answers");
      await expect.poll(() => harness.getPendingResponseCount()).toBe(0);
      await expect.poll(() => harness.session.isStreaming).toBe(false);
      expect(harness.sessionManager.getBranch()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: expect.arrayContaining([
                expect.objectContaining({
                  text: expect.stringContaining("Choose a color -> Blue"),
                }),
              ]),
            }),
          }),
        ]),
      );
    } finally {
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      harness.cleanup();
    }
  });

  it("steers a running turn without waiting for the agent to settle", async () => {
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let requests = 0;
    const { harness } = await setup([
      (pi) => {
        pi.on("before_provider_request", async () => {
          requests += 1;
          if (requests === 2) {
            held.resolve();
            await release.promise;
          }
        });
      },
    ]);
    try {
      harness.setResponses([
        fauxAssistantMessage(fauxToolCall("request_user_input_async", question), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Still working"),
        fauxAssistantMessage("Adjusted to Blue"),
      ]);
      const running = harness.prompt("Ask and continue");
      await held.promise;
      expect(harness.session.isStreaming).toBe(true);
      await harness.prompt("/answers");
      expect(harness.session.isStreaming).toBe(true);
      release.resolve();
      await running;
      expect(harness.getPendingResponseCount()).toBe(0);
      expect(harness.messages()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining("Choose a color -> Blue") }),
            ]),
          }),
        ]),
      );
    } finally {
      release.resolve();
      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      harness.cleanup();
    }
  });
});
