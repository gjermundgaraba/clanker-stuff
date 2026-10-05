import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component, SettingItem, TuiMouseEvent } from "@earendil-works/pi-tui";

/** The spinner's preview loop. */
export interface Preview {
  readonly label: string;
  readonly meta: string;
  readonly frames: readonly string[];
}

export interface SettingsView {
  readonly intervalMs: number;
  readonly footer: readonly string[];
  readonly items: SettingItem[];
  readonly onChange: (id: string, value: string) => void;
  readonly preview: () => Preview;
}

const MAX_VISIBLE = 10;

/** Animates the configured spinner at its real frame rate. */
class SpinnerPreview implements Component {
  private tick = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    public preview: Preview,
    intervalMs: number,
    private readonly accent: (text: string) => string,
    requestRender: () => void,
  ) {
    this.timer = setInterval(() => {
      this.tick += 1;
      requestRender();
    }, intervalMs);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {
    // Preview lines are rebuilt on every render; there is no cached state.
  }

  render(): string[] {
    const { label, frames, meta } = this.preview;

    return [` ${this.accent(`${label}  `)}${frames[this.tick % frames.length] ?? ""} ${meta}`];
  }
}

/**
 * Opens the shape spinner settings as an overlay, so the live editor with its
 * restyled border spinners stays visible around the dialog while editing.
 */
export const openSettings = async (ctx: ExtensionContext, view: SettingsView): Promise<void> => {
  await ctx.ui.custom<null>(
    (tui, theme, _keybindings, done) => {
      // The preview timer re-renders every frame, so edits need no render request of their own.
      const preview = new SpinnerPreview(
        view.preview(),
        view.intervalMs,
        (text) => theme.fg("accent", text),
        () => tui.requestRender(),
      );

      const list = new SettingsList(
        view.items,
        MAX_VISIBLE,
        getSettingsListTheme(),
        (id, value) => {
          view.onChange(id, value);
          preview.preview = view.preview();
        },
        () => done(null),
      );

      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Shape Spinner")), 0, 1));
      container.addChild(preview);
      container.addChild(new Spacer());
      container.addChild(list);

      for (const line of view.footer) container.addChild(new Text(theme.fg("dim", line), 1, 0));

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
