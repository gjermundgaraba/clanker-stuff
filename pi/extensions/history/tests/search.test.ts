import { stripVTControlCharacters } from "node:util";

import {
  CURSOR_MARKER,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { createIdentityTheme } from "../../../tests/harness/tui.js";
import { createSearch } from "../search.js";

const open = (texts: string[]) => {
  const done = vi.fn<(text: string | undefined) => void>();

  const search = createSearch(
    texts.map((text, index) => ({ text, timestamp: texts.length - index })),
    createIdentityTheme(),
    done,
  );

  search.focused = true;

  const type = (...keys: string[]) => {
    for (const key of keys) search.handleInput?.(key);
  };

  const screen = (width = 80) =>
    search
      .render(width)
      .map((line) => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")));

  return { done, render: (width = 80) => search.render(width), screen, type };
};

describe("history search", () => {
  it("previews matches newest-first and moves within their bounds", () => {
    const { done, screen, type } = open(["Check deploy status", "Deploy production", "other"]);
    type("deploy");
    expect(screen()).toEqual([expect.stringContaining("1/2"), "Check deploy status"]);

    type("\u0012", "\u0012");
    expect(screen()[1]).toBe("Deploy production");
    type("\u0013", "\u0013", "\u001B[B");
    expect(screen()[1]).toBe("Check deploy status");
    type("\u001B[A", "\r");
    expect(done).toHaveBeenCalledExactlyOnceWith("Deploy production");
  });

  it("moves with Pi's configured selection keys", () => {
    setKeybindings(
      new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.select.down": "ctrl+n",
        "tui.select.up": "ctrl+p",
      }),
    );
    onTestFinished(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));
    const { done, screen, type } = open(["Check deploy status", "Deploy production"]);
    type("deploy", "\u0010");
    expect(screen()[1]).toBe("Deploy production");
    type("\u000E", "\r");
    expect(done).toHaveBeenCalledExactlyOnceWith("Check deploy status");
  });

  it("matches literal text case-insensitively, including Unicode", () => {
    const { done, type } = open(["ÉCOLE (draft)", "ecole draft"]);
    type("école (", "\r");
    expect(done).toHaveBeenCalledExactlyOnceWith("ÉCOLE (draft)");
  });

  it("stays open without a match and cancels with Escape or Ctrl+C", () => {
    const first = open(["known prompt"]);
    first.type("missing", "\r");
    expect(first.screen()).toEqual([expect.stringContaining("no match")]);
    expect(first.done).not.toHaveBeenCalled();
    first.type("\u001B");
    expect(first.done).toHaveBeenCalledExactlyOnceWith(undefined);

    const second = open(["known prompt"]);
    second.type("known", "\u0003");
    expect(second.done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("broadens results when the query is edited", () => {
    const { screen, type } = open(["alpha beta", "alpha gamma"]);
    type("alpha g");
    expect(screen()[0]).toContain("1/1");
    type("\u007F");
    expect(screen()[0]).toContain("1/2");
  });

  it("removes control characters from pasted queries", () => {
    const { done, type } = open(["paste target"]);
    type("\u001B[200~paste\u0007 \u001Btarget\u001B[201~", "\r");
    expect(done).toHaveBeenCalledExactlyOnceWith("paste target");
  });

  it("limits long previews to the width and a few lines", () => {
    const long = Array.from({ length: 12 }, (_, index) => `line ${index} ${"x".repeat(100)}`);
    const { screen, type } = open([long.join("\n")]);
    type("line");
    const lines = screen(40);
    expect(lines).toHaveLength(10);
    expect(lines.at(-1)).toBe("… 4 more lines");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(screen(8).every((line) => visibleWidth(line) <= 8)).toBe(true);
  });

  it("renders terminal controls in stored history inert", () => {
    const { render, type } = open(["alpha\u001B[2J\u0007‮beta"]);
    type("alpha");
    // Raw output: the screen helper would strip a leaked escape sequence before the assertion.
    expect(render()[1]).toBe("alphabeta");
  });
});
