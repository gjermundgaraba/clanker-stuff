import assert from "node:assert/strict";
import manifest from "../assets/shapes.json" with { type: "json" };
import { fileURLToPath } from "node:url";

import { acquireEditorHost } from "@clanker-stuff/editor";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  createCustomUiDriver,
  createKeybindings,
  createMockTui,
  createStatusIndicator,
} from "../../../../tests/harness/tui.js";
import extension from "../index.js";

type Animation = typeof manifest.rubik;

const glyph = (codepoint: number) => `${String.fromCodePoint(codepoint)} `;

const defaultFrames = manifest.animations.orb.cyan.dark.frames.map(glyph);

const shapeOptions = ["rubik", "orb", "cube", "octahedron", "tetrahedron"] as const;

const colorOptions = [
  "blue",
  "purple",
  "pink",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "gray",
] as const;

/** The Ghostty font-codepoint-map range the dialog footer shows; pinned to the bundled font. */
const mappingRange = "U+100000-U+105C6A";

/** The settings dialog rows in navigation order, as spinner.ts builds them. */
const settingRows = [
  "playback",
  "background",
  "working-shape",
  "working-color",
  "working-enabled",
  "retry-shape",
  "retry-color",
  "retry-enabled",
  "compaction-shape",
  "compaction-color",
  "compaction-enabled",
  "summary-shape",
  "summary-color",
  "summary-enabled",
] as const;

type SettingRow = (typeof settingRows)[number];

const down = "\u001B[B";

const space = " ";

const escape = "\u001B";

/** Presses that move the cursor from `from` to `target`, cycling its value `presses` times. */
const rowKeys = (from: SettingRow, target: SettingRow, presses: number): string[] => {
  const distance =
    (settingRows.indexOf(target) - settingRows.indexOf(from) + settingRows.length) %
    settingRows.length;

  return [
    ...Array.from({ length: distance }, () => down),
    ...Array.from({ length: presses }, () => space),
  ];
};

/** Presses cycling a value list from `current` to `target`; a full lap when equal, so a change always applies. */
const cycle = (list: readonly string[], current: string, target: string): number =>
  (list.indexOf(target) - list.indexOf(current) + list.length) % list.length || list.length;

function setup(mode: ExtensionContext["mode"] = "tui") {
  initTheme("dark");
  const host = createExtensionHost(extension);
  const setWorkingIndicator = vi.fn<ExtensionContext["ui"]["setWorkingIndicator"]>();
  const driver = createCustomUiDriver({});

  const ctx = host.createContext({
    hasUI: mode === "tui" || mode === "rpc",
    mode,
    ui: { custom: driver.custom, setWorkingIndicator },
  });

  return { ctx, driver, host, setWorkingIndicator };
}

type Dialog = {
  close: () => Promise<void>;
  edit: (target: SettingRow, presses: number) => void;
  render: () => string;
};

const openDialog = async (
  host: ReturnType<typeof createExtensionHost>,
  driver: ReturnType<typeof createCustomUiDriver>,
  ctx: ExtensionCommandContext,
  args = "",
): Promise<Dialog> => {
  const previous = driver.component;
  const pending = host.runCommand("shape-spinner", args, ctx);

  const component = await vi.waitFor(() => {
    const current = driver.component;

    if (current === undefined || current === previous) {
      throw new Error("The settings dialog did not mount");
    }

    return current;
  });

  let cursor: SettingRow = "playback";

  return {
    async close() {
      component.handleInput?.(escape);
      await pending;
    },
    edit(target, presses) {
      for (const key of rowKeys(cursor, target, presses)) component.handleInput?.(key);

      cursor = target;
    },
    render: () => component.render(80).join("\n"),
  };
};

const statusIndicator = (kind: Parameters<typeof createStatusIndicator>[0]) => {
  const indicator = createStatusIndicator(kind);

  return { indicator, setIndicator: vi.spyOn(indicator, "setIndicator") };
};

const identity = (text: string) => text;

const editorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

const mountEditor = (ctx: ExtensionContext) => {
  const editorHost = acquireEditorHost(ctx);

  if (editorHost === undefined) throw new Error("The shape spinner did not join the shared editor");

  return editorHost.create(createMockTui(), editorTheme, createKeybindings());
};

const framesOf = (
  shape: keyof typeof manifest.animations,
  color: keyof typeof manifest.animations.orb,
  background: keyof typeof manifest.animations.orb.cyan = "dark",
) => manifest.animations[shape][color][background];

