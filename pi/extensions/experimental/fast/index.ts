import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createFastMode } from "./mode.js";

export default function fast(pi: ExtensionAPI): void {
  const mode = createFastMode(pi, getExtensionStoragePaths("fast").configFile);

  pi.registerFlag("fast", {
    description: "Start with local best-effort native subscription priority requests enabled",
    type: "boolean",
  });
  pi.registerCommand("fast", {
    description: "Toggle native OpenAI subscription priority routing",
    handler: async (args, ctx) => mode.toggle(args, ctx),
  });
  pi.on("session_start", (event, ctx) => mode.start(event, ctx));
  pi.on("before_provider_request", (event, ctx) => mode.payload(event, ctx));
  pi.on("session_shutdown", (_event, ctx) => mode.stop(ctx));
}
