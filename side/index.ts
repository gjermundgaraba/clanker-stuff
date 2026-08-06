import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import { createSideController } from "./controller.js";

export default function sideExtension(pi: ExtensionAPI): void {
  const side = createSideController(pi);

  pi.registerCommand("side", {
    description: "Open or restore a concurrent multi-turn side conversation",
    handler: (args, ctx) => side.launch(args, ctx),
  });

  pi.registerShortcut(Key.ctrl("/"), {
    description: "Open side or toggle focus between side and main",
    handler: (ctx) => side.toggle(ctx),
  });

  pi.on("session_tree", (_event, ctx) => side.closeOnTreeChange(ctx));
  pi.on("session_shutdown", () => side.dispose());
}
