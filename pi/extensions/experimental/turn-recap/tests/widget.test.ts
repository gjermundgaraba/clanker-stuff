import {
  stripTerminalSequences,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";

import {
  createIdentityTheme,
  createMockTui,
} from "../../../../tests/harness/tui.js";
import type { LiveState } from "../card.js";
import { parseRollingFont } from "../font.js";
import type { RollingFont } from "../font.js";
import { ROLL_FRAME_MS } from "../rolling.js";
import { createLiveWidget } from "../widget.js";
import { fontManifest, snapshot } from "./fixtures.js";

const font = parseRollingFont(fontManifest());

const hasFrames = (text: string) => /[\u{F0000}-\u{FFFFD}]/u.test(text);

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

const setup = (configured: RollingFont | undefined) => {
  const { metrics } = snapshot();

  const running: LiveState = { elapsedMs: 1000, metrics };

  let state: LiveState | undefined = running;
  const theme = createIdentityTheme();
  const tui = createMockTui();
  const request = vi.spyOn(tui, "requestRender");
  const widget = createLiveWidget(tui, theme, () => state, configured);
  onTestFinished(() => {
    widget.dispose();
  });

  return {
    metrics,
    running,
    theme,
    tui,
    request,
    widget,
    show(next: LiveState | undefined) {
      state = next;
    },
  };
};

describe("live widget", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => vi.useRealTimers());

  it("wakes once per displayed second when nothing rolls", () => {
    const env = setup(undefined);
    expect(plain(env.widget.render(80))).toContain("1s elapsed");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(env.request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(env.request).toHaveBeenCalledOnce();
  });

  it("snaps first observations, rolls observed changes, then settles as ordinary text", () => {
    const env = setup(font);
    expect(plain(env.widget.render(80))).toContain("1s elapsed");
    env.running.elapsedMs = 2000;
    // ASCII start still moves.
    expect(plain(env.widget.render(80))).toContain("1s elapsed");
    vi.advanceTimersByTime(Math.ceil(ROLL_FRAME_MS));
    expect(env.request).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(130 - Math.ceil(ROLL_FRAME_MS));
    const middle = env.widget.render(80);
    expect(plain(middle)).toContain(`${font.glyph("1", "2", 0.5)}s elapsed`);
    expect(middle.every((line) => visibleWidth(line) <= 80)).toBe(true);
    vi.advanceTimersByTime(129);
    env.widget.render(80);
    vi.advanceTimersByTime(1);
    expect(plain(env.widget.render(80))).toContain("2s elapsed");

    // Settled: the next wake is the next second, not another frame.
    env.request.mockClear();
    vi.advanceTimersByTime(1000);
    expect(env.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("colors numeric substitutions as their value on every render", () => {
    const env = setup(font);

    const foreground = vi
      .spyOn(env.theme, "fg")
      .mockImplementation(
        (tone, text) =>
          `\u001B[${tone === "text" ? "37" : "90"}m${text}\u001B[39m`
      );

    env.widget.render(80);
    env.metrics.toolCalls = 4;
    env.metrics.usage.input = 110;
    env.metrics.contextGrowth = 500;
    env.widget.render(80);
    vi.advanceTimersByTime(130);
    const middle = env.widget.render(80);
    expect(plain(middle)).toContain(` · ${font.glyph("3", "4", 0.5)} tools`);
    expect(plain(middle)).toContain(
      `3${font.glyph("7", "8", 0.5)}0 processed · +${font.glyph("4", "5", 0.5)}00 context`
    );
    expect(middle.join("")).toContain(
      `\u001B[37m+${font.glyph("4", "5", 0.5)}00\u001B[39m\u001B[90m context\u001B[39m`
    );
    foreground.mockImplementation(
      (_tone, text) => `\u001B[36m${text}\u001B[39m`
    );
    env.widget.invalidate();
    expect(env.widget.render(80).join("")).toContain(
      `\u001B[36m3${font.glyph("7", "8", 0.5)}0\u001B[39m`
    );
  });

  it("preserves motion across resizing", () => {
    const env = setup(font);
    env.widget.render(80);
    env.metrics.toolCalls = 4;
    env.widget.render(80);
    vi.advanceTimersByTime(130);
    const expected = `${font.glyph("3", "4", 0.5)} tools`;
    expect(plain(env.widget.render(70))).toContain(expected);
  });

  it("allows clipped rolling numbers without overflowing or scheduling frames forever", () => {
    const env = setup(font);
    env.metrics.usage.input = 111;
    env.widget.render(80);
    env.metrics.usage.input = 222;
    env.widget.render(80);
    vi.advanceTimersByTime(130);
    // Processed tokens are 381 → 492; width twenty truncates that field away.
    expect(plain(env.widget.render(80))).toContain(font.glyph("3", "4", 0.5));
    expect(hasFrames(plain(env.widget.render(20)))).toBe(false);

    for (const width of [1, 2, 3, 4, 10, 20, 80]) {
      expect(
        env.widget.render(width).every((line) => visibleWidth(line) <= width)
      ).toBe(true);
    }

    vi.advanceTimersByTime(770);
    expect(hasFrames(plain(env.widget.render(80)))).toBe(false);
    env.request.mockClear();
    vi.advanceTimersByTime(500);
    expect(env.request).not.toHaveBeenCalled();
  });

  it("stops every timer when settled", () => {
    const env = setup(font);
    env.widget.render(80);
    env.metrics.toolCalls = 4;
    env.widget.render(80);
    env.show(undefined);
    expect(hasFrames(plain(env.widget.render(80)))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    env.request.mockClear();
    vi.advanceTimersByTime(5000);
    expect(env.request).not.toHaveBeenCalled();
  });

  it("clears its timer when disposed", () => {
    const env = setup(font);
    env.widget.render(80);
    env.widget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders nothing when idle", () => {
    const env = setup(font);
    env.show(undefined);
    expect(env.widget.render(80)).toStrictEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reaches a real terminal with rolling frames, then settles to ordinary digits", async () => {
    const writes: string[] = [];

    const terminal: Terminal = {
      columns: 80,
      rows: 24,
      kittyProtocolActive: false,
      start() {},
      stop() {},
      async drainInput() {},
      write: (data) => {
        writes.push(data);
      },
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
      setProgramStatus() {},
    };

    let state: LiveState | undefined = {
      elapsedMs: 1000,
      metrics: snapshot().metrics,
    };

    const tui = new TuiMainScreen(terminal);

    const widget = createLiveWidget(
      tui,
      createIdentityTheme(),
      () => state,
      font
    );

    onTestFinished(() => {
      widget.dispose();
      tui.stop();
    });
    tui.addChild(widget);
    tui.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(writes.join("")).toContain("370 processed");
    writes.length = 0;

    state.metrics.toolCalls = 4;

    tui.requestRender();
    await vi.advanceTimersByTimeAsync(180);
    expect(hasFrames(writes.join(""))).toBe(true);
    writes.length = 0;
    state = undefined;
    tui.requestRender();
    await vi.advanceTimersByTimeAsync(50);
    expect(hasFrames(writes.join(""))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
