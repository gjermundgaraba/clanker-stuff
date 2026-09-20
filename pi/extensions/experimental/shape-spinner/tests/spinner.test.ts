import assert from "node:assert/strict";
import manifest from "../assets/shapes.json" with { type: "json" };
import { fileURLToPath } from "node:url";

import { acquireEditorHost } from "@clanker-stuff/editor";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import {
  createKeybindings,
  createMockTui,
  createStatusIndicator,
} from "../../../../tests/harness/tui.js";
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

  it("restyles the active spinner when a kind changes and follows global mode", async () => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(ctx);
    const editor = mountEditor(ctx);
    const retry = statusIndicator("retry");
    editor.setWorkingStatusIndicator(retry.indicator);
    setWorkingIndicator.mockClear();

    await host.runCommand("shape-spinner", " Retry  cube ", ctx);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: framesOf("cube", "orange").frames.map(glyph), intervalMs: 20 },
    ]);
    expect(host.getNotifications().at(-1)?.message).toBe("Shape spinner retry: cube orange.");
    await host.runCommand("shape-spinner", "retry red", ctx);
    await host.runCommand("shape-spinner", "light", ctx);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: framesOf("cube", "red", "light").frames.map(glyph), intervalMs: 20 },
    ]);
    await host.runCommand("shape-spinner", "static", ctx);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: [glyph(framesOf("cube", "red", "light").still)], intervalMs: 20 },
    ]);
    await host.runCommand("shape-spinner", "off", ctx);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([undefined]);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(undefined);
    await host.runCommand("shape-spinner", "on", ctx);
    await host.runCommand("shape-spinner", "retry off", ctx);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([undefined]);
    expect(host.getNotifications().at(-1)?.message).toBe("Shape spinner retry: off.");
    // A global `on` brings back spinners that were turned off individually.
    await host.runCommand("shape-spinner", "on", ctx);
    expect(retry.setIndicator.mock.lastCall).toStrictEqual([
      { frames: framesOf("cube", "red", "light").frames.map(glyph), intervalMs: 20 },
    ]);
    await host.runCommand("shape-spinner", "retry off", ctx);
    // The working spinner keeps its own choices.
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: framesOf("orb", "cyan", "light").frames.map(glyph),
      intervalMs: 20,
    });
    await host.runCommand("shape-spinner", "working purple", ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: framesOf("orb", "purple", "light").frames.map(glyph),
      intervalMs: 20,
    });
    await host.runCommand("shape-spinner", "", ctx);
    expect(host.getNotifications().at(-1)?.message).toContain(
      "orb, purple, light background, on. Retry: off. Compaction: cube purple. Summary: octahedron blue.",
    );

    for (const invalid of [
      "retry",
      "retry sphere",
      "sphere cube",
      "retry cube red",
      "preview cube",
    ]) {
      await host.runCommand("shape-spinner", invalid, ctx);
      expect(host.getNotifications().at(-1)?.type).toBe("error");
    }

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

    for (const invalid of ["sphere", "cube light", "indigo", "#ff0000", "retry cube light"]) {
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
