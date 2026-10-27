import { Editor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createKeybindings,
  createMockTui,
  createStatusIndicator,
} from "../../../tests/harness/tui.js";
import { acquireEditorHost } from "../index.js";
import type { Editing } from "../index.js";

const identity = (s: string) => s;

const theme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

describe("unsupported editor layout", () => {
  it("keeps public editor features when Pi's private layout is unsupported", () => {
    const marking = Object.assign(createIdentityTheme(), {
      fg: (_color: string, text: string) => `<${text}>`,
    });

    const ctx = createExtensionHost(() => {}).createContext({
      ui: { theme: marking },
    });

    // Pi invokes the factory while installing it. The editor it builds belongs to a Pi release
    // whose editor lacks a private member the document adapter needs.
    vi.mocked(ctx.ui.setEditorComponent).mockImplementationOnce((factory) => {
      const member = "cancelAutocomplete";
      const native = Object.getOwnPropertyDescriptor(Editor.prototype, member);

      expect(native?.value, `Pi's Editor defines ${member}`).toBeTypeOf(
        "function"
      );
      Object.defineProperty(Editor.prototype, member, {
        configurable: true,
        value: undefined,
      });

      try {
        factory!(createMockTui(), theme, createKeybindings());
      } finally {
        Object.defineProperty(Editor.prototype, member, native!);
      }

      vi.mocked(ctx.ui.getEditorComponent).mockReturnValue(factory);
    });
    const host = acquireEditorHost(ctx)!;
    const editor = host.editor!;
    host.seedHistory(["older", "recalled"]);

    const editing = {
      input: vi.fn<Editing["input"]>(() => true),
      changed: vi.fn<Editing["changed"]>(),
      submitted() {},
      selection: () => [],
    };

    host.contribute("editing", editing);
    host.contribute("foreground", () => [
      { start: 0, end: 1, foreground: "accent" },
    ]);
    host.contribute("border", {
      render: (line) => line.replace("busy", "BUSY"),
    });

    editor.setWorkingStatusIndicator(
      Object.assign(createStatusIndicator("working"), {
        renderInBorder: () => "busy",
      })
    );
    expect(editor.document).toBeUndefined();
    expect(stripTerminalSequences(editor.render(30)[0]!)).toContain("BUSY");

    editor.handleInput("\u001B[A");
    expect(editor.getText()).toBe("recalled");
    // Decorations and the modal engine need the document adapter.
    expect(editing.input).not.toHaveBeenCalled();
    expect(editing.changed).not.toHaveBeenCalled();
    expect(stripTerminalSequences(editor.render(30)[1]!).trimEnd()).toBe(
      "recalled"
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "shared-editor",
      "Unsupported Pi editor layout: required document/undo APIs are unavailable"
    );
    // Cooperating extensions that load later join the same host without reinstalling.
    expect(acquireEditorHost(ctx)).toBe(host);
    expect(ctx.ui.setEditorComponent).toHaveBeenCalledOnce();
  });
});
