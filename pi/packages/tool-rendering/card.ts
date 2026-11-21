import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  KeybindingHints,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import { spread } from "./layout.js";
import { preview } from "./preview.js";

export interface CardParts {
  /** The first row, already themed. */
  readonly heading: string;
  /** Plain text such as an ID, drawn dim at the right of the heading when it fits. */
  readonly aside?: string;
  /** Themed rows under the heading. */
  readonly lines?: readonly string[];
  /** Markdown under the rows, bounded to `limit` rows until expanded. */
  readonly body?: string;
}

export interface CardView extends Pick<KeybindingHints, "keyHint"> {
  readonly expanded: boolean;
}

const INDENT = 2;

class HeadingRow implements Component {
  private readonly heading: string;
  private readonly side: string;
  private cache: { width: number; rows: string[] } | undefined;

  constructor(theme: Theme, heading: string, aside: string | undefined) {
    this.heading = heading;
    this.side =
      aside === undefined || aside === "" ? "" : theme.fg("dim", aside);
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.cache?.width !== width) {
      this.cache = { width, rows: [spread(this.heading, this.side, width)] };
    }

    return this.cache.rows;
  }
}

/**
 * A transcript card: a heading with an optional right-hand aside, then
 * indented rows and a bounded Markdown body. `pad` is the horizontal padding
 * around the whole card; tool slots pass 0 because Pi pads them already.
 */
export const card = (
  theme: Theme,
  view: CardView,
  parts: CardParts,
  {
    pad = 0,
    limit = 4,
  }: { readonly pad?: number; readonly limit?: number } = {}
): Component => {
  const box = new Box(pad, 0);
  box.addChild(new HeadingRow(theme, parts.heading, parts.aside));

  if (parts.lines !== undefined && parts.lines.length > 0) {
    box.addChild(new Text(parts.lines.join("\n"), INDENT, 0));
  }

  const body = parts.body?.trim() ?? "";

  if (body !== "") {
    box.addChild(
      preview(
        () => new Markdown(body, INDENT, 0, getMarkdownTheme()),
        view,
        limit
      )
    );
  }

  return box;
};

/**
 * The padding Pi gives its own transcript rows, for renderers whose options do
 * not carry it, such as entry renderers. Mirrors Pi's own reading: 0 or 1.
 */
export const entryPad = (
  settings: Pick<ReturnType<ExtensionAPI["getSettings"]>, "outputPad">
): number => (settings.outputPad === 0 ? 0 : 1);
