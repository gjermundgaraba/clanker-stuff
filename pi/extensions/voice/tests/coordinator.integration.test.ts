import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentSessionHarness } from "../../../tests/harness/agent-session.js";
import type { AgentSessionHarness } from "../../../tests/harness/agent-session.js";
import { VoiceCoordinator } from "../coordinator.js";

const messageText = (message: {
  content: string | readonly unknown[];
}): string => {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .flatMap((part) =>
      part !== null &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : []
    )
    .join("\n")
    .trim();
};

describe("voice coordinator AgentSession routing", () => {
  let harness: AgentSessionHarness | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  it("keeps a finishing answer bound to its request before dispatching the next", async () => {
    const completions: { delegationId: string; text: string }[] = [];
    let coordinator: VoiceCoordinator | undefined;
    let injectedSecond = false;

    harness = await createAgentSessionHarness({
      extensionFactories: [
        (pi: ExtensionAPI) => {
          const nextCoordinator = new VoiceCoordinator({
            complete: (binding, text) => {
              completions.push({
                delegationId: binding.delegationId,
                text,
              });
              return true;
            },
            status: () => true,
            submit: (prompt) => {
              pi.sendUserMessage(prompt, { deliverAs: "steer" });
            },
            validate: async () => {
              await Promise.resolve();
            },
          });
          coordinator = nextCoordinator;

          pi.on("message_start", (event) => {
            if (event.message.role === "user") {
              nextCoordinator.accept(messageText(event.message));
            }
          });
          pi.on("turn_end", (event) => {
            if (event.message.role !== "assistant") {
              return;
            }
            if (!injectedSecond) {
              injectedSecond = true;
              nextCoordinator.enqueue({
                binding: { callId: "call-1", delegationId: "b" },
                prompt: "prompt-b",
              });
            }
            nextCoordinator.finish(messageText(event.message));
          });
          pi.on("agent_settled", () => {
            nextCoordinator.settled();
          });
        },
      ],
    });
    harness.setResponses([
      fauxAssistantMessage("answer-a"),
      fauxAssistantMessage("answer-b"),
    ]);

    coordinator?.enqueue({
      binding: { callId: "call-1", delegationId: "a" },
      prompt: "prompt-a",
    });
    await vi.waitFor(() => {
      expect(completions).toHaveLength(2);
    });

    expect(completions).toStrictEqual([
      { delegationId: "a", text: "answer-a" },
      { delegationId: "b", text: "answer-b" },
    ]);
  });
});
