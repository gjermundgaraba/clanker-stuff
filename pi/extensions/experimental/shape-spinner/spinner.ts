import { fileURLToPath } from "node:url";
import manifest from "./assets/shapes.json" with { type: "json" };

import { acquireEditorHost } from "@clanker-stuff/editor";
import type { StatusStyle } from "@clanker-stuff/editor";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  backgrounds,
  colors,
  defaultConfig,
  kinds,
  loadConfig,
  motions,
  saveConfig,
  shapes,
} from "./config.js";
import type { Config, Kind } from "./config.js";
import { openSettings } from "./settings.js";

const labels: Record<Kind, string> = {
  branchSummary: "Summary",
  compaction: "Compaction",
  retry: "Retry",
  working: "Working",
};

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

/** The indicator for one status kind, or nothing to keep Pi's own. */
export const styleFor = (config: Config, kind: Kind): StatusStyle | undefined => {
  const look = config.looks[kind];

  if (!look.enabled) return undefined;

  const animation =
    look.shape === "rubik"
      ? manifest.rubik
      : manifest.animations[look.shape][look.color][config.background];

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
      "Wireframe ink tuned for dark or light terminals; the puzzle keeps its sticker colors.",
    get: () => config.background,
    id: "background",
    label: "Background",
    set: (value) => {
      config.background = pick(backgrounds, value, config.background);
    },
    values: backgrounds,
  },
  ...kinds.flatMap((kind): Row[] => {
    const look = config.looks[kind];

    return [
      {
        description:
          "rubik is the colored puzzle; the others are wireframes that take their color and background ink.",
        get: () => look.shape,
        id: `${kind}.shape`,
        label: `${labels[kind]} shape`,
        set: (value) => {
          look.shape = pick(shapes, value, look.shape);
        },
        values: shapes,
      },
      {
        description: "Ink for the wireframe; the colored puzzle keeps its sticker colors.",
        get: () => look.color,
        id: `${kind}.color`,
        label: `${labels[kind]} color`,
        set: (value) => {
          look.color = pick(colors, value, look.color);
        },
        values: colors,
      },
      {
        description: "Off falls back to Pi's own indicator for this status.",
        get: () => (look.enabled ? "on" : "off"),
        id: `${kind}.enabled`,
        label: `${labels[kind]} enabled`,
        set: (value) => {
          look.enabled = value === "on";
        },
        values: ["on", "off"],
      },
    ];
  }),
];

export function createSpinner() {
  let config = defaultConfig();
  let release: (() => void) | undefined;

  const apply = (ctx: ExtensionContext): void => {
    ctx.ui.setWorkingIndicator(styleFor(config, "working"));
    // Border spinners belong to the shared editor; without it only the working spinner changes.
    release = acquireEditorHost(ctx)?.contribute("status", (kind) => styleFor(config, kind));
  };

  const start = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return;

    config = await loadConfig();
    apply(ctx);
  };

  const dispose = (): void => {
    release?.();
    release = undefined;
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
      previews: () =>
        kinds.map((kind) => ({
          frames: styleFor(config, kind)?.frames,
          label: labels[kind],
          meta: `${config.looks[kind].shape} · ${config.looks[kind].color}`,
        })),
    });

    if (changed) await saveConfig(config);
  };

  return { command, dispose, start };
}
