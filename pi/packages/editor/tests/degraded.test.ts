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

const acquireWithout = (member: string) => {
  const marking = Object.assign(createIdentityTheme(), {
    fg: (_color: string, text: string) => `<${text}>`,
  });

  const ctx = createExtensionHost(() => {}).createContext({
    ui: { theme: marking },
  });

  vi.mocked(ctx.ui.setEditorComponent).mockImplementationOnce((factory) => {
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

  return { ctx, host, editor: host.editor! };
};

describe("unsupported editor internals", () => {
  it("keeps public editor features and single-pass pastes when Pi's private layout is unsupported", () => {
    const { ctx, host, editor } = acquireWithout("buildVisualLineMap");
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

    editor.setText("");
    const first = `literal [paste #2] ${"A".repeat(1100)}`;
    const second = "B".repeat(1100);

    for (const text of [first, second]) {
      editor.handleInput(`\u001B[200~${text}\u001B[201~`);
    }

    expect(editor.getExpandedText()).toBe(first + second);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "shared-editor",
      "Unsupported Pi editor internals: layout"
    );
    expect(acquireEditorHost(ctx)).toBe(host);
    expect(ctx.ui.setEditorComponent).toHaveBeenCalledOnce();
  });

  it("keeps highlights when Pi's private paste expansion is unsupported", () => {
    const { ctx, host, editor } = acquireWithout("expandPasteMarkers");
    host.contribute("highlight", () => [{ start: 0, end: 1 }]);
    editor.setText("recalled");

    expect(stripTerminalSequences(editor.render(30)[1]!).trimEnd()).toBe(
      "<r>ecalled"
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "shared-editor",
      "Unsupported Pi editor internals: paste"
    );
  });
});
