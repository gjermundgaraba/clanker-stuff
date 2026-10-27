import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { setup } from "./helpers.js";

describe("runtime", () => {
  describe("native modal editing", () => {
    it("starts insert, changes a word as one transaction, then repeats semantically", () => {
      const { editor, keys, normal, mode } = setup("one two three");
      normal();
      keys("cw", "NEW", "\u001B");
      expect(mode()).toBe("normal");
      expect(editor.getText()).toBe("NEW two three");
      keys("w", ".");
      expect(editor.getText()).toBe("NEW NEW three");
      keys("u");
      expect(editor.getText()).toBe("NEW two three");
      keys("u");
      expect(editor.getText()).toBe("one two three");
      keys("\u0012");
      expect(editor.getText()).toBe("NEW two three");
    });

    it("undoes initial insertion as one change and invalidates redo on edit", () => {
      const { editor, keys } = setup();
      keys("hello", " world", "\u001B", "u");
      expect(editor.getText()).toBe("");
      keys("\u0012");
      expect(editor.getText()).toBe("hello world");
      keys("u", "i", "new", "\u001B", "\u0012");
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
      keys("hello", "\u001B", "A", " world", "\u001F");
      expect(editor.getText()).toBe("hello");
      expect(mode()).toBe("insert");
      keys("!", "\u001B", "u");
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
      keys(`\u001B[200~${payload}\u001B[201~`, "\u001B", "0", "yy", "dd", "p");
      expect(editor.getExpandedText()).toContain(payload);
      keys("u", "\u0012", "u");
      expect(() => editor.getExpandedText()).not.toThrow();
    });

    it.each(["d9iw", "d9aw", "dj", "dk"])(
      "leaves the prompt alone when %s cannot complete",
      (keys) => {
        const { editor, keys: press, normal } = setup("one two three");
        normal();
        press(keys);
        expect(editor.getText()).toBe("one two three");
      }
    );

    it("routes terminal paste in normal mode without treating controls as keys", () => {
      const { editor, keys, normal } = setup("one");
      normal();
      keys("\u001B[200~hello\nworld\u001B[201~");
      expect(editor.getExpandedText()).toContain("hello\nworld");
      keys("u");
      expect(editor.getText()).toBe("one");
    });

    it.each([
      [
        "a mouse click",
        (editor: ReturnType<typeof setup>["editor"]) => {
          editor.handleMouse({
            type: "click",
            button: "left",
            x: 40,
            y: 1,
            screenX: 40,
            screenY: 1,
            width: 80,
            height: 10,
            shift: false,
            alt: false,
            ctrl: false,
          });
        },
      ],
      [
        "the right arrow",
        (editor: ReturnType<typeof setup>["editor"]) => {
          editor.handleInput("$");
          editor.handleInput("\u001B[C");
        },
      ],
    ])(
      "starts commands on a character after %s moves past the line end",
      (_name, move) => {
        for (const [command, expected] of [
          ["x", "ab\ndef"],
          ["vd", "ab\ndef"],
        ] as const) {
          const { editor, keys, normal } = setup("abc\ndef");
          normal();
          editor.render(80);
          move(editor);
          keys(command);
          expect(editor.getText()).toBe(expected);
        }
      }
    );

    it("submits fast input exactly once and does not record submission in dot", () => {
      const { editor, keys } = setup();
      const submissions: string[] = [];
      editor.onSubmit = (text) => {
        submissions.push(text);
      };

      keys("hello", "\r");
      expect(submissions).toStrictEqual(["hello"]);
      keys("\u001B", ".");
      expect(submissions).toStrictEqual(["hello"]);
    });

    it("visual selections and linewise operators use the same edit path", () => {
      const { editor, keys, normal } = setup("one\ntwo\nthree");
      normal();
      keys("V", "j", "d");
      expect(editor.getText()).toBe("three");
      keys("u");
      expect(editor.getText()).toBe("one\ntwo\nthree");
      keys("gg", "0", "viw", "c", "new", "\u001B");
      expect(editor.getText()).toBe("new\ntwo\nthree");
    });
  });

  it("Escape dismisses completion before leaving Insert, then preserves Pi Escape", async () => {
    const { editor, keys, mode } = setup();
    const escape = vi.fn<() => void>();
    editor.onEscape = escape;
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
    await vi.waitFor(() => {
      expect(editor.isShowingAutocomplete()).toBe(true);
    });
    keys("\u001B");
    expect(mode()).toBe("insert");
    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(escape).not.toHaveBeenCalled();
    keys("\u001B");
    expect(mode()).toBe("normal");
    expect(escape).toHaveBeenCalledOnce();
  });

  it("Ctrl+R reaches extension shortcuts only in Insert", () => {
    const { editor, keys } = setup("one");
    let historyCalls = 0;
    editor.onExtensionShortcut = (data) => {
      if (data !== "\u0012") {
        return false;
      }

      historyCalls += 1;

      return true;
    };

    keys("\u0012");
    expect(historyCalls).toBe(1);
    keys("\u001B", "\u0012");
    expect(historyCalls).toBe(1);
  });

  it("an external replacement starts a new undo/repeat boundary", () => {
    const { editor, keys, normal, mode } = setup("old");
    normal();
    keys("x");
    editor.setText("accepted");
    expect(mode()).toBe("insert");
    keys("\u001B", "u", ".");
    expect(editor.getText()).toBe("accepted");
  });

  it("Normal Escape delegates to Pi without double invocation", () => {
    const { editor, keys } = setup("draft");
    const escape = vi.fn<() => void>();
    editor.onEscape = escape;
    keys("\u001B");
    expect(escape).not.toHaveBeenCalled();
    keys("\u001B");
    expect(escape).toHaveBeenCalledOnce();
  });

  it.each(["", " \n "])(
    "both Escapes reach Pi from a blank draft %j",
    (text) => {
      const { editor, keys, mode } = setup(text);

      const escape = vi.fn<() => void>(() => {
        expect(mode()).toBe("normal");
      });

      editor.onEscape = escape;
      keys("\u001B");
      expect(escape).toHaveBeenCalledOnce();
      keys("\u001B");
      expect(escape).toHaveBeenCalledTimes(2);
      expect(editor.getText()).toBe(text);
    }
  );

  it("leaving Visual still consumes Escape on an empty editor", () => {
    const { editor, keys, normal, mode } = setup();
    normal();
    const escape = vi.fn<() => void>();
    editor.onEscape = escape;
    keys("v", "\u001B");
    expect(mode()).toBe("normal");
    expect(escape).not.toHaveBeenCalled();
  });

  it("image-paste shortcuts remain native and dot never invokes them", () => {
    const { editor, keys, normal } = setup("draft");
    normal();

    const image = vi.fn<() => void>(() => {
      editor.insertTextAtCursor("[image attached]");
    });

    editor.onPasteImage = image;
    keys("\u0016", ".");
    expect(image).toHaveBeenCalledOnce();
    expect(editor.getText()).toContain("[image attached]");
  });

  it.each(["\u001B[65;2u", "\u001B[97:65;2u", "\u001B[27;2;65~"])(
    "decodes shifted terminal command %j instead of inserting escape bytes",
    (key) => {
      const { editor, keys, normal, mode } = setup("one");
      normal();
      keys(key);
      expect(mode()).toBe("insert");
      keys("Z", "\u001B");
      expect(editor.getText()).toBe("oneZ");
    }
  );

  it("Kitty releases cannot execute a second edit", () => {
    const { editor, keys, normal } = setup("one");
    normal();
    keys("\u001B[120;1u", "\u001B[120;1:3u");
    expect(editor.getText()).toBe("ne");
  });

  it("native arrow recall and draft restoration establish separate editing boundaries", () => {
    const { editor, keys } = setup();
    editor.addToHistory("old prompt");
    keys("draft", "\u001B[A", "\u001B[A");
    expect(editor.getText()).toBe("old prompt");
    keys("\u001B[B");
    expect(editor.getText()).toBe("draft");
    keys("\u001B", "u");
    expect(editor.getText()).toBe("draft");
  });

  it("dot compares paste ownership, not marker IDs renumbered by native Backspace", () => {
    const { editor, keys } = setup();
    const payloads = ["A\n", "B\n", "C\n"].map((text) => text.repeat(50));

    for (const payload of payloads) {
      keys(`\u001B[200~${payload}\u001B[201~`);
    }

    keys("\u001B", "0", "a", "\u007F", "\u001B");
    expect(editor.getText()).toBe(payloads[1]! + payloads[2]!);
    keys(".");
    expect(editor.getText()).toBe(payloads[2]);
  });

  it("insertion repeat follows edits after cursor movement, not equal-content positions", () => {
    const { editor, keys, normal } = setup("aaa bbb");
    normal();
    keys("i", "\u001B[C", "a", "\u001B", "w", ".");
    expect(editor.getText()).toBe("aaaa babb");
  });

  it("completion text is repeated as an edit without replaying its callback", async () => {
    const { editor, keys, normal } = setup("aaa bbb");
    normal();

    const complete = vi.fn<AutocompleteProvider["applyCompletion"]>(
      (lines, row, col) => ({
        lines: [`${lines[0]!.slice(0, col)}a${lines[0]!.slice(col)}`],
        cursorLine: row,
        cursorCol: col + 1,
      })
    );

    editor.setAutocompleteProvider({
      getSuggestions: async () => ({
        prefix: "",
        items: [{ value: "a", label: "a" }],
      }),
      applyCompletion: complete,
    });
    keys("i", "\t");
    await vi.waitFor(() => {
      expect(complete).toHaveBeenCalledOnce();
    });
    keys("\u001B", "w", ".");
    expect(editor.getText()).toBe("aaaa abbb");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("submission keeps literal payload markers after modal undo/redo", () => {
    const { editor, keys } = setup();
    const first = `literal [paste #2] ${"A".repeat(1100)}`;
    const second = "B".repeat(1100);
    keys(
      `\u001B[200~${first}\u001B[201~`,
      `\u001B[200~${second}\u001B[201~`,
      "\u001B",
      "u",
      "\u0012"
    );
    const submit = vi.fn<(text: string) => void>();
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
      keys("i", "\u001B[C");

      if (source === "paste") {
        keys("\u001B[200~a\u001B[201~");
      } else {
        editor.insertTextAtCursor("a");
      }

      keys("\u001B", "w", ".");
      expect(editor.getText()).toBe("aaaa babb");
    }
  );

  it("honors the injected undo binding rather than the global default", () => {
    const { editor, keys, normal } = setup("one");
    normal();
    keys("x");
    const matches = editor.keys.matches.bind(editor.keys);
    vi.spyOn(editor.keys, "matches").mockImplementation((data, action) =>
      action === "tui.editor.undo" ? data === "z" : matches(data, action)
    );
    keys("z");
    expect(editor.getText()).toBe("one");
  });
});
