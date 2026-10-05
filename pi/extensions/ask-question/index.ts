import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Coordinator } from "./coordinator.js";
import { registerQuestionTools, withdrawOutsideTui } from "./tools.js";
import { transformAnswerMarkdown } from "./transcript.js";

export default function askQuestion(pi: ExtensionAPI) {
  const coordinator = new Coordinator(pi);
  registerQuestionTools(pi, coordinator);
  pi.registerMarkdownTransformer(transformAnswerMarkdown);
  pi.registerCommand("answers", {
    description: "Review, answer, resume or revise questionnaires on this branch",
    handler: (_args, ctx) => coordinator.answer(ctx),
  });
  pi.registerShortcut("alt+i", {
    description: "Open question inbox",
    handler: (ctx) => coordinator.answer(ctx),
  });
  pi.on("session_start", (_event, ctx) => withdrawOutsideTui(pi, coordinator, ctx));
  pi.on("session_start", (_event, ctx) => coordinator.attach(ctx));
  pi.on("session_before_tree", () => coordinator.flush());
  pi.on("session_tree", (_event, ctx) => coordinator.attach(ctx));
  pi.on("session_shutdown", () => coordinator.shutdown());
}
