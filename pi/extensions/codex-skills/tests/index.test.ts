import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

const mentions = vi.hoisted(() => ({
  inject: vi.fn<
    (
      event: BeforeAgentStartEvent,
      ctx: ExtensionContext
    ) => Promise<BeforeAgentStartEventResult>
  >(async () => await Promise.resolve({})),
  injectStreaming: vi.fn<
    (
      event: InputEvent,
      ctx: ExtensionContext
    ) => Promise<InputEventResult | undefined>
  >(async () => {
    await Promise.resolve();
  }),
  install: vi.fn<(ctx: ExtensionContext) => void>(),
  render: vi.fn<MessageRenderer>(),
}));
const discoverOrchestrateSkill = vi.hoisted(() =>
  vi.fn<
    (
      pi: ExtensionAPI,
      ctx: ExtensionContext
    ) => { skillPaths: string[] } | undefined
  >(() => ({
    skillPaths: ["/tmp/orchestrate/SKILL.md"],
  }))
);

vi.mock(import("../mentions.js"), () => ({
  createSkillMentions: () => mentions,
}));
vi.mock(import("../orchestrate.js"), () => ({
  discoverOrchestrateSkill,
}));

describe("codex-skills registration", () => {
  it("registers and delegates skill behavior", async () => {
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
    const input = {
      source: "interactive",
      streamingBehavior: "steer",
      text: "Use $alpha",
      type: "input",
    } satisfies InputEvent;
    await host.emit("input", input, ctx);
    await host.emit(
      "resources_discover",
      {
        cwd: process.cwd(),
        reason: "startup",
        type: "resources_discover",
      },
      ctx
    );

    expect(host.getMessageRenderer("codex-skills")).toBe(mentions.render);
    expect(mentions.install).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(mentions.inject).toHaveBeenCalledExactlyOnceWith(event, ctx);
    expect(mentions.injectStreaming).toHaveBeenCalledExactlyOnceWith(
      input,
      ctx
    );
    expect({
      calls: discoverOrchestrateSkill.mock.calls.length,
      context: discoverOrchestrateSkill.mock.calls[0]?.[1],
    }).toStrictEqual({ calls: 1, context: ctx });
  });
});
