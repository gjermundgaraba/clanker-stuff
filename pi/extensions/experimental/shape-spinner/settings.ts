import { fileURLToPath } from "node:url";

import { FRAME_INTERVAL_MS, manifest } from "@clanker-stuff/pi-shape-glyphs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component, SettingItem, TuiMouseEvent } from "@earendil-works/pi-tui";

import { colors, motions, shapes, styleFor } from "./config.js";
import type { Config } from "./config.js";

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

/** Apply a SettingsList value, ignoring values that the setting does not offer. */
export const updateSetting = (config: Config, id: string, value: string): void => {
  switch (id) {
    case "motion":
      config.motion = motions.find((motion) => motion === value) ?? config.motion;
      break;
    case "shape":
      config.shape = shapes.find((shape) => shape === value) ?? config.shape;
      break;
    case "color":
      config.color = colors.find((color) => color === value) ?? config.color;
      break;
  }
};

/** Animates the configured spinner at its real frame rate. */
class SpinnerPreview implements Component {
  private tick = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: Config,
    public frames: readonly string[],
    private readonly accent: (text: string) => string,
    requestRender: () => void,
  ) {
    this.timer = setInterval(() => {
      this.tick += 1;
      requestRender();
    }, FRAME_INTERVAL_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {
    // Preview lines are rebuilt on every render; there is no cached state.
  }

  render(): string[] {
    const { shape, color } = this.config;
    const frame = this.frames[this.tick % this.frames.length] ?? "";

    return [` ${this.accent("Working  ")}${frame} ${shape} · ${color}`];
  }
}

/**
 * Opens the shape spinner settings as an overlay, so the live editor with its
 * restyled border spinners stays visible around the dialog while editing.
 */
export const openSettings = async (
  ctx: ExtensionContext,
  config: Config,
  onChange: () => void,
): Promise<void> => {
  await ctx.ui.custom<null>(
    (tui, theme, _keybindings, done) => {
      // The preview timer re-renders every frame, so edits need no render request of their own.
      const preview = new SpinnerPreview(
        config,
        styleFor(config, ctx.ui.theme.appearance).frames,
        (text) => theme.fg("accent", text),
        () => tui.requestRender(),
      );

      const items: SettingItem[] = [
        {
          currentValue: config.motion,
          description: "animated plays the loop; static rests on the closing pose.",
          id: "motion",
          label: "Motion",
          values: [...motions],
        },
        {
          currentValue: config.shape,
          description:
            "rubik is the colored puzzle; the others are wireframes inked for your theme's light or dark background.",
          id: "shape",
          label: "Shape",
          values: [...shapes],
        },
        {
          currentValue: config.color,
          description: "Ink for the wireframe; the colored puzzle keeps its sticker colors.",
          id: "color",
          label: "Color",
          values: [...colors],
        },
      ];

      const list = new SettingsList(
        items,
        10,
        getSettingsListTheme(),
        (id, value) => {
          updateSetting(config, id, value);
          onChange();
          preview.frames = styleFor(config, ctx.ui.theme.appearance).frames;
        },
        () => done(null),
      );

      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Shape Spinner")), 0, 1));
      container.addChild(preview);
      container.addChild(new Spacer());
      container.addChild(list);

      for (const line of [`Ghostty: ${mapping}`, `Font: ${fontPath}`])
        container.addChild(new Text(theme.fg("dim", line), 1, 0));

      return {
        dispose: () => preview.dispose(),
        handleInput: (data: string) => list.handleInput(data),
        handleMouse: (event: TuiMouseEvent) => container.handleMouse(event),
        invalidate: () => container.invalidate(),
        render: (width: number) => container.render(width),
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", margin: 1, minWidth: 64, width: "80%" } },
  );
};
