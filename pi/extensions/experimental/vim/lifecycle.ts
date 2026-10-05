import { acquireEditorHost } from "@clanker-stuff/editor";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mountVim } from "./runtime.js";

export function createVim() {
  let stop: (() => void) | undefined;
  let context: ExtensionContext | undefined;

  const dispose = () => {
    stop?.();
    stop = undefined;
    context?.ui.setStatus("vim", undefined);
    context = undefined;
  };

  return {
    start(ctx: ExtensionContext) {
      dispose();

      if (ctx.mode !== "tui") return;
      const host = acquireEditorHost(ctx);

      if (!host) return;
      context = ctx;
      stop = mountVim(host, (mode) =>
        ctx.ui.setStatus("vim", ctx.ui.theme.fg("accent", mode.toUpperCase())),
      );
    },
    dispose,
  };
}
