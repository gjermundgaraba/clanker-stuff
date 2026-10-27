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
  createKeybindings,
  createMockTui,
} from "../../../tests/harness/tui.js";
import { acquireEditorHost, currentEditorHost } from "../index.js";
import type { Editing } from "../index.js";

const setup = (uiTheme = createIdentityTheme()) => {
  const fixture = createExtensionHost(() => {});
  const ctx = fixture.createContext({ ui: { theme: uiTheme } });
  const host = acquireEditorHost(ctx)!;

  const theme = {
    borderColor: (s: string) => s,
    selectList: {
      selectedPrefix: (s: string) => s,
      selectedText: (s: string) => s,
      description: (s: string) => s,
      scrollInfo: (s: string) => s,
      noMatch: (s: string) => s,
    },
  };

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

    it("observes callbacks Pi assigns after factory construction", () => {
      const { editor } = setup();
      const changed = vi.fn<(text: string) => void>();
      editor.onChange = changed;
      editor.handleInput("hello");
      expect(changed).toHaveBeenCalledWith("hello");
    });

    it("routes complete bracketed paste before modal input", () => {
      const { host, editor } = setup();
      const input = vi.fn<Editing["input"]>(() => true);
      const changed = vi.fn<Editing["changed"]>();

      const release = host.contribute("editing", {
        input,
        changed,
        submitted() {},
        selection: () => [],
      });

      editor.handleInput("\u001B[200~hello\nworld\u001B[201~");
      expect(editor.getExpandedText()).toBe("hello\nworld");
      expect(input).not.toHaveBeenCalled();
      expect(changed).toHaveBeenCalledExactlyOnceWith(
        "insert",
        expect.anything()
      );
      // The modal engine's own edits and restores are not reported back to it.
      editor.edit(0, 0, "x", 1);
      editor.restoreView(editor.document!.view());
      expect(changed).toHaveBeenCalledOnce();
      release();
      editor.handleInput("y");
      expect(input).not.toHaveBeenCalled();
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
      // The border contribution runs before the shared renderer's final width clipping.
      host.contribute("border", { render: (line) => `${line}oversized` });
      expect(stripTerminalSequences(editor.render(20)[0]!)).toBe(
        "─".repeat(20)
      );
      host.contribute("foreground", () => [
        { start: 0, end: 1, foreground: "accent" },
      ]);
      editor.setText("x");
      expect(stripTerminalSequences(editor.render(20)[0]!)).toBe(
        "─".repeat(20)
      );
    });

    it("treats Pi's getText/setText round trip as no replacement", () => {
      const { editor } = setup();
      editor.handleInput(`\u001B[200~${"line\n".repeat(50)}\u001B[201~`);
      // cursor to line start
      editor.handleInput("\u0001");
      const before = editor.document!.view();
      const changed = vi.fn<(text: string) => void>();
      editor.onChange = changed;
      // InteractiveMode.showExtensionCustom restores exactly this string when a view closes.
      editor.setText(editor.getText());
      expect(editor.document!.view()).toStrictEqual(before);
      expect(changed).not.toHaveBeenCalled();
    });
  });

  it("exports payloads across Pi's string-only editor handoff", () => {
    const { editor } = setup();
    const payload = "line\n".repeat(50);
    editor.handleInput(`\u001B[200~${payload}\u001B[201~`);
    // InteractiveMode.setCustomEditorComponent transfers exactly this public string.
    const next = setup().editor;
    next.setText(editor.getText());
    expect(next.getExpandedText()).toBe(payload);
    expect(next.document!.text()).not.toContain("[paste #");
  });

  it("does not recursively expand marker-looking register payloads", () => {
    const { editor } = setup();
    const first = editor.document!.encode("secret\tvalue");
    const literal = editor.document!.encode(first);
    editor.edit(0, 0, literal, 0);
    expect(editor.getExpandedText()).toBe(first);
  });

  it("native kill/yank owns paste payloads across replacements and ID reuse", () => {
    const { editor } = setup();
    const payload = "owned\n".repeat(50);
    editor.handleInput(`\u001B[200~${payload}\u001B[201~`);
    // native kill to start
    editor.handleInput("\u0015");
    editor.setText("");
    editor.handleInput(`\u001B[200~${"different\n".repeat(50)}\u001B[201~`);
    editor.setText("");
    // native yank, after marker IDs have been reused
    editor.handleInput("\u0019");
    expect(editor.getExpandedText()).toBe(payload);
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

  it("restores a document checkpoint after native payload IDs are reused", () => {
    const { editor } = setup();
    const payload = `literal [paste #2] ${"A".repeat(1100)}`;
    editor.handleInput(`\u001B[200~${payload}\u001B[201~`);
    const checkpoint = editor.document!.view();
    editor.setText("");
    editor.handleInput(`\u001B[200~${"B".repeat(1100)}\u001B[201~`);
    editor.restoreView(checkpoint);
    expect(editor.document!.view()).toStrictEqual(checkpoint);
    expect(editor.getText()).toBe(payload);
    editor.handleInput(`\u001B[200~${"C".repeat(1100)}\u001B[201~`);
    expect(editor.getText()).toBe(payload + "C".repeat(1100));
    editor.restoreView(checkpoint);
    expect(editor.getText()).toBe(payload);
  });

  it("keeps a focused editor's cursor marker whole and out of decoration offsets", () => {
    const { host, editor } = setup(
      Object.assign(createIdentityTheme(), {
        fg: (_color: string, text: string) => `<${text}>`,
      })
    );

    editor.setText("this is a test");
    // cursor on the final "t"
    editor.handleInput("\u001B[D");
    host.contribute("foreground", () => [
      { start: 10, end: 14, foreground: "accent" },
    ]);
    editor.focused = true;
    const row = editor.render(40)[1]!;
    expect(row).toContain(CURSOR_MARKER + renderFakeCursor("<t>"));
    // Exactly the four spanned characters are decorated, including the one under the cursor.
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
