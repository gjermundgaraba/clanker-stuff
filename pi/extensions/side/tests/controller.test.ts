import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createCustomUiDriver,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import sideExtension from "../index.js";
import { SidePanel } from "../panel.js";
import { createSideConversation } from "../session.js";
import type { SideConversation } from "../session.js";

vi.mock(import("../session.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createSideConversation: vi.fn<typeof actual.createSideConversation>(
      actual.createSideConversation,
    ),
  };
});

const MODEL = {
  api: "openai-responses",
  baseUrl: "https://example.com",
  contextWindow: 100_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "side-test",
  input: ["text"],
  maxTokens: 10_000,
  name: "side-test",
  provider: "test",
  reasoning: true,
} satisfies Model<"openai-responses">;

const fakeConversation = (
  dispose: () => Promise<void> = () => Promise.resolve(),
): SideConversation => ({
  dispose: vi.fn<() => Promise<void>>(dispose),
  latestAssistantText: vi.fn<() => string | undefined>(),
  state: { activity: { kind: "idle" }, transcript: [] },
  submit: () => true,
  subscribe: () => () => {},
});

const createOverlayUi = () => {
  const tui = createMockTui();
  const showOverlay = tui.showOverlay.bind(tui);
  let component: SidePanel | undefined;
  tui.showOverlay = (nextComponent, options) => {
    if (nextComponent instanceof SidePanel) {
      component = nextComponent;
    }
    return showOverlay(nextComponent, options);
  };
  const driver = createCustomUiDriver({
    tui,
    keybindings: createKeybindings({
      "app.exit": ["\u0004"],
      "app.interrupt": ["\u001B"],
    }),
  });
  const customCalls: Promise<unknown>[] = [];
  const custom: typeof driver.custom = (factory, options) => {
    const call = driver.custom(factory, options);
    customCalls.push(call);
    return call;
  };
  return {
    get component() {
      return component;
    },
    custom,
    customCalls,
    tui,
  };
};

const openRunningSide = async () => {
  vi.useFakeTimers();
  const conversation = fakeConversation();
  conversation.state.activity = { kind: "running" };
  vi.mocked(createSideConversation).mockResolvedValueOnce(conversation);
  const host = createExtensionHost(sideExtension);
  await host.ready;
  const overlay = createOverlayUi();
  const ctx = host.createContext({
    model: MODEL,
    ui: { custom: overlay.custom },
  });

  await host.runCommand("side", "", ctx);
  await vi.waitFor(() => {
    expect(overlay.component).toBeDefined();
  });
  return { ctx, host, overlay };
};

