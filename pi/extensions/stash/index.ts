import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createStash } from "./stash.js";

export default function stashExtension(pi: ExtensionAPI): void {
  const stash = createStash();

  pi.on("session_start", (_event, ctx) => stash.start(ctx));

  pi.registerShortcut("ctrl+s", {
    description: "Stash current editor text, or pop the latest stash when empty",
    handler: (ctx) => stash.toggle(ctx),
  });

  pi.registerCommand("pop-stash", {
    description: "Pop the most recent stashed editor text",
    handler: (_args, ctx) => stash.pop(ctx),
  });

  pi.on("input", (event, ctx) => stash.prepareRestore(event, ctx));
  pi.on("turn_start", (_event, ctx) => stash.commitRestore(ctx));
  pi.on("session_shutdown", (_event, ctx) => stash.dispose(ctx));
}
