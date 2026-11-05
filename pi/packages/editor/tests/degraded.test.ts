import { Editor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createIdentityEditorTheme,
  createKeybindings,
  createMockTui,
  createStatusIndicator,
} from "../../../tests/harness/tui.js";
import { acquireEditorHost } from "../index.js";

const theme = createIdentityEditorTheme();

describe("unsupported editor layout", () => {
  it("keeps public editor features when Pi's private layout is unsupported", () => {
    const marking = Object.assign(createIdentityTheme(), {
      fg: (_color: string, text: string) => `<${text}>`,
    });

    const ctx = createExtensionHost(() => {}).createContext({
      ui: { theme: marking },
    });

    vi.mocked(ctx.ui.setEditorComponent).mockImplementationOnce((factory) => {
      const member = "buildVisualLineMap";
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

    host.contribute("highlight", () => [{ start: 0, end: 1 }]);
    host.contribute("border", {
      render: (line) => line.replace("busy", "BUSY"),
    });

    editor.setWorkingStatusIndicator(
      Object.assign(createStatusIndicator("working"), {
        renderInBorder: () => "busy",
      })
    );
    expect(stripTerminalSequences(editor.render(30)[0]!)).toContain("BUSY");

    editor.handleInput("\u001B[A");
    expect(editor.getText()).toBe("recalled");
    expect(stripTerminalSequences(editor.render(30)[1]!).trimEnd()).toBe(
      "recalled"
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "shared-editor",
      "Unsupported Pi editor layout: required paste and layout APIs are unavailable"
    );
    expect(acquireEditorHost(ctx)).toBe(host);
    expect(ctx.ui.setEditorComponent).toHaveBeenCalledOnce();
  });
});
