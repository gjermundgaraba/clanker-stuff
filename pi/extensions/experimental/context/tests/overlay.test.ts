import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createIdentityTheme, createMockTui } from "../../../../tests/harness/tui.js";
import { ContextOverlay } from "../overlay.js";
import type { ContextSnapshot } from "../snapshot.js";
import { fixtureJsonTools, fixturePart, fixtureSnapshot } from "./fixtures/snapshot.js";

const { copyToClipboard, highlightCode } = vi.hoisted(() => ({
  copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
  highlightCode: vi.fn<(code: string, lang?: string) => string[]>(),
}));
vi.mock(import("@earendil-works/pi-coding-agent"), async (importOriginal) => ({
  ...(await importOriginal()),
  copyToClipboard,
  highlightCode,
}));

const setup = (
  snapshot: ContextSnapshot = fixtureSnapshot(),
  keybindings = new KeybindingsManager(TUI_KEYBINDINGS),
) => {
  const tui = createMockTui({ rows: 24 });
  const done = vi.fn();
  const notify = vi.fn();
  const overlay = new ContextOverlay(
    tui,
    createIdentityTheme(),
    keybindings,
    snapshot,
    { notify },
    done,
  );
  overlay.focused = true;
  const render = (width = 120) => overlay.render(width).join("\n");
  const press = (...keys: string[]) => {
    for (const key of keys) {
      overlay.handleInput(key);
      render();
    }
  };
  return { overlay, tui, done, notify, render, press };
};

beforeEach(() => {
  copyToClipboard.mockReset();
  highlightCode.mockReset();
  let generation = 0;
  highlightCode.mockImplementation((code) => {
    generation += 1;
    return code.split("\n").map((line) => `HL${generation}:${line}`);
  });
});

