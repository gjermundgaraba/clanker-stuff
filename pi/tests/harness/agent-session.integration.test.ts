import { existsSync } from "node:fs";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentSessionHarness } from "./agent-session.js";
import type { AgentSessionHarness } from "./agent-session.js";

describe("agent-session harness", () => {
  let harness: AgentSessionHarness | undefined;

  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  it("loads extensions into a real AgentSession and uses faux responses deterministically", async () => {
    harness = await createAgentSessionHarness({
      extensionFactories: [
        (pi: ExtensionAPI) => {
          pi.on("input", (event) => ({
            action: "transform",
            text: `[ext] ${event.text}`,
          }));
        },
      ],
    });

    harness.setResponses([
      (context) => {
        const lastUserMessage = context.messages.findLast(
          (message) => message.role === "user"
        );
        return fauxAssistantMessage(
          typeof lastUserMessage?.content === "string"
            ? `seen:${lastUserMessage.content}`
            : "seen:[non-string]"
        );
      },
    ]);

    await harness.prompt("hello world");

    const assistant = harness
      .messages()
      .findLast((message) => message.role === "assistant");
    const user = harness
      .messages()
      .findLast((message) => message.role === "user");
    expect(assistant?.role).toBe("assistant");
    expect(JSON.stringify(user)).toContain("[ext] hello world");
    expect(harness.getPendingResponseCount()).toBe(0);
  });

  it("applies context-like before_provider_request payload changes to the wrapped faux provider context", async () => {
    harness = await createAgentSessionHarness({
      extensionFactories: [
        (pi: ExtensionAPI) => {
          pi.on("before_provider_request", (event) => {
            if (!event.payload || typeof event.payload !== "object") {
              return;
            }

            const payload = event.payload as Record<string, unknown>;
            const messages = Array.isArray(payload.messages)
              ? [...payload.messages]
              : [];
            let lastUserMessageIndex = -1;

            for (let i = messages.length - 1; i >= 0; i -= 1) {
              const message = messages[i];
              if (
                !!message &&
                typeof message === "object" &&
                "role" in message &&
                (message as { role?: unknown }).role === "user"
              ) {
                lastUserMessageIndex = i;
                break;
              }
            }

            if (lastUserMessageIndex < 0) {
              return payload;
            }

            const lastUserMessage = messages[lastUserMessageIndex] as Record<
              string,
              unknown
            >;
            messages[lastUserMessageIndex] = {
              ...lastUserMessage,
              content: "[wrapped] question",
            };

            return {
              ...payload,
              messages,
            };
          });
        },
      ],
    });
    harness.setResponses([
      (context) => {
        const lastUserMessage = context.messages.findLast(
          (message) => message.role === "user"
        );
        return fauxAssistantMessage(
          typeof lastUserMessage?.content === "string"
            ? `seen:${lastUserMessage.content}`
            : "seen:[non-string]"
        );
      },
    ]);

    await harness.prompt("question");

    const assistant = harness
      .messages()
      .findLast((message) => message.role === "assistant");
    expect(JSON.stringify(assistant)).toContain("seen:[wrapped] question");
  });

  it("preserves non-context before_provider_request payload fields for assertions", async () => {
    harness = await createAgentSessionHarness({
      extensionFactories: [
        (pi: ExtensionAPI) => {
          pi.on("before_provider_request", (event) => {
            const payload =
              event.payload && typeof event.payload === "object"
                ? (event.payload as Record<string, unknown>)
                : {};

            return {
              ...payload,
              headers: { "x-test": "1" },
              metadata: { harness: true },
              temperature: 0,
            };
          });
        },
      ],
    });
    harness.setResponses([fauxAssistantMessage("reply")]);

    await harness.prompt("question");

    const payload = harness.lastProviderPayload() as Record<string, unknown>;
    expect(payload.temperature).toBe(0);
    expect(payload.headers).toStrictEqual({ "x-test": "1" });
    expect(payload.metadata).toStrictEqual({ harness: true });
  });

  it("uses an isolated agentDir under the harness temp dir", async () => {
    harness = await createAgentSessionHarness();
    harness.setResponses([fauxAssistantMessage("reply")]);

    expect(harness.agentDir).toBe(path.join(harness.tempDir, "agent"));
    expect(existsSync(harness.agentDir)).toBeTruthy();

    await harness.prompt("question");

    const assistant = harness
      .messages()
      .findLast((message) => message.role === "assistant");
    expect(JSON.stringify(assistant)).toContain("reply");
  });

  it("captures session events and preserves prompt/message flow", async () => {
    harness = await createAgentSessionHarness();
    harness.setResponses([fauxAssistantMessage("reply")]);

    await harness.prompt("question");

    expect(harness.eventsOfType("agent_start")).toHaveLength(1);
    expect(harness.eventsOfType("agent_end")).toHaveLength(1);
    expect(harness.messages().map((message) => message.role)).toContain("user");
    expect(harness.messages().map((message) => message.role)).toContain(
      "assistant"
    );
  });

  it("throws on concurrent active harnesses", async () => {
    harness = await createAgentSessionHarness();

    await expect(createAgentSessionHarness()).rejects.toThrow(
      "Concurrent use of the wrapped faux provider is unsupported"
    );
  });

  it("allows a new harness after cleanup", async () => {
    harness = await createAgentSessionHarness();
    harness.cleanup();
    harness = await createAgentSessionHarness();
    harness.setResponses([fauxAssistantMessage("reply")]);

    await harness.prompt("question");

    expect(harness.messages().map((message) => message.role)).toContain(
      "assistant"
    );
  });

  it("cleans up temp resources", async () => {
    harness = await createAgentSessionHarness();
    const { tempDir, agentDir } = harness;

    expect(existsSync(tempDir)).toBeTruthy();
    expect(existsSync(agentDir)).toBeTruthy();
    harness.cleanup();

    expect(existsSync(tempDir)).toBeFalsy();
    expect(existsSync(agentDir)).toBeFalsy();
  });
});
