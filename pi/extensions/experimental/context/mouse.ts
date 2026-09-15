import type { OverlayBounds, TuiMouseEvent } from "@earendil-works/pi-tui";

// Pi's stdin buffer assembles SGR mouse sequences, but only fullscreen Pi decodes them.
export const parseMouseInput = (
  data: string,
  bounds: OverlayBounds | undefined,
): TuiMouseEvent | undefined => {
  // oxlint-disable-next-line no-control-regex -- SGR mouse reports start with ESC.
  const match = /^\u001B\[<(\d+);(\d+);(\d+)M$/.exec(data);
  if (!match || !bounds) return;
  const button = Number(match[1]);
  const screenX = Number(match[2]) - 1;
  const screenY = Number(match[3]) - 1;
  const x = screenX - bounds.col;
  const y = screenY - bounds.row;
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return;
  const wheel = (button & 64) !== 0;
  if ((button & 32) !== 0 || (wheel ? (button & 3) > 1 : (button & 3) !== 0)) return;
  return {
    type: wheel ? "wheel" : "press",
    button: wheel ? "none" : "left",
    x,
    y,
    screenX,
    screenY,
    width: bounds.width,
    height: bounds.height,
    shift: (button & 4) !== 0,
    alt: (button & 8) !== 0,
    ctrl: (button & 16) !== 0,
    wheelDelta: wheel ? ((button & 1) === 0 ? -3 : 3) : undefined,
  };
};
