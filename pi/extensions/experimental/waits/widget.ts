import { spread } from "@clanker-stuff/pi-tool-rendering/layout";
import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import type { WaitSnapshot } from "./machine.js";
import { span } from "./render.js";
import { rowOf } from "./report.js";

export interface LiveWait {
  readonly snapshot: WaitSnapshot;
  readonly expiresAt: number;
}

const STATUS_KEY = "waits.open";

const WIDGET_KEY = "waits.live";

const MAX_ROWS = 5;

const TICK_MS = 1000;

const progress = (wait: LiveWait, now: number): string => {
  const { context } = wait.snapshot;
  const left = `${span(wait.expiresAt - now)} left`;

  if (
    wait.snapshot.matches({ open: "checking" }) ||
    context.checkedAt === undefined
  ) {
    return `checking… · ${left}`;
  }

  const next = context.checkedAt + context.spec.intervalSeconds * 1000 - now;

  return `${rowOf(wait.snapshot).lastCheck} · next in ${span(next)} · ${left}`;
};

const waitRow = (theme: Theme, wait: LiveWait, now: number, width: number) =>
  spread(
    ` ${theme.fg("accent", "●")} ${theme.bold(inlineText(wait.snapshot.context.spec.label))} ${theme.fg("muted", progress(wait, now))}`,
    theme.fg("dim", `${wait.snapshot.context.id} `),
    width
  );

export class LiveWaitsWidget implements Component {
  private readonly theme: Theme;
  private readonly source: () => readonly LiveWait[];
  private readonly timer: ReturnType<typeof setInterval>;
  private cache: { key: string; rows: string[] } | undefined;

  constructor(tui: TUI, theme: Theme, source: () => readonly LiveWait[]) {
    this.theme = theme;
    this.source = source;
    this.timer = setInterval(() => {
      tui.requestRender();
    }, TICK_MS);
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    const now = Date.now();
    const key = `${width}:${Math.floor(now / TICK_MS)}`;

    if (this.cache?.key === key) {
      return this.cache.rows;
    }

    const waits = this.source().filter(
      (wait) => wait.snapshot.status === "active"
    );

    const rows = waits
      .slice(0, MAX_ROWS)
      .map((wait) => waitRow(this.theme, wait, now, width));

    if (waits.length > MAX_ROWS) {
      rows.push(
        this.theme.fg("dim", `   … ${waits.length - MAX_ROWS} more · /waits`)
      );
    }

    this.cache = { key, rows };

    return rows;
  }
}

/**
 * The waits that are live, shown as a count in the footer and as a widget
 * above the editor. Both appear only while a wait is open, and only in the TUI.
 */
export class WaitsView {
  private readonly source: () => readonly LiveWait[];
  private shown = false;

  constructor(source: () => readonly LiveWait[]) {
    this.source = source;
  }

  update(ctx: ExtensionContext | undefined): void {
    if (ctx?.mode !== "tui") {
      return;
    }

    const count = this.source().length;

    ctx.ui.setStatus(
      STATUS_KEY,
      count ? ctx.ui.theme.fg("accent", `⏳ ${count}`) : undefined
    );

    if (count > 0 && !this.shown) {
      this.shown = true;
      ctx.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => new LiveWaitsWidget(tui, theme, this.source)
      );
    } else if (count === 0 && this.shown) {
      this.shown = false;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  }
}
