import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import sideExtension from "../index.js";
import { createSideConversation } from "../session.js";
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

const fakeConversation = (
  dispose: () => Promise<unknown> = () => Promise.resolve()
) =>
  ({
    dispose: vi.fn<() => Promise<unknown>>(dispose),
    latestAssistantText: vi.fn<() => string | undefined>(),
    state: { activity: { kind: "idle" }, transcript: [] },
    submit: () => true,
    subscribe: () => () => {},
  }) as unknown as SideSessionController;

// Pending overlay stand-in for pi's ui.custom: runs the factory, exposes the
// handle, and resolves only when the extension calls done().
const createOverlayUi = () => {
  let component: unknown;
  const handle = {
    focus: vi.fn<() => void>(),
    hide: vi.fn<() => void>(),
    isFocused: () => true,
    isHidden: () => false,
    setHidden: vi.fn<(hidden: boolean) => void>(),
    unfocus: vi.fn<() => void>(),
  };
  type CustomFactory = (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    done: (result: null) => void
  ) => unknown;
  interface CustomOptions {
    onHandle?: (handle: unknown) => void;
  }
  const custom = vi.fn<
    (factory: CustomFactory, options?: CustomOptions) => Promise<null>
  >((factory, options) => {
    const { promise, resolve } = Promise.withResolvers<null>();
    component = factory(
      createMockTui(),
      createIdentityTheme(),
      createKeybindings({ "app.interrupt": ["\u001B"] }),
      resolve
    );
    options?.onHandle?.(handle);
    return promise;
  }) as unknown as ExtensionContext["ui"]["custom"];
  return {
    get component() {
      return component;
    },
    custom,
    handle,
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
    model: {} as never,
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

  it("tears down on session shutdown", async () => {
    const conversation = fakeConversation();
    vi.mocked(createSideConversation).mockResolvedValue(conversation);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const { custom, handle } = createOverlayUi();
    const ctx = host.createContext({ model: {} as never, ui: { custom } });

    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(custom).toHaveBeenCalledOnce();
    });

    await host.emitSessionShutdown(ctx);

    expect(conversation.dispose).toHaveBeenCalledWith();
    expect(handle.hide).toHaveBeenCalledWith();
    expect(host.getStatus("side")).toBeUndefined();
  });

  it("opens a fresh side while the previous teardown is still disposing", async () => {
    const disposeGate = Promise.withResolvers<null>();
    const conversation = fakeConversation(() => disposeGate.promise);
    vi.mocked(createSideConversation).mockResolvedValueOnce(conversation);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const { custom } = createOverlayUi();
    const ctx = host.createContext({ model: {} as never, ui: { custom } });

    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(custom).toHaveBeenCalledOnce();
    });

    const closing = host.emitSessionTree(ctx);
    const { promise: pendingSecond } =
      Promise.withResolvers<SideSessionController>();
    vi.mocked(createSideConversation).mockReturnValueOnce(pendingSecond);
    await host.runCommand("side", "", ctx);

    expect(createSideConversation).toHaveBeenCalledTimes(2);
    expect(host.getNotifications()).toContainEqual({
      message: "Closed side because the main branch changed.",
      type: "info",
    });

    disposeGate.resolve(null);
    await closing;
  });

  it("clears the opening indicator when the tree changes while opening", async () => {
    const opening = Promise.withResolvers<SideSessionController>();
    vi.mocked(createSideConversation).mockReturnValueOnce(opening.promise);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const ctx = host.createContext({ model: {} as never });

    await host.runCommand("side", "", ctx);
    expect(host.getStatus("side")).toContain("opening");

    await host.emitSessionTree(ctx);
    const conversation = fakeConversation();
    opening.resolve(conversation);

    await vi.waitFor(() => {
      expect(conversation.dispose).toHaveBeenCalledWith();
    });
    expect(host.getStatus("side")).toBeUndefined();
  });

  it("lets a replacement opening own status after a tree change", async () => {
    const firstOpening = Promise.withResolvers<SideSessionController>();
    vi.mocked(createSideConversation).mockReturnValueOnce(firstOpening.promise);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const overlay = createOverlayUi();
    const ctx = host.createContext({
      model: {} as never,
      ui: { custom: overlay.custom },
    });

    await host.runCommand("side", "", ctx);
    await host.emitSessionTree(ctx);

    const replacement = fakeConversation();
    vi.mocked(createSideConversation).mockResolvedValueOnce(replacement);
    await host.runCommand("side", "", ctx);
    await vi.waitFor(() => {
      expect(overlay.custom).toHaveBeenCalledOnce();
    });

    const obsolete = fakeConversation();
    firstOpening.resolve(obsolete);
    await vi.waitFor(() => {
      expect(obsolete.dispose).toHaveBeenCalledOnce();
    });

    expect(createSideConversation).toHaveBeenCalledTimes(2);
    expect(replacement.dispose).not.toHaveBeenCalled();
    expect(host.getStatus("side")).toContain("active");

    await host.emitSessionShutdown(ctx);
  });

  it("stops and disposes an opening conversation during shutdown", async () => {
    const opening = Promise.withResolvers<SideSessionController>();
    vi.mocked(createSideConversation).mockReturnValueOnce(opening.promise);
    const host = createExtensionHost(sideExtension);
    await host.ready;
    const ctx = host.createContext({ model: {} as never });

    await host.runCommand("side", "", ctx);
    expect(host.getStatus("side")).toContain("opening");

    await host.emitSessionShutdown(ctx);
    expect(host.getStatus("side")).toBeUndefined();

    const obsolete = fakeConversation();
    opening.resolve(obsolete);
    await vi.waitFor(() => {
      expect(obsolete.dispose).toHaveBeenCalledOnce();
    });
    await host.runCommand("side", "", ctx);
    expect(createSideConversation).toHaveBeenCalledOnce();
  });

  it("shows static activity in the panel and hidden status", async () => {
    const { ctx, host, overlay } = await openRunningSide();
    const panel = overlay.component as {
      handleInput: (data: string) => void;
      render: (width: number) => string[];
    };
    expect(panel.render(80).join("\n")).toContain("Side ● working");

    panel.handleInput("\u001B");
    expect(host.getStatus("side")).toBe("SIDE ● working");
    expect(panel.render(80).join("\n")).toContain("Side ● working");

    await host.emitSessionShutdown(ctx);
    expect(host.getStatus("side")).toBeUndefined();
  });
});
