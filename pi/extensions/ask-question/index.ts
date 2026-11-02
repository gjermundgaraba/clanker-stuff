import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Coordinator } from "./coordinator.js";
import { MESSAGE_TYPE } from "./delivery.js";
import { registerQuestionTool, withdrawOutsideTui } from "./tools.js";
import { renderOutcomeMessage } from "./transcript.js";

export default function askQuestion(pi: ExtensionAPI) {
  const coordinator = new Coordinator(pi);
  registerQuestionTool(pi, coordinator);
  pi.registerMessageRenderer(MESSAGE_TYPE, renderOutcomeMessage);
  pi.registerCommand("answers", {
    description: "Answer or dismiss open questionnaires on this branch",
    handler: async (_args, ctx) => {
      await coordinator.answer(ctx);
    },
  });
  pi.registerShortcut("alt+i", {
    description: "Open question inbox",
    handler: async (ctx) => {
      await coordinator.answer(ctx);
    },
  });
  pi.on("session_start", (_event, ctx) => {
    withdrawOutsideTui(pi, coordinator, ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    coordinator.attach(ctx);
  });
  pi.on("session_before_tree", () => {
    coordinator.flush();
  });
  pi.on("session_tree", (_event, ctx) => {
    coordinator.attach(ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    coordinator.settled(event, ctx);
  });
  pi.on("session_shutdown", () => {
    coordinator.shutdown();
  });
}
