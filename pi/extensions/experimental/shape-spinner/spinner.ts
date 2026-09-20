import { fileURLToPath } from "node:url";
import manifest from "./assets/shapes.json" with { type: "json" };

import { acquireEditorHost } from "@clanker-stuff/editor";
import type { StatusKind, StatusStyle } from "@clanker-stuff/editor";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { openSettings } from "./settings.js";
import type { SettingsModel } from "./settings.js";

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

/** Pi's border spinners by command name; `summary` is the branch-summary indicator. */
const kinds = ["working", "retry", "compaction", "summary"] as const;

const toggles = ["on", "off"] as const;

type Shape = (typeof shapes)[number];

type Color = (typeof colors)[number];

type Background = (typeof backgrounds)[number];

type Kind = (typeof kinds)[number];

type Animation = typeof manifest.rubik;

interface Look {
  color: Color;
  enabled: boolean;
  shape: Shape;
}

const statusKinds: Record<StatusKind, Exclude<Kind, "working">> = {
  branchSummary: "summary",
  compaction: "compaction",
  retry: "retry",
};

// Shape signals the kind of work; color follows its severity.
const defaultLooks = (): Record<Kind, Look> => ({
  compaction: { color: "purple", enabled: true, shape: "cube" },
  retry: { color: "orange", enabled: true, shape: "tetrahedron" },
  summary: { color: "blue", enabled: true, shape: "octahedron" },
  working: { color: "cyan", enabled: true, shape: "orb" },
});

// The unmapped space reserves a second terminal column for the square artwork.
const glyph = (codepoint: number): string => `${String.fromCodePoint(codepoint)} `;

const loops = [
  manifest.rubik,
  ...Object.values(manifest.animations).flatMap((colors) =>
    Object.values(colors).flatMap((backgrounds) => Object.values(backgrounds)),
  ),
];

const codepoints = loops.flatMap((animation) => [...animation.frames, animation.still]);

const range = [Math.min(...codepoints), Math.max(...codepoints)]
  .map((cp) => `U+${cp.toString(16).toUpperCase()}`)
  .join("-");

const mapping = `font-codepoint-map = ${range}=${manifest.family}`;

const fontPath = fileURLToPath(new URL("./assets/ShapeSpinner.ttf", import.meta.url));

const frameIntervalMs = 1000 / manifest.fps;

/** Advance one step in a nonempty cycle; the options head covers an impossible miss. */
const advance = <T>(options: readonly [T, ...T[]], current: T): T =>
  options[(options.indexOf(current) + 1) % options.length] ?? options[0];

const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const animationFor = (shape: Shape, color: Color, background: Background): Animation =>
  shape === "rubik" ? manifest.rubik : manifest.animations[shape][color][background];

const descriptions = {
  background:
    "Wireframe ink tuned for dark or light terminals; the puzzle keeps its sticker colors.",
  color: "Ink for the wireframe; the colored puzzle keeps its sticker colors.",
  enabled: "Off falls back to Pi's own indicator for this status.",
  playback:
    "on animates, static rests on the closing pose, off restores Pi's own spinners everywhere. Returning to on re-enables every spinner.",
  shape:
    "rubik is the colored puzzle; the others are wireframes that take their color and background ink.",
} as const;

/**
 * One dialog row. SettingsList only cycles forward through `values`, so the row
 * advances its own state rather than trusting a value it was just handed back.
 */
interface Row {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly values: string[];
  readonly currentValue: () => string;
  readonly cycle: () => void;
}

export function createSpinner() {
  const looks = defaultLooks();
  let background: Background = "dark";
  let mode: (typeof modes)[number] = "on";
  let release: (() => void) | undefined;

  const style = (kind: Kind): StatusStyle | undefined => {
    const look = looks[kind];

    if (mode === "off" || !look.enabled) return undefined;

    const animation = animationFor(look.shape, look.color, background);

    return {
      frames: (mode === "static" ? [animation.still] : animation.frames).map(glyph),
      intervalMs: frameIntervalMs,
    };
  };

  const status = (kind: StatusKind) => style(statusKinds[kind]);

  const apply = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingIndicator(style("working"));
    // Border spinners belong to the shared editor; without it only the working spinner changes.
    release = acquireEditorHost(ctx)?.contribute("status", status);
  };

  const dispose = (): void => {
    release?.();
    release = undefined;
  };

  const spinnerRows = (kind: Kind): Row[] => {
    const look = looks[kind];

    return [
      {
        currentValue: () => look.shape,
        cycle: () => {
          look.shape = advance(shapes, look.shape);
        },
        description: descriptions.shape,
        id: `${kind}-shape`,
        label: `${capitalize(kind)} shape`,
        values: [...shapes],
      },
      {
        currentValue: () => look.color,
        cycle: () => {
          look.color = advance(colors, look.color);
        },
        description: descriptions.color,
        id: `${kind}-color`,
        label: `${capitalize(kind)} color`,
        values: [...colors],
      },
      {
        currentValue: () => (look.enabled ? "on" : "off"),
        cycle: () => {
          look.enabled = !look.enabled;
        },
        description: descriptions.enabled,
        id: `${kind}-enabled`,
        label: `${capitalize(kind)} enabled`,
        values: [...toggles],
      },
    ];
  };

  const rows = (): Row[] => [
    {
      currentValue: () => mode,
      cycle: () => {
        mode = advance(modes, mode);

        // Global playback `on` brings back spinners turned off individually.
        if (mode === "on") for (const look of Object.values(looks)) look.enabled = true;
      },
      description: descriptions.playback,
      id: "playback",
      label: "Playback",
      values: [...modes],
    },
    {
      currentValue: () => background,
      cycle: () => {
        background = advance(backgrounds, background);
      },
      description: descriptions.background,
      id: "background",
      label: "Background",
      values: [...backgrounds],
    },
    ...kinds.flatMap(spinnerRows),
  ];

  const settings = (ctx: ExtensionContext): SettingsModel => ({
    footer: [
      `Ghostty: ${mapping}`,
      `Font: ${fontPath}`,
      "Boxes or stray symbols mean the Shape Spinner font is missing on this machine; see docs/setup.md.",
      "Previews play even while playback is off.",
      "Choices are runtime-only; reload resets every spinner to its default look with dark-background ink.",
    ],
    intervalMs: frameIntervalMs,
    items: rows().map((row) => ({
      currentValue: row.currentValue(),
      description: row.description,
      id: row.id,
      label: row.label,
      values: row.values,
    })),
    preview: () =>
      kinds.map((kind) => {
        const look = looks[kind];
        const animation = animationFor(look.shape, look.color, background);

        return {
          frameAt: look.enabled
            ? (tick: number) =>
                glyph(
                  mode === "static"
                    ? animation.still
                    : // Bundled loops are nonempty (checked by the builder and asset tests).
                      animation.frames[tick % animation.frames.length]!,
                )
            : () => undefined,
          label: capitalize(kind),
          meta: `${look.shape} · ${look.color}`,
        };
      }),
    update: (id) => {
      rows()
        .find((row) => row.id === id)
        ?.cycle();
      apply(ctx);
    },
    values: () => Object.fromEntries(rows().map((row) => [row.id, row.currentValue()])),
  });

  const command = async (_args: string, ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return;

    await openSettings(ctx, settings(ctx));
  };

  return { apply, command, dispose };
}
