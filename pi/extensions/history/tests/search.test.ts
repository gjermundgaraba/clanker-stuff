import { describe, expect, it, vi, onTestFinished } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import {
  visibleWidth,
  Input,
  isFocusable,
  CURSOR_MARKER,
  getKeybindings,
  setKeybindings,
  KeybindingsManager,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import type { HistoryItem } from "../history.js";
import { createWidgetHarness, editorTheme } from "./fixtures.js";
import { installHistoryEditor } from "../editor.js";
import { createKeybindings } from "../../../tests/harness/tui.js";
import { createSearch } from "../search.js";

const item = (text: string, timestamp: number): HistoryItem => ({
  text,
  timestamp,
});

const createHarness = (
  history: HistoryItem[],
  mode: "regular" | "fullscreen" = "regular",
  foreign = false,
) => {
  const host = createExtensionHost(() => Promise.resolve());
  const ctx = host.createContext();
  const widgets = createWidgetHarness(host, ctx, mode, foreign);
  const { tui } = widgets;
  const previousFocus = new Input();
  tui.addChild(previousFocus);
  tui.setFocus(previousFocus);
  const search = createSearch(() => history);

  return {
    tui,
    previousFocus,
    widget: widgets.widget,
    begin: () => search.begin(ctx.ui),
    ctx,
    host: { ...host, terminalInput: widgets.terminalInput },
    reset: search.reset,
  };
};

describe("reverse search", () => {
  it("searches newest-first and accepts without submitting", () => {
    const { begin, ctx, host, widget } = createHarness([
      item("Check deploy status", 200),
      item("Deploy production", 100),
    ]);

    ctx.ui.setEditorText("unfinished draft");

    begin();
    expect(host.terminalInput("deploy").consumed).toBeTruthy();
    expect(ctx.ui.getEditorText()).toBe("Check deploy status");

    host.terminalInput("\u0012");
    expect(ctx.ui.getEditorText()).toBe("Deploy production");

    host.terminalInput("\u0013");
    expect(ctx.ui.getEditorText()).toBe("Check deploy status");

    expect(host.terminalInput("\r").consumed).toBeTruthy();
    expect(ctx.ui.getEditorText()).toBe("Check deploy status");
    expect(widget()).toBeUndefined();
    expect(host.terminalInput("\r").consumed).toBeFalsy();
  });

  it("previews, cancels and yields to newer text under another extension's editor", () => {
    const { begin, ctx, host, widget } = createHarness(
      [item("deploy production", 100)],
      "regular",
      true,
    );

    ctx.ui.setEditorText("unfinished draft");
    begin();
    host.terminalInput("deploy");
    expect(ctx.ui.getEditorText()).toBe("deploy production");
    host.terminalInput("\u001B");
    expect(ctx.ui.getEditorText()).toBe("unfinished draft");

    begin();
    host.terminalInput("deploy");
    ctx.ui.setEditorText("edited elsewhere");
    host.terminalInput("\u001B");
    expect(ctx.ui.getEditorText()).toBe("edited elsewhere");
    expect(widget()).toBeUndefined();
  });

  it("keeps no-match search open and restores the original draft", () => {
    const { begin, ctx, host, widget } = createHarness([item("Known prompt", 100)]);
    ctx.ui.setEditorText("unfinished draft");

    begin();
    host.terminalInput("missing");
    expect(widget()).toContain("no match");

    expect(host.terminalInput("\r").consumed).toBeTruthy();
    expect(widget()).toContain("no match");

    host.terminalInput("\u0015");
    expect(ctx.ui.getEditorText()).toBe("unfinished draft");
    expect(stripAnsi((widget() ?? "").replaceAll(CURSOR_MARKER, "")).trimEnd()).toBe("history:");

    host.terminalInput("known");
    expect(ctx.ui.getEditorText()).toBe("Known prompt");
    expect(host.terminalInput("\u001B").consumed).toBeTruthy();
    expect(ctx.ui.getEditorText()).toBe("unfinished draft");
    expect(widget()).toBeUndefined();
  });

  it("matches case-insensitively and holds selection boundaries", () => {
    const { begin, ctx, host } = createHarness([
      item("Build Release", 300),
      item("build release", 100),
    ]);

    begin();
    host.terminalInput("BUILD");
    expect(ctx.ui.getEditorText()).toBe("Build Release");

    host.terminalInput("\u001B[A");
    expect(ctx.ui.getEditorText()).toBe("build release");
    host.terminalInput("\u0012");
    expect(ctx.ui.getEditorText()).toBe("build release");

    host.terminalInput("\u001B[B");
    expect(ctx.ui.getEditorText()).toBe("Build Release");
  });

  it.each(["submit", "cancel"])("honors the configured %s shortcut", (action) => {
    const original = getKeybindings();
    onTestFinished(() => setKeybindings(original));
    setKeybindings(
      new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.input.submit": "ctrl+x",
        "tui.select.cancel": "ctrl+q",
      }),
    );

    const { begin, ctx, host, widget, tui, previousFocus } = createHarness([
      item("deploy production", 100),
    ]);

    ctx.ui.setEditorText("original draft");
    begin();
    host.terminalInput("deploy");
    expect(widget()).toContain("ctrl+x accept");
    expect(widget()).toContain("ctrl+q/ctrl+c cancel");
    host.terminalInput("\r");
    host.terminalInput("\u001B");
    expect(widget()).toBeDefined();
    host.terminalInput(action === "submit" ? "\u0018" : "\u0011");
    expect(widget()).toBeUndefined();
    expect(ctx.ui.getEditorText()).toBe(
      action === "submit" ? "deploy production" : "original draft",
    );
    expect(tui.getFocusedComponent()).toBe(previousFocus);
  });

  it("keeps empty and no-match searches open with configured submit", () => {
    const original = getKeybindings();
    onTestFinished(() => setKeybindings(original));
    setKeybindings(
      new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.input.submit": "ctrl+x",
        "tui.select.cancel": "ctrl+q",
      }),
    );
    const { begin, ctx, host, widget } = createHarness([item("deploy production", 100)]);
    ctx.ui.setEditorText("original draft");
    begin();
    host.terminalInput("\u0018");
    expect(widget()).toBeDefined();
    host.terminalInput("missing");
    host.terminalInput("\u0018");
    expect(widget()).toContain("no match");
    host.terminalInput("\u0011");
    expect(widget()).toBeUndefined();
    expect(ctx.ui.getEditorText()).toBe("original draft");
  });

  it("matches Unicode text changed by lowercasing", () => {
    const { begin, ctx, host } = createHarness([item("İstanbul", 100)]);

    begin();
    host.terminalInput("İ");

    expect(ctx.ui.getEditorText()).toBe("İstanbul");
  });

  it("treats regex syntax as literal search text", () => {
    const { begin, ctx, host } = createHarness([item("find [literal].* text", 100)]);

    begin();
    host.terminalInput("[literal].*");
    expect(ctx.ui.getEditorText()).toBe("find [literal].* text");
  });

  it("broadens incremental results after backspace", () => {
    const { begin, ctx, host } = createHarness([
      item("alpha release", 200),
      item("alpha beta", 100),
    ]);

    begin();
    host.terminalInput("alpha b");
    expect(ctx.ui.getEditorText()).toBe("alpha beta");

    host.terminalInput("\u007F");
    host.terminalInput("\u007F");
    expect(ctx.ui.getEditorText()).toBe("alpha release");
  });

  it("removes one Unicode grapheme on backspace", () => {
    const family = "👨‍👩‍👧‍👦";
    const { begin, ctx, host } = createHarness([item(`ship ${family} now`, 100)]);
    ctx.ui.setEditorText("draft");

    begin();
    host.terminalInput(family);
    expect(ctx.ui.getEditorText()).toBe(`ship ${family} now`);

    host.terminalInput("\u007F");
    expect(ctx.ui.getEditorText()).toBe("draft");
  });

  it("restores the draft when reset", () => {
    const { begin, ctx, host, reset, widget } = createHarness([item("Known prompt", 100)]);
    ctx.ui.setEditorText("unfinished draft");

    begin();
    host.terminalInput("known");
    reset();

    expect(ctx.ui.getEditorText()).toBe("unfinished draft");
    expect(widget()).toBeUndefined();
  });

  it("edits inside a query with cursor movement, forward deletion and undo", () => {
    const { begin, ctx, host, widget } = createHarness([item("deploy production", 100)]);
    begin();
    host.terminalInput("dexploy");
    host.terminalInput("\u0001"); // line start
    host.terminalInput("\u001B[C");
    host.terminalInput("\u001B[C");
    expect(widget()).toContain("\u001B[7mx"); // visible query cursor
    host.terminalInput("\u001B[3~"); // forward delete
    expect(ctx.ui.getEditorText()).toBe("deploy production");
    host.terminalInput("\u001F"); // undo
    expect(ctx.ui.getEditorText()).toBe("");
    host.terminalInput("\u001B[3~");
    host.terminalInput("\u001B[D");
    host.terminalInput("x");
    expect(ctx.ui.getEditorText()).toBe("");
    host.terminalInput("\u007F");
    expect(ctx.ui.getEditorText()).toBe("deploy production");
  });

  it("supports word editing and clears the whole query from an interior cursor", () => {
    const { begin, ctx, host } = createHarness([item("deploy production", 100)]);
    begin();
    host.terminalInput("deploy typo");
    host.terminalInput("\u0017"); // delete word backward
    expect(ctx.ui.getEditorText()).toBe("deploy production");
    host.terminalInput("\u001Bb"); // word left
    host.terminalInput("\u001Bd"); // delete word forward
    host.terminalInput("\u0015");
    expect(ctx.ui.getEditorText()).toBe("");
    host.terminalInput("deploy");
    host.terminalInput("\u0001");
    host.terminalInput("\u0015");
    expect(ctx.ui.getEditorText()).toBe("");
    host.terminalInput("production");
    expect(ctx.ui.getEditorText()).toBe("deploy production");
  });

  it.each(["end", "start", "middle"])("undoes whole-query clear from the %s", (position) => {
    const { begin, host, ctx } = createHarness([item("deploy production", 100)]);
    begin();

    for (const char of "deploy") host.terminalInput(char);

    if (position === "start") host.terminalInput("\u0001");

    if (position === "middle") host.terminalInput("\u001B[D");
    host.terminalInput("\u0015");
    expect(ctx.ui.getEditorText()).toBe("");
    host.terminalInput("\u001F");
    expect(ctx.ui.getEditorText()).toBe("deploy production");
    host.terminalInput("\u001F");
    expect(ctx.ui.getEditorText()).toBe("");
  });

  it("separates typing after a clear into its own undo step and ignores empty clears", () => {
    const { begin, host, ctx } = createHarness([item("deploy production", 100)]);
    begin();
    host.terminalInput("deploy");
    host.terminalInput("\u0015");
    host.terminalInput("\u0015");
    host.terminalInput("missing");
    host.terminalInput("\u001F");
    expect(ctx.ui.getEditorText()).toBe("");
    host.terminalInput("\u001F");
    expect(ctx.ui.getEditorText()).toBe("deploy production");
  });

  it("clears independently of remapped keys and restores the user's keybindings", () => {
    const original = getKeybindings();
    onTestFinished(() => setKeybindings(original));

    const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.editor.cursorLineEnd": [],
      "tui.editor.deleteToLineStart": [],
      "tui.editor.undo": "ctrl+z",
      "tui.editor.cursorLeft": "ctrl+e",
    });

    setKeybindings(bindings);
    const { begin, host, ctx, widget } = createHarness([item("deploy production", 100)]);
    begin();
    host.terminalInput("deploy");
    host.terminalInput("\u0015");
    expect(ctx.ui.getEditorText()).toBe("");
    expect(getKeybindings()).toBe(bindings);
    host.terminalInput("\u001A");
    expect(ctx.ui.getEditorText()).toBe("deploy production");
    host.terminalInput("\u0005");
    expect(widget()).toContain(CURSOR_MARKER + "\u001B[7my");
  });

  it.each(["accept", "escape", "ctrl+c", "reset"])(
    "owns the query cursor and restores focus on %s",
    (action) => {
      const { begin, host, tui, previousFocus, widget, reset, ctx } = createHarness([
        item("deploy production", 100),
      ]);

      begin();
      const queryFocus = tui.getFocusedComponent();
      expect(queryFocus).not.toBe(previousFocus);
      expect(previousFocus.focused).toBe(false);
      expect(widget()).toContain(CURSOR_MARKER);
      host.terminalInput("deploy");
      host.terminalInput("\u001B[D");
      expect(widget()).toContain(CURSOR_MARKER + "\u001B[7my");
      expect(tui.getFocusedComponent()).toBe(queryFocus);
      expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);

      if (action === "reset") reset();
      else
        host.terminalInput(action === "accept" ? "\r" : action === "escape" ? "\u001B" : "\u0003");
      expect(tui.getFocusedComponent()).toBe(previousFocus);
      expect(previousFocus.focused).toBe(true);
      expect(queryFocus?.render(80).join("")).not.toContain(CURSOR_MARKER);
      expect(widget()).toBeUndefined();
    },
  );

  it("does not steal focus from a newly opened dialog on cleanup", () => {
    const { begin, tui, reset, widget } = createHarness([]);
    begin();
    const dialog = new Input();
    tui.setFocus(dialog);
    expect(widget()).not.toContain(CURSOR_MARKER);
    reset();
    expect(tui.getFocusedComponent()).toBe(dialog);
    expect(dialog.focused).toBe(true);
  });

  it.each(["regular", "fullscreen"] as const)("restores the shared editor in %s mode", (mode) => {
    const { host, ctx, tui, begin } = createHarness([], mode);
    Object.assign(ctx.sessionManager, {
      getSessionDir: () => "",
      getHeader: () => undefined,
    });
    installHistoryEditor({ type: "session_start", reason: "startup" }, ctx, () => []);
    const historyFactory = ctx.ui.getEditorComponent();

    if (!historyFactory) throw new Error("Expected history factory");
    const wrapper = historyFactory(tui, editorTheme, createKeybindings());
    const wrapperInput = vi.spyOn(wrapper, "handleInput");
    tui.addChild(wrapper);
    tui.setFocus(wrapper);
    begin();
    host.terminalInput("\u001B");
    expect(tui.getFocusedComponent()).toBe(wrapper);
    expect(isFocusable(wrapper) && wrapper.focused).toBe(true);
    host.terminalInput("x");
    expect(wrapperInput).toHaveBeenCalledExactlyOnceWith("x");
    expect(wrapper.getText()).toBe("x");
  });

  it.each(["regular", "fullscreen"] as const)(
    "lets a focused overlay receive keys in %s mode and resumes afterward",
    (mode) => {
      const { begin, host, tui, ctx, widget } = createHarness(
        [item("deploy production", 100)],
        mode,
      );

      begin();
      host.terminalInput("de");
      const query = widget();
      const queryFocus = tui.getFocusedComponent();
      const dialog = new Input();
      const submit = vi.fn<(value: string) => void>();
      dialog.onSubmit = submit;
      const overlay = tui.showOverlay(dialog);
      expect(widget()).not.toContain(CURSOR_MARKER);
      host.terminalInput("dialog text");
      host.terminalInput("\r");
      expect(dialog.getValue()).toBe("dialog text");
      expect(submit).toHaveBeenCalledExactlyOnceWith("dialog text");
      expect(ctx.ui.getEditorText()).toBe("deploy production");
      expect(ctx.ui.onTerminalInput).not.toHaveBeenCalled();
      overlay.hide();
      expect(tui.getFocusedComponent()).toBe(queryFocus);
      expect(widget()).toBe(query);
      host.terminalInput("ploy");
      host.terminalInput("\r");
      expect(widget()).toBeUndefined();
    },
  );

  describe.each(["regular", "fullscreen"] as const)(
    "overlay draft ownership in %s mode",
    (mode) => {
      it.each([
        { action: "selection", key: "\u001B[A" },
        { action: "query editing", key: " production" },
        { action: "query clearing", key: "\u0015" },
      ])("preserves external edits across $action", ({ key }) => {
        const { begin, host, tui, ctx } = createHarness(
          [item("deploy production", 200), item("deploy staging", 100)],
          mode,
        );

        ctx.ui.setEditorText("original draft");

        // Exercise repeated ownership handoffs, including an intentionally empty draft.
        for (const draft of ["new overlay draft", ""]) {
          begin();
          host.terminalInput("deploy");
          const overlay = tui.showOverlay(new Input());
          ctx.ui.setEditorText(draft);
          overlay.hide();
          host.terminalInput(key);
          host.terminalInput("\u001B");
          expect(ctx.ui.getEditorText()).toBe(draft);
        }
      });

      it("retains the original draft across unchanged overlay previews", () => {
        const { begin, host, tui, ctx } = createHarness(
          [item("deploy production", 200), item("deploy staging", 100)],
          mode,
        );

        ctx.ui.setEditorText("original draft");
        begin();
        host.terminalInput("deploy");
        const overlay = tui.showOverlay(new Input());
        overlay.hide();
        host.terminalInput("\u001B[A");
        expect(ctx.ui.getEditorText()).toBe("deploy staging");
        host.terminalInput("\u001B");
        expect(ctx.ui.getEditorText()).toBe("original draft");
      });
    },
  );

  it.each(["regular", "fullscreen"] as const)(
    "preserves an unsent draft through unchanged non-overlay dialog round-trips in %s mode",
    (mode) => {
      const { begin, host, tui, ctx, previousFocus, widget } = createHarness(
        [item("deploy production", 200), item("deploy staging", 100)],
        mode,
      );

      ctx.ui.setEditorText("original unsent draft");
      begin();
      host.terminalInput("deploy");
      host.terminalInput("\u0012");
      expect(ctx.ui.getEditorText()).toBe("deploy staging");

      for (let round = 0; round < 2; round++) {
        const dialog = new Input();
        tui.setFocus(dialog);
        host.terminalInput("dialog answer");
        expect(dialog.getValue()).toBe("dialog answer");
        tui.setFocus(previousFocus);
        begin();
        expect(ctx.ui.getEditorText()).toBe("original unsent draft");

        if (round === 0) {
          host.terminalInput("\u001B");
          expect(ctx.ui.getEditorText()).toBe("original unsent draft");
          begin();
        }
      }

      host.terminalInput("production");
      expect(ctx.ui.getEditorText()).toBe("deploy production");
      host.terminalInput("\u001B");
      expect(ctx.ui.getEditorText()).toBe("original unsent draft");
      expect(widget()).toBeUndefined();
    },
  );

  it("recognizes an unchanged preview after the native editor normalizes it", () => {
    const { begin, host, tui, ctx } = createHarness([item("deploy\tproduction\r\nnow", 100)]);
    Object.assign(ctx.sessionManager, { getSessionDir: () => "", getHeader: () => undefined });
    installHistoryEditor({ type: "session_start", reason: "startup" }, ctx, () => []);
    const editor = ctx.ui.getEditorComponent()?.(tui, editorTheme, createKeybindings());

    if (!editor) throw new Error("Expected editor");
    vi.spyOn(ctx.ui, "getEditorText").mockImplementation(() => editor.getText());
    vi.spyOn(ctx.ui, "setEditorText").mockImplementation((text) => editor.setText(text));
    tui.addChild(editor);
    tui.setFocus(editor);
    editor.setText("original draft");
    begin();
    host.terminalInput("deploy");
    expect(editor.getText()).toBe("deploy    production\nnow");
    tui.setFocus(new Input());
    tui.setFocus(editor);
    begin();
    host.terminalInput("\u001B");
    expect(editor.getText()).toBe("original draft");
  });

  it.each(["unchanged", "edited", "cleared"])(
    "reconciles a %s preview when disposing a suspended search",
    (state) => {
      const { begin, host, tui, ctx, reset } = createHarness([item("deploy production", 100)]);
      ctx.ui.setEditorText("original draft");
      begin();
      host.terminalInput("deploy");
      const dialog = new Input();
      tui.setFocus(dialog);

      if (state === "edited") ctx.ui.setEditorText("newer draft");

      if (state === "cleared") ctx.ui.setEditorText("");
      reset();
      expect(ctx.ui.getEditorText()).toBe(
        state === "unchanged" ? "original draft" : state === "edited" ? "newer draft" : "",
      );
      expect(tui.getFocusedComponent()).toBe(dialog);
    },
  );

  it("preserves a genuinely cleared draft when starting the next search", () => {
    const { begin, host, tui, ctx, previousFocus } = createHarness([
      item("deploy production", 100),
    ]);

    ctx.ui.setEditorText("original draft");
    begin();
    host.terminalInput("deploy");
    tui.setFocus(new Input());
    ctx.ui.setEditorText("");
    tui.setFocus(previousFocus);
    begin();
    host.terminalInput("deploy");
    host.terminalInput("\u001B");
    expect(ctx.ui.getEditorText()).toBe("");
  });

  it("starts a fresh search after a non-overlay dialog without losing the new draft", () => {
    const { begin, host, tui, widget, ctx } = createHarness([item("deploy production", 100)]);
    begin();
    host.terminalInput("deploy");
    const dialog = new Input();
    tui.addChild(dialog);
    tui.setFocus(dialog);
    host.terminalInput("dialog text");
    expect(dialog.getValue()).toBe("dialog text");
    const replacement = new Input();
    tui.addChild(replacement);
    tui.setFocus(replacement);
    host.terminalInput("editor text");
    expect(replacement.getValue()).toBe("editor text");
    ctx.ui.setEditorText("new draft");
    begin();
    expect(widget()).toContain(CURSOR_MARKER);
    expect(stripAnsi((widget() ?? "").replaceAll(CURSOR_MARKER, "")).trimEnd()).toBe("history:");
    host.terminalInput("deploy");
    expect(ctx.ui.getEditorText()).toBe("deploy production");
    host.terminalInput("\u001B");
    expect(ctx.ui.getEditorText()).toBe("new draft");
    expect(tui.getFocusedComponent()).toBe(replacement);
    expect(widget()).toBeUndefined();
  });

  it("drops a paste interrupted by focus loss rather than swallowing later query keys", () => {
    const { begin, host, tui, ctx } = createHarness([item("deploy production", 100)]);
    begin();
    host.terminalInput("de");
    host.terminalInput("\u001B[200~discarded");
    const dialog = new Input();
    const overlay = tui.showOverlay(dialog);
    host.terminalInput("dialog text");
    expect(dialog.getValue()).toBe("dialog text");
    overlay.hide();
    host.terminalInput("ploy");
    host.terminalInput("\r");
    expect(ctx.ui.getEditorText()).toBe("deploy production");
  });

  it("sanitizes chunked paste before editing, undo or search key handling", () => {
    const { begin, ctx, host, widget } = createHarness([item("deploy production", 100)]);
    ctx.ui.setEditorText("draft");
    begin();
    host.terminalInput("\u001B[200~de");
    host.terminalInput("\r");
    host.terminalInput("\u001B");
    host.terminalInput("\u0003\u0015\u0080ploy\t\n\u001B[20");
    host.terminalInput("1~");
    expect(ctx.ui.getEditorText()).toBe("deploy production");
    expect(stripAnsi((widget() ?? "").replaceAll(CURSOR_MARKER, ""))).toContain("history: deploy");
    host.terminalInput("\u001F");
    expect(ctx.ui.getEditorText()).toBe("draft");
    host.terminalInput("\u001B[100u"); // Kitty printable d
    expect(ctx.ui.getEditorText()).toBe("deploy production");
  });

  it("scrolls long queries within the widget width", () => {
    const { begin, host, widget } = createHarness([]);
    begin();
    host.terminalInput("a".repeat(200) + "tail");
    expect(visibleWidth(widget(35) ?? "")).toBeLessThanOrEqual(35);
    expect(stripAnsi((widget(35) ?? "").replaceAll(CURSOR_MARKER, ""))).toContain("tail");
    host.terminalInput("\u0001");
    expect(widget(35)).toContain("\u001B[7ma");
    expect(visibleWidth(widget(5) ?? "")).toBeLessThanOrEqual(5);
  });

  it("accepts bracketed paste without leaking terminal sequences", () => {
    const { begin, ctx, host } = createHarness([item("deploy production", 100)]);
    ctx.ui.setEditorText("draft");

    begin();
    host.terminalInput("\u001B[200~de\u0080ploy\u001B[201~");
    expect(ctx.ui.getEditorText()).toBe("deploy production");

    host.terminalInput("\u0015");
    host.terminalInput("\u001B[3~");
    expect(ctx.ui.getEditorText()).toBe("draft");
  });
});
