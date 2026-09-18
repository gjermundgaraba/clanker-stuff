import { describe, it, expect, vi } from "vite-plus/test";
import { setup } from "./helpers.js";

describe("native modal editing", () => {
  it("starts insert, changes a word as one transaction, then repeats semantically", () => {
    const { editor, keys, normal, mode } = setup("one two three");
    normal();
    keys("cw", "NEW", "\x1b");
    expect(mode()).toBe("normal");
    expect(editor.getText()).toBe("NEW two three");
    keys("w", ".");
    expect(editor.getText()).toBe("NEW NEW three");
    keys("u");
    expect(editor.getText()).toBe("NEW two three");
    keys("u");
    expect(editor.getText()).toBe("one two three");
    keys("\x12");
    expect(editor.getText()).toBe("NEW two three");
  });
  it("undoes initial insertion as one change and invalidates redo on edit", () => {
    const { editor, keys } = setup();
    keys("hello", " world", "\x1b", "u");
    expect(editor.getText()).toBe("");
    keys("\x12");
    expect(editor.getText()).toBe("hello world");
    keys("u", "i", "new", "\x1b", "\x12");
    expect(editor.getText()).toBe("new");
  });
  it("keeps mode and undo across Pi's getText/setText round trip", () => {
    const { editor, keys, normal, mode } = setup("one two three");
    normal();
    keys("dw");
    // InteractiveMode.showExtensionCustom does this whenever a non-overlay view closes.
    editor.setText(editor.getText());
    expect(mode()).toBe("normal");
    keys("u");
    expect(editor.getText()).toBe("one two three");
  });
  it("keeps typing after the native undo binding in Insert", () => {
    const { editor, keys, mode } = setup();
    keys("hello", "\x1b", "A", " world", "\x1f");
    expect(editor.getText()).toBe("hello");
    expect(mode()).toBe("insert");
    keys("!", "\x1b", "u");
    expect(editor.getText()).toBe("hello");
    expect(mode()).toBe("normal");
  });
  it("deletes whole graphemes and yanks paste payload ownership", () => {
    const { editor, keys, normal } = setup("👩‍💻éx");
    normal();
    keys("x");
    expect(editor.getText()).toBe("éx");
    keys("x");
    expect(editor.getText()).toBe("x");
    const payload = "line\n".repeat(50);
    editor.setText("");
    keys("\x1b[200~" + payload + "\x1b[201~", "\x1b", "0", "yy", "dd", "p");
    expect(editor.getExpandedText()).toContain(payload);
    keys("u", "\x12", "u");
    expect(() => editor.getExpandedText()).not.toThrow();
  });
  it.each(["d9iw", "d9aw", "dj", "dk"])(
    "leaves the prompt alone when %s cannot complete",
    (keys) => {
      const { editor, keys: press, normal } = setup("one two three");
      normal();
      press(keys);
      expect(editor.getText()).toBe("one two three");
    },
  );
  it("routes terminal paste in normal mode without treating controls as keys", () => {
    const { editor, keys, normal } = setup("one");
    normal();
    keys("\x1b[200~hello\nworld\x1b[201~");
    expect(editor.getExpandedText()).toContain("hello\nworld");
    keys("u");
    expect(editor.getText()).toBe("one");
  });
  it("restores preview cancellation including mode, cursor, payloads and undo", () => {
    const { editor, host, keys, normal, mode } = setup("one two");
    normal();
    keys("cw", "new", "\x1b");
    const before = editor.document.capture();
    const preview = host.preview();
    preview.show("other");
    preview.close(true);
    expect(editor.document.capture()).toEqual(before);
    expect(mode()).toBe("normal");
    keys("u");
    expect(editor.getText()).toBe("one two");
  });
  it("does not overwrite intervening edits when a preview closes", () => {
    const { editor, host } = setup("draft");
    const preview = host.preview();
    preview.show("history");
    editor.setText("external");
    preview.show("stale");
    preview.close(true);
    expect(editor.getText()).toBe("external");
  });
  it("submits fast input exactly once and does not record submission in dot", () => {
    const { editor, keys } = setup();
    const submissions: string[] = [];
    editor.onSubmit = (text) => submissions.push(text);
    keys("hello", "\r");
    expect(submissions).toEqual(["hello"]);
    keys("\x1b", ".");
    expect(submissions).toEqual(["hello"]);
  });
  it("visual selections and linewise operators use the same edit path", () => {
    const { editor, keys, normal } = setup("one\ntwo\nthree");
    normal();
    keys("V", "j", "d");
    expect(editor.getText()).toBe("three");
    keys("u");
    expect(editor.getText()).toBe("one\ntwo\nthree");
    keys("gg", "0", "viw", "c", "new", "\x1b");
    expect(editor.getText()).toBe("new\ntwo\nthree");
  });
});

it("Escape dismisses completion before leaving Insert, then preserves Pi Escape", async () => {
  const { editor, keys, mode } = setup();
  editor.setAutocompleteProvider({
    getSuggestions: async () => ({
      prefix: "",
      items: [
        { value: "choice", label: "choice" },
        { value: "second", label: "second" },
      ],
    }),
    applyCompletion: (_lines, _line, _column, item) => ({
      lines: [item.value],
      cursorLine: 0,
      cursorCol: item.value.length,
    }),
  });
  keys("\t");
  await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
  keys("\x1b");
  expect(mode()).toBe("insert");
  expect(editor.isShowingAutocomplete()).toBe(false);
  keys("\x1b");
  expect(mode()).toBe("normal");
});