describe("overlay", () => {
  it("keeps search active after confirmation so matches can be navigated and copied", async () => {
    const snapshot = {
      ...fixtureSnapshot(),
      messages: [
        fixturePart("1. user", "needle first", 3),
        fixturePart("2. user", "needle second", 3),
        fixturePart("3. user", "unrelated", 3),
      ],
    };
    const t = setup(snapshot);
    t.press("/", ..."needle".split(""));
    expect(t.render()).toContain(CURSOR_MARKER);
    t.press("\r", "j", "j", "y");
    expect(t.render()).not.toContain(CURSOR_MARKER);
    expect(t.render()).not.toContain("3. user");
    expect(copyToClipboard).toHaveBeenCalledWith("needle second");
    await vi.waitFor(() =>
      expect(t.notify).toHaveBeenCalledWith(expect.stringContaining("Copied"), "info"),
    );
    t.press("\u001B");
    expect(t.render()).toContain("System prompt");
    expect(t.done).not.toHaveBeenCalled();
    t.press("\u001B");
    expect(t.done).toHaveBeenCalledOnce();
  });

  it("uses native paste and grapheme deletion, and handles no matches", () => {
    const t = setup();
    t.press("/", "\u001B[200~missing🦄\u001B[201~");
    expect(t.render()).toContain("missing🦄");
    expect(t.render()).toContain("No matches");
    t.press("\u007F");
    expect(t.render()).toContain("/missing");
    expect(t.render()).not.toContain("🦄");
    t.press("\r", "y");
    expect(copyToClipboard).not.toHaveBeenCalled();
    t.press("\u001B");
    expect(t.render()).toContain("System prompt");
  });

  it("accepts Kitty-encoded letters for the vim-style aliases and copy", async () => {
    const t = setup({ ...fixtureSnapshot(), tools: [fixturePart("read", "READ BODY", 3)] });
    t.press("\u001B[106u", "\u001B[106u");
    expect(t.render()).toContain("READ BODY");
    t.press("\u001B[121u");
    expect(copyToClipboard).toHaveBeenCalledWith("READ BODY");
    t.press("\u001B[104u");
    expect(t.render()).toContain("Expand this group");
    t.press("\u001B[108u");
    expect(t.render()).toContain("READ BODY");
    await vi.waitFor(() => expect(t.notify).toHaveBeenCalled());
  });

  it("lets configured actions win over the built-in vim aliases", () => {
    const t = setup(
      { ...fixtureSnapshot(), tools: fixtureJsonTools(30) },
      new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.pageDown": "j" }),
    );
    t.render();
    t.press("j");
    // Page size is the body height (10 rows here), so one press lands on tool-8, not tool-0.
    expect(t.render()).toMatch(/▌.*tool-8/);
    t.press("k");
    expect(t.render()).toMatch(/▌.*tool-7/);
  });

  it("marks tree token counts as estimates", () => {
    const t = setup({ ...fixtureSnapshot(), tools: [fixturePart("read", "{}", 1234)] });
    expect(t.render()).toMatch(/read.*~1,234/);
  });

  it("honors remapped navigation, confirmation and cancellation", () => {
    const t = setup(
      fixtureSnapshot(),
      new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.select.down": "n",
        "tui.select.up": "p",
        "tui.select.confirm": "o",
        "tui.select.cancel": "q",
      }),
    );
    t.press("n", "o");
    expect(t.render()).toContain("Expand this group");
    t.press("q", "p", "o");
    expect(t.render()).toContain("You are pi.");
    t.press("q", "q");
    expect(t.done).toHaveBeenCalledOnce();
  });

  it.each([80, 120])(
    "shows multiline details and scrolls through the entire body at %s columns",
    (width) => {
      const t = setup(
        fixtureSnapshot({ prompt: Array.from({ length: 60 }, (_, i) => `LINE-${i}`).join("\n") }),
      );
      t.overlay.render(width);
      t.overlay.handleInput("\r");
      expect(t.render(width)).toContain("LINE-0");
      expect(t.render(width)).toContain("LINE-1");
      for (let i = 0; i < 10; i++) {
        t.overlay.handleInput("\u001B[6~");
        t.overlay.render(width);
      }
      expect(t.render(width)).toContain("LINE-59");
      expect(t.render(width)).not.toContain("LINE-0");
      for (let i = 0; i < 10; i++) {
        t.overlay.handleInput("\u001B[5~");
        t.overlay.render(width);
      }
      expect(t.render(width)).toContain("LINE-0");
    },
  );

  it("keeps the last selected row visible after scrolling and resizing a short terminal", () => {
    const t = setup({
      ...fixtureSnapshot(),
      tools: Array.from({ length: 50 }, (_, i) => fixturePart(`tool-${i}`, `definition ${i}`, 10)),
    });
    t.press("j", "l");
    for (let i = 0; i < 50; i++) t.press("j");
    expect(t.render(80)).toContain("tool-49");
    Object.assign(t.tui.terminal, { rows: 12 });
    for (const width of [80, 120, 30]) {
      const lines = t.overlay.render(width);
      expect(lines.length).toBeLessThanOrEqual(10);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).toContain("tool-49");
    }
  });

  it.each([12, 13])("keeps at least one details content row on a %s-row terminal", (rows) => {
    const t = setup(fixtureSnapshot({ prompt: "CONTENT-LINE-A\nCONTENT-LINE-B" }));
    Object.assign(t.tui.terminal, { rows });
    t.render();
    t.press("\r");
    expect(t.render()).toContain("CONTENT-LINE-A");
    expect(t.render()).not.toContain("■ system");
    t.press("j");
    expect(t.render()).toContain("CONTENT-LINE-B");
  });

  it("drops preview focus when the split pane disappears on resize", () => {
    const t = setup({ ...fixtureSnapshot(), tools: [fixturePart("read", "{}", 3)] });
    t.render(120);
    t.press("\t");
    expect(t.render(120)).toContain("tab tree");
    t.overlay.render(70);
    t.overlay.handleInput("j");
    t.overlay.handleInput("h");
    expect(t.render(70)).not.toContain("read");
    expect(t.render(70)).toContain("Active tools (1)");
  });

  it("highlights only the final parent when collapsing from deep inside a group", () => {
    const t = setup({ ...fixtureSnapshot(), tools: fixtureJsonTools(100) });
    t.render();
    for (let i = 0; i < 101; i++) t.overlay.handleInput("j");
    expect(t.render()).toContain("HL");
    highlightCode.mockClear();
    t.press("h");
    expect(highlightCode).not.toHaveBeenCalled();
    expect(t.render()).toContain("Expand this group");
    t.press("l");
    expect(highlightCode).toHaveBeenCalledOnce();
  });

  it("rebuilds highlighted previews on invalidate so theme changes apply", () => {
    const t = setup({ ...fixtureSnapshot(), tools: fixtureJsonTools(1) });
    t.press("j", "j");
    expect(t.render()).toContain("HL1:");
    t.overlay.invalidate();
    expect(t.render()).toContain("HL2:");
    expect(t.render()).not.toContain("HL1:");
  });

  it("copies the full original body, not the preview, and reports clipboard failures", async () => {
    const body = "\u001B[31moriginal\u001B[0m\n" + "long body ".repeat(1000);
    const t = setup(fixtureSnapshot({ prompt: body }));
    expect(t.render()).not.toContain("\u001B[31m");
    copyToClipboard.mockRejectedValueOnce(new Error("unavailable"));
    t.press("y");
    expect(copyToClipboard).toHaveBeenCalledWith(body);
    await vi.waitFor(() => expect(t.notify).toHaveBeenCalledWith("Clipboard copy failed", "error"));
  });
});

