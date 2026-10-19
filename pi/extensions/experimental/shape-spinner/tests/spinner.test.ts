import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { manifest, RUBIK, wireframe } from "@clanker-stuff/pi-shape-glyphs";
import type { Animation } from "@clanker-stuff/pi-shape-glyphs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ThemeAppearance,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { createCustomUiDriver, createIdentityTheme } from "../../../../tests/harness/tui.js";
import {
  colors,
  configPath,
  defaultConfig,
  loadConfig,
  saveConfig,
  shapes,
  styleFor,
} from "../config.js";
import type { Config } from "../config.js";
import extension from "../index.js";
import { updateSetting } from "../settings.js";

type Loop = typeof manifest.rubik;

const down = "\u001B[B";

const up = "\u001B[A";

const space = " ";

const escape = "\u001B";

const looped = (animation: Animation) => ({ frames: animation.frames, intervalMs: 20 });

const resting = (animation: Animation) => ({ frames: [animation.still], intervalMs: 20 });

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
        theme: createIdentityTheme(appearance),
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

describe("shape spinner", () => {
  it("only sets Pi's working indicator, at startup and for each run", async () => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(ctx);
    expect([...host.getRegisteredCommands().keys()]).toEqual(["shape-spinner"]);
    expect(host.getRegisteredTools()).toHaveLength(0);
    expect(setWorkingIndicator).toHaveBeenCalledExactlyOnceWith(
      looped(wireframe("orb", "cyan", "dark")),
    );
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
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(looped(wireframe("orb", "cyan", "light")));
    await host.emit("agent_start", { type: "agent_start" }, context("dark"));
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(looped(wireframe("orb", "cyan", "dark")));
  });

  it("rests on the closing pose in static motion", () => {
    const config: Config = { ...defaultConfig(), motion: "static", shape: "cube" };

    expect(styleFor(config, "dark")).toStrictEqual(resting(wireframe("cube", "cyan", "dark")));
  });

  it("keeps the puzzle's stickers but remembers the color for the next wireframe", async () => {
    const { context, driver, host, setWorkingIndicator } = setup();
    await saveConfig({ color: "red", motion: "animated", shape: "rubik" });
    const ctx = context("light");
    await host.emitSessionStart(ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(looped(RUBIK));

    const dialog = await openDialog(host, driver, ctx);
    dialog.press(down, down, space);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(looped(RUBIK));
    expect(dialog.render()).toContain("rubik · orange");

    dialog.press(up, space, space);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(
      looped(wireframe("cube", "orange", "light")),
    );
    expect(dialog.render()).toContain("cube · orange");
    await dialog.close();
    await expect(loadConfig()).resolves.toStrictEqual({
      color: "orange",
      motion: "animated",
      shape: "cube",
    });
  });

  it.each([
    ["shape", "dodecahedron"],
    ["motion", "bouncy"],
    ["color", "ultraviolet"],
    ["unknown", "static"],
  ])("ignores unsupported setting %s=%s", (id, value) => {
    const config = defaultConfig();
    updateSetting(config, id, value);
    expect(config).toStrictEqual(defaultConfig());
  });

  it("round-trips the config file and falls back to defaults on invalid content", async () => {
    const config: Config = { ...defaultConfig(), color: "red", shape: "cube" };
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
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(resting(wireframe("orb", "cyan", "dark")));
    dialog.press(down, space);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(
      resting(wireframe("cube", "cyan", "dark")),
    );
    expect(dialog.render()).toContain(`${wireframe("cube", "cyan", "dark").still} cube · cyan`);
    expect(existsSync(configPath())).toBe(false);
    await dialog.close();

    const reloaded = createExtensionHost(extension);
    await reloaded.emitSessionStart(ctx, "reload");
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(
      resting(wireframe("cube", "cyan", "dark")),
    );
  });

  it("previews the configured spinner, mapping, and font path in the dialog", async () => {
    const { ctx, driver, host, setWorkingIndicator } = setup();
    const dialog = await openDialog(host, driver, ctx);
    const rendered = dialog.render();
    const line = rendered.split("\n").find((row) => row.includes("Working"));

    expect(line).toContain("orb · cyan");
    // Previews animate, so any frame of the loop may be showing.
    expect(wireframe("orb", "cyan", "dark").frames.some((frame) => line?.includes(frame))).toBe(
      true,
    );
    expect(rendered).toMatch(
      new RegExp(`Ghostty: font-codepoint-map = U\\+[0-9A-F]+-U\\+[0-9A-F]+=${manifest.family}`),
    );
    // The footer wraps the long font path; whitespace is the only difference.
    expect(rendered.replace(/\s+/g, "")).toContain(
      fileURLToPath(new URL("../assets/ShapeSpinner.ttf", import.meta.url)),
    );
    expect(setWorkingIndicator).not.toHaveBeenCalled();

    await dialog.close();
    expect(existsSync(configPath())).toBe(false);
  });

  it("advances the preview at the playback rate and stops its timer on close", async () => {
    vi.useFakeTimers();

    try {
      const { ctx, driver, host } = setup();
      const dialog = await openDialog(host, driver, ctx);
      const frames = wireframe("orb", "cyan", "dark").frames;
      const before = dialog.render();
      const index = frames.findIndex((frame) => before.includes(frame));
      expect(index).toBeGreaterThanOrEqual(0);
      vi.advanceTimersByTime(400);
      expect(dialog.render()).toContain(frames[(index + 20) % frames.length]);
      expect(vi.getTimerCount()).toBe(1);

      await dialog.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bundles complete loops and distinct resting poses in its own PUA bank", () => {
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
    const loops: [string, Loop][] = [["rubik", manifest.rubik]];

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
      }
    }
  });
});
