import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AskQuestionParametersSchema, MAX_QUESTIONS, executeAskQuestion } from "./tool.js";

export default function askQuestion(pi: ExtensionAPI) {
  pi.registerTool({
    constrainedSampling: { strict: "prefer", type: "json_schema" },
    description:
      "Ask one or more structured clarification questions and return machine-readable answers.",
    execute: (_toolCallId, params, signal, _onUpdate, ctx) =>
      executeAskQuestion(pi, params, signal, ctx),
    executionMode: "sequential",
    label: "Ask Question",
    name: "ask_question",
    parameters: AskQuestionParametersSchema,
    promptGuidelines: [
      "When using ask_question, mark likely defaults with '(Suggested)' and explain why in option.details.",
      "For ask_question, do not include an 'Other' option; the UI always provides a free-text Other field.",
      "For ask_question, set multiSelect only when several answers are valid at once.",
      `For ask_question, ask at most ${MAX_QUESTIONS} questions per call; use multiple ask_question calls if needed.`,
    ],
    promptSnippet: "Ask structured clarification questions and return machine-readable answers",
  });
}