it("Ctrl+R reaches extension shortcuts only in Insert", () => {
  const { editor, keys } = setup("one");
  let historyCalls = 0;
  editor.onExtensionShortcut = (data) => {
    if (data !== "\x12") return false;
    historyCalls++;

    return true;
  };

  keys("\x12");
  expect(historyCalls).toBe(1);
  keys("\x1b", "\x12");
  expect(historyCalls).toBe(1);
});

it("accepted history starts a new undo/repeat boundary", () => {
  const { editor, host, keys, normal, mode } = setup("old");
  normal();
  keys("x");
  const preview = host.preview();
  preview.show("accepted");
  preview.close(false);
  expect(mode()).toBe("insert");
  keys("\x1b", "u", ".");
  expect(editor.getText()).toBe("accepted");
});

it("Normal Escape delegates to Pi without double invocation", () => {
  const { editor, keys } = setup();
  const escape = vi.fn();
  editor.onEscape = escape;
  keys("\x1b");
  expect(escape).not.toHaveBeenCalled();
  keys("\x1b");
  expect(escape).toHaveBeenCalledTimes(1);
});

it("image-paste shortcuts remain native and dot never invokes them", () => {
  const { editor, keys, normal } = setup("draft");
  normal();
  const image = vi.fn(() => editor.insertTextAtCursor("[image attached]"));
  editor.onPasteImage = image;
  keys("\x16", ".");
  expect(image).toHaveBeenCalledTimes(1);
  expect(editor.getText()).toContain("[image attached]");
});

it.each(["\x1b[65;2u", "\x1b[97:65;2u", "\x1b[27;2;65~"])(
  "decodes shifted terminal command %j instead of inserting escape bytes",
  (key) => {
    const { editor, keys, normal, mode } = setup("one");
    normal();
    keys(key);
    expect(mode()).toBe("insert");
    keys("Z", "\x1b");
    expect(editor.getText()).toBe("oneZ");
  },
);

it("Kitty releases cannot execute a second edit", () => {
  const { editor, keys, normal } = setup("one");
  normal();
  keys("\x1b[120;1u", "\x1b[120;1:3u");
  expect(editor.getText()).toBe("ne");
});

it("native arrow recall and draft restoration establish separate editing boundaries", () => {
  const { editor, keys } = setup();
  editor.addToHistory("old prompt");
  keys("draft", "\x1b[A", "\x1b[A");
  expect(editor.getText()).toBe("old prompt");
  keys("\x1b[B");
  expect(editor.getText()).toBe("draft");
  keys("\x1b", "u");
  expect(editor.getText()).toBe("draft");
});

it("dot compares paste ownership, not marker IDs renumbered by native Backspace", () => {
  const { editor, keys } = setup();
  const payloads = ["A\n", "B\n", "C\n"].map((text) => text.repeat(50));

  for (const payload of payloads) keys("\x1b[200~" + payload + "\x1b[201~");
  keys("\x1b", "0", "a", "\x7f", "\x1b");
  expect(editor.getText()).toBe(payloads[1]! + payloads[2]!);
  keys(".");
  expect(editor.getText()).toBe(payloads[2]);
});

it("insertion repeat follows edits after cursor movement, not equal-content positions", () => {
  const { editor, keys, normal } = setup("aaa bbb");
  normal();
  keys("i", "\x1b[C", "a", "\x1b", "w", ".");
  expect(editor.getText()).toBe("aaaa babb");
});

it("completion text is repeated as an edit without replaying its callback", async () => {
  const { editor, keys, normal } = setup("aaa bbb");
  normal();

  const complete = vi.fn((lines: string[], row: number, col: number) => ({
    lines: [lines[0]!.slice(0, col) + "a" + lines[0]!.slice(col)],
    cursorLine: row,
    cursorCol: col + 1,
  }));

  editor.setAutocompleteProvider({
    getSuggestions: async () => ({ prefix: "", items: [{ value: "a", label: "a" }] }),
    applyCompletion: complete,
  });
  keys("i", "\t");
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  keys("\x1b", "w", ".");
  expect(editor.getText()).toBe("aaaa abbb");
  expect(complete).toHaveBeenCalledTimes(1);
});

it("submission keeps literal payload markers after modal undo/redo", () => {
  const { editor, keys } = setup();
  const first = "literal [paste #2] " + "A".repeat(1100);
  const second = "B".repeat(1100);
  keys("\x1b[200~" + first + "\x1b[201~", "\x1b[200~" + second + "\x1b[201~", "\x1b", "u", "\x12");
  const submit = vi.fn();
  editor.onSubmit = submit;
  expect(editor.getExpandedText()).toBe(first + second);
  keys("\r");
  expect(submit).toHaveBeenCalledExactlyOnceWith(first + second);
});

it.each(["paste", "programmatic"])(
  "anchors %s insertion after native cursor movement",
  (source) => {
    const { editor, keys, normal } = setup("aaa bbb");
    normal();
    keys("i", "\x1b[C");

    if (source === "paste") keys("\x1b[200~a\x1b[201~");
    else editor.insertTextAtCursor("a");
    keys("\x1b", "w", ".");
    expect(editor.getText()).toBe("aaaa babb");
  },
);

it("honors the injected undo binding rather than the global default", () => {
  const { editor, keys, normal } = setup("one");
  normal();
  keys("x");
  const matches = editor.keys.matches.bind(editor.keys);
  vi.spyOn(editor.keys, "matches").mockImplementation((data, action) =>
    action === "tui.editor.undo" ? data === "z" : matches(data, action),
  );
  keys("z");
  expect(editor.getText()).toBe("one");
});
