import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, SettingItem, TuiMouseEvent } from "@earendil-works/pi-tui";

/** One spinner's preview loop, or no frames when its look is off. */
export interface Preview {
  readonly label: string;
  readonly meta: string;
  readonly frames: readonly string[] | undefined;
}

export interface SettingsView {
  /** Frame interval shared by every preview row. */
  readonly intervalMs: number;
  readonly footer: readonly string[];
  readonly items: SettingItem[];
  readonly onChange: (id: string, value: string) => void;
  readonly previews: () => readonly Preview[];
}

const MAX_VISIBLE = 10;

/** Animates every configured spinner at its real frame rate, sharing one tick. */
class SpinnerPreview implements Component {
  private tick = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    public previews: readonly Preview[],
    intervalMs: number,
    private readonly accent: (text: string) => string,
    private readonly dim: (text: string) => string,
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
    const labelWidth = Math.max(...this.previews.map((row) => visibleWidth(row.label)));

    return this.previews.map((row) => {
      const label = this.accent(row.label.padEnd(labelWidth + 2));
      const frame = row.frames?.[this.tick % row.frames.length];

      return frame === undefined ? ` ${label}${this.dim("off")}` : ` ${label}${frame} ${row.meta}`;
    });
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
        view.previews(),
        view.intervalMs,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("dim", text),
        () => tui.requestRender(),
      );

      const list = new SettingsList(
        view.items,
        MAX_VISIBLE,
        getSettingsListTheme(),
        (id, value) => {
          view.onChange(id, value);
          preview.previews = view.previews();
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
