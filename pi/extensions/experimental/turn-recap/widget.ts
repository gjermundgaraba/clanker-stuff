import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { renderLive } from "./card.js";
import type { LiveState } from "./card.js";
import type { RollingFont } from "./font.js";
import { ROLL_FRAME_MS, RollingNumbers } from "./rolling.js";

export const createLiveWidget = (
  tui: TUI,
  theme: Pick<Theme, "fg">,
  view: () => LiveState | undefined,
  font: RollingFont | undefined
) => {
  const numbers = new RollingNumbers();
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    render(width: number): string[] {
      clearTimeout(timer);
      const state = view();

      if (!state) {
        return [];
      }

      const nextSecond = 1001 - (state.elapsedMs % 1000);

      const { lines, animated } = font
        ? numbers.frame(performance.now(), font, (numeric) =>
            renderLive(state, width, theme, numeric)
          )
        : { lines: renderLive(state, width, theme), animated: false };

      timer = setTimeout(
        () => {
          tui.requestRender();
        },
        animated ? Math.min(ROLL_FRAME_MS, nextSecond) : nextSecond
      );

      return lines;
    },
    invalidate: () => undefined,
    dispose() {
      clearTimeout(timer);
    },
  };
};
