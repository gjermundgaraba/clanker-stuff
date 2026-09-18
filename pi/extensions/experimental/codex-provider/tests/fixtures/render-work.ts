import { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { vi } from "vite-plus/test";

/** Observe real work without replacing the highlighter/layout engine or reading Pi's private caches. */
export const observeRenderWork = () => {
  const layouts = vi.fn();
  const highlights = vi.fn();
  const previous = new WeakMap<Text, string[]>();
  // oxlint-disable-next-line typescript/unbound-method -- Rebound to the observed instance with .call below.
  const render = Text.prototype.render;
  // oxlint-disable-next-line typescript/unbound-method -- Rebound to the observed instance with .call below.
  const fg = Theme.prototype.fg;
  vi.spyOn(Text.prototype, "render").mockImplementation(function (this: Text, width) {
    const lines = render.call(this, width);

    if (previous.get(this) !== lines) {
      previous.set(this, lines);
      layouts();
    }

    return lines;
  });
  vi.spyOn(Theme.prototype, "fg").mockImplementation(function (this: Theme, color, text) {
    if (color.startsWith("syntax")) highlights();

    return fg.call(this, color, text);
  });

  return { layouts, highlights };
};
