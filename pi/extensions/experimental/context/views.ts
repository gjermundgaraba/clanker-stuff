import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  Focusable,
  KeybindingsManager,
  TUI,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { ContextOverlay } from "./overlay.js";
import type { OverlayServices } from "./overlay.js";
import type {
  ContextSnapshot,
  RequestSnapshot,
  InspectorSnapshot,
} from "./snapshot.js";
import type { ToolsSnapshot } from "./tools.js";

export class ContextViews implements Component, Focusable {
  private readonly views: readonly ContextOverlay[];
  private active = 0;
  private hasFocus = false;

  private readonly tui: TUI;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    state: ContextSnapshot,
    request: RequestSnapshot,
    tools: ToolsSnapshot,
    ui: Pick<ExtensionUIContext, "notify">,
    services: OverlayServices,
    done: () => void
  ) {
    this.tui = tui;
    const snapshots: readonly InspectorSnapshot[] = [state, request, tools];

    this.views = snapshots.map((snapshot, index) => {
      const next = (index + 1) % snapshots.length;
      const destination = snapshots[next];

      if (!destination) {
        throw new Error(`Context view ${next} does not exist`);
      }

      return new ContextOverlay(
        tui,
        theme,
        keys,
        snapshot,
        ui,
        services,
        done,
        {
          label: destination.kind,
          open: () => {
            this.current.focused = false;
            this.active = next;
            this.current.focused = this.hasFocus;
            this.tui.requestRender();
          },
        }
      );
    });
  }

  private get current(): ContextOverlay {
    const view = this.views[this.active];

    if (!view) {
      throw new Error(`Context view ${this.active} does not exist`);
    }

    return view;
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
    for (const view of this.views) {
      view.invalidate();
    }
  }
}
