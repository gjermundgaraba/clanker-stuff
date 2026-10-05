import assert from "node:assert/strict";
import manifest from "../assets/shapes.json" with { type: "json" };
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { initTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ThemeAppearance,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createCustomUiDriver, createIdentityTheme } from "../../../../tests/harness/tui.js";
import { colors, configPath, defaultConfig, loadConfig, saveConfig, shapes } from "../config.js";
import type { Config } from "../config.js";
import extension from "../index.js";
import { settingRows, styleFor } from "../spinner.js";

type Animation = typeof manifest.rubik;

const glyph = (codepoint: number) => `${String.fromCodePoint(codepoint)} `;

const down = "\u001B[B";

const space = " ";

const escape = "\u001B";

const framesOf = (
  shape: keyof typeof manifest.animations,
  color: keyof typeof manifest.animations.orb,
  background: ThemeAppearance = "dark",
) => manifest.animations[shape][color][background];

const looped = (animation: Animation) => ({ frames: animation.frames.map(glyph), intervalMs: 20 });

const resting = (animation: Animation) => ({ frames: [glyph(animation.still)], intervalMs: 20 });

function setup(mode: ExtensionContext["mode"] = "tui") {
  initTheme("dark");
  rmSync(configPath(), { force: true });
  const host = createExtensionHost(extension);
  const setWorkingIndicator = vi.fn<ExtensionContext["ui"]["setWorkingIndicator"]>();
  const driver = createCustomUiDriver({});

  // Pi's ctx.ui.theme is live, so each context stands for the theme at the time of its event.
  const context = (appearance: ThemeAppearance = "dark") =>
    host.createContext({
      hasUI: mode === "tui" || mode === "rpc",
      mode,
      ui: {
        custom: driver.custom,
        setWorkingIndicator,
        theme: Object.assign(createIdentityTheme(), { appearance }),
      },
    });

  return { context, ctx: context(), driver, host, setWorkingIndicator };
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

describe("shape spinner", () => {
  it("only sets Pi's working indicator, at startup and for each run", async () => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(ctx);
    expect([...host.getRegisteredCommands().keys()]).toEqual(["shape-spinner"]);
    expect(host.getRegisteredTools()).toHaveLength(0);
    expect(setWorkingIndicator).toHaveBeenCalledExactlyOnceWith(looped(framesOf("orb", "cyan")));
    await host.emit("agent_start", { type: "agent_start" }, ctx);
    expect(setWorkingIndicator).toHaveBeenCalledTimes(2);
    expect(host.getEditorFactory()).toBeUndefined();
    expect(host.getNotifications()).toHaveLength(0);
    expect(host.getSentMessages()).toHaveLength(0);
    expect(host.getAppendedEntries()).toHaveLength(0);
  });

  it.each(["rpc", "print", "json"] as const)("does not use UI in %s mode", async (mode) => {
    const { ctx, driver, host, setWorkingIndicator } = setup(mode);
    await host.emitSessionStart(ctx);
    await host.emit("agent_start", { type: "agent_start" }, ctx);
    await host.runCommand("shape-spinner", "", ctx);

    expect(setWorkingIndicator).not.toHaveBeenCalled();
    expect(driver.component).toBeUndefined();
    expect(host.getNotifications()).toHaveLength(0);
  });

  it("inks wireframes for the theme's background, following a switch on the next run", async () => {
    const { context, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(context("light"));
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(looped(framesOf("orb", "cyan", "light")));
    await host.emit("agent_start", { type: "agent_start" }, context("dark"));
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(looped(framesOf("orb", "cyan", "dark")));
  });

  it("rests on the closing pose in static motion", () => {
    const config = edit(defaultConfig(), { motion: "static", shape: "cube" });

    expect(styleFor(config, "dark")).toStrictEqual(resting(framesOf("cube", "cyan")));
  });

  it("keeps the puzzle's stickers but remembers the color for the next wireframe", () => {
    const config = edit(defaultConfig(), { color: "red", shape: "rubik" });

    expect(styleFor(config, "light")).toStrictEqual(looped(manifest.rubik));
    edit(config, { shape: "cube" });
    expect(styleFor(config, "dark")).toStrictEqual(looped(framesOf("cube", "red")));
  });

  it("ignores values a row does not offer", () => {
    const config = defaultConfig();
    settingRows(config)
      .find((row) => row.id === "shape")
      ?.set("dodecahedron");
    expect(config).toStrictEqual(defaultConfig());
  });

  it("round-trips the config file and falls back to defaults on invalid content", async () => {
    const config = edit(defaultConfig(), { color: "red", shape: "cube" });
    await saveConfig(config);
    await expect(loadConfig()).resolves.toStrictEqual(config);
    writeFileSync(configPath(), JSON.stringify({ ...config, motion: "bouncy" }));
    await expect(loadConfig()).resolves.toStrictEqual(defaultConfig());
  });

  it("restyles the live spinner from the dialog and persists the choices", async () => {
    const { ctx, driver, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(ctx);
    const dialog = await openDialog(host, driver, ctx);

    // Motion is the first row; the shape is the row below it.
    dialog.press(space);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(resting(framesOf("orb", "cyan")));
    dialog.press(down, space);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(resting(framesOf("cube", "cyan")));
    expect(dialog.render()).toContain(`${glyph(framesOf("cube", "cyan").still)} cube · cyan`);
    await dialog.close();

    const reloaded = createExtensionHost(extension);
    await reloaded.emitSessionStart(ctx, "reload");
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(resting(framesOf("cube", "cyan")));
  });

  it("previews the configured spinner, mapping, and font path in the dialog", async () => {
    const { ctx, driver, host, setWorkingIndicator } = setup();
    const dialog = await openDialog(host, driver, ctx);
    const rendered = dialog.render();
    const line = rendered.split("\n").find((row) => row.includes("Working"));

    expect(line).toContain("orb · cyan");
    // Previews animate, so any frame of the loop may be showing.
    expect(framesOf("orb", "cyan").frames.some((frame) => line?.includes(glyph(frame)))).toBe(true);
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
    // The settings offer exactly what the manifest bundles; rubik has no colored animations.
    expect(new Set(Object.keys(manifest.animations))).toEqual(
      new Set(shapes.filter((shape) => shape !== "rubik")),
    );
    expect(new Set(Object.keys(manifest.inks))).toEqual(new Set(colors));
    const loops: [string, Animation][] = [["rubik", manifest.rubik]];

    for (const [shape, byColor] of Object.entries(manifest.animations)) {
      expect(new Set(Object.keys(byColor))).toEqual(new Set(Object.keys(manifest.inks)));
      const firsts = new Set<number>();

      for (const backgrounds of Object.values(byColor)) {
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
