import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createCustomUiDriver, createKeybindings } from "../../../tests/harness/tui.js";
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

const createOverlayUi = () =>
  createCustomUiDriver({
    keybindings: createKeybindings({ "app.interrupt": ["\u001B"] }),
    waitForDone: true,
  });

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
    expect(overlay.handle.isHidden()).toBeTruthy();
    expect(overlay.handle.isFocused()).toBeFalsy();
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

  it("shows static activity in the panel and hidden status", async () => {
    const { ctx, host, overlay } = await openRunningSide();
    const panel = overlay.component;
    expect(panel).toBeInstanceOf(SidePanel);
    if (!(panel instanceof SidePanel)) {
      throw new Error("Expected the side overlay to contain a SidePanel");
    }
    expect(panel.render(80).join("\n")).toContain("Side ● working");

    panel.handleInput("\u001B");
    expect(host.getStatus("side")).toBe("SIDE ● working");
    expect(overlay.handle.isHidden()).toBeTruthy();
    expect(overlay.handle.isFocused()).toBeFalsy();
    expect(panel.render(80).join("\n")).toContain("Side ● working");

    await host.runShortcut("ctrl+/", ctx);
    expect(overlay.handle.isHidden()).toBeFalsy();
    expect(overlay.handle.isFocused()).toBeTruthy();

    await host.emitSessionShutdown(ctx);
    expect(host.getStatus("side")).toBeUndefined();
    expect(overlay.handle.isHidden()).toBeTruthy();
  });
});
