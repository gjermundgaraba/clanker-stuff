import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { autoRestoreStash, popStashCommand, toggleStash } from "./stash.js";

export default function stashExtension(pi: ExtensionAPI): void {
  pi.registerShortcut("ctrl+s", {
    description:
      "Stash current editor text, or pop the latest stash when empty",
    handler: toggleStash,
  });

  pi.registerCommand("pop-stash", {
    description: "Pop the most recent stashed editor text",
    handler: popStashCommand,
  });

  pi.on("input", autoRestoreStash);
}
