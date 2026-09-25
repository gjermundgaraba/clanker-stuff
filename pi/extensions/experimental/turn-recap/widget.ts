import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { renderLive } from "./card.js";
import type { LiveState } from "./card.js";
import type { RollingFont } from "./font.js";
import { ROLL_FRAME_MS, RollingNumbers } from "./rolling.js";

/**
 * One widget per run. It owns the only redraw timer: rolling frames while digits move,
 * otherwise the next displayed second, and nothing while paused.
 */
export const createLiveWidget = (
  tui: TUI,
  theme: Pick<Theme, "fg">,
  view: () => LiveState | undefined,
  font: RollingFont | undefined,
) => {
  const numbers = new RollingNumbers();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const wake = (ms: number) => {
    timer = setTimeout(() => tui.requestRender(), ms);
  };

  return {
    render(width: number): string[] {
      clearTimeout(timer);
      const state = view();

      if (!state) return [];

      // Values that changed while paused snap on resume.
      if (state.paused) {
        numbers.reset();

        return renderLive(state, width, theme);
      }

      // Running time shows whole seconds; wake just after the next one.
      const nextSecond = 1001 - (state.activeMs % 1000);

      if (!font) {
        wake(nextSecond);

        return renderLive(state, width, theme);
      }

      const { lines, animated } = numbers.frame(performance.now(), font, (numeric) =>
        renderLive(state, width, theme, numeric),
      );

      // A quantized frame can be ASCII at a step boundary and still be moving.
      wake(animated ? Math.min(ROLL_FRAME_MS, nextSecond) : nextSecond);

      return lines;
    },
    // Theme and layout are recomputed on every render; no styled cache to clear.
    invalidate() {},
    dispose() {
      clearTimeout(timer);
    },
  };
};
