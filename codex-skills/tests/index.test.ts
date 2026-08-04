import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionContext,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

const mentions = vi.hoisted(() => ({
  inject: vi.fn<
    (
      event: BeforeAgentStartEvent,
      ctx: ExtensionContext
    ) => Promise<BeforeAgentStartEventResult>
  >(async () => await Promise.resolve({})),
  install: vi.fn<(ctx: ExtensionContext) => void>(),
  render: vi.fn<MessageRenderer>(),
}));

vi.mock(import("../mentions.js"), () => ({
  createSkillMentions: () => mentions,
}));

describe("codex-skills registration", () => {
  it("registers and delegates skill mention behavior", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    const event = {
      prompt: "Use $alpha",
      systemPrompt: "",
      systemPromptOptions: { cwd: process.cwd() },
      type: "before_agent_start",
    } satisfies BeforeAgentStartEvent;

    await host.emitSessionStart(ctx);
    await host.emit("before_agent_start", event, ctx);

    expect(host.getMessageRenderer("codex-skills")).toBe(mentions.render);
    expect(mentions.install).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(mentions.inject).toHaveBeenCalledExactlyOnceWith(event, ctx);
  });
});
