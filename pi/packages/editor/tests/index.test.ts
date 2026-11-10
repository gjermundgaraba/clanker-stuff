import {
  CURSOR_MARKER,
  renderFakeCursor,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  createIdentityEditorTheme,
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { acquireEditorHost, currentEditorHost } from "../index.js";

const setup = (uiTheme = createIdentityTheme()) => {
  const fixture = createExtensionHost(() => {});
  const ctx = fixture.createContext({ ui: { theme: uiTheme } });
  const host = acquireEditorHost(ctx)!;

  const theme = createIdentityEditorTheme();

  const editor = host.create(createMockTui(), theme, createKeybindings());
  editor.render(80);

  return { ctx, host, editor };
};

const border = (tag: string) => ({ render: () => tag });

describe("editor host", () => {
  describe("shared editor ownership and document", () => {
    it("reuses one factory and one native editor", () => {
      const { ctx, host, editor } = setup();
      const factory = ctx.ui.getEditorComponent();
      expect(acquireEditorHost(ctx)!).toBe(host);
      expect(ctx.ui.getEditorComponent()).toBe(factory);
      expect(host.editor).toBe(editor);
    });

    it("reports the shared host only while it is Pi's current editor", () => {
      const { ctx, host } = setup();
      expect(currentEditorHost(ctx)).toBe(host);

      ctx.ui.setEditorComponent(vi.fn());

      expect(currentEditorHost(ctx)).toBeUndefined();
      expect(acquireEditorHost(ctx)).toBeUndefined();
    });

    it("leaves a later owner's contribution in place when an earlier one releases", () => {
      const { host, editor } = setup();
      const first = host.contribute("border", border("first"));
      host.contribute("border", border("second"));
      first();
      expect(editor.render(20)[0]).toBe("second");
    });

    it("keeps border contributions within the native rendering and clipping pipeline", () => {
      const { host, editor } = setup();
      host.contribute("border", { render: (line) => `${line}oversized` });
      expect(stripTerminalSequences(editor.render(20)[0]!)).toBe(
        "─".repeat(20)
      );
      host.contribute("highlight", () => [{ start: 0, end: 1 }]);
      editor.setText("x");
      expect(stripTerminalSequences(editor.render(20)[0]!)).toBe(
        "─".repeat(20)
      );
    });

    it("treats Pi's getText/setText round trip as no replacement", () => {
      const { editor } = setup();
      editor.handleInput(`\u001B[200~${"line\n".repeat(50)}\u001B[201~`);
      const draft = editor.getLines();
      const changed = vi.fn<(text: string) => void>();
      editor.onChange = changed;
      editor.setText(editor.getText());
      expect(editor.getLines()).toStrictEqual(draft);
      expect(editor.getExpandedText()).toBe("line\n".repeat(50));
      expect(changed).not.toHaveBeenCalled();
    });
  });

  it("submits the same single-pass payload content that retrieval exposes", () => {
    const { editor } = setup();
    const first = `literal [paste #2] ${"A".repeat(1100)}`;
    const second = "B".repeat(1100);

    for (const text of [first, second]) {
      editor.handleInput(`\u001B[200~${text}\u001B[201~`);
    }

    const submit = vi.fn<(text: string) => void>();
    editor.onSubmit = submit;
    expect(editor.getExpandedText()).toBe(first + second);
    editor.handleInput("\r");
    expect(submit).toHaveBeenCalledExactlyOnceWith(first + second);
    expect(editor.getText()).toBe("");
  });

  it("keeps a focused editor's cursor marker whole and out of highlight offsets", () => {
    const { host, editor } = setup(
      Object.assign(createIdentityTheme(), {
        fg: (_color: string, text: string) => `<${text}>`,
      })
    );

    editor.setText("this is a test");
    editor.handleInput("\u001B[D");
    host.contribute("highlight", () => [{ start: 10, end: 14 }]);
    editor.focused = true;
    const row = editor.render(40)[1]!;
    expect(row).toContain(CURSOR_MARKER + renderFakeCursor("<t>"));
    expect(row.match(/<[^>]*>/gu)).toHaveLength(4);
    expect(row.replaceAll(CURSOR_MARKER, "")).toMatch(
      /^this is a <t><e><s>.*<t>/u
    );
  });

  it.each([
    ["x", 1],
    ["abc", 2],
    ["👩‍💻界é", 5],
    ["👩‍💻界é", 12],
  ])("keeps undecorated %s within %i terminal columns", (text, width) => {
    const { editor } = setup();
    editor.setText(text);
    expect(
      editor.render(width).every((row) => visibleWidth(row) <= width)
    ).toBe(true);
  });
});
