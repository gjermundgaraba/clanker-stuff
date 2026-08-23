import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  createSideConversation,
  createSideSessionManager,
  SideSessionController,
  stableSnapshotMessages,
} from "../session.js";

vi.mock(import("@earendil-works/pi-coding-agent"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAgentSession: vi.fn<typeof actual.createAgentSession>(),
  };
});

describe("side session", () => {
  it("returns to idle when a handled prompt emits no agent events", async () => {
    const prompt = vi.fn<(text: string) => Promise<void>>(async () => {});
    const controller = new SideSessionController({
      isStreaming: false,
      prompt,
      subscribe: () => () => {},
    } as unknown as AgentSession);

    expect(controller.submit("first command")).toBeTruthy();
    await vi.waitFor(() => {
      expect(controller.state.activity.kind).toBe("idle");
    });
    expect(controller.submit("second command")).toBeTruthy();
    await vi.waitFor(() => {
      expect(controller.state.activity.kind).toBe("idle");
    });

    expect(prompt.mock.calls).toStrictEqual([
      ["first command"],
      ["second command"],
    ]);
  });

  it("clears streaming activity when a prompt rejects after an update", async () => {
    const prompt = Promise.withResolvers<null>();
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const controller = new SideSessionController({
      isStreaming: false,
      prompt: () => prompt.promise,
      subscribe: (next: (event: AgentSessionEvent) => void) => {
        listener = next;
        return () => {};
      },
    } as unknown as AgentSession);

    expect(controller.submit("stream")).toBeTruthy();
    listener?.({
      assistantMessageEvent: {} as never,
      message: fauxAssistantMessage("partial"),
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
    const binding = Promise.withResolvers<null>();
    const bindExtensions = vi.fn<() => Promise<null>>(() => binding.promise);
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      session: {
        bindExtensions,
        isStreaming: false,
        subscribe: () => () => {},
      },
    } as never);
    const ctx = {
      cwd: process.cwd(),
      isProjectTrusted: () => true,
      mode: "tui",
      model: {} as never,
      sessionManager: SessionManager.inMemory(),
      ui: {} as never,
    } as unknown as ExtensionContext;

    const conversation = createSideConversation(ctx, "off");
    let returned = false;
    void conversation.then(() => {
      returned = true;
    });
    await vi.waitFor(() => {
      expect(bindExtensions).toHaveBeenCalledWith({
        mode: "print",
      });
    });
    expect(returned).toBeFalsy();

    binding.resolve(null);
    await expect(conversation).resolves.toBeInstanceOf(SideSessionController);
  });

  it("emits session_shutdown to child extensions before disposal", async () => {
    const order: string[] = [];
    const session = {
      dispose: vi.fn<() => void>(() => {
        order.push("dispose");
      }),
      extensionRunner: {
        emit: vi.fn<() => Promise<void>>(async () => {
          order.push("emit");
          await Promise.resolve();
        }),
      },
      hasExtensionHandlers: () => true,
      isStreaming: false,
      subscribe: () => () => {},
    } as unknown as AgentSession;

    const controller = new SideSessionController(session);
    await controller.dispose();

    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
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
        [
          { text: "Reading it", type: "text" },
          fauxToolCall("read", {}, { id: "call-1" }),
        ],
        { stopReason: "toolUse" }
      )
    );

    const snapshot = stableSnapshotMessages(
      parent.buildSessionContext().messages
    );

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
    expect(boundary?.role === "user" && boundary.content).toContain(
      "Side conversation boundary"
    );
  });
});
