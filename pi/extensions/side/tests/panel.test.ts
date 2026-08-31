import { describe, expect, it, vi } from "vite-plus/test";
import { TuiAltScreen } from "@earendil-works/pi-tui";

import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { SidePanel } from "../panel.js";

describe("side panel", () => {
  it("preserves the editor draft when the side is already running", () => {
    const submit = vi.fn<(text: string) => boolean>(() => false);
    const panel = new SidePanel(
      createMockTui(),
      createIdentityTheme(),
      createKeybindings(),
      {
        state: { activity: { kind: "running" }, transcript: [] },
        submit,
        subscribe: () => vi.fn<() => void>(),
      },
      {
        getMainWorking: () => false,
        getWorkingMarker: () => "●",
        onClose: vi.fn<() => void>(),
        onDismiss: vi.fn<() => void>(),
        onInsertLatest: vi.fn<() => void>(),
      },
    );

    for (const character of "draft") {
      panel.handleInput(character);
    }
    panel.handleInput("\r");

    expect(submit).toHaveBeenCalledWith("draft");
    expect(panel.render(80).join("\n")).toContain("draft");
    panel.dispose();
  });

  it("copies an active manual fullscreen selection", () => {
    const copyActiveSelectionToClipboard = vi.fn<() => Promise<boolean>>(async () => true);
    const tui = Object.assign(createMockTui(), {
      copyActiveSelectionToClipboard,
      getCopyOnSelect: () => false,
      hasActiveSelection: () => true,
    });
    Object.setPrototypeOf(tui, TuiAltScreen.prototype);
    const panel = new SidePanel(
      tui,
      createIdentityTheme(),
      createKeybindings({ "app.message.copy": ["\u0018"] }),
      {
        state: { activity: { kind: "idle" }, transcript: [] },
        submit: () => true,
        subscribe: () => vi.fn<() => void>(),
      },
      {
        getMainWorking: () => false,
        getWorkingMarker: () => "●",
        onClose: vi.fn<() => void>(),
        onDismiss: vi.fn<() => void>(),
        onInsertLatest: vi.fn<() => void>(),
      },
    );

    panel.handleInput("\u0018");

    expect(copyActiveSelectionToClipboard).toHaveBeenCalledOnce();
    panel.dispose();
  });

  it("restores prompt history from the conversation transcript", () => {
    const panel = new SidePanel(
      createMockTui(),
      createIdentityTheme(),
      createKeybindings(),
      {
        state: {
          activity: { kind: "idle" },
          transcript: [
            { kind: "user", text: "first prompt" },
            { kind: "user", text: "latest prompt" },
          ],
        },
        submit: () => true,
        subscribe: () => vi.fn<() => void>(),
      },
      {
        getMainWorking: () => false,
        getWorkingMarker: () => "●",
        onClose: vi.fn<() => void>(),
        onDismiss: vi.fn<() => void>(),
        onInsertLatest: vi.fn<() => void>(),
      },
    );

    panel.handleInput("\u001B[A");

    expect(panel.getDraft()).toBe("latest prompt");
    panel.dispose();
  });

  it("preserves expanded pasted content and drafts while submitting an external prompt", () => {
    const submit = vi
      .fn<(text: string) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const panel = new SidePanel(
      createMockTui(),
      createIdentityTheme(),
      createKeybindings(),
      {
        state: { activity: { kind: "idle" }, transcript: [] },
        submit,
        subscribe: () => vi.fn<() => void>(),
      },
      {
        getMainWorking: () => false,
        getWorkingMarker: () => "●",
        onClose: vi.fn<() => void>(),
        onDismiss: vi.fn<() => void>(),
        onInsertLatest: vi.fn<() => void>(),
      },
      "existing draft\n",
    );
    const paste = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    panel.handleInput(`\u001B[200~${paste}\u001B[201~`);
    panel.submitExternalPrompt("external prompt");

    expect(submit).toHaveBeenCalledWith("external prompt");
    expect(panel.getDraft()).toBe(`existing draft\n${paste}`);
    panel.submitExternalPrompt("queued prompt");
    expect(panel.getDraft()).toBe(`existing draft\n${paste}\nqueued prompt`);
    panel.dispose();
  });

  it("uses remapped interrupt and exit bindings for behavior and hints", () => {
    const keybindings = createKeybindings({
      "app.exit": ["ctrl+q"],
      "app.interrupt": ["ctrl+x"],
    });
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const panel = new SidePanel(
      createMockTui(),
      createIdentityTheme(),
      keybindings,
      {
        state: { activity: { kind: "idle" }, transcript: [] },
        submit: () => true,
        subscribe: () => vi.fn<() => void>(),
      },
      {
        getMainWorking: () => false,
        getWorkingMarker: () => "●",
        onClose,
        onDismiss,
        onInsertLatest: vi.fn<() => void>(),
      },
    );

    expect(panel.render(80).join("\n")).toContain(
      "Ctrl+/ or Ctrl+X dismiss · Ctrl+Q close · Alt+Enter insert · PgUp/PgDn scroll",
    );
    panel.handleInput("ctrl+x");
    panel.handleInput("ctrl+q");

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    panel.dispose();
  });
});
