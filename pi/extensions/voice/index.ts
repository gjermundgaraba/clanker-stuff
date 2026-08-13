import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createVoiceController } from "./controller.js";
import { registerVoiceTools } from "./tools.js";

export default function voiceExtension(pi: ExtensionAPI): void {
  const voice = createVoiceController(pi);

  pi.registerCommand("voice", {
    description: "Start, stop, or inspect realtime voice",
    handler: (args, ctx) => voice.runCommand(args, ctx),
  });

  pi.registerShortcut("ctrl+shift+v", {
    description: "Toggle realtime voice",
    handler: (ctx) => voice.toggle(ctx),
  });

  registerVoiceTools(pi, {
    endActiveCall: () => voice.endActiveCall(),
    finish: (spokenSummary) => voice.finish(spokenSummary),
    sendStatus: (message) => voice.sendStatus(message),
  });

  pi.on("session_start", (_event, ctx) => {
    voice.sessionStart(ctx);
  });
  pi.on("session_before_tree", (event) => {
    voice.sessionBeforeTree(event.preparation.oldLeafId);
  });
  pi.on("session_tree", (_event, ctx) => {
    voice.sessionTree(ctx);
  });
  pi.on("before_agent_start", (event) => voice.beforeAgentStart(event));
  pi.on("turn_end", (event) => {
    voice.turnEnd(event);
  });
  pi.on("agent_settled", () => {
    voice.settled();
  });
  pi.on("message_start", (event) => {
    voice.messageStart(event);
  });
  pi.on("session_shutdown", () => {
    voice.shutdown();
  });
}
