import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createVoiceRuntime } from "./runtime.js";

export default function voiceExtension(pi: ExtensionAPI): void {
  const runtime = createVoiceRuntime(pi);

  pi.registerCommand("voice", {
    description: "Start, stop, or inspect realtime voice",
    handler: (args, ctx) => runtime.runCommand(args, ctx),
  });

  pi.registerShortcut("ctrl+shift+v", {
    description: "Toggle realtime voice",
    handler: (ctx) => runtime.toggle(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.sessionStart(ctx);
  });
  pi.on("session_before_tree", (event) => {
    runtime.sessionBeforeTree(event.preparation.oldLeafId);
  });
  pi.on("session_tree", (_event, ctx) => {
    runtime.sessionTree(ctx);
  });
  pi.on("before_agent_start", (event) => runtime.beforeAgentStart(event));
  pi.on("turn_end", (event) => {
    runtime.turnEnd(event);
  });
  pi.on("agent_settled", () => {
    runtime.settled();
  });
  pi.on("message_start", (event) => {
    runtime.messageStart(event);
  });
  pi.on("session_shutdown", () => runtime.shutdown());
}
