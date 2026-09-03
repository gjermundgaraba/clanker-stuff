import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createOrbLifecycle } from "./lifecycle.js";

export default function thinkingOrbExtension(pi: ExtensionAPI): void {
  const orb = createOrbLifecycle();

  pi.on("agent_start", (_event, ctx) => orb.onAgentStart(ctx));
  pi.on("agent_settled", (_event, _ctx) => {
    orb.onAgentSettled();
  });
  pi.on("session_shutdown", () => orb.onSessionShutdown());

  pi.registerCommand("orb-start", {
    description: "Start the pane-local Ghostty Thinking Orb overlay",
    handler: (_args, ctx) => orb.startManual(ctx),
  });
  pi.registerCommand("orb-stop", {
    description: "Stop and remove the Thinking Orb overlay",
    handler: (_args, ctx) => orb.stopManual(ctx),
  });
  pi.registerCommand("orb-status", {
    description:
      "Show Thinking Orb configuration, environment, and runtime status",
    handler: (_args, ctx) => orb.status(ctx),
  });
  pi.registerCommand("orb-setup", {
    description: "Install the Thinking Orb shader and Ghostty config",
    handler: (_args, ctx) => orb.setup(ctx),
  });
}
