import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface CubeAnimation {
  family: string;
  fps: number;
  frames: [number, 32][];
  still: number;
}

// SAFETY: This metadata is a bundled, generated asset checked by the package tests.
const cube = JSON.parse(
  readFileSync(new URL("./assets/cube.json", import.meta.url), "utf8"),
) as CubeAnimation;
const frames = cube.frames.map((frame) => String.fromCodePoint(...frame));
// The ordinary-space spacer reserves the second cell; never map it to this font.
const codepoints = cube.frames.map(([codepoint]) => codepoint);
const range = [Math.min(...codepoints), Math.max(...codepoints)]
  .map((codepoint) => `U+${codepoint.toString(16).toUpperCase()}`)
  .join("-");
const mapping = `font-codepoint-map = ${range}=${cube.family}`;
const fontPath = fileURLToPath(new URL("./assets/CubeSpinner.ttf", import.meta.url));
const usage = "/cube-spinner on|static|off|preview";

export function createSpinner() {
  let mode: "on" | "static" | "off" = "on";

  const apply = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setWorkingIndicator(
      mode === "off"
        ? undefined
        : {
            frames: mode === "static" ? [frames[cube.still]] : frames,
            intervalMs: 1000 / cube.fps,
          },
    );
  };

  const command = (args: string, ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;

    switch (args.trim().toLowerCase()) {
      case "":
        ctx.ui.notify(
          `Cube spinner: ${mode}. ${usage}\nChoices are runtime-only; reloading the extension starts in on mode.`,
          "info",
        );
        return;
      case "preview":
        ctx.ui.notify(
          [
            `Solved: ${frames[cube.still]}`,
            `Frames: ${[0, 0.25, 0.5, 0.75].map((fraction) => frames[Math.floor(fraction * frames.length)]).join(" ")}`,
            `Font: ${cube.family}`,
            `Font file: ${fontPath}`,
            `Ghostty: ${mapping}`,
            "Install the bundled font and configure your terminal. Boxes or unrelated symbols mean the font is not ready.",
            "Use /cube-spinner on to animate while Pi works, or /cube-spinner off to restore Pi's default spinner.",
          ].join("\n"),
          "info",
        );
        return;
      case "on":
        mode = "on";
        break;
      case "static":
        mode = "static";
        break;
      case "off":
        mode = "off";
        break;
      default:
        ctx.ui.notify(`Usage: ${usage}`, "error");
        return;
    }

    apply(ctx);
    ctx.ui.notify(
      mode === "off"
        ? "Cube spinner off: restored Pi's default spinner."
        : `Cube spinner: ${mode}.`,
      "info",
    );
  };

  return { apply, command };
}
