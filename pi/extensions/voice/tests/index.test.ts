import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionContext,
  MessageStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

const controller = vi.hoisted(() => ({
  beforeAgentStart: vi.fn<
    (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult
  >(() => ({})),
  endActiveCall: vi.fn<() => boolean>(() => true),
  finish: vi.fn<(spokenSummary: string) => boolean>(() => true),
  messageStart: vi.fn<(event: MessageStartEvent) => void>(),
  runCommand: vi.fn<(args: string, ctx: ExtensionContext) => Promise<void>>(),
  sendStatus: vi.fn<(message: string) => boolean>(() => true),
  sessionBeforeTree: vi.fn<(oldLeafId: string | null) => void>(),
  sessionStart: vi.fn<(ctx: ExtensionContext) => void>(),
  sessionTree: vi.fn<(ctx: ExtensionContext) => void>(),
  settled: vi.fn<() => void>(),
  shutdown: vi.fn<() => void>(),
  toggle: vi.fn<(ctx: ExtensionContext) => Promise<void>>(),
  turnEnd: vi.fn<(event: TurnEndEvent) => void>(),
}));
const createController = vi.hoisted(() => vi.fn<() => void>());

vi.mock(import("../controller.js"), () => ({
  createVoiceController: () => {
    createController();
    return controller;
  },
}));

describe("voice registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the command, shortcut, and tools, and delegates to the controller", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    const turnEndEvent = { message: { role: "assistant" }, type: "turn_end" };
    const messageStartEvent = {
      message: { role: "user" },
      type: "message_start",
    };

    expect(host.getRegisteredTools().has("speak_to_user")).toBeFalsy();

    await host.runCommand("voice", "status", ctx);
    await host.runShortcut("ctrl+shift+v", ctx);
    await host.emitSessionStart(ctx);
    await host.emit(
      "session_before_tree",
      { preparation: { oldLeafId: null }, type: "session_before_tree" },
      ctx
    );
    await host.emitSessionTree(ctx);
    await host.emit(
      "before_agent_start",
      { systemPrompt: "base", type: "before_agent_start" },
      ctx
    );
    await host.emit("turn_end", turnEndEvent, ctx);
    await host.emit("agent_settled", { type: "agent_settled" }, ctx);
    await host.emit("message_start", messageStartEvent, ctx);
    await host.runTool("speak_to_user", { message: "Progress update." });
    await host.runTool("present_voice_result", {
      markdown: "# Result",
      spokenSummary: "The result is ready.",
    });
    await host.runTool("end_realtime_voice_call", {});
    await host.emitSessionShutdown(ctx);

    expect(host.getRegisteredCommands().get("voice")).toMatchObject({
      description: "Start, stop, or inspect realtime voice",
    });
    expect(
      host.getRegisteredTools().get("end_realtime_voice_call")?.definition
        .description
    ).toContain("clearly signs off");
    expect({
      beforeAgentStart: controller.beforeAgentStart.mock.calls.length,
      endActiveCall: controller.endActiveCall.mock.calls.length,
      finish: controller.finish.mock.calls,
      messageStart: controller.messageStart.mock.calls.length,
      runCommand: controller.runCommand.mock.calls,
      sendStatus: controller.sendStatus.mock.calls,
      sessionBeforeTree: controller.sessionBeforeTree.mock.calls,
      sessionStart: controller.sessionStart.mock.calls,
      sessionTree: controller.sessionTree.mock.calls,
      settled: controller.settled.mock.calls.length,
      shutdown: controller.shutdown.mock.calls.length,
      toggle: controller.toggle.mock.calls,
      turnEnd: controller.turnEnd.mock.calls.length,
    }).toStrictEqual({
      beforeAgentStart: 1,
      endActiveCall: 1,
      finish: [["The result is ready."]],
      messageStart: 1,
      runCommand: [["status", ctx]],
      sendStatus: [["Progress update."]],
      sessionBeforeTree: [[null]],
      sessionStart: [[ctx]],
      sessionTree: [[ctx]],
      settled: 1,
      shutdown: 1,
      toggle: [[ctx]],
      turnEnd: 1,
    });
  });

  it("does not finish loading after shutdown", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();
    await host.emitSessionStart(ctx);

    const toggle = host.runShortcut("ctrl+shift+v", ctx);
    await host.emitSessionShutdown(ctx);
    await toggle;

    expect(createController).not.toHaveBeenCalled();
  });
});