const mouse = (overrides: Partial<TuiMouseEvent>): TuiMouseEvent => ({
  type: "wheel",
  button: "none",
  x: 80,
  y: 9,
  screenX: 80,
  screenY: 9,
  width: 120,
  height: 21,
  shift: false,
  alt: false,
  ctrl: false,
  wheelDelta: 3,
  ...overrides,
});

describe("pane scrolling", () => {
  const snapshot = () =>
    fixtureSnapshot({ prompt: Array.from({ length: 80 }, (_, i) => `LINE-${i}`).join("\n") });

  it("scrolls the right pane with Tab and the configured navigation keys without changing tree selection", () => {
    const t = setup(snapshot());
    t.render();
    t.press("\t", "j");
    expect(t.render()).toContain("LINE-1");
    expect(t.render()).not.toContain("LINE-0");
    t.press("\u001B[6~");
    expect(t.render()).toContain("LINE-15");
    expect(t.render()).toContain("Active tools");
    t.press("\t", "j");
    expect(t.render()).toContain("Expand this group");
  });

  it("routes wheel input to the pane under the pointer, clamps scrolling, and focuses panes on click", () => {
    const t = setup(snapshot());
    t.render();
    t.overlay.handleMouse(mouse({ wheelDelta: 3 }));
    expect(t.render()).toContain("LINE-3");
    expect(t.render()).not.toContain("LINE-0");
    t.overlay.handleMouse(mouse({ wheelDelta: 1000 }));
    expect(t.render()).toContain("LINE-79");
    t.overlay.handleMouse(mouse({ wheelDelta: -1000 }));
    expect(t.render()).toContain("LINE-0");
    t.overlay.handleMouse(mouse({ type: "press", button: "left" }));
    t.press("j");
    expect(t.render()).toContain("LINE-1");
    t.overlay.handleMouse(mouse({ x: 2, y: 9, type: "press", button: "left" }));
    expect(t.render()).toContain("Expand this group");
    t.overlay.handleMouse(mouse({ x: 2, y: 9, wheelDelta: -1 }));
    expect(t.render()).toContain("LINE-0");
    t.overlay.handleMouse(mouse({ y: 2, wheelDelta: 3 }));
    expect(t.render()).toContain("LINE-0");
  });

  it("scrolls narrow full-width details with the wheel too", () => {
    const t = setup(snapshot());
    t.overlay.render(80);
    t.overlay.handleInput("\r");
    t.render(80);
    t.overlay.handleMouse(mouse({ width: 80, x: 20, wheelDelta: 5 }));
    expect(t.render(80)).toContain("LINE-5");
    expect(t.render(80)).not.toContain("LINE-0");
  });

  it("decodes regular-mode mouse reports using live overlay bounds and restores reporting on blur/dispose", () => {
    const t = setup(snapshot());
    const write = vi.fn();
    Object.assign(t.tui, { mode: "regular" });
    Object.assign(t.tui.terminal, { write });
    const handle = t.tui.showOverlay(t.overlay);
    let col = 10;
    handle.getBounds = () => ({ col, row: 2, width: 120, height: 21 });
    t.overlay.attachMouse(handle);
    expect(write).toHaveBeenLastCalledWith("\u001B[?1000h\u001B[?1006h");
    t.render();
    t.press("\u001B[<65;91;12M");
    expect(t.render()).toContain("LINE-3");
    col = 20;
    t.press("\u001B[<65;101;12M");
    expect(t.render()).toContain("LINE-6");
    t.overlay.focused = false;
    expect(write).toHaveBeenLastCalledWith("\u001B[?1006l\u001B[?1000l");
    t.overlay.focused = true;
    expect(write).toHaveBeenLastCalledWith("\u001B[?1000h\u001B[?1006h");
    t.overlay.dispose();
    expect(write).toHaveBeenLastCalledWith("\u001B[?1006l\u001B[?1000l");
    t.overlay.dispose();
    expect(write).toHaveBeenCalledTimes(4);
  });

  it("leaves fullscreen mouse reporting to Pi", () => {
    const t = setup(snapshot());
    const write = vi.fn();
    Object.assign(t.tui, { mode: "fullscreen" });
    Object.assign(t.tui.terminal, { write });
    t.overlay.attachMouse(t.tui.showOverlay(t.overlay));
    t.overlay.dispose();
    expect(write).not.toHaveBeenCalled();
  });
});
