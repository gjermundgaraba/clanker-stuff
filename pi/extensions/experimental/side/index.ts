import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSideRuntime } from "./runtime.js";

export default function sideExtension(pi: ExtensionAPI): void {
  const runtime = createSideRuntime(pi);

  pi.registerCommand("side", {
    description: "Open or resume a concurrent multi-turn side conversation",
    handler: (args, ctx) => runtime.launch(args, ctx),
  });

  pi.registerShortcut("ctrl+/", {
    description: "Open or dismiss the side panel",
    handler: (ctx) => runtime.toggle(ctx),
  });

  pi.on("session_tree", (_event, ctx) => runtime.closeOnTreeChange(ctx));
  pi.on("session_shutdown", () => runtime.shutdown());
}
