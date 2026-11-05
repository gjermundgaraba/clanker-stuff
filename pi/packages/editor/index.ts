import { errorMessage } from "@clanker-stuff/pi-tool-rendering/text";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

import { connect } from "./adapter.js";
import type { Layout } from "./adapter.js";
import { highlightRows } from "./render.js";
import type { Highlight } from "./render.js";

export interface Border {
  render(line: string, width: number, color: (text: string) => string): string;
}

interface Contributions {
  highlight?: ((text: string) => Highlight[]) | undefined;
  border?: Border | undefined;
}

class SharedEditor extends CustomEditor {
  readonly unsupported: string | undefined;
  private readonly layout: (() => Layout) | undefined;
  private readonly contributions: Contributions;
  private readonly uiTheme: () => Theme;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keys: KeybindingsManager,
    contributions: Contributions,
    uiTheme: () => Theme
  ) {
    super(tui, theme, keys, { embedWorkingStatus: true });
    this.contributions = contributions;
    this.uiTheme = uiTheme;

    try {
      this.layout = connect(this);
    } catch (error) {
      this.unsupported = errorMessage(error);
    }
  }
  override getText() {
    return this.getExpandedText();
  }
  override setText(text: string) {
    // Pi round-trips getText() through setText() when a custom view closes: https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2940-L2950
    if (text !== this.getExpandedText()) {
      super.setText(text);
    }
  }
  refresh() {
    this.tui.requestRender();
  }
  protected override renderTopBorder(
    width: number,
    hiddenLineCount: number
  ): string {
    const line = super.renderTopBorder(width, hiddenLineCount);

    return (
      this.contributions.border?.render(line, width, this.borderColor) ?? line
    );
  }
  override render(width: number) {
    let rows = super.render(width);
    const { layout } = this;
    const text = super.getText();
    const highlights = this.contributions.highlight?.(text) ?? [];

    if (layout && highlights.length > 0) {
      const padding = Math.min(
        this.getPaddingX(),
        Math.max(0, Math.floor((width - 1) / 2))
      );

      rows = highlightRows(
        rows,
        text,
        padding,
        layout(),
        highlights,
        this.uiTheme()
      );
    }

    return rows.map((row) => truncateToWidth(row, width, ""));
  }
}

export class EditorHost {
  editor: SharedEditor | undefined;
  private readonly contributions: Contributions = {};
  private history: string[] = [];
  private readonly theme: () => Theme;

  constructor(theme: () => Theme) {
    this.theme = theme;
  }
  create(tui: TUI, theme: EditorTheme, keys: KeybindingsManager) {
    if (this.editor) {
      return this.editor;
    }

    const editor = new SharedEditor(
      tui,
      theme,
      keys,
      this.contributions,
      this.theme
    );

    this.editor = editor;

    for (const entry of this.history) {
      editor.addToHistory(entry);
    }

    return editor;
  }
  /** One owner per slot; the release leaves a later owner's contribution in place. */
  contribute<K extends keyof Contributions>(
    slot: K,
    value: NonNullable<Contributions[K]>
  ) {
    this.contributions[slot] = value;
    this.editor?.refresh();

    return () => {
      if (this.contributions[slot] !== value) {
        return;
      }

      this.contributions[slot] = undefined;
      this.editor?.refresh();
    };
  }
  seedHistory(entries: string[]) {
    this.history = entries;

    for (const entry of entries) {
      this.editor?.addToHistory(entry);
    }
  }
}

const owner = Symbol.for("clanker-stuff.editor/4");

type OwnedFactory = NonNullable<
  ReturnType<ExtensionUIContext["getEditorComponent"]>
> & {
  [owner]?: EditorHost;
};

/** The shared editor while it is Pi's current editor; another extension can replace it later. */
export const currentEditorHost = (
  ctx: Pick<ExtensionContext, "ui">
): EditorHost | undefined => {
  const factory: OwnedFactory | undefined = ctx.ui.getEditorComponent();

  return factory?.[owner];
};

/** Install or join the shared editor. Undefined means another editor owns the session. */
export const acquireEditorHost = (
  ctx: Pick<ExtensionContext, "ui">
): EditorHost | undefined => {
  const { ui } = ctx;
  let host = currentEditorHost(ctx);

  if (!host) {
    if (ui.getEditorComponent()) {
      ui.setStatus(
        "shared-editor",
        "Custom editor: shared editing features unavailable"
      );

      return undefined;
    }

    const installed = new EditorHost(() => ui.theme);
    host = installed;

    const next: OwnedFactory = (tui, theme, keys) =>
      installed.create(tui, theme, keys);

    next[owner] = installed;
    const draft = ui.getEditorText();
    ui.setEditorComponent(next);
    // Pi's editor swap copies the previous editor's getText(), not its expanded text: https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2836-L2854
    installed.editor?.setText(draft);
  }

  ui.setStatus("shared-editor", host.editor?.unsupported);

  return host;
};

export type { Highlight } from "./render.js";
