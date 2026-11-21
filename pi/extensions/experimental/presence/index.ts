import { PARKED_CHANNEL } from "@clanker-stuff/presence-protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { presenceTable } from "./report.ts";
import { PresenceTracker } from "./tracker.ts";

export default function presence(pi: ExtensionAPI): void {
  const tracker = new PresenceTracker(pi);
  pi.events.on(PARKED_CHANNEL, (data) => {
    tracker.report(data);
  });
  pi.registerCommand("who", {
    description: "Show every Pi session as working, waiting on you, or stopped",
    handler: async (_args, ctx) => {
      ctx.ui.notify(await presenceTable(), "info");
    },
  });
  pi.on("session_start", (_event, ctx) => {
    tracker.start(ctx);
  });
  pi.on("session_info_changed", () => {
    tracker.renamed();
  });
  pi.on("agent_start", () => {
    tracker.agentStarted();
  });
  pi.on("agent_settled", () => {
    tracker.agentSettled();
  });
  pi.on("tool_execution_start", (event) => {
    tracker.toolStarted(event.toolCallId, event.toolName);
  });
  pi.on("tool_execution_end", (event) => {
    tracker.toolEnded(event.toolCallId);
  });
  pi.on("ui_prompt_start", () => {
    tracker.dialogOpened();
  });
  pi.on("ui_prompt_end", () => {
    tracker.dialogClosed();
  });
  pi.on("session_shutdown", async () => {
    await tracker.shutdown();
  });
}
