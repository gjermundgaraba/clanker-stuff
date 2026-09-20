import { fileURLToPath } from "node:url";
import manifest from "./assets/shapes.json" with { type: "json" };

import { acquireEditorHost } from "@clanker-stuff/editor";
import type { StatusKind, StatusStyle } from "@clanker-stuff/editor";
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

const animationFor = (shape: Shape, color: Color, background: Background): Animation =>
  shape === "rubik" ? manifest.rubik : manifest.animations[shape][color][background];

const range = [Math.min(...codepoints), Math.max(...codepoints)]
  .map((cp) => `U+${cp.toString(16).toUpperCase()}`)
  .join("-");

const mapping = `font-codepoint-map = ${range}=${manifest.family}`;

const fontPath = fileURLToPath(new URL("./assets/ShapeSpinner.ttf", import.meta.url));

const usage = `/shape-spinner ${[...shapes, ...colors, ...backgrounds, ...modes, "preview"].join("|")} or /shape-spinner ${kinds.join("|")} ${[...shapes, ...colors, ...toggles].join("|")}`;

const oneOf = <T extends string>(options: readonly T[], value: string): value is T =>
  options.some((option) => option === value);

const describeLook = (look: Look) => (look.enabled ? `${look.shape} ${look.color}` : "off");

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
      intervalMs: 1000 / manifest.fps,
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

  const choices = () => {
    const working = looks.working;

    return `Shape spinner: ${working.shape}, ${working.color}, ${background} background, ${mode}. Retry: ${describeLook(looks.retry)}. Compaction: ${describeLook(looks.compaction)}. Summary: ${describeLook(looks.summary)}.`;
  };

  const command = (args: string, ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const [first = "", second, ...rest] = args.trim().toLowerCase().split(/\s+/);

    if (!first) {
      ctx.ui.notify(
        `${choices()} ${usage}\nChoices are runtime-only; reload resets every spinner to its default look with dark-background ink.`,
        "info",
      );

      return;
    }

    if (first === "preview" && second === undefined) {
      const { shape, color } = looks.working;
      ctx.ui.notify(
        [
          ...shapes.map((name) => {
            const animation = animationFor(name, color, background);

            // Bundled loops are nonempty (checked by the builder and asset tests); each fraction is in [0, 1).
            return `${name}: ${glyph(animation.still)} ${[0, 0.25, 0.5, 0.75].map((fraction) => glyph(animation.frames[Math.floor(fraction * animation.frames.length)]!)).join(" ")}`;
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

    if (second !== undefined) {
      const look = oneOf(kinds, first) && rest.length === 0 ? looks[first] : undefined;

      if (look === undefined) {
        ctx.ui.notify(`Usage: ${usage}`, "error");

        return;
      }

      if (oneOf(shapes, second)) look.shape = second;
      else if (oneOf(colors, second)) look.color = second;
      else if (oneOf(toggles, second)) look.enabled = second === "on";
      else {
        ctx.ui.notify(`Usage: ${usage}`, "error");

        return;
      }

      apply(ctx);
      ctx.ui.notify(`Shape spinner ${first}: ${describeLook(look)}.`, "info");

      return;
    }

    if (oneOf(shapes, first)) looks.working.shape = first;
    else if (oneOf(colors, first)) looks.working.color = first;
    else if (oneOf(backgrounds, first)) background = first;
    else if (oneOf(modes, first)) {
      mode = first;

      // Global playback applies to every spinner, including ones turned off individually.
      if (first === "on") for (const look of Object.values(looks)) look.enabled = true;
    } else {
      ctx.ui.notify(`Usage: ${usage}`, "error");

      return;
    }

    apply(ctx);
    ctx.ui.notify(
      mode === "off"
        ? "Shape spinner off: restored Pi's default spinners."
        : `Shape spinner: ${looks.working.shape}, ${looks.working.color}, ${background} background, ${mode}.`,
      "info",
    );
  };

  return { apply, command, dispose };
}