const previewLine = (rendered: string, label: string) =>
  rendered.split("\n").find((line) => line.includes(label));

describe("shape spinner", () => {
  it("registers one command and delegates playback to Pi once at startup", async () => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(ctx);
    expect([...host.getRegisteredCommands().keys()]).toEqual(["shape-spinner"]);
    expect(host.getRegisteredTools()).toHaveLength(0);
    expect(setWorkingIndicator).toHaveBeenCalledExactlyOnceWith({
      frames: defaultFrames,
      intervalMs: 20,
    });

    for (const type of ["agent_start", "turn_start", "turn_end", "agent_end", "agent_settled"]) {
      await host.emit(type, { type }, ctx);
    }

    expect(setWorkingIndicator).toHaveBeenCalledTimes(1);
    expect(host.getEditorFactory()).toBeTypeOf("function");
    expect(host.getNotifications()).toHaveLength(0);
    expect(host.getSentMessages()).toHaveLength(0);
    expect(host.getAppendedEntries()).toHaveLength(0);
  });

  it.each(["rpc", "print", "json"] as const)("does not use UI in %s mode", async (mode) => {
    const { ctx, host, setWorkingIndicator } = setup(mode);
    await host.emitSessionStart(ctx);

    for (const action of [
      "",
      "on",
      "static",
      "off",
      "preview",
      "rubik",
      "cube",
      "light",
      "invalid",
      "purple",
    ]) {
      await host.runCommand("shape-spinner", action, ctx);
    }

    expect(setWorkingIndicator).not.toHaveBeenCalled();
    expect(host.getEditorFactory()).toBeUndefined();
    expect(host.getNotifications()).toHaveLength(0);
  });

  it("styles Pi's retry, compaction, and summary spinners with their default looks", async () => {
    const { ctx, host } = setup();
    await host.emitSessionStart(ctx);
    const editor = mountEditor(ctx);
    const retry = statusIndicator("retry");
    const compaction = statusIndicator("compaction");
    const summary = statusIndicator("branchSummary");
    const working = statusIndicator("working");

    for (const { indicator } of [retry, compaction, summary, working]) {
      editor.setWorkingStatusIndicator(indicator);
    }

    expect({
      compaction: compaction.setIndicator.mock.calls,
      retry: retry.setIndicator.mock.calls,
      summary: summary.setIndicator.mock.calls,
      working: working.setIndicator.mock.calls,
    }).toStrictEqual({
      compaction: [[{ frames: framesOf("cube", "purple").frames.map(glyph), intervalMs: 20 }]],
      retry: [[{ frames: framesOf("tetrahedron", "orange").frames.map(glyph), intervalMs: 20 }]],
      summary: [[{ frames: framesOf("octahedron", "blue").frames.map(glyph), intervalMs: 20 }]],
      working: [],
    });
    expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("shared-editor", expect.any(String));

    for (const { indicator } of [retry, compaction, summary, working]) indicator.dispose();
  });

  it("restyles the active spinner live from the settings dialog", async () => {
    const { ctx, driver, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(ctx);
    const editor = mountEditor(ctx);
    const retry = statusIndicator("retry");
    editor.setWorkingStatusIndicator(retry.indicator);
    setWorkingIndicator.mockClear();
    const dialog = await openDialog(host, driver, ctx);

    dialog.edit("retry-shape", cycle(shapeOptions, "tetrahedron", "cube"));
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: framesOf("cube", "orange").frames.map(glyph), intervalMs: 20 },
    ]);
    dialog.edit("retry-color", cycle(colorOptions, "orange", "red"));
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: framesOf("cube", "red").frames.map(glyph), intervalMs: 20 },
    ]);
    dialog.edit("background", 1);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: framesOf("cube", "red", "light").frames.map(glyph), intervalMs: 20 },
    ]);
    dialog.edit("playback", 1);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: [glyph(framesOf("cube", "red", "light").still)], intervalMs: 20 },
    ]);
    dialog.edit("playback", 1);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([undefined]);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(undefined);
    dialog.edit("playback", 1);
    // A global `on` brings back spinners that were turned off individually.
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: framesOf("cube", "red", "light").frames.map(glyph), intervalMs: 20 },
    ]);
    dialog.edit("retry-enabled", 1);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([undefined]);
    dialog.edit("playback", 3);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: framesOf("cube", "red", "light").frames.map(glyph), intervalMs: 20 },
    ]);
    dialog.edit("retry-enabled", 1);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([undefined]);
    // The working spinner keeps its own choices.
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: framesOf("orb", "cyan", "light").frames.map(glyph),
      intervalMs: 20,
    });
    dialog.edit("working-color", cycle(colorOptions, "cyan", "purple"));
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: framesOf("orb", "purple", "light").frames.map(glyph),
      intervalMs: 20,
    });

    await dialog.close();
    retry.indicator.dispose();
  });

  it("releases its border styling on shutdown", async () => {
    const { ctx, host } = setup();
    await host.emitSessionStart(ctx);
    const editor = mountEditor(ctx);
    const compaction = statusIndicator("compaction");
    editor.setWorkingStatusIndicator(compaction.indicator);
    expect(compaction.setIndicator).toHaveBeenCalledTimes(1);
    await host.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, ctx);
    expect(compaction.setIndicator.mock.lastCall).toStrictEqual([undefined]);
    compaction.indicator.dispose();
  });

  it("applies shape, color, and background changes without leaving static mode", async () => {
    const { ctx, driver, host, setWorkingIndicator } = setup();
    const dialog = await openDialog(host, driver, ctx);

    dialog.edit("playback", 1);
    dialog.edit("working-shape", cycle(shapeOptions, "orb", "cube"));
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [glyph(manifest.animations.cube.cyan.dark.still)],
      intervalMs: 20,
    });
    dialog.edit("working-color", cycle(colorOptions, "cyan", "purple"));
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [glyph(manifest.animations.cube.purple.dark.still)],
      intervalMs: 20,
    });
    dialog.edit("background", 1);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [glyph(manifest.animations.cube.purple.light.still)],
      intervalMs: 20,
    });

    await dialog.close();
  });

  it("remembers selectors while off and applies them when reenabled", async () => {
    const { ctx, driver, host, setWorkingIndicator } = setup();
    const dialog = await openDialog(host, driver, ctx);
    dialog.edit("playback", 2);

    for (const [row, presses] of [
      ["working-shape", cycle(shapeOptions, "orb", "tetrahedron")],
      ["working-color", cycle(colorOptions, "cyan", "pink")],
      ["background", 1],
    ] as const) {
      dialog.edit(row, presses);
      expect(setWorkingIndicator).toHaveBeenLastCalledWith(undefined);
    }

    dialog.edit("playback", 1);
    await dialog.close();
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: manifest.animations.tetrahedron.pink.light.frames.map(glyph),
      intervalMs: 20,
    });
  });

  it("switches between puzzle and wireframe without losing color, background or mode", async () => {
    const { ctx, driver, host, setWorkingIndicator } = setup();
    const dialog = await openDialog(host, driver, ctx);
    dialog.edit("background", 1);
    dialog.edit("working-color", cycle(colorOptions, "cyan", "purple"));

    for (const [row, presses] of [
      ["working-shape", cycle(shapeOptions, "orb", "rubik")],
      ["working-color", cycle(colorOptions, "purple", "red")],
      ["background", 1],
    ] as const) {
      dialog.edit(row, presses);
      expect(setWorkingIndicator).toHaveBeenLastCalledWith({
        frames: manifest.rubik.frames.map(glyph),
        intervalMs: 20,
      });
    }

    dialog.edit("playback", 1);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [glyph(manifest.rubik.still)],
      intervalMs: 20,
    });
    dialog.edit("working-shape", cycle(shapeOptions, "rubik", "cube"));
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [glyph(manifest.animations.cube.red.dark.still)],
      intervalMs: 20,
    });
    dialog.edit("playback", 2);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: manifest.animations.cube.red.dark.frames.map(glyph),
      intervalMs: 20,
    });
    dialog.edit("playback", 2);
    dialog.edit("working-shape", cycle(shapeOptions, "cube", "rubik"));
    await dialog.close();
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(undefined);
  });

  it("resets runtime choices on a fresh extension load", async () => {
    const first = setup();
    const dialog = await openDialog(first.host, first.driver, first.ctx);

    dialog.edit("working-shape", cycle(shapeOptions, "orb", "tetrahedron"));
    dialog.edit("working-color", cycle(colorOptions, "cyan", "pink"));
    dialog.edit("background", 1);
    dialog.edit("playback", 2);
    await dialog.close();

    const reloaded = setup();
    await reloaded.host.emitSessionStart(reloaded.ctx, "reload");
    expect(reloaded.setWorkingIndicator).toHaveBeenCalledExactlyOnceWith({
      frames: defaultFrames,
      intervalMs: 1000 / manifest.fps,
    });
  });

  it("previews the configured spinners, mapping, and font path in the dialog", async () => {
    const { ctx, driver, host, setWorkingIndicator } = setup();
    const dialog = await openDialog(host, driver, ctx);
    const rendered = dialog.render();

    for (const [label, shape, color] of [
      ["Working", "orb", "cyan"],
      ["Retry", "tetrahedron", "orange"],
      ["Compaction", "cube", "purple"],
      ["Summary", "octahedron", "blue"],
    ] as const) {
      const line = previewLine(rendered, label);
      expect(line).toContain(`${shape} · ${color}`);
      // Previews animate, so any frame of the loop may be showing.
      expect(framesOf(shape, color).frames.some((frame) => line?.includes(glyph(frame)))).toBe(
        true,
      );
    }

    expect(rendered).toContain("Playback");
    expect(rendered).toContain("Background");
    expect(rendered).toContain(`Ghostty: font-codepoint-map = ${mappingRange}=${manifest.family}`);
    // The footer wraps the long font path; whitespace is the only difference.
    expect(rendered.replace(/\s+/g, "")).toContain(
      fileURLToPath(new URL("../assets/ShapeSpinner.ttf", import.meta.url)),
    );
    expect(rendered).toContain("Boxes or stray symbols");
    expect(setWorkingIndicator).not.toHaveBeenCalled();

    await dialog.close();
  });

  it("updates the live preview as settings change", async () => {
    const { ctx, driver, host } = setup();
    const dialog = await openDialog(host, driver, ctx);

    dialog.edit("summary-shape", cycle(shapeOptions, "octahedron", "orb"));
    expect(previewLine(dialog.render(), "Summary")).toContain("orb · blue");
    dialog.edit("summary-enabled", 1);
    expect(previewLine(dialog.render(), "Summary")).toContain("off");
    // Static playback rests previews on the closing pose.
    dialog.edit("playback", 1);
    expect(previewLine(dialog.render(), "Working")).toContain(
      glyph(manifest.animations.orb.cyan.dark.still),
    );

    await dialog.close();
  });

  it("opens the settings dialog regardless of arguments", async () => {
    const { ctx, driver, host } = setup();
    const dialog = await openDialog(host, driver, ctx, "cube");
    expect(dialog.render()).toContain("Shape Spinner");
    await dialog.close();
    expect(host.getNotifications()).toHaveLength(0);
  });

  it("bundles complete, two-column loops and distinct resting poses in its own PUA bank", () => {
    expect(manifest.family).toMatch(/^Shape Spinner [a-f0-9]{10}$/);
    expect(manifest.fps).toBe(50);
    expect(Number.isInteger(1000 / manifest.fps)).toBe(true);
    expect(manifest.seed).toBe("amp-orb");
    expect(manifest.rubik.frames).toContainEqual(manifest.rubik.still);
    expect(new Set(Object.keys(manifest.animations))).toEqual(
      new Set(["orb", "cube", "octahedron", "tetrahedron"]),
    );
    expect(new Set(Object.keys(manifest.inks))).toEqual(
      new Set(["blue", "purple", "pink", "red", "orange", "yellow", "green", "cyan", "gray"]),
    );
    const loops: [string, Animation][] = [["rubik", manifest.rubik]];

    for (const [shape, colors] of Object.entries(manifest.animations)) {
      expect(new Set(Object.keys(colors))).toEqual(new Set(Object.keys(manifest.inks)));
      const firsts = new Set<number>();

      for (const backgrounds of Object.values(colors)) {
        expect(new Set(Object.keys(backgrounds))).toEqual(new Set(["dark", "light"]));

        for (const animation of Object.values(backgrounds)) {
          const first = animation.frames[0];
          assert(first !== undefined);
          firsts.add(first);
          loops.push([shape, animation]);
        }
      }

      expect(firsts.size).toBe(18);
    }

    for (const [shape, { seconds, frames, still }] of loops) {
      expect(seconds).toBe(shape === "rubik" ? 4.4 : 8);
      expect(frames).toHaveLength(shape === "rubik" ? 220 : 400);
      expect(frames.length * Math.trunc(1000 / manifest.fps)).toBe(seconds * 1000);
      expect(still).not.toEqual(frames[0]);

      for (const codepoint of [...frames, still]) {
        expect(Number.isInteger(codepoint)).toBe(true);
        expect(codepoint).toBeGreaterThanOrEqual(0x100000);
        expect(codepoint).toBeLessThanOrEqual(0x10fffd);
        expect(visibleWidth(glyph(codepoint))).toBe(2);
      }
    }
  });
});
