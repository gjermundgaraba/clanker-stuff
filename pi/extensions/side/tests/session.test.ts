import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createSideConversation,
  createSideSessionManager,
  SideSessionController,
  stableSnapshotMessages,
} from "../session.js";
import type { SideAgentSession, SideConversationContext } from "../session.js";

const createSession = (overrides: Partial<SideAgentSession> = {}): SideAgentSession => ({
  abort: async () => await Promise.resolve(),
  bindExtensions: async () => await Promise.resolve(),
  dispose: () => {},
  extensionRunner: { emit: async () => await Promise.resolve() },
  hasExtensionHandlers: () => false,
  isStreaming: false,
  prompt: async () => await Promise.resolve(),
  subscribe: () => () => {},
  ...overrides,
});

describe("side session", () => {
  it("returns to idle when a handled prompt emits no agent events", async () => {
    const prompt = vi.fn<(text: string) => Promise<void>>(async () => {});
    const controller = new SideSessionController(
      createSession({
        prompt,
      }),
    );

    expect(controller.submit("first command")).toBeTruthy();
    await vi.waitFor(() => {
      expect(controller.state.activity.kind).toBe("idle");
    });
    expect(controller.submit("second command")).toBeTruthy();
    await vi.waitFor(() => {
      expect(controller.state.activity.kind).toBe("idle");
    });

    expect(prompt.mock.calls).toStrictEqual([["first command"], ["second command"]]);
  });

  it("clears streaming activity when a prompt rejects after an update", async () => {
    const prompt = Promise.withResolvers<void>();
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const controller = new SideSessionController(
      createSession({
        prompt: () => prompt.promise,
        subscribe: (next: (event: AgentSessionEvent) => void) => {
          listener = next;
          return () => {};
        },
      }),
    );

    expect(controller.submit("stream")).toBeTruthy();
    const partial = fauxAssistantMessage("partial");
    listener?.({
      assistantMessageEvent: { partial, type: "start" },
      message: partial,
      type: "message_update",
    });
    expect(controller.state.activity.kind).toBe("streaming");

    prompt.reject(new Error("stream failed"));
    await vi.waitFor(() => {
      expect(controller.state.activity.kind).toBe("idle");
    });
    expect(controller.state.transcript.at(-1)).toStrictEqual({
      kind: "error",
      text: "stream failed",
    });
  });

  it("binds child extensions without access to the main UI", async () => {
    const binding = Promise.withResolvers<void>();
    const bindExtensions = vi.fn<() => Promise<void>>(() => binding.promise);
    const session = createSession({ bindExtensions });
    const createAgentSession = vi.fn(async () => ({ session }));
    const ctx: SideConversationContext = {
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      model: undefined,
      sessionManager: SessionManager.inMemory(),
    };
    const conversation = createSideConversation(ctx, "off", createAgentSession);
    let returned = false;
    void conversation.then(() => {
      returned = true;
    });
    await vi.waitFor(() => {
      expect(createAgentSession).toHaveBeenCalledOnce();
      expect(bindExtensions).toHaveBeenCalledWith({
        mode: "print",
      });
    });
    expect(returned).toBeFalsy();

    binding.resolve();
    await expect(conversation).resolves.toBeInstanceOf(SideSessionController);
  });

  it("emits session_shutdown to child extensions before disposal", async () => {
    const order: string[] = [];
    const emit = vi.fn<() => Promise<void>>(async () => {
      order.push("emit");
      await Promise.resolve();
    });
    const session = createSession({
      dispose: vi.fn<() => void>(() => {
        order.push("dispose");
      }),
      extensionRunner: {
        emit,
      },
      hasExtensionHandlers: () => true,
    });

    const controller = new SideSessionController(session);
    await controller.dispose();

    expect(emit).toHaveBeenCalledWith({
      reason: "quit",
      type: "session_shutdown",
    });
    expect(order).toStrictEqual(["emit", "dispose"]);
  });

  it("removes an incomplete parent tool turn from the snapshot", () => {
    const parent = SessionManager.inMemory();
    parent.appendMessage({
      content: "Inspect the file",
      role: "user",
      timestamp: Date.now(),
    });
    parent.appendMessage(
      fauxAssistantMessage(
        [{ text: "Reading it", type: "text" }, fauxToolCall("read", {}, { id: "call-1" })],
        { stopReason: "toolUse" },
      ),
    );

    const snapshot = stableSnapshotMessages(parent.buildSessionContext().messages);

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.role).toBe("user");
  });

  it("seeds an isolated child with stable parent context and a boundary", () => {
    const parent = SessionManager.inMemory("/tmp/parent");
    parent.appendMessage({
      content: "Parent question",
      role: "user",
      timestamp: Date.now(),
    });
    parent.appendMessage(fauxAssistantMessage("Parent answer"));

    const child = createSideSessionManager(parent, "/tmp/parent");
    const { messages } = child.buildSessionContext();
    const boundary = messages.at(-1);

    expect(child.isPersisted()).toBeFalsy();
    expect(messages).toHaveLength(3);
    expect(boundary).toMatchObject({
      role: "user",
    });
    expect(boundary?.role === "user" && boundary.content).toContain("Side conversation boundary");
  });
});
