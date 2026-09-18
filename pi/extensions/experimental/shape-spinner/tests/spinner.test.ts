import assert from "node:assert/strict";
import manifest from "../assets/shapes.json" with { type: "json" };
import { fileURLToPath } from "node:url";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";

type Animation = typeof manifest.rubik;

const glyph = (codepoint: number) => `${String.fromCodePoint(codepoint)} `;

const defaultFrames = manifest.animations.orb.cyan.dark.frames.map(glyph);

function setup(mode: ExtensionContext["mode"] = "tui") {
  const host = createExtensionHost(extension);
  const setWorkingIndicator = vi.fn<ExtensionContext["ui"]["setWorkingIndicator"]>();

  const ctx = host.createContext({
    hasUI: mode === "tui" || mode === "rpc",
    mode,
    ui: { setWorkingIndicator },
  });

  return { ctx, host, setWorkingIndicator };
}

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
    expect(host.getEditorFactory()).toBeUndefined();
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
    expect(host.getNotifications()).toHaveLength(0);
  });

  it.each(["rubik", "orb", "cube", "octahedron", "tetrahedron"] as const)(
    "selects %s",
    async (shape) => {
      const { ctx, host, setWorkingIndicator } = setup();
      await host.runCommand("shape-spinner", ` ${shape.toUpperCase()} `, ctx);
      const animation = shape === "rubik" ? manifest.rubik : manifest.animations[shape].cyan.dark;
      expect(setWorkingIndicator).toHaveBeenLastCalledWith({
        frames: animation.frames.map(glyph),
        intervalMs: 20,
      });
    },
  );

  it.each(["blue", "purple", "pink", "red", "orange", "yellow", "green", "cyan", "gray"] as const)(
    "selects %s color without leaving static mode",
    async (color) => {
      const { ctx, host, setWorkingIndicator } = setup();

      for (const action of ["cube", "light", "static", ` ${color.toUpperCase()} `]) {
        await host.runCommand("shape-spinner", action, ctx);
      }

      expect(setWorkingIndicator).toHaveBeenLastCalledWith({
        frames: [glyph(manifest.animations.cube[color].light.still)],
        intervalMs: 20,
      });
    },
  );

  it.each(["dark", "light"] as const)("selects %s background", async (background) => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.runCommand("shape-spinner", "light", ctx);
    await host.runCommand("shape-spinner", background, ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: manifest.animations.orb.cyan[background].frames.map(glyph),
      intervalMs: 20,
    });
  });

  it("remembers selectors while off and applies them when reenabled", async () => {
    const { ctx, host, setWorkingIndicator } = setup();

    for (const action of ["off", "tetrahedron", "pink", "light"]) {
      await host.runCommand("shape-spinner", action, ctx);
      expect(setWorkingIndicator).toHaveBeenLastCalledWith(undefined);
    }

    await host.runCommand("shape-spinner", "on", ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: manifest.animations.tetrahedron.pink.light.frames.map(glyph),
      intervalMs: 20,
    });
  });

  it("switches between puzzle and wireframe without losing color, background or mode", async () => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.runCommand("shape-spinner", "light", ctx);
    await host.runCommand("shape-spinner", "purple", ctx);

    for (const action of ["rubik", "red", "dark"]) {
      await host.runCommand("shape-spinner", action, ctx);
      expect(setWorkingIndicator).toHaveBeenLastCalledWith({
        frames: manifest.rubik.frames.map(glyph),
        intervalMs: 20,
      });
    }

    await host.runCommand("shape-spinner", "static", ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [glyph(manifest.rubik.still)],
      intervalMs: 20,
    });
    await host.runCommand("shape-spinner", "cube", ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [glyph(manifest.animations.cube.red.dark.still)],
      intervalMs: 20,
    });
    await host.runCommand("shape-spinner", "on", ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: manifest.animations.cube.red.dark.frames.map(glyph),
      intervalMs: 20,
    });
    await host.runCommand("shape-spinner", "off", ctx);
    await host.runCommand("shape-spinner", "rubik", ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(undefined);
  });

  it("resets runtime choices on a fresh extension load", async () => {
    const first = setup();

    for (const action of ["tetrahedron", "pink", "light", "off"]) {
      await first.host.runCommand("shape-spinner", action, first.ctx);
    }

    const reloaded = setup();
    await reloaded.host.emitSessionStart(reloaded.ctx, "reload");
    expect(reloaded.setWorkingIndicator).toHaveBeenCalledExactlyOnceWith({
      frames: defaultFrames,
      intervalMs: 1000 / manifest.fps,
    });
  });

  it("previews all shapes and a spacer-free mapping without changing state", async () => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.runCommand("shape-spinner", "off", ctx);
    setWorkingIndicator.mockClear();
    await host.runCommand("shape-spinner", "preview", ctx);
    const preview = host.getNotifications().at(-1)?.message ?? "";

    for (const [shape, colors] of Object.entries(manifest.animations)) {
      expect(preview).toContain(`${shape}: ${glyph(colors.cyan.dark.still)}`);
    }

    expect(preview).toContain(`rubik: ${glyph(manifest.rubik.still)}`);

    for (const [color, animation] of Object.entries(manifest.animations.orb)) {
      expect(preview).toContain(`${color} ${glyph(animation.dark.still)}`);
    }

    expect(preview).toContain(`font-codepoint-map = U+100000-U+105C6A=${manifest.family}`);
    expect(preview).toContain(
      fileURLToPath(new URL("../assets/ShapeSpinner.ttf", import.meta.url)),
    );
    expect(preview).toContain("/shape-spinner off");
    expect(host.getSentUserMessages()).toHaveLength(0);
    await host.runCommand("shape-spinner", "", ctx);
    expect(host.getNotifications().at(-1)?.message).toContain("orb, cyan, dark background, off");

    for (const invalid of ["sphere", "cube light", "indigo", "#ff0000"]) {
      await host.runCommand("shape-spinner", invalid, ctx);
      expect(host.getNotifications().at(-1)?.type).toBe("error");
    }

    expect(setWorkingIndicator).not.toHaveBeenCalled();
  });

  it("previews the selected color/background and uses orb swatches for Rubik", async () => {
    const { ctx, host, setWorkingIndicator } = setup();

    for (const action of ["red", "light", "cube", "static", "preview"]) {
      await host.runCommand("shape-spinner", action, ctx);
    }

    expect(host.getNotifications().at(-1)?.message).toContain(
      `cube: ${glyph(manifest.animations.cube.red.light.still)}`,
    );
    expect(host.getNotifications().at(-1)?.message).toContain("Colors (cube):");
    await host.runCommand("shape-spinner", "rubik", ctx);
    setWorkingIndicator.mockClear();
    await host.runCommand("shape-spinner", "preview", ctx);
    const preview = host.getNotifications().at(-1)?.message ?? "";
    expect(preview).toContain("Colors (orb):");
    expect(preview).toContain("Color: red. Background: light.");
    expect(preview).toContain(`red ${glyph(manifest.animations.orb.red.light.still)}`);
    expect(setWorkingIndicator).not.toHaveBeenCalled();
    await host.runCommand("shape-spinner", "cube", ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [glyph(manifest.animations.cube.red.light.still)],
      intervalMs: 20,
    });
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
