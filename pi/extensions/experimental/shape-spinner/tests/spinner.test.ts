import assert from "node:assert/strict";
import manifest from "../assets/shapes.json" with { type: "json" };
import { rmSync, writeFileSync } from "node:fs";
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
import { configPath, defaultConfig, loadConfig, saveConfig } from "../config.js";
import type { Config } from "../config.js";
import extension from "../index.js";
import { settingRows, styleFor } from "../spinner.js";

type Animation = typeof manifest.rubik;

const glyph = (codepoint: number) => `${String.fromCodePoint(codepoint)} `;

const defaultFrames = manifest.animations.orb.cyan.dark.frames.map(glyph);

const down = "\u001B[B";

const space = " ";

const escape = "\u001B";

function setup(mode: ExtensionContext["mode"] = "tui") {
  initTheme("dark");
  rmSync(configPath(), { force: true });
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

const openDialog = async (
  host: ReturnType<typeof createExtensionHost>,
  driver: ReturnType<typeof createCustomUiDriver>,
  ctx: ExtensionCommandContext,
) => {
  const pending = host.runCommand("shape-spinner", "", ctx);

  const component = await vi.waitFor(() => {
    if (driver.component === undefined) throw new Error("The settings dialog did not mount");

    return driver.component;
  });

  return {
    async close() {
      component.handleInput?.(escape);
      await pending;
    },
    press: (...keys: string[]) => {
      for (const key of keys) component.handleInput?.(key);
    },
    render: () => component.render(80).join("\n"),
  };
};

/** Apply dialog values to a config through the same rows the dialog edits. */
const edit = (config: Config, values: Record<string, string>): Config => {
  const rows = settingRows(config);

  for (const [id, value] of Object.entries(values)) {
    const row = rows.find((candidate) => candidate.id === id);
    assert(row !== undefined, `unknown row ${id}`);
    assert(row.values.includes(value), `row ${id} does not offer ${value}`);
    row.set(value);
    expect(row.get()).toBe(value);
  }

  return config;
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
    const { ctx, driver, host, setWorkingIndicator } = setup(mode);
    await host.emitSessionStart(ctx);
    await host.runCommand("shape-spinner", "", ctx);

    expect(setWorkingIndicator).not.toHaveBeenCalled();
    expect(driver.component).toBeUndefined();
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

  it("styles each spinner from its own shape, color, and the shared background", () => {
    const config = edit(defaultConfig(), {
      background: "light",
      "retry.color": "red",
      "retry.shape": "cube",
    });

    expect(styleFor(config, "retry")).toStrictEqual({
      frames: framesOf("cube", "red", "light").frames.map(glyph),
      intervalMs: 20,
    });
    // The other spinners keep their own choices.
    expect(styleFor(config, "working")).toStrictEqual({
      frames: framesOf("orb", "cyan", "light").frames.map(glyph),
      intervalMs: 20,
    });
  });

  it("rests on the closing pose in static motion", () => {
    const config = edit(defaultConfig(), { motion: "static", "working.shape": "cube" });

    expect(styleFor(config, "working")).toStrictEqual({
      frames: [glyph(manifest.animations.cube.cyan.dark.still)],
      intervalMs: 20,
    });
  });

  it("keeps the puzzle's stickers but remembers the color for the next wireframe", () => {
    const config = edit(defaultConfig(), { "working.color": "red", "working.shape": "rubik" });

    expect(styleFor(config, "working")?.frames).toStrictEqual(manifest.rubik.frames.map(glyph));
    edit(config, { "working.shape": "cube" });
    expect(styleFor(config, "working")?.frames).toStrictEqual(
      framesOf("cube", "red").frames.map(glyph),
    );
  });

  it("disables one spinner without touching the others, and keeps its look", () => {
    const config = edit(defaultConfig(), { "retry.enabled": "off", "retry.shape": "orb" });

    expect(styleFor(config, "retry")).toBeUndefined();
    expect(styleFor(config, "working")).toBeDefined();
    // Motion changes never re-enable a spinner.
    edit(config, { motion: "static" });
    edit(config, { motion: "animated" });
    expect(styleFor(config, "retry")).toBeUndefined();
    edit(config, { "retry.enabled": "on" });
    expect(styleFor(config, "retry")?.frames).toStrictEqual(
      framesOf("orb", "orange").frames.map(glyph),
    );
  });

  it("ignores values a row does not offer", () => {
    const config = defaultConfig();
    settingRows(config)
      .find((row) => row.id === "working.shape")
      ?.set("dodecahedron");
    expect(config).toStrictEqual(defaultConfig());
  });

  it("round-trips the config file and falls back to defaults on invalid content", async () => {
    const config = edit(defaultConfig(), { background: "light", "branchSummary.enabled": "off" });
    await saveConfig(config);
    await expect(loadConfig()).resolves.toStrictEqual(config);
    writeFileSync(configPath(), JSON.stringify({ ...config, motion: "bouncy" }));
    await expect(loadConfig()).resolves.toStrictEqual(defaultConfig());
  });

  it("restyles the live spinners from the dialog and persists the choices", async () => {
    const { ctx, driver, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(ctx);
    const editor = mountEditor(ctx);
    const retry = statusIndicator("retry");
    editor.setWorkingStatusIndicator(retry.indicator);
    const dialog = await openDialog(host, driver, ctx);

    // Motion is the first row; the working shape is two rows below it.
    dialog.press(space);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: [glyph(framesOf("tetrahedron", "orange").still)], intervalMs: 20 },
    ]);
    dialog.press(down, down, space);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [glyph(framesOf("cube", "cyan").still)],
      intervalMs: 20,
    });
    expect(previewLine(dialog.render(), "Working")).toContain(
      `${glyph(framesOf("cube", "cyan").still)} cube · cyan`,
    );
    await dialog.close();
    retry.indicator.dispose();

    const reloaded = createExtensionHost(extension);
    await reloaded.emitSessionStart(ctx, "reload");
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [glyph(framesOf("cube", "cyan").still)],
      intervalMs: 20,
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

    expect(rendered).toMatch(
      new RegExp(`Ghostty: font-codepoint-map = U\\+[0-9A-F]+-U\\+[0-9A-F]+=${manifest.family}`),
    );
    // The footer wraps the long font path; whitespace is the only difference.
    expect(rendered.replace(/\s+/g, "")).toContain(
      fileURLToPath(new URL("../assets/ShapeSpinner.ttf", import.meta.url)),
    );
    expect(setWorkingIndicator).not.toHaveBeenCalled();

    await dialog.close();
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
