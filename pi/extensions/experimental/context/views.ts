import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type {
  Component,
  Focusable,
  KeybindingsManager,
  OverlayHandle,
  TUI,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { ContextOverlay } from "./overlay.js";
import type { ContextSnapshot, RequestSnapshot } from "./snapshot.js";

/** Independent pane/search/scroll state per view, within one Pi-owned overlay interaction. */
export class ContextViews implements Component, Focusable {
  private readonly views: [ContextOverlay, ContextOverlay];
  private active: 0 | 1 = 0;
  private hasFocus = false;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    state: ContextSnapshot,
    request: RequestSnapshot,
    ui: Pick<ExtensionUIContext, "notify">,
    done: () => void,
  ) {
    const toggle = () => {
      this.current.focused = false;
      this.active = this.active === 0 ? 1 : 0;
      this.current.focused = this.hasFocus;
      this.tui.requestRender();
    };

    this.views = [
      new ContextOverlay(tui, theme, keys, state, ui, done, toggle),
      new ContextOverlay(tui, theme, keys, request, ui, done, toggle),
    ];
  }

  private get current(): ContextOverlay {
    return this.views[this.active];
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.current.focused = value;
  }

  attachMouse(handle: OverlayHandle): void {
    for (const view of this.views) view.attachMouse(handle);
  }

  handleInput(data: string): void {
    this.current.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.current.handleMouse(event);
  }

  render(width: number): string[] {
    return this.current.render(width);
  }

  invalidate(): void {
    for (const view of this.views) view.invalidate();
  }

  dispose(): void {
    for (const view of this.views) view.dispose();
  }
}
