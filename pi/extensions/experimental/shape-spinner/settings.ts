import { fileURLToPath } from "node:url";

import { manifest } from "@clanker-stuff/pi-shape-glyphs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Loader,
  SettingsList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { SettingItem } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";

import { colors, ConfigSchema, motions, shapes, styleFor } from "./config.js";
import type { Config } from "./config.js";

const loops = [
  manifest.rubik,
  ...Object.values(manifest.animations).flatMap((byColor) =>
    Object.values(byColor).flatMap((byBackground) =>
      Object.values(byBackground)
    )
  ),
];

const codepoints = loops.flatMap((animation) => [
  ...animation.frames,
  animation.still,
]);

const range = [Math.min(...codepoints), Math.max(...codepoints)]
  .map((cp) => `U+${cp.toString(16).toUpperCase()}`)
  .join("-");

const mapping = `font-codepoint-map = ${range}=${manifest.family}`;

const fontPath = fileURLToPath(
  new URL("assets/ShapeSpinner.ttf", import.meta.url)
);

export const updateSetting = (
  config: Config,
  id: string,
  value: string
): void => {
  const next = { ...config, [id]: value };

  if (Value.Check(ConfigSchema, next)) {
    Object.assign(config, next);
  }
};

export const openSettings = async (
  ctx: ExtensionContext,
  config: Config,
  onChange: () => void
): Promise<void> => {
  await ctx.ui.custom<null>(
    (tui, theme, _keybindings, done) => {
      const previewLabel = () => `${config.shape} · ${config.color}`;

      const preview = new Loader(
        tui,
        (frame) => frame,
        (label) => `${theme.fg("accent", "Working")}  ${label}`,
        previewLabel(),
        styleFor(config, ctx.ui.theme.appearance)
      );

      const items: SettingItem[] = [
        {
          currentValue: config.motion,
          description:
            "animated plays the loop; static rests on the closing pose.",
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
          description:
            "Ink for the wireframe; the colored puzzle keeps its sticker colors.",
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
          preview.setIndicator(styleFor(config, ctx.ui.theme.appearance));
          preview.setMessage(previewLabel());
        },
        () => {
          done(null);
        }
      );

      const container = new Container();
      container.addChild(new Spacer());
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Shape Spinner")), 0, 0)
      );
      container.addChild(preview);
      container.addChild(new Spacer());
      container.addChild(list);

      for (const line of [`Ghostty: ${mapping}`, `Font: ${fontPath}`]) {
        container.addChild(new Text(theme.fg("dim", line), 1, 0));
      }

      return {
        dispose: () => {
          preview.stop();
        },
        handleInput: (data) => {
          list.handleInput(data);
        },
        handleMouse: (event) => container.handleMouse(event),
        invalidate: () => {
          container.invalidate();
        },
        render: (width) => container.render(width),
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        margin: 1,
        minWidth: 64,
        width: "80%",
      },
    }
  );
};
