import { acquireEditorHost } from "@clanker-stuff/editor";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mountVim } from "./runtime.js";

export function createVim() {
  let stop: (() => void) | undefined;

  const dispose = () => {
    stop?.();
    stop = undefined;
  };

  return {
    start(ctx: ExtensionContext) {
      dispose();

      if (ctx.mode !== "tui") return;
      const host = acquireEditorHost(ctx);

      if (!host) return;

      const unmount = mountVim(host, (mode) =>
        ctx.ui.setStatus("vim", ctx.ui.theme.fg("accent", mode.toUpperCase())),
      );

      stop = () => {
        unmount();
        ctx.ui.setStatus("vim", undefined);
      };
    },
    dispose,
  };
}
