import { SHAPE_SPINNER_COMMAND } from "@clanker-stuff/pi-shape-glyphs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSpinner } from "./spinner.js";

export default function spinnerExtension(pi: ExtensionAPI): void {
  const spinner = createSpinner();

  pi.on("session_start", async (_event, ctx) => {
    await spinner.start(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    spinner.apply(ctx);
  });
  pi.registerCommand(SHAPE_SPINNER_COMMAND, {
    description: "Open the spinner settings dialog",
    handler: async (_args, ctx) => {
      await spinner.command(ctx);
    },
  });
}
