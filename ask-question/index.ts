import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  AskQuestionParametersSchema,
  MAX_QUESTIONS,
  buildCancelledToolResult,
  buildSuccessToolResult,
  parseQuestionsFromParameters,
} from "./contract.js";
import { runAskQuestionTuiFlow } from "./tui.js";

export default function askQuestion(pi: ExtensionAPI) {
  pi.registerTool({
    description:
      "Ask one or more structured clarification questions and return machine-readable answers.",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = parseQuestionsFromParameters(params);

      if (ctx.mode !== "tui") {
        throw new Error("ask_question requires interactive UI");
      }

      // https://github.com/ogulcancelik/herdr/blob/v0.7.5/src/integration/assets/pi/herdr-agent-state.ts#L230-L246
      pi.events.emit("herdr:blocked", {
        active: true,
        label: "Waiting for answers",
      });

      try {
        const flow = await runAskQuestionTuiFlow(ctx, questions, signal);

        if (flow.cancelled) {
          ctx.abort();
          return buildCancelledToolResult(flow.reason);
        }

        return buildSuccessToolResult(questions, flow);
      } finally {
        pi.events.emit("herdr:blocked", { active: false });
      }
    },
    executionMode: "sequential",
    label: "Ask Question",
    name: "ask_question",
    parameters: AskQuestionParametersSchema,
    promptGuidelines: [
      "When using ask_question, prefer single_select or multi_select over free_text when practical.",
      "When using ask_question, mark likely defaults with '(Suggested)' and explain why in option.details.",
      "For ask_question, do not include an 'Other' option; the UI always provides a free-text Other field for option-based questions.",
      `For ask_question, ask at most ${MAX_QUESTIONS} questions per call; use multiple ask_question calls if needed.`,
    ],
    promptSnippet:
      "Ask structured clarification questions and return machine-readable answers",
  });
}
