import { describe, expect, it, vi } from "vite-plus/test";
import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { createKeybindings, createMockTui } from "../../../tests/harness/tui.js";
import { acquireEditorHost } from "../index.js";
import { visibleWidth } from "@earendil-works/pi-tui";

function setup() {
  const fixture = createExtensionHost(() => {});
  const ctx = fixture.createContext();
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
}

describe("shared editor ownership and snapshots", () => {
  it("reuses one factory and one native editor", () => {
    const { ctx, host, editor } = setup();
    const factory = ctx.ui.getEditorComponent();
    expect(acquireEditorHost(ctx)!).toBe(host);
    expect(ctx.ui.getEditorComponent()).toBe(factory);
    expect(host.editor).toBe(editor);
  });
  it("restores hidden paste payloads, cursor and native undo", () => {
    const { editor } = setup();
    const payload = "line\n".repeat(50);
    editor.handleInput("\x1b[200~" + payload + "\x1b[201~");
    expect(editor.document.text()).toContain("[paste #");
    expect(editor.getText()).toBe(payload);
    const before = editor.document.capture();
    editor.setText("replacement");
    editor.restore(before);
    expect(editor.getExpandedText()).toBe(payload);
    expect(editor.document.capture()).toEqual(before);
  });
  it("observes callbacks Pi assigns after factory construction", () => {
    const { editor } = setup();
    const changed = vi.fn();
    editor.onChange = changed;
    editor.handleInput("hello");
    expect(changed).toHaveBeenCalledWith("hello");
  });
  it("routes complete bracketed paste before modal input", () => {
    const { host, editor } = setup();
    const input = vi.fn(() => true);
    const changed = vi.fn();
    const release = host.contribute("editing", {
      input,
      changed,
      submitted() {},
      suspend: () => () => {},
      selection: () => [],
    });
    editor.handleInput("\x1b[200~hello\nworld\x1b[201~");
    expect(editor.getExpandedText()).toBe("hello\nworld");
    expect(input).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledExactlyOnceWith("insert", expect.anything());
    // The modal engine's own edits and restores are not reported back to it.
    editor.edit(0, 0, "x", 1);
    editor.restoreView(editor.document.view());
    expect(changed).toHaveBeenCalledOnce();
    release();
    editor.handleInput("y");
    expect(input).not.toHaveBeenCalled();
  });
  it("leaves a later owner's contribution in place when an earlier one releases", () => {
    const { host, editor } = setup();
    const border = (tag: string) => ({ render: () => tag });
    const first = host.contribute("border", border("first"));
    host.contribute("border", border("second"));
    first();
    expect(editor.render(20)[0]).toBe("second");
  });
  it("treats Pi's getText/setText round trip as no replacement", () => {
    const { editor } = setup();
    editor.handleInput("\x1b[200~" + "line\n".repeat(50) + "\x1b[201~");
    editor.handleInput("\x01"); // cursor to line start
    const before = editor.document.capture();
    const changed = vi.fn();
    editor.onChange = changed;
    // InteractiveMode.showExtensionCustom restores exactly this string when a view closes.
    editor.setText(editor.getText());
    expect(editor.document.capture()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
  });
});

it("exports payloads across Pi's string-only editor handoff", () => {
  const { editor } = setup();
  const payload = "line\n".repeat(50);
  editor.handleInput("\x1b[200~" + payload + "\x1b[201~");
  // InteractiveMode.setCustomEditorComponent transfers exactly this public string.
  const next = setup().editor;
  next.setText(editor.getText());
  expect(next.getExpandedText()).toBe(payload);
  expect(next.document.text()).not.toContain("[paste #");
});

it("does not recursively expand marker-looking register payloads", () => {
  const { editor } = setup();
  const first = editor.document.encode("secret\tvalue");
  const literal = editor.document.encode(first);
  editor.edit(0, 0, literal, 0);
  expect(editor.getExpandedText()).toBe(first);
});

it("native kill/yank owns paste payloads across replacements and ID reuse", () => {
  const { editor } = setup();
  const payload = "owned\n".repeat(50);
  editor.handleInput("\x1b[200~" + payload + "\x1b[201~");
  editor.handleInput("\x15"); // native kill to start
  editor.setText("");
  editor.handleInput("\x1b[200~" + "different\n".repeat(50) + "\x1b[201~");
  editor.setText("");
  editor.handleInput("\x19"); // native yank, after marker IDs have been reused
  expect(editor.getExpandedText()).toBe(payload);
});

it("accepting history clears native preview undo even without Vim", () => {
  const { editor, host } = setup();
  editor.setText("draft");
  const preview = host.preview();
  preview.show("accepted");
  preview.close(false);
  editor.handleInput("\x1f");
  expect(editor.getText()).toBe("accepted");
});

it("submits the same single-pass payload content that retrieval exposes", () => {
  const { editor } = setup();
  const first = "literal [paste #2] " + "A".repeat(1100);
  const second = "B".repeat(1100);
  for (const text of [first, second]) editor.handleInput("\x1b[200~" + text + "\x1b[201~");
  const draft = editor.document.capture();
  editor.setText("other");
  editor.restore(draft);
  const submit = vi.fn();
  editor.onSubmit = submit;
  expect(editor.getExpandedText()).toBe(first + second);
  editor.handleInput("\r");
  expect(submit).toHaveBeenCalledExactlyOnceWith(first + second);
  expect(editor.getText()).toBe("");
});

it("restores a document checkpoint after native payload IDs are reused", () => {
  const { editor } = setup();
  const payload = "literal [paste #2] " + "A".repeat(1100);
  editor.handleInput("\x1b[200~" + payload + "\x1b[201~");
  const checkpoint = editor.document.view();
  editor.setText("");
  editor.handleInput("\x1b[200~" + "B".repeat(1100) + "\x1b[201~");
  editor.restoreView(checkpoint);
  expect(editor.document.view()).toEqual(checkpoint);
  expect(editor.getText()).toBe(payload);
  editor.handleInput("\x1b[200~" + "C".repeat(1100) + "\x1b[201~");
  expect(editor.getText()).toBe(payload + "C".repeat(1100));
  editor.restoreView(checkpoint);
  expect(editor.getText()).toBe(payload);
});

it.each([
  ["x", 1],
  ["abc", 2],
  ["👩‍💻界é", 5],
  ["👩‍💻界é", 12],
])("keeps undecorated %s within %i terminal columns", (text, width) => {
  const { editor } = setup();
  editor.setText(text);
  expect(editor.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
});
