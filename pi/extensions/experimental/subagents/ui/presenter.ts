import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { BRAILLE_MARKS } from "./format.js";
import type { Marks } from "./format.js";
import { openViewer } from "./viewer.js";
import type { ViewerSource } from "./viewer.js";
import { AgentsWidget } from "./widget.js";

const WIDGET_KEY = "subagents";

/** The shortcut that opens the viewer; the widget advertises it. */
export const VIEWER_SHORTCUT = "alt+a";

type PresenterContext = Pick<ExtensionContext, "cwd" | "mode" | "ui">;

/** Shows the live tree while any child runs, and opens the viewer on request. TUI mode only. */
export class Presenter {
  readonly #source: ViewerSource;
  #ctx: PresenterContext | undefined;
  #marks: Marks = BRAILLE_MARKS;
  #shown = false;
  #unsubscribe: (() => void) | undefined;

  constructor(source: ViewerSource) {
    this.#source = source;
  }

  start(ctx: PresenterContext, marks: Marks): void {
    this.stop();

    if (ctx.mode !== "tui") {
      return;
    }

    this.#ctx = ctx;
    this.#marks = marks;
    this.#unsubscribe = this.#source.monitor.onChange(() => {
      this.#sync();
    });
    this.#sync();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;

    if (this.#shown) {
      this.#ctx?.ui.setWidget(WIDGET_KEY, undefined);
    }

    this.#shown = false;
    this.#ctx = undefined;
  }

  async open(ctx: PresenterContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("The subagent viewer requires TUI mode", "error");

      return;
    }

    await openViewer(ctx.ui, this.#source, this.#marks, ctx.cwd);
  }

  #sync(): void {
    const ctx = this.#ctx;

    if (ctx === undefined) {
      return;
    }

    const running = this.#source
      .nodes()
      .some((node) => node.status === "running");

    if (running && !this.#shown) {
      const since = Date.now();
      this.#shown = true;
      ctx.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) =>
          new AgentsWidget(
            tui,
            theme,
            this.#source,
            this.#marks,
            since,
            VIEWER_SHORTCUT
          )
      );
    } else if (!running && this.#shown) {
      this.#shown = false;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  }
}
