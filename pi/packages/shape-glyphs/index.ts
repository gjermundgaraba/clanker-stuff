import manifest from "./shapes.json" with { type: "json" };

export { default as manifest } from "./shapes.json" with { type: "json" };

/** The command the shape-spinner extension registers; its presence shows the font is in use. */
export const SHAPE_SPINNER_COMMAND = "shape-spinner";

export const FRAME_INTERVAL_MS = 1000 / manifest.fps;

export type Wireframe = keyof typeof manifest.animations;

export type Ink = keyof (typeof manifest.animations)[Wireframe];

/** The theme background a wireframe's ink suits. */
export type Background = keyof (typeof manifest.animations)[Wireframe][Ink];

export interface Animation {
  readonly frames: readonly string[];
  readonly still: string;
}

const SECOND_COLUMN_PAD = " ";

const twoColumnGlyph = (codepoint: number): string =>
  `${String.fromCodePoint(codepoint)}${SECOND_COLUMN_PAD}`;

const animation = ({
  frames,
  still,
}: {
  frames: number[];
  still: number;
}): Animation => ({
  frames: frames.map(twoColumnGlyph),
  still: twoColumnGlyph(still),
});

const wireframes = new Map<string, Animation>();

/** A wireframe's frames, built once; spinners draw them on every tick. */
export const wireframe = (
  shape: Wireframe,
  ink: Ink,
  background: Background
): Animation => {
  const key = `${shape}/${ink}/${background}`;
  const cached = wireframes.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const built = animation(manifest.animations[shape][ink][background]);
  wireframes.set(key, built);

  return built;
};

/** The colored puzzle, whose stickers keep their colors on any background. */
export const RUBIK: Animation = animation(manifest.rubik);
