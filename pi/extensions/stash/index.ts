import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createStash } from "./stash.js";

export default function stashExtension(pi: ExtensionAPI): void {
  const stash = createStash();

  pi.on("session_start", (_event, ctx) => stash.start(ctx));

  pi.registerShortcut("ctrl+s", {
    description: "Stash current editor text, or pop the latest stash when empty",
    handler: stash.toggle,
  });

  pi.registerCommand("pop-stash", {
    description: "Pop the most recent stashed editor text",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error("pop-stash requires interactive UI");
      await stash.pop(ctx);
    },
  });

  pi.on("input", stash.restore);
  pi.on("session_shutdown", stash.dispose);
}
