import { acquireEditorHost } from "@clanker-stuff/editor";
import { createBorderStatusClient } from "@clanker-stuff/border-status-protocol";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mountVim } from "./runtime.js";
import type { Mode } from "./core/commands.js";

export function createVim(pi: ExtensionAPI) {
  let stop: (() => void) | undefined;
  let context: ExtensionContext | undefined;
  let mode: Mode = "insert";

  const fallback = () =>
    context?.ui.setStatus("vim", border.available ? undefined : `VIM ${mode.toUpperCase()}`);

  const border = createBorderStatusClient(pi, { owner: "vim", onAvailabilityChange: fallback });

  const publish = (next: Mode) => {
    mode = next;
    border.set("mode", { text: next.toUpperCase(), tone: "accent", priority: 100 });
    fallback();
  };

  const dispose = () => {
    stop?.();
    stop = undefined;
    border.dispose();
    context?.ui.setStatus("vim", undefined);
    context = undefined;
  };

  return {
    start(ctx: ExtensionContext) {
      dispose();
      context = ctx;

      if (ctx.mode !== "tui") return;
      const host = acquireEditorHost(ctx);

      if (!host) return;
      border.attach(ctx);
      stop = mountVim(host, publish);
    },
    navigate(ctx: ExtensionContext, newLeafId: string | null) {
      if (!stop) return;
      border.attach(ctx, newLeafId);
      publish(mode);
    },
    dispose,
  };
}
