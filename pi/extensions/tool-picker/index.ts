import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createToolPicker } from "./runtime.js";

export default function toolPickerExtension(pi: ExtensionAPI): void {
  const picker = createToolPicker(pi);

  pi.registerCommand("tools", {
    description: "Enable/disable tools",
    handler: (_args, ctx) => picker.open(ctx),
  });
  pi.on("session_start", (_event, ctx) => {
    picker.start(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    picker.restore(ctx);
  });
}
