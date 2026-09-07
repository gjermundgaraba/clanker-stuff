import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";

// SAFETY: Tests below check the bundled metadata's scalar values, dimensions, and timing.
const cube = JSON.parse(readFileSync(new URL("../assets/cube.json", import.meta.url), "utf8")) as {
  family: string;
  fps: number;
  frames: number[][];
  still: number;
};
const frames = cube.frames.map((frame) => String.fromCodePoint(...frame));

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

describe("cube spinner", () => {
  it("registers the command and configures native animation once at startup", async () => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(ctx);

    expect([...host.getRegisteredCommands().keys()]).toEqual(["cube-spinner"]);
    expect(host.getRegisteredTools()).toHaveLength(0);
    expect(setWorkingIndicator).toHaveBeenCalledExactlyOnceWith({
      frames,
      intervalMs: 1000 / cube.fps,
    });

    for (const type of ["agent_start", "turn_start", "turn_end", "agent_end", "agent_settled"]) {
      await host.emit(type, { type }, ctx);
    }
    expect(setWorkingIndicator).toHaveBeenCalledTimes(1);
    expect(host.getNotifications()).toHaveLength(0);
    expect(host.getSentMessages()).toHaveLength(0);
    expect(host.getAppendedEntries()).toHaveLength(0);
  });

  it.each(["rpc", "print", "json"] as const)("does not touch UI in %s mode", async (mode) => {
    const { ctx, host, setWorkingIndicator } = setup(mode);
    await host.emitSessionStart(ctx);
    for (const action of ["", "on", "static", "off", "preview"]) {
      await host.runCommand("cube-spinner", action, ctx);
    }

    expect(setWorkingIndicator).not.toHaveBeenCalled();
    expect(host.getNotifications()).toHaveLength(0);
  });

  it("switches between solved, default, and animated indicators", async () => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(ctx);

    await host.runCommand("cube-spinner", " static ", ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames: [frames[cube.still]],
      intervalMs: 1000 / cube.fps,
    });

    await host.runCommand("cube-spinner", "off", ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith(undefined);
    await host.runCommand("cube-spinner", "ON", ctx);
    expect(setWorkingIndicator).toHaveBeenLastCalledWith({
      frames,
      intervalMs: 1000 / cube.fps,
    });
  });

  it("does not persist the choice into a newly loaded extension instance", async () => {
    const first = setup();
    await first.host.runCommand("cube-spinner", "off", first.ctx);

    const reloaded = setup();
    await reloaded.host.emitSessionStart(reloaded.ctx, "reload");
    expect(reloaded.setWorkingIndicator).toHaveBeenCalledExactlyOnceWith({
      frames,
      intervalMs: 1000 / cube.fps,
    });
  });

  it("previews the font and reports help without changing the chosen mode", async () => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.runCommand("cube-spinner", "off", ctx);
    setWorkingIndicator.mockClear();
    await host.runCommand("cube-spinner", "preview", ctx);

    const preview = host.getNotifications().at(-1)?.message ?? "";
    const codepoints = cube.frames.map(([codepoint]) => codepoint);
    const range = [Math.min(...codepoints), Math.max(...codepoints)]
      .map((codepoint) => `U+${codepoint.toString(16).toUpperCase()}`)
      .join("-");
    expect(preview).toContain(`Solved: ${frames[cube.still]}`);
    for (const fraction of [0, 0.25, 0.5, 0.75]) {
      expect(preview).toContain(frames[Math.floor(fraction * frames.length)]);
    }
    expect(preview).toContain(`Font: ${cube.family}`);
    expect(preview).toContain(
      `Font file: ${fileURLToPath(new URL("../assets/CubeSpinner.ttf", import.meta.url))}`,
    );
    expect(preview).toContain(`font-codepoint-map = ${range}=${cube.family}`);
    expect(preview).not.toMatch(/font-codepoint-map = U\+0*20-/);
    expect(preview).toContain("/cube-spinner off");
    expect(host.getSentMessages()).toHaveLength(0);
    expect(host.getSentUserMessages()).toHaveLength(0);
    expect(host.getEditorFactory()).toBeUndefined();

    await host.runCommand("cube-spinner", "", ctx);
    expect(host.getNotifications().at(-1)?.message).toContain("Cube spinner: off.");
    await host.runCommand("cube-spinner", "unknown", ctx);
    expect(host.getNotifications().at(-1)?.type).toBe("error");
    expect(setWorkingIndicator).not.toHaveBeenCalled();
  });

  it("starts scrambled, keeps a solved static frame, and reserves two columns", async () => {
    const { ctx, host, setWorkingIndicator } = setup();
    await host.emitSessionStart(ctx);
    const indicator: WorkingIndicatorOptions | undefined = setWorkingIndicator.mock.calls[0]?.[0];

    expect(cube.family.length).toBeGreaterThan(0);
    expect(Number.isFinite(cube.fps)).toBe(true);
    expect(cube.fps).toBeGreaterThan(0);
    expect(cube.frames.length).toBeGreaterThan(1);
    expect(Number.isInteger(cube.still)).toBe(true);
    expect(cube.still).toBeGreaterThanOrEqual(0);
    expect(cube.still).toBeLessThan(cube.frames.length);
    expect(frames[0]).not.toBe(frames[cube.still]);
    for (const frame of cube.frames) {
      expect(frame).toHaveLength(2);
      expect(frame[1]).toBe(0x20);
      expect(String.fromCodePoint(frame[0])).toMatch(/^\p{Private_Use}$/u);
      for (const codepoint of frame) {
        expect(Number.isInteger(codepoint)).toBe(true);
      }
    }
    expect(indicator?.frames).toEqual(frames);
    expect(new Set(frames.map(visibleWidth))).toEqual(new Set([2]));
  });
});
