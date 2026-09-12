import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const shapes = ["rubik", "orb", "cube", "octahedron", "tetrahedron"] as const;
const colors = [
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
const backgrounds = ["dark", "light"] as const;
const modes = ["on", "static", "off"] as const;
type Shape = (typeof shapes)[number];
type Color = (typeof colors)[number];
type Background = (typeof backgrounds)[number];
interface Animation {
  frames: number[];
  still: number;
}
interface Manifest {
  family: string;
  fps: number;
  animations: Record<Exclude<Shape, "rubik">, Record<Color, Record<Background, Animation>>>;
  rubik: Animation;
}

// SAFETY: Bundled generated metadata is validated by the builder and package tests.
const manifest = JSON.parse(
  readFileSync(new URL("./assets/shapes.json", import.meta.url), "utf8"),
) as Manifest;
// The unmapped space reserves a second terminal column for the square artwork.
const glyph = (codepoint: number): string => `${String.fromCodePoint(codepoint)} `;
const loops = [
  manifest.rubik,
  ...Object.values(manifest.animations).flatMap((colors) =>
    Object.values(colors).flatMap((backgrounds) => Object.values(backgrounds)),
  ),
];
const codepoints = loops.flatMap((animation) => [...animation.frames, animation.still]);
const animationFor = (shape: Shape, color: Color, background: Background): Animation =>
  shape === "rubik" ? manifest.rubik : manifest.animations[shape][color][background];
const range = [Math.min(...codepoints), Math.max(...codepoints)]
  .map((cp) => `U+${cp.toString(16).toUpperCase()}`)
  .join("-");
const mapping = `font-codepoint-map = ${range}=${manifest.family}`;
const fontPath = fileURLToPath(new URL("./assets/ShapeSpinner.ttf", import.meta.url));
const usage = `/shape-spinner ${[...shapes, ...colors, ...backgrounds, ...modes, "preview"].join("|")}`;
const oneOf = <T extends string>(options: readonly T[], value: string): value is T =>
  options.some((option) => option === value);

export function createSpinner() {
  let shape: Shape = "orb";
  let background: Background = "dark";
  let color: Color = "cyan";
  let mode: (typeof modes)[number] = "on";

  const apply = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const animation = animationFor(shape, color, background);
    ctx.ui.setWorkingIndicator(
      mode === "off"
        ? undefined
        : {
            frames: (mode === "static" ? [animation.still] : animation.frames).map(glyph),
            intervalMs: 1000 / manifest.fps,
          },
    );
  };

  const command = (args: string, ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const action = args.trim().toLowerCase();
    if (!action) {
      ctx.ui.notify(
        `Shape spinner: ${shape}, ${color}, ${background} background, ${mode}. ${usage}\nChoices are runtime-only; reload resets to animated cyan orb with dark-background ink.`,
        "info",
      );
      return;
    }
    if (action === "preview") {
      ctx.ui.notify(
        [
          ...shapes.map((name) => {
            const animation = animationFor(name, color, background);
            return `${name}: ${glyph(animation.still)} ${[0, 0.25, 0.5, 0.75].map((fraction) => glyph(animation.frames[Math.floor(fraction * animation.frames.length)])).join(" ")}`;
          }),
          `Colors (${shape === "rubik" ? "orb" : shape}): ${colors.map((name) => `${name} ${glyph(animationFor(shape === "rubik" ? "orb" : shape, name, background).still)}`).join("  ")}`,
          `Color: ${color}. Background: ${background}. Font: ${manifest.family}`,
          `Font file: ${fontPath}`,
          `Ghostty: ${mapping}`,
          "Install the font on the display machine and configure your terminal. Boxes or unrelated symbols mean the font is not ready.",
          "rubik is the colored puzzle; cube is the wireframe. Color and dark/light only change wireframes; Rubik keeps its sticker colors.",
          "Use /shape-spinner off to restore Pi's default.",
        ].join("\n"),
        "info",
      );
      return;
    }
    if (oneOf(shapes, action)) shape = action;
    else if (oneOf(colors, action)) color = action;
    else if (oneOf(backgrounds, action)) background = action;
    else if (oneOf(modes, action)) mode = action;
    else {
      ctx.ui.notify(`Usage: ${usage}`, "error");
      return;
    }
    apply(ctx);
    ctx.ui.notify(
      mode === "off"
        ? "Shape spinner off: restored Pi's default spinner."
        : `Shape spinner: ${shape}, ${color}, ${background} background, ${mode}.`,
      "info",
    );
  };

  return { apply, command };
}
