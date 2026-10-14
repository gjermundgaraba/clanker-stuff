import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type {
  Component,
  Focusable,
  KeybindingsManager,
  TUI,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { ContextOverlay } from "./overlay.js";
import type { ContextSnapshot, RequestSnapshot, InspectorSnapshot } from "./snapshot.js";
import type { ToolsSnapshot } from "./tools.js";

/** Independent pane/search/scroll state per view, within one Pi-owned overlay interaction. */
export class ContextViews implements Component, Focusable {
  private readonly views: readonly ContextOverlay[];
  private active = 0;
  private hasFocus = false;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    state: ContextSnapshot,
    request: RequestSnapshot,
    tools: ToolsSnapshot,
    ui: Pick<ExtensionUIContext, "notify">,
    done: () => void,
  ) {
    const snapshots: readonly InspectorSnapshot[] = [state, request, tools];

    this.views = snapshots.map((snapshot, index) => {
      const next = (index + 1) % snapshots.length;
      // Both lookups use indexes bounded by this fixed, nonempty collection.
      const destination = snapshots[next]!;

      return new ContextOverlay(tui, theme, keys, snapshot, ui, done, {
        label: destination.kind,
        open: () => {
          this.current.focused = false;
          this.active = next;
          this.current.focused = this.hasFocus;
          this.tui.requestRender();
        },
      });
    });
  }

  private get current(): ContextOverlay {
    // active is initialized to zero and only assigned an index from views' construction.
    return this.views[this.active]!;
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.current.focused = value;
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
}
