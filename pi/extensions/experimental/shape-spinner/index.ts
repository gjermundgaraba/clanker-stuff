import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSpinner } from "./spinner.js";

export default function spinnerExtension(pi: ExtensionAPI): void {
  const spinner = createSpinner();

  pi.on("session_start", (_event, ctx) => spinner.apply(ctx));
  pi.on("session_shutdown", () => spinner.dispose());
  pi.registerCommand("shape-spinner", {
    description: "Open the spinner settings dialog",
    handler: async (args, ctx) => spinner.command(args, ctx),
  });
}
