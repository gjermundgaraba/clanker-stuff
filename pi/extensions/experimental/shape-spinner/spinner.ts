import { fileURLToPath } from "node:url";
import manifest from "./assets/shapes.json" with { type: "json" };

import type { ExtensionContext, ThemeAppearance } from "@earendil-works/pi-coding-agent";

import { colors, defaultConfig, loadConfig, motions, saveConfig, shapes } from "./config.js";
import type { Config } from "./config.js";
import { openSettings } from "./settings.js";

// The unmapped space reserves a second terminal column for the square artwork.
const glyph = (codepoint: number): string => `${String.fromCodePoint(codepoint)} `;

const loops = [
  manifest.rubik,
  ...Object.values(manifest.animations).flatMap((byColor) =>
    Object.values(byColor).flatMap((byBackground) => Object.values(byBackground)),
  ),
];

const codepoints = loops.flatMap((animation) => [...animation.frames, animation.still]);

const range = [Math.min(...codepoints), Math.max(...codepoints)]
  .map((cp) => `U+${cp.toString(16).toUpperCase()}`)
  .join("-");

const mapping = `font-codepoint-map = ${range}=${manifest.family}`;

const fontPath = fileURLToPath(new URL("./assets/ShapeSpinner.ttf", import.meta.url));

const frameIntervalMs = 1000 / manifest.fps;

/** Pi's working indicator for a look, with wireframe ink for the theme's background. */
export const styleFor = (
  config: Config,
  appearance: ThemeAppearance,
): { frames: string[]; intervalMs: number } => {
  const animation =
    config.shape === "rubik"
      ? manifest.rubik
      : manifest.animations[config.shape][config.color][appearance];

  return {
    frames: (config.motion === "static" ? [animation.still] : animation.frames).map(glyph),
    intervalMs: frameIntervalMs,
  };
};

/** One settings dialog row editing `config` in place. */
export interface Row {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly values: readonly string[];
  readonly get: () => string;
  readonly set: (value: string) => void;
}

const pick = <T extends string>(options: readonly T[], value: string, current: T): T =>
  options.find((option) => option === value) ?? current;

export const settingRows = (config: Config): Row[] => [
  {
    description: "animated plays the loop; static rests on the closing pose.",
    get: () => config.motion,
    id: "motion",
    label: "Motion",
    set: (value) => {
      config.motion = pick(motions, value, config.motion);
    },
    values: motions,
  },
  {
    description:
      "rubik is the colored puzzle; the others are wireframes inked for your theme's light or dark background.",
    get: () => config.shape,
    id: "shape",
    label: "Shape",
    set: (value) => {
      config.shape = pick(shapes, value, config.shape);
    },
    values: shapes,
  },
  {
    description: "Ink for the wireframe; the colored puzzle keeps its sticker colors.",
    get: () => config.color,
    id: "color",
    label: "Color",
    set: (value) => {
      config.color = pick(colors, value, config.color);
    },
    values: colors,
  },
];

export function createSpinner() {
  let config = defaultConfig();

  // Pi has no theme-change event, so a light/dark switch shows from the next run.
  const apply = (ctx: ExtensionContext): void => {
    if (ctx.mode === "tui") ctx.ui.setWorkingIndicator(styleFor(config, ctx.ui.theme.appearance));
  };

  const start = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return;

    config = await loadConfig();
    apply(ctx);
  };

  const command = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return;

    const rows = settingRows(config);
    let changed = false;

    await openSettings(ctx, {
      footer: [`Ghostty: ${mapping}`, `Font: ${fontPath}`],
      intervalMs: frameIntervalMs,
      items: rows.map((row) => ({
        currentValue: row.get(),
        description: row.description,
        id: row.id,
        label: row.label,
        values: [...row.values],
      })),
      onChange: (id, value) => {
        rows.find((row) => row.id === id)?.set(value);
        changed = true;
        apply(ctx);
      },
      preview: () => ({
        frames: styleFor(config, ctx.ui.theme.appearance).frames,
        label: "Working",
        meta: `${config.shape} · ${config.color}`,
      }),
    });

    if (changed) await saveConfig(config);
  };

  return { apply, command, start };
}
