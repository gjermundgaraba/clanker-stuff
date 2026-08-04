import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createFastMode } from "./fast-mode.js";

export default function codexFastExtension(pi: ExtensionAPI): void {
  const fastMode = createFastMode();

  pi.registerFlag("fast", {
    default: false,
    description: "Start with OpenAI Codex fast mode enabled",
    type: "boolean",
  });

  pi.on("before_provider_request", (event, ctx) =>
    fastMode.applyToRequest(event.payload, ctx)
  );

  pi.registerCommand("fast", {
    description: "Toggle OpenAI Codex fast mode",
    handler: (_args, ctx) => Promise.resolve(fastMode.toggle(ctx)),
  });

  pi.on("session_start", (_event, ctx) =>
    fastMode.start(pi.getFlag("fast") === true, ctx)
  );
  pi.on("model_select", (_event, ctx) => fastMode.refreshStatus(ctx));
}
