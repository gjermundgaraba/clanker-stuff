import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSideRuntime } from "./runtime.js";

export default function sideExtension(pi: ExtensionAPI): void {
  const runtime = createSideRuntime(pi);

  pi.registerCommand("side", {
    description: "Open or restore a concurrent multi-turn side conversation",
    handler: (args, ctx) => runtime.launch(args, ctx),
  });

  pi.registerShortcut("ctrl+/", {
    description: "Open side or toggle focus between side and main",
    handler: (ctx) => runtime.toggle(ctx),
  });

  pi.on("session_tree", (_event, ctx) => runtime.closeOnTreeChange(ctx));
  pi.on("session_shutdown", () => runtime.shutdown());
}
