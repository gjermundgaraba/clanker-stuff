import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSpinner } from "./spinner.js";

export default function spinnerExtension(pi: ExtensionAPI): void {
  const spinner = createSpinner();

  pi.on("session_start", (_event, ctx) => spinner.apply(ctx));
  pi.registerCommand("shape-spinner", {
    description: "Choose a spinner shape, wireframe color or background, playback mode, or preview",
    handler: async (args, ctx) => spinner.command(args, ctx),
  });
}