describe("side controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects /side outside interactive TUI mode", async () => {
    const host = createExtensionHost(sideExtension);
    await host.ready;

    await host.runShortcut("ctrl+/", host.createContext({ mode: "rpc" }));

    expect(host.getNotifications()).toStrictEqual([
      {
        message: "/side requires interactive TUI mode.",
        type: "warning",
      },
    ]);
  });

  it("returns from /side while the child session opens in the background", async () => {
    const { promise: pending } = Promise.withResolvers<SideConversation>();
    vi.mocked(createSideConversation).mockReturnValueOnce(pending);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const ctx = host.createContext({ model: MODEL });

    await expect(host.runCommand("side", "", ctx)).resolves.toBeUndefined();
    await host.runCommand("side", "second prompt", ctx);

    expect(createSideConversation).toHaveBeenCalledOnce();
    expect(host.getNotifications()).toContainEqual({
      message: "Side is still opening. Use its editor once ready.",
      type: "info",
    });
  });

  it("tears down on session shutdown", async () => {
    const conversation = fakeConversation();
    vi.mocked(createSideConversation).mockResolvedValue(conversation);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const overlay = createOverlayUi();
    const ctx = host.createContext({ model: MODEL, ui: { custom: overlay.custom } });

    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(overlay.component).toBeDefined();
    });

    await host.emitSessionShutdown(ctx);

    expect(vi.mocked(conversation).dispose.mock.calls).toStrictEqual([[]]);
    expect(host.getStatus("side")).toBeUndefined();
  });

  it("closes the conversation exactly once on Ctrl+D", async () => {
    const conversation = fakeConversation();
    vi.mocked(createSideConversation).mockResolvedValue(conversation);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const overlay = createOverlayUi();
    const ctx = host.createContext({ model: MODEL, ui: { custom: overlay.custom } });

    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(overlay.component).toBeInstanceOf(SidePanel);
    });
    overlay.component?.handleInput?.("\u0004");
    await vi.waitFor(() => {
      expect(vi.mocked(conversation).dispose.mock.calls).toHaveLength(1);
    });

    await host.emitSessionTree(ctx);
    await host.emitSessionShutdown(ctx);

    expect(vi.mocked(conversation).dispose.mock.calls).toHaveLength(1);
    expect(host.getStatus("side")).toBeUndefined();
  });

  it("reports a conversation teardown failure from Ctrl+D", async () => {
    const conversation = fakeConversation(() => Promise.reject(new Error("teardown failed")));
    vi.mocked(createSideConversation).mockResolvedValue(conversation);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const overlay = createOverlayUi();
    const ctx = host.createContext({ model: MODEL, ui: { custom: overlay.custom } });

    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(overlay.component).toBeInstanceOf(SidePanel);
    });
    overlay.component?.handleInput?.("\u0004");

    await vi.waitFor(() => {
      expect(host.getNotifications()).toContainEqual({
        message: "Side failed to close: teardown failed",
        type: "error",
      });
    });
    expect(host.getStatus("side")).toBeUndefined();
  });

  it("opens a fresh side while the previous teardown is still disposing", async () => {
    const disposeGate = Promise.withResolvers<void>();
    const conversation = fakeConversation(() => disposeGate.promise);
    vi.mocked(createSideConversation).mockResolvedValueOnce(conversation);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const overlay = createOverlayUi();
    const ctx = host.createContext({ model: MODEL, ui: { custom: overlay.custom } });

    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(overlay.component).toBeDefined();
    });

    const closing = host.emitSessionTree(ctx);
    const { promise: pendingSecond } = Promise.withResolvers<SideConversation>();
    vi.mocked(createSideConversation).mockReturnValueOnce(pendingSecond);
    await host.runCommand("side", "", ctx);

    expect(createSideConversation).toHaveBeenCalledTimes(2);
    expect(host.getNotifications()).toContainEqual({
      message: "Closed side because the main branch changed.",
      type: "info",
    });

    disposeGate.resolve();
    await closing;
  });

  it("clears the opening indicator when the tree changes while opening", async () => {
    const opening = Promise.withResolvers<SideConversation>();
    vi.mocked(createSideConversation).mockReturnValueOnce(opening.promise);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const ctx = host.createContext({ model: MODEL });

    await host.runCommand("side", "", ctx);
    expect(host.getStatus("side")).toContain("opening");

    await host.emitSessionTree(ctx);
    const conversation = fakeConversation();
    opening.resolve(conversation);

    await vi.waitFor(() => {
      expect(vi.mocked(conversation).dispose.mock.calls).toStrictEqual([[]]);
    });
    expect(host.getStatus("side")).toBeUndefined();
  });

  it("lets a replacement opening own status after a tree change", async () => {
    const firstOpening = Promise.withResolvers<SideConversation>();
    vi.mocked(createSideConversation).mockReturnValueOnce(firstOpening.promise);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const overlay = createOverlayUi();
    const ctx = host.createContext({
      model: MODEL,
      ui: { custom: overlay.custom },
    });

    await host.runCommand("side", "", ctx);
    await host.emitSessionTree(ctx);

    const replacement = fakeConversation();
    vi.mocked(createSideConversation).mockResolvedValueOnce(replacement);
    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(overlay.component).toBeDefined();
    });

    const obsolete = fakeConversation();
    firstOpening.resolve(obsolete);
    await vi.waitFor(() => {
      expect(vi.mocked(obsolete).dispose.mock.calls).toStrictEqual([[]]);
    });

    expect(createSideConversation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(replacement).dispose.mock.calls).toStrictEqual([]);
    expect(host.getStatus("side")).toContain("active");

    await host.emitSessionShutdown(ctx);
  });

  it("stops and disposes an opening conversation during shutdown", async () => {
    const opening = Promise.withResolvers<SideConversation>();
    vi.mocked(createSideConversation).mockReturnValueOnce(opening.promise);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const ctx = host.createContext({ model: MODEL });

    await host.runCommand("side", "", ctx);
    expect(host.getStatus("side")).toContain("opening");

    await host.emitSessionShutdown(ctx);
    expect(host.getStatus("side")).toBeUndefined();

    const obsolete = fakeConversation();
    opening.resolve(obsolete);
    await vi.waitFor(() => {
      expect(vi.mocked(obsolete).dispose.mock.calls).toStrictEqual([[]]);
    });
    await host.runCommand("side", "", ctx);
    expect(createSideConversation).toHaveBeenCalledOnce();
  });

  it("settles the custom prompt and recreates the panel without disposing the conversation", async () => {
    const unsubscribers: Array<ReturnType<typeof vi.fn<() => void>>> = [];
    const conversation = fakeConversation();
    conversation.subscribe = vi.fn(() => {
      const unsubscribe = vi.fn<() => void>();
      unsubscribers.push(unsubscribe);
      return unsubscribe;
    });
    vi.mocked(createSideConversation).mockResolvedValueOnce(conversation);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const overlay = createOverlayUi();
    const ctx = host.createContext({
      model: MODEL,
      ui: { custom: overlay.custom },
    });

    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(overlay.component).toBeInstanceOf(SidePanel);
    });
    const firstPanel = overlay.component;
    if (!(firstPanel instanceof SidePanel)) {
      throw new Error("Expected the side overlay to contain a SidePanel");
    }
    await expect(overlay.customCalls[0]).resolves.toBeNull();
    expect(overlay.tui.hasOverlay()).toBeTruthy();
    for (const character of "saved draft") {
      firstPanel.handleInput(character);
    }
    const foreignOverlay = overlay.tui.showOverlay({
      invalidate() {},
      render: () => ["foreign"],
    });
    firstPanel.handleInput("\u001B");

    await vi.waitFor(() => {
      expect(unsubscribers[1]).toHaveBeenCalledOnce();
    });
    expect(overlay.tui.hasOverlay()).toBeTruthy();
    foreignOverlay.hide();
    expect(overlay.tui.hasOverlay()).toBeFalsy();
    expect(host.getStatus("side")).toContain("background");
    expect(vi.mocked(conversation).dispose.mock.calls).toStrictEqual([]);

    await host.runShortcut("ctrl+/", ctx);
    await vi.waitFor(() => {
      expect(overlay.component).not.toBe(firstPanel);
    });
    const secondPanel = overlay.component;
    if (!(secondPanel instanceof SidePanel)) {
      throw new Error("Expected the reopened side overlay to contain a SidePanel");
    }

    expect(secondPanel.getDraft()).toBe("saved draft");
    expect(createSideConversation).toHaveBeenCalledOnce();
    expect(vi.mocked(conversation).dispose.mock.calls).toStrictEqual([]);

    await host.emitSessionShutdown(ctx);

    expect(vi.mocked(conversation).dispose.mock.calls).toHaveLength(1);
    expect(unsubscribers).toHaveLength(3);
    expect(unsubscribers.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBeTruthy();
    expect(host.getStatus("side")).toBeUndefined();
  });

  it("submits prompts to initial, mounted, and reopened presentations", async () => {
    const conversation = fakeConversation();
    const submit = vi.fn(() => true);
    conversation.submit = submit;
    vi.mocked(createSideConversation).mockResolvedValueOnce(conversation);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const overlay = createOverlayUi();
    const ctx = host.createContext({
      model: MODEL,
      ui: { custom: overlay.custom },
    });

    await host.runCommand("side", "initial", ctx);
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith("initial");
    });

    await host.runCommand("side", "mounted", ctx);
    expect(submit).toHaveBeenCalledWith("mounted");

    overlay.component?.handleInput?.("\u001B");
    await host.runCommand("side", "reopened", ctx);
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith("reopened");
    });
    expect(submit.mock.calls).toStrictEqual([["initial"], ["mounted"], ["reopened"]]);

    await host.emitSessionShutdown(ctx);
  });

  it("preserves unread status when reopening the panel fails", async () => {
    const listeners = new Set<() => void>();
    const conversation = fakeConversation();
    conversation.state.activity = { kind: "running" };
    conversation.subscribe = vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    });
    vi.mocked(createSideConversation).mockResolvedValueOnce(conversation);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const overlay = createOverlayUi();
    const ctx = host.createContext({
      model: MODEL,
      ui: { custom: overlay.custom },
    });

    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(overlay.component).toBeInstanceOf(SidePanel);
    });
    overlay.component?.handleInput?.("\u001B");
    conversation.state.activity = { kind: "idle" };
    for (const listener of listeners) {
      listener();
    }
    expect(host.getStatus("side")).toContain("done");

    ctx.ui.custom = async () => {
      throw new Error("mount failed");
    };
    await host.runShortcut("ctrl+/", ctx);
    await vi.waitFor(() => {
      expect(host.getNotifications()).toContainEqual({
        message: "Side failed: mount failed",
        type: "error",
      });
    });

    expect(host.getStatus("side")).toContain("done");
    await host.emitSessionShutdown(ctx);
  });

  it("inserts the latest response and dismisses only the presentation", async () => {
    const conversation = fakeConversation();
    conversation.latestAssistantText = vi.fn(() => "side answer");
    vi.mocked(createSideConversation).mockResolvedValueOnce(conversation);
    const pasteToEditor = vi.fn<(text: string) => void>();
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const overlay = createOverlayUi();
    const ctx = host.createContext({
      model: MODEL,
      ui: { custom: overlay.custom, pasteToEditor },
    });

    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(overlay.component).toBeInstanceOf(SidePanel);
    });
    overlay.component?.handleInput?.("\u001B[27;3;13~");
    await vi.waitFor(() => {
      expect(host.getStatus("side")).toContain("background");
    });

    expect(pasteToEditor.mock.calls).toStrictEqual([["side answer"]]);
    expect(vi.mocked(conversation).dispose.mock.calls).toStrictEqual([]);

    await host.emitSessionShutdown(ctx);
  });

  it("shows static activity while the panel is dismissed", async () => {
    const { ctx, host, overlay } = await openRunningSide();
    const panel = overlay.component;
    expect(panel).toBeInstanceOf(SidePanel);
    if (!(panel instanceof SidePanel)) {
      throw new Error("Expected the side overlay to contain a SidePanel");
    }
    expect(panel.render(80).join("\n")).toContain("Side ● working");

    panel.handleInput("\u001B");
    expect(host.getStatus("side")).toBe("SIDE ● working");
    expect(panel.render(80).join("\n")).toContain("Side ● working");

    await host.runShortcut("ctrl+/", ctx);
    await vi.waitFor(() => {
      expect(overlay.component).not.toBe(panel);
    });

    await host.emitSessionShutdown(ctx);
    expect(host.getStatus("side")).toBeUndefined();
  });
});
