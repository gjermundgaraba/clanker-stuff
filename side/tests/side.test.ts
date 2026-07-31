import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../tests/harness/tui.js";
import sideExtension from "../index.js";
import { SidePanel } from "../panel.js";
import {
  createSideConversation,
  createSideSessionManager,
  stableSnapshotMessages,
} from "../session.js";
import type { SideSessionController } from "../session.js";

vi.mock(import("../session.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createSideConversation: vi.fn<typeof actual.createSideConversation>(
      actual.createSideConversation
    ),
  };
});

describe("side extension", () => {
  it("registers only /side and the focus shortcut", async () => {
    const host = createExtensionHost(sideExtension);
    await host.ready;

    expect([...host.getRegisteredCommands().keys()]).toStrictEqual(["side"]);
    await host.runShortcut("ctrl+/", host.createContext({ mode: "rpc" }));
    expect(host.getNotifications()).toStrictEqual([
      {
        message: "/side requires interactive TUI mode.",
        type: "warning",
      },
    ]);
  });

  it("returns from /side while the child session opens in the background", async () => {
    const { promise: pending } = Promise.withResolvers<SideSessionController>();
    vi.mocked(createSideConversation).mockReturnValueOnce(pending);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const ctx = host.createContext({ model: {} as never });

    await expect(host.runCommand("side", "", ctx)).resolves.toBeUndefined();
    await host.runCommand("side", "second prompt", ctx);

    expect(createSideConversation).toHaveBeenCalledOnce();
    expect(host.getNotifications()).toContainEqual({
      message: "Side is still opening. Use its editor once ready.",
      type: "info",
    });
  });

  it("preserves the editor draft when the side is already running", () => {
    const submit = vi.fn<(text: string) => boolean>(() => false);
    const panel = new SidePanel(
      createMockTui(),
      createIdentityTheme(),
      createKeybindings() as unknown as KeybindingsManager,
      {
        state: { isRunning: true, transcript: [] },
        submit,
        subscribe: () => vi.fn<() => void>(),
      } as unknown as SideSessionController,
      {
        getMainWorking: () => false,
        onClose: vi.fn<() => void>(),
        onFocus: vi.fn<() => void>(),
        onHide: vi.fn<() => void>(),
        onInsertLatest: vi.fn<() => void>(),
        onToggleFocus: vi.fn<() => void>(),
      }
    );

    for (const character of "draft") {
      panel.handleInput(character);
    }
    panel.handleInput("\r");

    expect(submit).toHaveBeenCalledWith("draft");
    expect(panel.render(80).join("\n")).toContain("draft");
    panel.dispose();
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
