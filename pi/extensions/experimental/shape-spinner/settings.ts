import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, SettingItem, TuiMouseEvent } from "@earendil-works/pi-tui";

/** One spinner's preview: the frame to show at each tick, or nothing when its look is off. */
export interface PreviewRow {
  readonly label: string;
  readonly meta: string;
  readonly frameAt: (tick: number) => string | undefined;
}

/** The spinner state surface the settings dialog reads and edits. */
export interface SettingsModel {
  /** Frame interval shared by every preview row. */
  readonly intervalMs: number;
  readonly footer: readonly string[];
  readonly items: SettingItem[];
  readonly preview: () => readonly PreviewRow[];
  /** Advance the setting one step and restyle the real spinners immediately. */
  readonly update: (id: string) => void;
  /** Current value for every item id, kept in sync with cascading changes. */
  readonly values: () => Readonly<Record<string, string>>;
}

const MAX_VISIBLE = 10;

/** Animates every configured spinner at its real frame rate, sharing one tick. */
class SpinnerPreview implements Component {
  private tick = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly model: SettingsModel,
    private readonly accent: (text: string) => string,
    private readonly dim: (text: string) => string,
    requestRender: () => void,
  ) {
    this.timer = setInterval(() => {
      this.tick += 1;
      requestRender();
    }, model.intervalMs);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {
    // Preview lines are rebuilt on every render; there is no cached state.
  }

  render(): string[] {
    const rows = this.model.preview();
    const labelWidth = Math.max(...rows.map((row) => visibleWidth(row.label)));

    return rows.map((row) => {
      const label = this.accent(row.label.padEnd(labelWidth + 2));
      const frame = row.frameAt(this.tick);

      if (frame === undefined) return ` ${label}${this.dim("off")}`;

      return ` ${label}${frame} ${row.meta}`;
    });
  }
}

/**
 * Opens the shape spinner settings as an overlay, so the live editor with its
 * restyled border spinners stays visible around the dialog while editing.
 */
export const openSettings = async (ctx: ExtensionContext, model: SettingsModel): Promise<void> => {
  await ctx.ui.custom<null>(
    (tui, theme, _keybindings, done) => {
      const list = new SettingsList(
        model.items,
        MAX_VISIBLE,
        getSettingsListTheme(),
        (id) => {
          model.update(id);

          // Playback `on` re-enables every spinner; resync all rows with the state.
          for (const [itemId, current] of Object.entries(model.values())) {
            list.updateValue(itemId, current);
          }

          tui.requestRender();
        },
        () => done(null),
      );

      const preview = new SpinnerPreview(
        model,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("dim", text),
        () => tui.requestRender(),
      );

      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Shape Spinner")), 0, 1));
      container.addChild(preview);
      container.addChild(new Spacer());
      container.addChild(list);

      for (const line of model.footer) container.addChild(new Text(theme.fg("dim", line), 1, 0));

      return {
        dispose: () => preview.dispose(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
        handleMouse: (event: TuiMouseEvent) => container.handleMouse(event),
        invalidate: () => container.invalidate(),
        render: (width: number) => container.render(width),
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", margin: 1, minWidth: 64, width: "80%" } },
  );
};
